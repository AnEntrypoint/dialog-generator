"""One-time export of the LuxTTS LinaCodec 48kHz Vocos vocoder to ONNX.

Run with the isolated venv that has linacodec+vocos+onnx+onnxscript installed:
    .venv-lux/Scripts/python tools/export-vocos.py

Uses the torch>=2.6 dynamo exporter (decomposes the complex FFT / ISTFT /
Linkwitz-Riley crossover that the legacy exporter can't handle). The crossover's
in-place mask assignment is monkeypatched to a concat build so onnxruntime gets
int64 ScatterND-free indices.

Outputs models/tts/lux/vocos.onnx  (decode: mel[1,100,T] -> 48k waveform[1,L]).
"""
import os, sys
import numpy as np
import torch
from huggingface_hub import hf_hub_download
from torch.nn.utils import parametrize

REPO = "YatharthS/LuxTTS"
OUT_DIR = os.path.join("models", "tts", "lux")
os.makedirs(OUT_DIR, exist_ok=True)

# --- export-clean reimplementation of the Linkwitz-Riley crossover ---------
# Identical math to linacodec.vocoder.linkwitz.crossover_merge_linkwitz_riley
# but builds the frequency mask by concatenation instead of three in-place
# slice writes (which lower to ScatterND with int32 indices -> invalid graph).
import linacodec.vocoder.linkwitz as _lk


def _crossover_concat(path1_48k, path2_48k, sample_rate=48000, cutoff=4000, transition_bins=8):
    spec1 = torch.fft.rfft(path1_48k)
    spec2 = torch.fft.rfft(path2_48k)
    n_bins = spec1.size(-1)
    cutoff_bin = int((cutoff / (sample_rate / 2)) * n_bins)
    half = transition_bins // 2
    start = max(0, cutoff_bin - half)
    end = min(n_bins, cutoff_bin + half)
    actual_width = end - start
    x = torch.linspace(-1, 1, steps=actual_width, device=spec1.device)
    fade = 3 * torch.pow((x + 1) / 2, 2) - 2 * torch.pow((x + 1) / 2, 3)
    mask = torch.cat([
        torch.zeros(start, device=spec1.device),
        fade,
        torch.ones(n_bins - end, device=spec1.device),
    ])
    merged_spec = (spec1 * mask) + (spec2 * (1.0 - mask))
    return torch.fft.irfft(merged_spec, n=path1_48k.size(-1))


_lk.crossover_merge_linkwitz_riley = _crossover_concat
# vocos.py imported the symbol by name; rebind there too.
import linacodec.vocoder.vocos as _vmod
if hasattr(_vmod, "crossover_merge_linkwitz_riley"):
    _vmod.crossover_merge_linkwitz_riley = _crossover_concat

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
    def __init__(self, v):
        super().__init__()
        self.v = v

    def forward(self, mel):
        return self.v.decode(mel)


wrapper = DecodeWrapper(vocos).eval()
mel = torch.randn(1, 100, 200, dtype=torch.float32)
with torch.no_grad():
    ref = wrapper(mel).numpy()
print("torch decode out shape:", ref.shape)

out_path = os.path.join(OUT_DIR, "vocos.onnx")
torch.onnx.export(
    wrapper, (mel,), out_path, dynamo=True,
    input_names=["mel"], output_names=["audio"],
    dynamic_shapes={"mel": {2: torch.export.Dim.AUTO}},
)
print("DYNAMO EXPORT OK ->", out_path)

# --- post-process: ONNX requires ScatterND/GatherND indices to be int64.
# The dynamo exporter emits some as int32; insert a Cast(to=int64) before
# each such indices input. Generic and order-independent.
import onnx
from onnx import helper, TensorProto

m = onnx.load(out_path)
g = m.graph
casts = 0
for node in list(g.node):
    if node.op_type in ("ScatterND", "GatherND", "ScatterElements", "GatherElements"):
        idx_in = node.input[1]
        cast_out = f"{idx_in}__i64_{casts}"
        cast = helper.make_node("Cast", [idx_in], [cast_out], to=TensorProto.INT64,
                                name=f"cast_idx_i64_{casts}")
        g.node.insert(list(g.node).index(node), cast)
        node.input[1] = cast_out
        casts += 1
print(f"patched {casts} index inputs -> int64")
onnx.save(m, out_path)

import onnxruntime as ort
sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
o = sess.run(None, {"mel": mel.numpy()})[0]
n = min(o.shape[-1], ref.shape[-1])
d = float(np.abs(o[..., :n] - ref[..., :n]).max())
print("onnx out:", o.shape, "max-abs-diff vs torch:", d)
# dynamic T check
o2 = sess.run(None, {"mel": torch.randn(1, 100, 350).numpy()})[0]
print("dynamic-T onnx out:", o2.shape)
print("VALIDATE", "OK" if d < 1e-2 else "DIFF-HIGH")
sys.exit(0 if d < 1e-2 else 3)
