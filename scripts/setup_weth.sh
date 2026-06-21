#!/usr/bin/env bash
# Provision a SECOND test asset (WETH) so the pool can be demoed multi-asset.
# Mirrors setup_usdc.sh: trustlines for user + recipient, fund the user, deploy
# the SAC. Appends WETH_SAC to circuits/build/usdc.env.
set -euo pipefail
cd "$(dirname "$0")/.."
NET=testnet
B=circuits/build

ISSUER=$(stellar keys address usdc-issuer)   # reuse the same issuer
USER=$(stellar keys address shield)
RECIP=$(stellar keys address recipient)
ASSET="WETH:$ISSUER"
echo "WETH asset: $ASSET"

echo "== trustlines =="
stellar tx new change-trust --source shield    --line "$ASSET" --network "$NET" 2>&1 | tail -1
stellar tx new change-trust --source recipient --line "$ASSET" --network "$NET" 2>&1 | tail -1

echo "== issuer funds user with WETH =="
stellar tx new payment --source usdc-issuer --destination "$USER" \
  --asset "$ASSET" --amount 10000000000000 --network "$NET" 2>&1 | tail -1

echo "== deploy SAC =="
SAC=$(stellar contract asset deploy --asset "$ASSET" --source usdc-issuer --network "$NET" 2>/dev/null | tail -1)
echo "WETH_SAC=$SAC"

# append to env (drop any prior WETH_SAC line first)
grep -v '^WETH_SAC=' "$B/usdc.env" > "$B/usdc.env.tmp" 2>/dev/null || true
mv "$B/usdc.env.tmp" "$B/usdc.env" 2>/dev/null || true
echo "WETH_SAC=$SAC" >> "$B/usdc.env"
echo "appended WETH_SAC to $B/usdc.env"
