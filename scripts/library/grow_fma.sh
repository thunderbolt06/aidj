#!/bin/bash
# Widen the FMA selection to untagged-language tracks and ingest as they land.
#   FMA_LIMIT=20500 bash scripts/library/grow_fma.sh     # resumable
#   tail -f library/logs/fma-grow.log
cd "$(dirname "$0")/../.." || exit 1
LIB="${LIBRARY_DIR:-library}"
mkdir -p "$LIB/logs"
ingest() {
  # library:build may be running its own ingest loop - never overlap with it
  while pgrep -f "scripts/library/ingest.mjs" >/dev/null; do sleep 15; done
  node --experimental-strip-types --no-warnings scripts/library/ingest.mjs --jobs 4 >> "$LIB/logs/ingest.log" 2>&1
}
command -v caffeinate >/dev/null && caffeinate -i -w $$ &

python3 scripts/library/fetch_fma.py --untagged --limit "${FMA_LIMIT:-20500}" --workers 32 > "$LIB/logs/fma-grow.log" 2>&1 &
FMA=$!
trap 'kill $FMA 2>/dev/null' EXIT
while kill -0 $FMA 2>/dev/null; do
  sleep 600
  ingest
done
ingest
echo "fma grow finished $(date)" >> "$LIB/logs/ingest.log"
