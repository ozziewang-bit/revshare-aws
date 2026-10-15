#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Refuse to ship a name that is not defined anywhere (eslint.config.js, one rule) — 2026-10-14.
( cd "$ROOT" && npx --no-install eslint 'lambda/revshare-api/code/**/*.mjs' ) || { echo "deploy stopped: undefined name (see above)"; exit 1; }
cd "$ROOT/lambda/revshare-api/code"
rm -f ../../../_deploy.zip
zip -r ../../../_deploy.zip . -x 'node_modules/.cache/*' >/dev/null
aws lambda update-function-code \
  --function-name revshare-api \
  --zip-file "fileb://$ROOT/_deploy.zip" \
  --region ap-southeast-7 \
  --output text >/dev/null
rm -f "$ROOT/_deploy.zip"
echo "deployed revshare-api"
