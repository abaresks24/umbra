#![no_std]
//! Phase 0 gate (b) — the #1 risk killer: prove that the on-chain Poseidon
//! (native CAP-0075 permutation, wrapped by `soroban-poseidon` with circomlib
//! BN254 parameters) reproduces circomlib's `Poseidon(n)` byte-for-byte.
//!
//! circomlib uses state width `t = nInputs + 1`, so:
//!   Poseidon(1) -> t=2 ,  Poseidon(2) -> t=3 ,  Poseidon(3) -> t=4.
//! The unit test in `mod test` runs these through the real host function via
//! `Env::default()` and asserts equality against vectors produced by the
//! canonical iden3 `circomlibjs` (see scripts/poseidon-golden/).

use soroban_sdk::{contract, contractimpl, vec, Env, U256};
use soroban_sdk::crypto::bn254::Bn254Fr;
use soroban_poseidon::poseidon_hash;

#[contract]
pub struct PoseidonMatch;

#[contractimpl]
impl PoseidonMatch {
    /// circomlib Poseidon(1): t=2.
    pub fn hash1(env: Env, a: U256) -> U256 {
        poseidon_hash::<2, Bn254Fr>(&env, &vec![&env, a])
    }

    /// circomlib Poseidon(2): t=3. Used for Merkle node hashing.
    pub fn hash2(env: Env, a: U256, b: U256) -> U256 {
        poseidon_hash::<3, Bn254Fr>(&env, &vec![&env, a, b])
    }

    /// circomlib Poseidon(3): t=4. Used for commitments and nullifiers.
    pub fn hash3(env: Env, a: U256, b: U256, c: U256) -> U256 {
        poseidon_hash::<4, Bn254Fr>(&env, &vec![&env, a, b, c])
    }
}

#[cfg(test)]
mod test;
