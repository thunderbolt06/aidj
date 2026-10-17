#!/bin/bash
# Widen the FMA selection to untagged-language tracks and ingest as they land.
#   FMA_LIMIT=20500 bash scripts/library/grow_fma.sh     # resumable
#   tail -f library/logs/fma-grow.log
# Every track ends up as ~6 MB of AAC, so 20k of them is well over 100 GB: the
# download stops (resumable) once less than FMA_MIN_FREE_GB (default 30) is free.
cd "$(dirname "$0")/../.." || exit 1
LIB="${LIBRARY_DIR:-library}"
mkdir -p "$LIB/logs"
free_gb() { df -g "$LIB" | awk 'NR==2 {print $4}'; }
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
  if [ "$(free_gb)" -lt "${FMA_MIN_FREE_GB:-30}" ]; then
    echo "fma grow stopped: only $(free_gb) GB free $(date)" | tee -a "$LIB/logs/ingest.log"
    kill $FMA 2>/dev/null
    break
  fi
done
ingest
echo "fma grow finished $(date)" >> "$LIB/logs/ingest.log"
