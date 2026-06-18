#!/usr/bin/env bash
# Phase 1: compile transfer.circom and run a full Groth16 trusted setup over BN254.
# Produces transfer_final.zkey + verification_key.json used by the CLI/contract.
set -euo pipefail
cd "$(dirname "$0")/.."
B=circuits/build
mkdir -p "$B"
POWER=15

echo "== compile transfer.circom (BN254) =="
circom circuits/transfer.circom --r1cs --wasm --sym -o "$B" -l node_modules/circomlib/circuits

echo "== powers of tau (bn128, 2^$POWER) =="
if [ ! -f "$B/pot_final.ptau" ]; then
  snarkjs powersoftau new bn128 "$POWER" "$B/pot_0000.ptau" -v
  snarkjs powersoftau contribute "$B/pot_0000.ptau" "$B/pot_0001.ptau" \
    --name="transfer phase1" -v -e="shielded-usdc transfer entropy 1"
  snarkjs powersoftau prepare phase2 "$B/pot_0001.ptau" "$B/pot_final.ptau" -v
fi

echo "== groth16 setup + phase2 contribution =="
snarkjs groth16 setup "$B/transfer.r1cs" "$B/pot_final.ptau" "$B/transfer_0000.zkey"
snarkjs zkey contribute "$B/transfer_0000.zkey" "$B/transfer_final.zkey" \
  --name="transfer phase2" -v -e="shielded-usdc transfer entropy 2"
snarkjs zkey export verificationkey "$B/transfer_final.zkey" "$B/transfer_vk.json"

echo "== DONE: $B/transfer_final.zkey + $B/transfer_vk.json =="
