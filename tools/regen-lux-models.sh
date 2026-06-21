#!/usr/bin/env bash
# Regenerate the 3 LuxTTS (ZipVoice-distill) ONNX models into models/tts/lux/.
# They are gitignored (large), so a fresh clone must rebuild them. Needs a python
# venv with torch; this script assumes .venv-lux exists (python -m venv .venv-lux).
#
#   bash tools/regen-lux-models.sh
set -e
PY=.venv-lux/Scripts/python.exe          # Windows venv; use .venv-lux/bin/python on POSIX
[ -f "$PY" ] || PY=.venv-lux/bin/python
DST=models/tts/lux
mkdir -p "$DST/ckpt"

# --- ZipVoice-distill text_encoder + fm_decoder ----------------------------
# The PyPI `zipvoice` wheel is a code-less stub; the real source is on GitHub.
[ -d ../ZipVoice ] || git clone https://github.com/k2-fsa/ZipVoice.git ../ZipVoice
"$PY" -m pip install -q -e ../ZipVoice huggingface_hub
# onnx_export does NOT auto-download — fetch the checkpoint first (HF k2-fsa/ZipVoice, zipvoice_distill/)
"$PY" - <<'PYEOF'
from huggingface_hub import hf_hub_download as d
import shutil, os
dst = 'models/tts/lux/ckpt'
for f in ('model.pt', 'model.json', 'tokens.txt'):
    shutil.copy(d('k2-fsa/ZipVoice', f'zipvoice_distill/{f}'), os.path.join(dst, f))
PYEOF
cp -f "$DST/ckpt/tokens.txt" "$DST/tokens.txt"
"$PY" -m zipvoice.bin.onnx_export --model-name zipvoice_distill \
  --model-dir "$DST/ckpt" --checkpoint-name model.pt --onnx-model-dir "$DST"

# --- LinaCodec 48kHz Vocos vocoder -----------------------------------------
# linacodec is not on PyPI; install from git WITHOUT deps so it cannot replace
# the cpu torch with a CUDA build (its pyproject pins a CUDA-12.6 torch index).
"$PY" -m pip install -q --no-deps vocos huggingface_hub onnxscript
"$PY" -m pip install -q encodec einops pyyaml
"$PY" -m pip install -q --no-deps git+https://github.com/ysharma3501/LinaCodec.git
"$PY" tools/export-vocos.py   # downloads vocoder from HF YatharthS/LuxTTS, writes vocos.onnx

echo "Done. Models in $DST: $(ls "$DST"/*.onnx)"
