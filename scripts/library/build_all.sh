#!/bin/bash
# Grow the whole library unattended: both downloads in parallel, with an
# ingest pass every 10 minutes so new tracks show up in the app as they land.
# Safe to stop (Ctrl-C / kill) and re-run - every step resumes.
#
#   npm run library:build                 # everything
#   FMA_LIMIT=3000 YT_YEARS=2000-2024 npm run library:build
#   tail -f library/logs/*.log            # watch it
cd "$(dirname "$0")/../.." || exit 1
LIB="${LIBRARY_DIR:-library}"
mkdir -p "$LIB/logs"
INGEST=(node --experimental-strip-types --no-warnings scripts/library/ingest.mjs --jobs 4)

# a multi-hour download stalls every time the Mac idles to sleep
command -v caffeinate >/dev/null && caffeinate -i -w $$ &

python3 scripts/library/fetch_fma.py --limit "${FMA_LIMIT:-11000}" --workers 32 > "$LIB/logs/fma.log" 2>&1 &
FMA=$!
python3 scripts/library/fetch_youtube.py --years "${YT_YEARS:-1960-2024}" --workers 2 > "$LIB/logs/youtube.log" 2>&1 &
YT=$!
trap 'kill $FMA $YT 2>/dev/null' EXIT

while kill -0 $FMA 2>/dev/null || kill -0 $YT 2>/dev/null; do
  sleep 600
  "${INGEST[@]}" >> "$LIB/logs/ingest.log" 2>&1
done
"${INGEST[@]}" >> "$LIB/logs/ingest.log" 2>&1
echo "library build finished $(date)" >> "$LIB/logs/ingest.log"
