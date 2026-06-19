#!/usr/bin/env bash
set -euo pipefail

INSTANCE_ID="${1:-}"
BEATS_FILE="${2:-}"
BASE_URL="${BASE_URL:-http://localhost:4000}"

if [ -z "$INSTANCE_ID" ] || [ -z "$BEATS_FILE" ]; then
  echo "Usage: BASE_URL=http://localhost:4000 $0 <instance_id> <beats.json>"
  echo ""
  echo "JSON format:"
  echo '[
  {
    "beatId": "1.5",
    "type": "ai-image | reenactment | archive | aerial",
    "prompt": "...",
    "negativePrompt": "...",
    "width": 1344,
    "height": 768,
    "steps": 30,
    "cfgScale": 3.5,
    "sampler": "euler",
    "scheduler": "simple"
  }
]'
  exit 1
fi

if [ ! -f "$BEATS_FILE" ]; then
  echo "File not found: $BEATS_FILE"
  exit 1
fi

count=$(jq length "$BEATS_FILE")
echo "Sending $count beats to instance $INSTANCE_ID..."

for i in $(seq 0 $((count - 1))); do
  beat=$(jq ".[$i]" "$BEATS_FILE")
  beat_id=$(echo "$beat" | jq -r '.beatId')

  # Build payload with defaults
  payload=$(echo "$beat" | jq --arg iid "$INSTANCE_ID" '{
    prompt: .prompt,
    negativePrompt: (.negativePrompt // "cartoon, illustration, painting, 3d render, cgi, drawing, anime, oversaturated, artificial lighting, shallow depth of field, bokeh, blurry, low resolution, distorted faces, smooth plastic look, hdr, unrealistic shadows"),
    width: (.width // 1344),
    height: (.height // 768),
    steps: (.steps // 30),
    cfgScale: (.cfgScale // 3.5),
    sampler: (.sampler // "euler"),
    scheduler: (.scheduler // "simple"),
    beatId: .beatId,
    instanceId: $iid
  }')

  job_id=$(curl -s -X POST "$BASE_URL/api/v1/generate" \
    -H "Content-Type: application/json" \
    -d "$payload" | jq -r '.jobId')

  echo "  Beat $beat_id → $job_id"
done

echo "Done! Monitoring server logs for progress."
