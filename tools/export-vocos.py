"""One-time export of the LuxTTS LinaCodec 48kHz Vocos vocoder to ONNX.

Run with the isolated venv (linacodec+vocos+onnx+onnxscript+torch>=2.6):
    .venv-lux/Scripts/python tools/export-vocos.py

The vocoder's ISTFT lowers to an ONNX `DFT` op with inverse+onesided set, which
onnxruntime rejects. We monkeypatch:
  * vocos.heads.ISTFTHead.forward  -> emits real/imag tensors (no complex op)
  * vocos.heads.ISTFT.forward      -> matmul-based irfft + fold overlap-add
  * Vocos.decode (via wrapper)     -> head_48k path only; the dynamic-length
                                      Linkwitz-Riley crossover (full-signal FFT)
                                      is dropped per design decision.
Result is a pure matmul/conv graph that onnxruntime loads and runs.

Outputs models/tts/lux/vocos.onnx  (decode: mel[1,100,T] -> 48k waveform[1,L]).
"""
import os, sys, math
import numpy as np
import torch
from huggingface_hub import hf_hub_download
from torch.nn.utils import parametrize

REPO = "YatharthS/LuxTTS"
OUT_DIR = os.path.join("models", "tts", "lux")
os.makedirs(OUT_DIR, exist_ok=True)

import vocos.heads as _heads

# torch.export specializes the time dim when nn.Linear flattens (B,T,C)->(B*T,C)
# for a Gemm. Route every 3D Linear through conv1d (kernel=1) instead -- identical
# math, operates on (B,C,T), keeps T fully dynamic in the ONNX graph.
_orig_linear_forward = torch.nn.Linear.forward


def _linear_forward_conv(self, x):
    if x.dim() == 3:
        w = self.weight.unsqueeze(-1)  # (out, in, 1)
        return torch.nn.functional.conv1d(x.transpose(1, 2), w, self.bias).transpose(1, 2)
    return _orig_linear_forward(self, x)


torch.nn.Linear.forward = _linear_forward_conv


def _build_irfft_basis(n_fft: int):
    """Real cos/sin matrices for a backward-normalized onesided inverse rFFT.
    X is onesided length M=n_fft//2+1; output length N=n_fft.
    y[n] = (1/N) [ w_k * ( Xr_k cos(2pi k n/N) - Xi_k sin(2pi k n/N) ) summed over k ]
    with w_0 = w_{N/2} = 1, else 2.  Returns C,S of shape (M, N)."""
    N = n_fft
    M = N // 2 + 1
    k = np.arange(M)[:, None]
    n = np.arange(N)[None, :]
    ang = 2.0 * math.pi * k * n / N
    w = np.full((M, 1), 2.0)
    w[0, 0] = 1.0
    if N % 2 == 0:
        w[M - 1, 0] = 1.0
    C = (w * np.cos(ang) / N).astype(np.float32)
    S = (w * np.sin(ang) / N).astype(np.float32)
    return torch.from_numpy(C), torch.from_numpy(S)


def _patch_istft(istft):
    """Replace ISTFT.forward with a matmul-irfft implementation (no DFT op).
    Operates on real/imag tensors set by the patched head (istft._Sre/_Sim)."""
    C, Smat = _build_irfft_basis(istft.n_fft)
    istft.register_buffer("_irfft_C", C, persistent=False)
    istft.register_buffer("_irfft_S", Smat, persistent=False)

    # identity overlap-add kernel: ConvTranspose1d(in=n_fft,out=1,K=n_fft) with
    # weight[j,0,k]=1 iff j==k reproduces overlap-add and keeps length dynamic
    # (fold/Col2Im would force a static output size).
    eye = torch.eye(istft.n_fft).unsqueeze(1)  # (n_fft, 1, n_fft)
    istft.register_buffer("_oa_kernel", eye, persistent=False)

    def forward(spec_unused, _self=istft):
        Xr, Xi = _self._Sre, _self._Sim  # (B, M, T)
        yr = torch.matmul(Xr.transpose(1, 2), _self._irfft_C).transpose(1, 2)
        yi = torch.matmul(Xi.transpose(1, 2), _self._irfft_S).transpose(1, 2)
        ifft = (yr - yi) * _self.window[None, :, None]  # (B, n_fft, T)
        if _self.padding == "center":
            pad = _self.win_length // 2
        else:  # "same"
            pad = (_self.win_length - _self.hop_length) // 2
        y = torch.nn.functional.conv_transpose1d(
            ifft, _self._oa_kernel, stride=_self.hop_length
        )[:, 0, :]  # (B, L)
        win_sq = _self.window.square()[None, :, None].expand_as(ifft)
        env = torch.nn.functional.conv_transpose1d(
            win_sq, _self._oa_kernel, stride=_self.hop_length
        )[:, 0, :]
        y = y[:, pad:-pad]
        env = env[:, pad:-pad]
        return y / env

    istft.forward = forward


def _patch_head(head):
    _patch_istft(head.istft)
    orig_out = head.out

    def forward(x, _head=head):
        x = orig_out(x).transpose(1, 2)
        mag, p = x.chunk(2, dim=1)
        mag = torch.clip(torch.exp(mag), max=1e2)
        _head.istft._Sre = mag * torch.cos(p)
        _head.istft._Sim = mag * torch.sin(p)
        return _head.istft.forward(None)

    head.forward = forward


# Snake1d's snake() does `x.reshape(shape[0],shape[1],-1)` then `x.reshape(shape)`
# where shape captured the trace dims -> bakes the time axis. For 3D input both
# reshapes are no-ops; replace with the bare elementwise op (dynamic-safe).
import linacodec.vocoder.upsampler_block as _ub


def _snake_flat(x, alpha):
    return x + (alpha + 1e-9).reciprocal() * torch.sin(alpha * x).pow(2)


_ub.snake = _snake_flat

from linacodec.vocoder.vocos import Vocos

cfg = hf_hub_download(REPO, "vocoder/config.yaml")
binp = hf_hub_download(REPO, "vocoder/vocos.bin")
vocos = Vocos.from_hparams(cfg).eval()
parametrize.remove_parametrizations(vocos.upsampler.upsample_layers[0], "weight")
parametrize.remove_parametrizations(vocos.upsampler.upsample_layers[1], "weight")
vocos.load_state_dict(torch.load(binp, map_location="cpu"))
vocos.freq_range = 12000
vocos.return_48k = True


class DecodeWrapper(torch.nn.Module):
    """head_48k path of Vocos.decode (crossover dropped)."""
    def __init__(self, v):
        super().__init__()
        self.v = v

    def forward(self, mel):
        features = self.v.backbone(mel).transpose(1, 2)
        upsampled = self.v.upsampler(features).transpose(1, 2)
        return self.v.head_48k(upsampled)


# Fixed mel frame length. torch.export fights symbolic time at several internal
# ops (Col2Im static output, conv_transpose numel(), snake reshape). A fixed
# length sidesteps all of it; the bridge pads each chunk's features to L_FIX and
# trims the vocoder output to the true length (the vocoder is conv/ISTFT, i.e.
# time-local, so zero-padded tails only affect trimmed-away samples).
L_FIX = int(os.environ.get("LUX_VOCOS_FRAMES", "768"))

# reference (torch, head_48k path) BEFORE patching the head
wrapper = DecodeWrapper(vocos).eval()
mel = torch.randn(1, 100, L_FIX, dtype=torch.float32)
with torch.no_grad():
    ref = wrapper(mel).numpy()
print("torch head_48k out shape:", ref.shape)

# patch the head to the matmul iSTFT and confirm parity vs torch istft
_patch_head(vocos.head_48k)
with torch.no_grad():
    ref_patched = wrapper(mel).numpy()
nref = min(ref.shape[-1], ref_patched.shape[-1])
dpatch = float(np.abs(ref[..., :nref] - ref_patched[..., :nref]).max())
print("matmul-istft vs torch-istft max-abs-diff:", dpatch)

out_path = os.path.join(OUT_DIR, "vocos.onnx")
torch.onnx.export(
    wrapper, (mel,), out_path, dynamo=True,
    input_names=["mel"], output_names=["audio"],
)
print(f"DYNAMO EXPORT OK (fixed {L_FIX} frames) ->", out_path)

import onnxruntime as ort
sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
o = sess.run(None, {"mel": mel.numpy()})[0]
n = min(o.shape[-1], ref_patched.shape[-1])
d = float(np.abs(o[..., :n] - ref_patched[..., :n]).max())
print("onnx out:", o.shape, "max-abs-diff vs torch(patched):", d)
# sanity: a different content tensor of the same fixed length still runs
o2 = sess.run(None, {"mel": torch.randn(1, 100, L_FIX).numpy()})[0]
print("second-input onnx out:", o2.shape)
ok = d < 1e-3 and dpatch < 1e-3
print("VALIDATE", "OK" if ok else "DIFF-HIGH", "frames_per_input", L_FIX,
      "samples_per_input", o.shape[-1])
sys.exit(0 if ok else 3)
