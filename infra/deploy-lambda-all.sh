#!/usr/bin/env bash
# Deploy the backend to BOTH regions in one shot.
#
# revshare-aws is the source of truth for backend code. This script copies the
# shared Lambda source into the SG repo (everything EXCEPT db.mjs, which holds
# each region's DynamoDB table + S3 bucket names), then deploys both functions:
#   TH → revshare-api        (DDB RevsharePartner)
#   SG → revshare-api-sg     (DDB RevsharePartnerSG)
#
# NOTE: db.mjs is intentionally NOT synced. If you ever change db.mjs *logic*
# (not just the region defaults), mirror that change into the SG repo by hand,
# or migrate the region defaults to Lambda env vars so db.mjs can be identical.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SG_ROOT="${REVSHARE_SG_ROOT:-/Users/ozziewang/revshare_sg}"
TH_CODE="$ROOT/lambda/revshare-api/code"
SG_CODE="$SG_ROOT/lambda/revshare-api/code"

[ -d "$SG_CODE" ] || { echo "ERROR: SG repo not found at $SG_ROOT (set REVSHARE_SG_ROOT)"; exit 1; }

echo "→ Syncing backend code TH → SG (preserving SG db.mjs)…"
for f in index.mjs engine.mjs csv.mjs package.json; do
  cp "$TH_CODE/$f" "$SG_CODE/$f"
done
cp "$TH_CODE"/routes/*.mjs "$SG_CODE"/routes/

# Show what (if anything) the sync changed in the SG repo.
if git -C "$SG_ROOT" diff --quiet -- lambda/revshare-api/code; then
  echo "  SG backend already in parity (no code changes)."
else
  echo "  SG backend updated — review & commit in $SG_ROOT:"
  git -C "$SG_ROOT" status --short -- lambda/revshare-api/code | sed 's/^/    /'
fi

echo "→ Deploying Thailand (revshare-api)…"
"$ROOT/infra/deploy-lambda.sh"

echo "→ Deploying Singapore (revshare-api-sg)…"
"$SG_ROOT/infra/deploy-lambda.sh"

echo "✓ Both backends deployed — TH: revshare-api · SG: revshare-api-sg"
echo "  (If SG code changed above, commit it in $SG_ROOT.)"
