#!/usr/bin/env bash
# Phase 0 gate (a): deploy the BN254 Groth16 verifier to testnet, store the VK,
# and verify the multiplier proof on-chain. Expects circuits/build/*.hex present.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=contracts/groth16-verifier
WASM=$SRC/target/wasm32v1-none/release/groth16_verifier.wasm
IDENT=shield
NET=testnet
B=circuits/build

echo "== build =="
(cd "$SRC" && stellar contract build >/dev/null)

echo "== deploy =="
CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENT" --network "$NET" 2>/dev/null | tail -1)
echo "contract id: $CID"
echo "$CID" > "$B/contract_id.txt"

echo "== set_vk =="
stellar contract invoke --id "$CID" --source "$IDENT" --network "$NET" -- \
  set_vk --vk_bytes "$(cat $B/vk.hex)" >/dev/null
echo "VK stored."

echo "== verify (expect: true) =="
RESULT=$(stellar contract invoke --id "$CID" --source "$IDENT" --network "$NET" -- \
  verify --proof_bytes "$(cat $B/proof.hex)" --public_bytes "$(cat $B/public.hex)")
echo "on-chain verify result: $RESULT"

if [ "$RESULT" = "true" ]; then
  echo "✅ PHASE 0 GATE (a) PASSED: BN254 Groth16 proof verified on Stellar testnet."
else
  echo "❌ verify returned '$RESULT' (expected true)"; exit 1
fi
