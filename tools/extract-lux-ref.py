import sys, numpy as np, soundfile as sf, librosa, torch
from vocos.feature_extractors import MelSpectrogramFeatures
wav, sr = sf.read('voices/cleetus.wav')
if wav.ndim > 1: wav = wav.mean(1)
if sr != 24000: wav = librosa.resample(wav.astype('float32'), orig_sr=sr, target_sr=24000)
wav = wav[:24000*5]  # 5s cap (matches bridge REF_SECONDS)
fe = MelSpectrogramFeatures(sample_rate=24000, n_fft=1024, hop_length=256, n_mels=100, padding='center')
mel = fe(torch.from_numpy(np.asarray(wav, dtype='float32'))[None])  # [1,100,T] log-mel
mel = mel[0].T.contiguous().numpy().astype('float32')  # [T,100]
feat = (mel * 0.1).astype('float32')  # FEAT_SCALE
feat.tofile('voices/cleetus.luxmel.f32')
print('wrote voices/cleetus.luxmel.f32 frames=%d dim=%d  melmean=%.3f melstd=%.3f' % (feat.shape[0], feat.shape[1], mel.mean(), mel.std()))
