#!/bin/bash
# Run vocal_map.py in its own venv (torch + demucs are ~1 GB, so they stay out
# of the fetchers' library/.venv). First run creates it; logs to library/logs.
#
#   npm run library:vocals [-- --limit 50 | --source fma | --ids a,b --force]
#   tail -f library/logs/vocals.log
cd "$(dirname "$0")/../.." || exit 1
LIB="${LIBRARY_DIR:-library}"
VENV="$LIB/.venv-vocals"
mkdir -p "$LIB/logs"
if ! "$VENV/bin/python" -c "import demucs, numpy" 2>/dev/null; then
  python3 -m venv "$VENV" && "$VENV/bin/pip" install -q torch torchaudio demucs numpy || exit 1
fi
# a day-long run stalls every time the Mac idles to sleep
command -v caffeinate >/dev/null && caffeinate -i -w $$ &
"$VENV/bin/python" -W ignore scripts/library/vocal_map.py "$@" 2>&1 | tee -a "$LIB/logs/vocals.log"
