#!/bin/bash
# Run the vibe refresh (refresh_vibes.sh) on the 1st of every month at 04:00,
# as a launchd agent for this user. A Mac that is asleep then runs it on wake;
# one that is off skips that month (re-run by hand: npm run library:vibes).
#
#   npm run library:vibes:schedule                 # install / update
#   npm run library:vibes:schedule -- --uninstall  # remove
#   launchctl kickstart gui/$(id -u)/com.everplay.vibes   # run it now
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.everplay.vibes"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

# launchd starts jobs with a bare PATH: hand it the one that finds this
# Mac's node, python3 and ffmpeg
TOOLS=""
for t in node python3 ffmpeg aws; do
  d=$(dirname "$(command -v "$t" 2>/dev/null || echo /usr/bin/true)")
  case ":$TOOLS:" in *":$d:"*) ;; *) TOOLS="$TOOLS:$d" ;; esac
done
PATH_FOR_JOB="/opt/homebrew/bin${TOOLS}:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/library/logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/library/refresh_vibes.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH_FOR_JOB</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Day</key><integer>1</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$REPO/library/logs/vibes-launchd.log</string>
  <key>StandardErrorPath</key><string>$REPO/library/logs/vibes-launchd.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "scheduled $LABEL: 1st of every month, 04:00 (plist: $PLIST)"
echo "log: $REPO/library/logs/vibes-<month>.log"

# macOS keeps background jobs out of ~/Documents unless allowed: prove now,
# with a one-off job of the same shape, that the monthly one will get in
CHECK="$LABEL.check"
CHECK_LOG="$REPO/library/logs/vibes-check.log"
CHECK_PLIST="$(mktemp -d)/$CHECK.plist"
rm -f "$CHECK_LOG"
sed -e "s|<string>$LABEL</string>|<string>$CHECK</string>|" \
    -e "s|refresh_vibes.sh</string>|refresh_vibes.sh</string><string>--check</string>|" \
    -e "s|vibes-launchd.log|vibes-check.log|g" \
    -e "s|<key>StartCalendarInterval</key>|<key>RunAtLoad</key><true/><key>Unused</key>|" "$PLIST" > "$CHECK_PLIST"
launchctl bootstrap "$DOMAIN" "$CHECK_PLIST"
sleep 4
launchctl bootout "$DOMAIN/$CHECK" 2>/dev/null || true
rm -f "$CHECK_PLIST"
if grep -q "readable" "$CHECK_LOG" 2>/dev/null; then
  echo "check passed: a background job can read the repo"
else
  echo "CHECK FAILED - the scheduled job could not run here:"
  sed 's/^/  /' "$CHECK_LOG" 2>/dev/null || echo "  (no output)"
  echo "If it says 'Operation not permitted': System Settings > Privacy & Security >"
  echo "Full Disk Access > add /bin/bash, or move the repo out of ~/Documents."
  exit 1
fi
