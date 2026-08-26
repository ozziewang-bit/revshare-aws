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
# Sync ALL shared top-level files EXCEPT db.mjs (region-specific table/bucket names),
# so new modules (e.g. auth.mjs, users-db.mjs) are never missed.
for f in "$TH_CODE"/*.mjs "$TH_CODE"/*.json; do
  base="$(basename "$f")"
  [ "$base" = "db.mjs" ] && continue
  cp "$f" "$SG_CODE/$base"
done
cp "$TH_CODE"/routes/*.mjs "$SG_CODE"/routes/

# Show what (if anything) the sync changed in the SG repo.
if git -C "$SG_ROOT" diff --quiet -- lambda/revshare-api/code; then
  echo "  SG backend already in parity (no code changes)."
else
  echo "  SG backend updated — review & commit in $SG_ROOT:"
  git -C "$SG_ROOT" status --short -- lambda/revshare-api/code | sed 's/^/    /'
fi

# PREFLIGHT: every name the synced code imports from db.mjs must exist in BOTH regions'
# db.mjs. db.mjs is never synced, so adding a db function to TH alone means the synced module
# fails to LOAD in SG — a static ESM binding does not degrade — and every SG route 500s.
# This has taken Singapore down three times; the check costs milliseconds.
echo "→ Checking db.mjs exports in both regions…"
node "$ROOT/infra/check-db-exports.mjs" "$TH_CODE" "$SG_CODE" || exit 1

echo "→ Deploying Thailand (revshare-api)…"
"$ROOT/infra/deploy-lambda.sh"

echo "→ Deploying Singapore (revshare-api-sg)…"
"$SG_ROOT/infra/deploy-lambda.sh"

# Health-check both immediately. A module that fails to load still deploys "successfully" —
# the failure only shows on the first request.
echo "→ Verifying…"
th_health=$(curl -sS --max-time 20 https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod/healthz || echo FAILED)
sg_health=$(curl -sS --max-time 20 https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod/healthz || echo FAILED)
echo "  TH /healthz: $th_health"
echo "  SG /healthz: $sg_health"
if [ "$th_health" != '{"ok":true}' ] || [ "$sg_health" != '{"ok":true}' ]; then
  echo "✗ A region is NOT healthy after deploy — check CloudWatch logs immediately." >&2
  exit 1
fi

echo "✓ Both backends deployed — TH: revshare-api · SG: revshare-api-sg"
echo "  (If SG code changed above, commit it in $SG_ROOT.)"
