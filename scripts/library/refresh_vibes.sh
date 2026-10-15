#!/bin/bash
# The monthly vibe refresh: re-read the public playlists behind every vibe
# chip (lib/vibes.json), download the songs they rank highly that the library
# lacks, and rebuild the index the pickers read (library/vibes.json). Songs
# are kept once downloaded; only the index follows the playlists.
#
#   npm run library:vibes                     # the whole routine
#   VIBES_MAX=2000 npm run library:vibes      # cap this run's downloads (default 4000)
#   VIBES_PUSH=0 npm run library:vibes        # skip the upload to S3
#
# Scheduled monthly by the Claude app task "everplay-monthly-vibe-refresh"
# (1st of the month, 04:00). `npm run library:vibes:schedule` installs a
# launchd job instead, but macOS keeps background jobs out of ~/Documents
# unless /bin/bash gets Full Disk Access - its install check says so.
#
# Resumable: every step skips what it already did, so re-running after an
# interruption (or a YouTube refusal) picks up where it stopped.
# Log: library/logs/vibes-<YYYY-MM>.log
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
LIB="${LIBRARY_DIR:-library}"
MONTH=$(date -u +%Y-%m)
mkdir -p "$LIB/logs"
LOG="$LIB/logs/vibes-$MONTH.log"
exec > >(tee -a "$LOG") 2>&1

say() { echo "[$(date '+%F %T')] $*"; }
notify() {
  # a scheduled run has no terminal: say how it went where the user will see it
  command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"Everplay vibes\"" >/dev/null 2>&1
  say "$1"
}

if [ "${1:-}" = "--check" ]; then
  # what the scheduler runs once at install: can a background job reach the repo?
  say "check: $(pwd) readable, $(ls "$LIB/meta" 2>/dev/null | wc -l | tr -d ' ') library entries"
  exit 0
fi

if ! mkdir "$LIB/.vibes.lock" 2>/dev/null; then
  say "another refresh is running ($LIB/.vibes.lock) - exiting"
  exit 0
fi
trap 'rmdir "$LIB/.vibes.lock" 2>/dev/null' EXIT
# a multi-hour download stalls every time the Mac idles to sleep
command -v caffeinate >/dev/null && caffeinate -i -w $$ &

say "vibe refresh $MONTH"
if ! python3 scripts/library/harvest_vibes.py harvest --month "$MONTH"; then
  # last month's index stays in place - the vibes keep working, just older
  notify "Playlist search failed this month - kept last month's vibes. See $LOG"
  exit 1
fi
python3 scripts/library/harvest_vibes.py wanted --month "$MONTH" --max "${VIBES_MAX:-4000}" || exit 1
WANTED="$LIB/sources/vibes/$MONTH/wanted.txt"

free_gb=$(df -g "$LIB" | awk 'NR==2 {print $4}')
if [ "${free_gb:-0}" -lt 15 ]; then
  notify "Only ${free_gb} GB free - skipped downloading new vibe songs"
else
  before=$(ls "$LIB/meta" | wc -l)
  # same throttle as the other YouTube fetches: more than ~2 at once gets 403s
  python3 scripts/library/fetch_youtube.py --queries "$WANTED" --workers 2
  node --experimental-strip-types --no-warnings scripts/library/ingest.mjs --jobs 4
  added=$(( $(ls "$LIB/meta" | wc -l) - before ))
  say "added $added songs"
fi

python3 scripts/library/harvest_vibes.py index --month "$MONTH" || exit 1

pushed=""
if [ "${VIBES_PUSH:-1}" != "0" ] && grep -q "^S3_BUCKET=" .env.local 2>/dev/null; then
  # prod reads the whole library (incl. yt-*) through signed CloudFront links
  if bash scripts/library/sync_s3.sh --all; then
    pushed=", uploaded"
  else
    pushed=", NOT uploaded (run: aws login, then npm run library:push -- --all)"
  fi
fi
notify "Vibes refreshed for $MONTH: ${added:-0} new songs$pushed"
