#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/lambda/revshare-api/code"
rm -f ../../../_deploy.zip
zip -r ../../../_deploy.zip . -x 'node_modules/.cache/*' >/dev/null
aws lambda update-function-code \
  --function-name revshare-api \
  --zip-file "fileb://$ROOT/_deploy.zip" \
  --region ap-northeast-1 \
  --output text >/dev/null
rm -f "$ROOT/_deploy.zip"
echo "deployed revshare-api"
