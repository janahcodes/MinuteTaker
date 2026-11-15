#!/usr/bin/env bash
# Upload the same recording N times to pile up transcription jobs, then watch
# the worker HorizontalPodAutoscaler add pods.
# Usage: scripts/loadtest.sh [N] [file] [base-url]
set -euo pipefail
N="${1:-20}"
FILE="${2:-samples/standup.wav}"
URL="${3:-http://localhost:8080}"
[ -f "$FILE" ] || "$(dirname "$0")/make-sample.sh" "$FILE" >/dev/null

echo "Uploading $FILE x $N to $URL"
for i in $(seq 1 "$N"); do
  curl -sf -o /dev/null -w "%{http_code} " -F "title=Load test #$i" -F "file=@$FILE;type=audio/wav" "$URL/api/meetings" &
  (( i % 5 == 0 )) && wait
done
wait
echo
echo "Queue: $(curl -s "$URL/api/stats")"
echo "Watch scaling with:  kubectl -n minutetaker get hpa,pods -w"
