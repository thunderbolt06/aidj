#!/bin/bash
# Push the PUBLIC part of the library to S3 (everything except yt-* files,
# which are all-rights-reserved and stay local), then point the app at it.
#
#   aws login                                  # once - signs the CLI in via your browser
#   npm run library:push [-- --dryrun]         # resumable; re-run to add new tracks
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
EXTRA=()
for a in "$@"; do [ "$a" = "--all" ] && ALL=1 || EXTRA+=("$a"); done
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

node --experimental-strip-types --no-warnings scripts/library/ingest.mjs --index-only
# browsers fetch the audio cross-origin (Web Audio decode), so GET needs CORS
"$AWS" s3api put-bucket-cors --bucket "$S3_BUCKET" --region "$S3_REGION" --cors-configuration \
  '{"CORSRules":[{"AllowedMethods":["GET","HEAD"],"AllowedOrigins":["*"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]}'
for d in audio meta covers; do
  "$AWS" s3 sync "$LIB/$d" "$DEST/$d" --region "$S3_REGION" ${EXCLUDE[@]+"${EXCLUDE[@]}"} \
    --cache-control "public, max-age=31536000, immutable" --only-show-errors ${EXTRA[@]+"${EXTRA[@]}"}
  echo "synced $d"
done
# the hosted catalog is the public one, under the name the app reads
"$AWS" s3 cp "$LIB/$CATALOG" "$DEST/catalog.json" --region "$S3_REGION" \
  --content-type application/json --cache-control "public, max-age=300" ${EXTRA[@]+"${EXTRA[@]}"}
# the vibe playlists index (harvest_vibes.py index), when one has been built
if [ -f "$LIB/$VIBES" ]; then
  "$AWS" s3 cp "$LIB/$VIBES" "$DEST/vibes.json" --region "$S3_REGION" \
    --content-type application/json --cache-control "public, max-age=300" ${EXTRA[@]+"${EXTRA[@]}"}
fi
echo "done. LIBRARY_URL=https://$S3_BUCKET.s3.$S3_REGION.amazonaws.com"
