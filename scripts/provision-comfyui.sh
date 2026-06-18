#!/bin/bash
set -eo pipefail

MODELS_DIR="/workspace/ComfyUI/models"

DM_URL="https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors"
TE_URL="https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"
VAE_URL="https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors"

DM_DEST="${MODELS_DIR}/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors"
TE_DEST="${MODELS_DIR}/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"
VAE_DEST="${MODELS_DIR}/vae/qwen_image_vae.safetensors"

mkdir -p "${MODELS_DIR}/diffusion_models" "${MODELS_DIR}/text_encoders" "${MODELS_DIR}/vae"

if [ ! -f "$DM_DEST" ]; then
  echo "[provision] Downloading Qwen Image 2512 diffusion model (fp8, ~20GB)..."
  wget -q --show-progress -O "$DM_DEST" "$DM_URL"
fi

if [ ! -f "$TE_DEST" ]; then
  echo "[provision] Downloading Qwen 2.5 VL 7B text encoder (fp8, ~9GB)..."
  wget -q --show-progress -O "$TE_DEST" "$TE_URL"
fi

if [ ! -f "$VAE_DEST" ]; then
  echo "[provision] Downloading Qwen Image VAE..."
  wget -q --show-progress -O "$VAE_DEST" "$VAE_URL"
fi

echo "[provision] Done — Qwen Image 2512 ready"
