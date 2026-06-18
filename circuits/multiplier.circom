pragma circom 2.1.6;

// Phase 0 de-risking circuit: trivial a*b=c over BN254 (circom default prime).
// Sole purpose: produce a Groth16 proof we can verify inside a Soroban contract
// on testnet, proving the snarkjs -> BN254 host-function verifier pipeline works.
// `c` is the single public output; a, b are private witnesses.
template Multiplier() {
    signal input a;
    signal input b;
    signal output c;
    c <== a * b;
}

component main = Multiplier();
