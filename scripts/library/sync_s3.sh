#!/bin/bash
# Push the PUBLIC part of the library to S3 (everything except yt-* files,
# which are all-rights-reserved and stay local), then point the app at it.
#
#   aws login                                  # once - signs the CLI in via your browser
#   npm run library:push [-- --dryrun]         # resumable; re-run to add new tracks
#   npm run library:push -- --all --only covers   # just the cover images (after fetch_covers.py)
#
# Bucket and region come from S3_BUCKET / S3_REGION (env or .env.local).
# Afterwards set LIBRARY_URL on Vercel to the URL this prints.
set -euo pipefail
cd "$(dirname "$0")/../.."
LIB="${LIBRARY_DIR:-library}"
fromenv() { grep -E "^$1=" .env.local 2>/dev/null | tail -1 | cut -d= -f2- || true; }
S3_BUCKET="${S3_BUCKET:-$(fromenv S3_BUCKET)}"
S3_REGION="${S3_REGION:-$(fromenv S3_REGION)}"
: "${S3_BUCKET:?set S3_BUCKET (env or .env.local)}"
: "${S3_REGION:?set S3_REGION (env or .env.local)}"
# `aws login` needs CLI >= 2.32; the Homebrew one is current, an old pkg install may shadow it
AWS="${AWS_CLI:-$([ -x /opt/homebrew/bin/aws ] && echo /opt/homebrew/bin/aws || echo aws)}"
DEST="s3://$S3_BUCKET"

# --all also uploads the all-rights-reserved yt-* tracks and the full catalog.
# Only allowed when the CloudFront distribution serves signed links exclusively
# (and the app sits behind its login) - otherwise those files would be public.
ALL=0
ONLY=""
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1 ;;
    --only) ONLY="${2:?--only needs a folder list, e.g. covers or audio,meta}"; shift ;;
    --only=*) ONLY="${1#--only=}"; : "${ONLY:?--only needs a folder list, e.g. covers or audio,meta}" ;;
    *) EXTRA+=("$1") ;;
  esac
  shift
done
SYNC_DIRS=(audio meta covers)
if [ -n "$ONLY" ]; then
  IFS=, read -r -a SYNC_DIRS <<< "$ONLY"
  for d in "${SYNC_DIRS[@]}"; do
    case "$d" in audio|meta|covers) ;; *) echo "--only takes audio, meta and/or covers (got '$d')"; exit 1 ;; esac
  done
fi
EXCLUDE=(--exclude "yt-*")
CATALOG="catalog.public.json"
VIBES="vibes.public.json"
if [ "$ALL" = 1 ]; then
  DIST="${CLOUDFRONT_DISTRIBUTION_ID:-$(fromenv CLOUDFRONT_DISTRIBUTION_ID)}"
  : "${DIST:?--all needs CLOUDFRONT_DISTRIBUTION_ID (env or .env.local)}"
  # CloudFront is global, but the CLI still wants a region to sign the call
  locked=$("$AWS" cloudfront get-distribution-config --id "$DIST" --region us-east-1 \
    --query "DistributionConfig.DefaultCacheBehavior.TrustedKeyGroups.Enabled" --output text)
  [ "$locked" = "True" ] || { echo "refusing --all: distribution $DIST does not require signed links"; exit 1; }
  public=$("$AWS" s3api get-public-access-block --bucket "$S3_BUCKET" --region "$S3_REGION" \
    --query "PublicAccessBlockConfiguration.RestrictPublicBuckets" --output text)
  [ "$public" = "True" ] || { echo "refusing --all: bucket $S3_BUCKET allows public access"; exit 1; }
  EXCLUDE=()
  CATALOG="catalog.json"
  VIBES="vibes.json"
fi

"$AWS" sts get-caller-identity >/dev/null 2>&1 || { echo "Not signed in to AWS. Run:  $AWS login --region $S3_REGION"; exit 1; }

if [ -z "$ONLY" ]; then
  node --experimental-strip-types --no-warnings scripts/library/ingest.mjs --index-only
  # browsers fetch the audio cross-origin (Web Audio decode), so GET needs CORS
  "$AWS" s3api put-bucket-cors --bucket "$S3_BUCKET" --region "$S3_REGION" --cors-configuration \
    '{"CORSRules":[{"AllowedMethods":["GET","HEAD"],"AllowedOrigins":["*"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]}'
fi
# audio and meta never change once written; a cover can be replaced (a video thumbnail
# upgraded to album art), so it gets a day instead of "forever"
STARTED=$(mktemp)
trap 'rm -f "$STARTED"' EXIT
for d in "${SYNC_DIRS[@]}"; do
  CACHE="public, max-age=31536000, immutable"
  [ "$d" = covers ] && CACHE="public, max-age=86400"
  # *.tmp: a half-written file left by an interrupted fetcher
  "$AWS" s3 sync "$LIB/$d" "$DEST/$d" --region "$S3_REGION" ${EXCLUDE[@]+"${EXCLUDE[@]}"} --exclude "*.tmp" \
    --cache-control "$CACHE" --only-show-errors ${EXTRA[@]+"${EXTRA[@]}"}
  echo "synced $d"
done

if [ -z "$ONLY" ]; then
  # the hosted catalog is the public one, under the name the app reads
  "$AWS" s3 cp "$LIB/$CATALOG" "$DEST/catalog.json" --region "$S3_REGION" \
    --content-type application/json --cache-control "public, max-age=300" ${EXTRA[@]+"${EXTRA[@]}"}
  # the vibe playlists index (harvest_vibes.py index), when one has been built
  if [ -f "$LIB/$VIBES" ]; then
    "$AWS" s3 cp "$LIB/$VIBES" "$DEST/vibes.json" --region "$S3_REGION" \
      --content-type application/json --cache-control "public, max-age=300" ${EXTRA[@]+"${EXTRA[@]}"}
  fi
fi
# CloudFront keeps what it fetched for a day (and the first covers it ever served for a year):
# when any cover changed since the last push to THIS bucket/distribution/scope, drop the cached
# ones. Last and non-fatal: a role that may not invalidate must not stop the catalog going up.
case " ${SYNC_DIRS[*]} " in
  *" covers "*)
    DIST="${CLOUDFRONT_DISTRIBUTION_ID:-$(fromenv CLOUDFRONT_DISTRIBUTION_ID)}"
    MARK="$LIB/.covers-pushed.${S3_BUCKET}.${DIST:-none}.${ALL}"
    DRY=0; [[ " ${EXTRA[*]-} " == *" --dryrun "* ]] && DRY=1
    if [ -z "$DIST" ]; then
      echo "note: no CLOUDFRONT_DISTRIBUTION_ID - cached covers are not invalidated"
    elif [ ! -e "$MARK" ] || [ -n "$(find "$LIB/covers" -type f -newer "$MARK" -print -quit)" ]; then
      if [ "$DRY" = 1 ]; then
        echo "dry run: would invalidate /covers/* on $DIST"
      elif "$AWS" cloudfront create-invalidation --distribution-id "$DIST" --paths "/covers/*" \
          --region us-east-1 --query "Invalidation.Status" --output text | sed 's/^/invalidating \/covers\/*: /'; then
        mv "$STARTED" "$MARK"
      else
        echo "warning: could not invalidate /covers/* (needs cloudfront:CreateInvalidation) - old covers may be served from cache for up to a day"
      fi
    else
      mv "$STARTED" "$MARK"
    fi
    ;;
esac
echo "done. LIBRARY_URL=https://$S3_BUCKET.s3.$S3_REGION.amazonaws.com"
