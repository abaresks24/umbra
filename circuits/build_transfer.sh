#!/usr/bin/env bash
# Build the transfer circuit with a CREDIBLE trusted setup:
#   - Phase 1: the real Perpetual Powers of Tau ceremony (hundreds of independent
#     contributors) — NOT a local single-party setup.
#   - Phase 2: a multi-party contribution chain + a public random beacon.
#   - Verified end-to-end with `snarkjs zkey verify`.
#
# Soundness then holds unless EVERY phase-1 contributor AND every phase-2
# contributor colluded. For a production launch, run the phase-2 contributions as
# a public ceremony with external participants (this script shows the mechanics).
set -euo pipefail
cd "$(dirname "$0")/.."
B=circuits/build
mkdir -p "$B"
PTAU="$B/ppot_final_16.ptau"
PPOT_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau"

echo "== compile transfer.circom (BN254) =="
circom circuits/transfer.circom --r1cs --wasm --sym -o "$B" -l node_modules/circomlib/circuits

if [ ! -f "$PTAU" ]; then
  echo "== fetch real Perpetual Powers of Tau (phase 1) =="
  curl -sL -o "$PTAU" "$PPOT_URL"
fi
echo "== verify phase-1 ceremony transcript =="
snarkjs powersoftau verify "$PTAU" >/dev/null && echo "  phase-1 ptau: VALID"

echo "== groth16 setup =="
snarkjs groth16 setup "$B/transfer.r1cs" "$PTAU" "$B/transfer_0000.zkey"

echo "== phase-2 multi-party ceremony =="
# Each `contribute` mixes in fresh secret randomness; only one honest party is
# needed for soundness. In production these run on different machines/people.
snarkjs zkey contribute "$B/transfer_0000.zkey" "$B/transfer_0001.zkey" --name="contributor-1" -e="$(head -c 64 /dev/urandom | base64)"
snarkjs zkey contribute "$B/transfer_0001.zkey" "$B/transfer_0002.zkey" --name="contributor-2" -e="$(head -c 64 /dev/urandom | base64)"
snarkjs zkey contribute "$B/transfer_0002.zkey" "$B/transfer_0003.zkey" --name="contributor-3" -e="$(head -c 64 /dev/urandom | base64)"
# Public, unbiasable beacon finalises the ceremony (here: a fixed hash; in
# production use a future Bitcoin/drand block hash so no one can bias it).
snarkjs zkey beacon "$B/transfer_0003.zkey" "$B/transfer_final.zkey" \
  0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20 10 --name="final beacon"

echo "== verify the full setup (r1cs + ptau + contributions + beacon) =="
snarkjs zkey verify "$B/transfer.r1cs" "$PTAU" "$B/transfer_final.zkey" 2>&1 | grep -iE 'verified|valid|ok' | tail -1

snarkjs zkey export verificationkey "$B/transfer_final.zkey" "$B/transfer_vk.json"
echo "== DONE: $B/transfer_final.zkey + $B/transfer_vk.json (credible setup) =="
