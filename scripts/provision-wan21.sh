#!/bin/bash
set -eo pipefail

MODELS_DIR="/workspace/ComfyUI/models"
CUSTOM_NODES_DIR="/workspace/ComfyUI/custom_nodes"

UNET_URL="https://huggingface.co/kijai/WanVideo_comfy/resolve/main/Wan2.1_T2V_14B_fp8_e4m3fn.safetensors"
UNET_DEST="${MODELS_DIR}/diffusion_models/wan2.1_t2v_14B_fp8_e4m3fn.safetensors"

CLIP_URL="https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
CLIP_DEST="${MODELS_DIR}/clip/umt5_xxl_fp8_e4m3fn_scaled.safetensors"

VAE_URL="https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors"
VAE_DEST="${MODELS_DIR}/vae/wan_2.1_vae.safetensors"

VHS_DIR="${CUSTOM_NODES_DIR}/ComfyUI-VideoHelperSuite"

# --- Download models ---

mkdir -p "${MODELS_DIR}/diffusion_models" "${MODELS_DIR}/clip" "${MODELS_DIR}/vae"

if [ ! -f "$UNET_DEST" ]; then
  echo "[provision] Downloading Wan 2.1 T2V 14B diffusion model (~14GB)..."
  wget -q --show-progress -O "$UNET_DEST" "$UNET_URL"
else
  echo "[provision] Wan 2.1 diffusion model already present, skipping"
fi

if [ ! -f "$CLIP_DEST" ]; then
  echo "[provision] Downloading UMT5-XXL text encoder (~10GB)..."
  wget -q --show-progress -O "$CLIP_DEST" "$CLIP_URL"
else
  echo "[provision] UMT5-XXL already present, skipping"
fi

if [ ! -f "$VAE_DEST" ]; then
  echo "[provision] Downloading Wan 2.1 VAE (~1GB)..."
  wget -q --show-progress -O "$VAE_DEST" "$VAE_URL"
else
  echo "[provision] Wan 2.1 VAE already present, skipping"
fi

# --- Install ComfyUI-VideoHelperSuite ---

if [ ! -d "$VHS_DIR" ]; then
  echo "[provision] Installing ComfyUI-VideoHelperSuite..."
  git clone --depth=1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git "$VHS_DIR"
  cd "$VHS_DIR"
  pip install -q -r requirements.txt
  echo "[provision] ComfyUI-VideoHelperSuite installed"
else
  echo "[provision] ComfyUI-VideoHelperSuite already installed, skipping"
fi

echo "[provision] Done — Wan 2.1 ready"
