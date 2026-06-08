#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="revshare-ozziemac-sea7"
DIST_ID="${REVSHARE_CLOUDFRONT_DIST_ID:-E3JLOVJXN5DI24}"

# API URLs live in app.js (REGIONS config) — uploaded as-is, no injection.
aws s3 cp "$ROOT/frontend/index.html"  "s3://$BUCKET/index.html"  --content-type "text/html"            --cache-control "no-cache"
aws s3 cp "$ROOT/frontend/style.css"    "s3://$BUCKET/style.css"    --content-type "text/css"             --cache-control "no-cache"
aws s3 cp "$ROOT/frontend/app.js"      "s3://$BUCKET/app.js"       --content-type "application/javascript" --cache-control "no-cache"
aws s3 cp "$ROOT/frontend/service-worker.js" "s3://$BUCKET/service-worker.js" --content-type "application/javascript" --cache-control "no-cache"
aws s3 cp "$ROOT/frontend/manifest.json" "s3://$BUCKET/manifest.json" --content-type "application/manifest+json" --cache-control "no-cache"
for f in icon-192.png icon-512.png apple-touch-icon.png logo.png; do
  aws s3 cp "$ROOT/frontend/$f" "s3://$BUCKET/$f" --content-type "image/png" --cache-control "public,max-age=86400"
done

aws s3 cp "$ROOT/frontend/lib/" "s3://$BUCKET/lib/" --recursive --content-type "application/javascript" --cache-control "public,max-age=86400"

if [ -n "$DIST_ID" ]; then
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --query 'Invalidation.Status' --output text
fi
echo "deployed → https://d2t76jfby056ul.cloudfront.net"
