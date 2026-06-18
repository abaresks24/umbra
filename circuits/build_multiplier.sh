#!/usr/bin/env bash
# Phase 0: compile the trivial multiplier circuit, run a full Groth16 trusted
# setup over BN254 (circom default = bn128), and produce a proof we can verify
# both locally (snarkjs) and on-chain (Soroban BN254 host functions).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
BUILD=build

echo "== compile (BN254 / bn128 default) =="
circom multiplier.circom --r1cs --wasm --sym -o "$BUILD"

echo "== powers of tau (bn128, small) =="
snarkjs powersoftau new bn128 12 "$BUILD/pot12_0000.ptau" -v
snarkjs powersoftau contribute "$BUILD/pot12_0000.ptau" "$BUILD/pot12_0001.ptau" \
  --name="phase0 contrib" -v -e="shielded-usdc phase0 entropy"
snarkjs powersoftau prepare phase2 "$BUILD/pot12_0001.ptau" "$BUILD/pot12_final.ptau" -v

echo "== groth16 setup + phase2 contribution =="
snarkjs groth16 setup "$BUILD/multiplier.r1cs" "$BUILD/pot12_final.ptau" "$BUILD/multiplier_0000.zkey"
snarkjs zkey contribute "$BUILD/multiplier_0000.zkey" "$BUILD/multiplier_final.zkey" \
  --name="phase0 zkey" -v -e="more phase0 entropy"
snarkjs zkey export verificationkey "$BUILD/multiplier_final.zkey" "$BUILD/verification_key.json"

echo "== witness + proof (a=3, b=11 -> c=33) =="
echo '{ "a": 3, "b": 11 }' > "$BUILD/input.json"
node "$BUILD/multiplier_js/generate_witness.js" \
  "$BUILD/multiplier_js/multiplier.wasm" "$BUILD/input.json" "$BUILD/witness.wtns"
snarkjs groth16 prove "$BUILD/multiplier_final.zkey" "$BUILD/witness.wtns" \
  "$BUILD/proof.json" "$BUILD/public.json"

echo "== local verify (sanity) =="
snarkjs groth16 verify "$BUILD/verification_key.json" "$BUILD/public.json" "$BUILD/proof.json"

echo "== artifacts =="
echo "public signals:"; cat "$BUILD/public.json"
echo "DONE: proof.json, public.json, verification_key.json in $BUILD/"
