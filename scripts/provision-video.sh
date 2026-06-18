#!/bin/bash
set -eo pipefail

MODELS_DIR="/workspace/ComfyUI/models"

T2V_HIGH_URL="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors"
T2V_HIGH_DEST="${MODELS_DIR}/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors"

T2V_LOW_URL="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors"
T2V_LOW_DEST="${MODELS_DIR}/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors"

I2V_HIGH_URL="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
I2V_HIGH_DEST="${MODELS_DIR}/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"

I2V_LOW_URL="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
I2V_LOW_DEST="${MODELS_DIR}/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"

CLIP_URL="https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
CLIP_DEST="${MODELS_DIR}/clip/umt5_xxl_fp8_e4m3fn_scaled.safetensors"

VAE_URL="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors"
VAE_DEST="${MODELS_DIR}/vae/wan_2.1_vae.safetensors"

mkdir -p "${MODELS_DIR}/diffusion_models" "${MODELS_DIR}/clip" "${MODELS_DIR}/vae"

download_if_missing() {
  local url="$1"
  local dest="$2"
  local label="$3"
  if [ ! -f "$dest" ]; then
    echo "[provision] Downloading $label..."
    wget -q --show-progress -O "$dest" "$url"
  else
    echo "[provision] $label already present, skipping"
  fi
}

download_if_missing "$T2V_HIGH_URL" "$T2V_HIGH_DEST" "Wan 2.2 T2V high noise (~14GB)"
download_if_missing "$T2V_LOW_URL" "$T2V_LOW_DEST" "Wan 2.2 T2V low noise (~14GB)"
download_if_missing "$I2V_HIGH_URL" "$I2V_HIGH_DEST" "Wan 2.2 I2V high noise (~14GB)"
download_if_missing "$I2V_LOW_URL" "$I2V_LOW_DEST" "Wan 2.2 I2V low noise (~14GB)"
download_if_missing "$CLIP_URL" "$CLIP_DEST" "UMT5-XXL text encoder (~10GB)"
download_if_missing "$VAE_URL" "$VAE_DEST" "Wan 2.1 VAE (~1GB)"

echo "[provision] Done — Wan 2.2 T2V+I2V ready"
