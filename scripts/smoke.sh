#!/usr/bin/env bash
# Manual smoke test against the REAL codex CLI. Needs a running gateway.
# Usage: LZVR_TOKEN=... PROJECT_DIR=/path/inside/WORKSPACE_ROOT bash scripts/smoke.sh
set -euo pipefail
: "${LZVR_TOKEN:?set LZVR_TOKEN}" "${PROJECT_DIR:?set PROJECT_DIR}"
BASE=${BASE:-http://127.0.0.1:9876}
auth=(-H "Authorization: Bearer $LZVR_TOKEN")
json=(-H 'content-type: application/json')
field() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).$1"; }

pid=$(curl -sf "${auth[@]}" "${json[@]}" -d "{\"name\":\"smoke\",\"path\":\"$PROJECT_DIR\"}" "$BASE/api/projects" | field id)
cid=$(curl -sf "${auth[@]}" -X POST "$BASE/api/projects/$pid/conversations" | field id)
curl -sf "${auth[@]}" "${json[@]}" -d '{"prompt":"Reply with exactly: pong"}' "$BASE/api/conversations/$cid/prompts" >/dev/null
echo "streaming events (Ctrl-C after turn.completed)..."
curl -sN --max-time 120 "${auth[@]}" "$BASE/api/conversations/$cid/events"
