#!/usr/bin/env bash
# Provision a test USDC Stellar Asset Contract (SAC) on testnet:
#   - issuer identity, a recipient identity (for unshield payouts)
#   - trustlines from the user (shield) and recipient to USDC:issuer
#   - issuer funds the user with USDC
#   - deploy the SAC and print its contract id
# Writes circuits/build/usdc.env with addresses for the lifecycle script.
set -euo pipefail
cd "$(dirname "$0")/.."
NET=testnet
B=circuits/build
mkdir -p "$B"

ensure_key() { stellar keys address "$1" >/dev/null 2>&1 || stellar keys generate "$1" --network "$NET" --fund; }
echo "== identities =="
ensure_key usdc-issuer
ensure_key recipient
# ensure funded (idempotent friendbot top-ups are fine)
stellar keys fund usdc-issuer --network "$NET" 2>/dev/null || true
stellar keys fund recipient   --network "$NET" 2>/dev/null || true
stellar keys fund shield      --network "$NET" 2>/dev/null || true

ISSUER=$(stellar keys address usdc-issuer)
USER=$(stellar keys address shield)
RECIP=$(stellar keys address recipient)
ASSET="USDC:$ISSUER"
echo "issuer=$ISSUER"; echo "user=$USER"; echo "recipient=$RECIP"

echo "== trustlines (user + recipient) =="
stellar tx new change-trust --source shield    --line "$ASSET" --network "$NET" 2>&1 | tail -1
stellar tx new change-trust --source recipient --line "$ASSET" --network "$NET" 2>&1 | tail -1

echo "== issuer funds user with 1,000,000 USDC =="
stellar tx new payment --source usdc-issuer --destination "$USER" \
  --asset "$ASSET" --amount 10000000000000 --network "$NET" 2>&1 | tail -1

echo "== deploy SAC for $ASSET =="
SAC=$(stellar contract asset deploy --asset "$ASSET" --source usdc-issuer --network "$NET" 2>/dev/null | tail -1)
echo "SAC=$SAC"

cat > "$B/usdc.env" <<EOF
USDC_SAC=$SAC
USDC_ISSUER=$ISSUER
USER_ADDR=$USER
RECIP_ADDR=$RECIP
EOF
echo "wrote $B/usdc.env"
