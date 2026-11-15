#!/usr/bin/env bash
# Generate a short fake meeting recording with macOS text-to-speech.
# Usage: scripts/make-sample.sh [out.wav]
set -euo pipefail
OUT="${1:-samples/standup.wav}"
mkdir -p "$(dirname "$OUT")"
say -v Samantha -r 175 -o "$OUT" --data-format=LEI16@16000 \
"Okay, thanks everyone for joining the Monday standup. \
The client demo went well last week and they liked the new dashboard. \
Sarah, can you send the revised proposal to the client by Friday? \
Sure. I'll also update the budget sheet before the review. \
We need to finalize the hiring plan before next Monday. \
Mike will set up the staging environment tomorrow. \
Let's make sure the contract is signed by end of week. \
That's everything, thanks all."
echo "$OUT"
