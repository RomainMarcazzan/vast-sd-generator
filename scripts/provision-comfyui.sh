#!/bin/bash
set -eo pipefail

SDXL_URL="https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors"
DEST="/workspace/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors"

if [ -f "$DEST" ]; then
  echo "[provision] SDXL model already present, skipping download"
  exit 0
fi

echo "[provision] Downloading SDXL base model..."
mkdir -p "$(dirname "$DEST")"
wget -q --show-progress -O "$DEST" "$SDXL_URL"
echo "[provision] Done"
