#![no_std]
//! Phase 0 de-risking contract: a BN254 Groth16 verifier on Soroban using the
//! native BN254 host functions (CAP-0074, Protocol 25+). It proves that a
//! snarkjs/circom Groth16 proof over BN254 verifies on Stellar testnet — the
//! foundation the shielded-pool `transact` entrypoint will later build on.
//!
//! Byte encodings (all big-endian), matching scripts/bn254_snark_hex.js:
//!   - Fq  coordinate : 32 bytes BE
//!   - Bn254 G1 affine: X(32) || Y(32)                       = 64 bytes
//!   - Bn254 G2 affine: X.c1(32) || X.c0(32) || Y.c1(32) || Y.c0(32) = 128 bytes  (c1 FIRST)
//!   - Fr scalar      : 32 bytes BE
//!
//! Blob framing:
//!   vk_bytes     = alpha(G1) || beta(G2) || gamma(G2) || delta(G2)
//!                  || u32_be(ic_len) || ic[0..ic_len](G1 each)
//!   proof_bytes  = A(G1) || B(G2) || C(G1)        (A is NOT pre-negated)
//!   public_bytes = u32_be(n) || signal[0..n](Fr each)
//!
//! Groth16 check:  e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1
//! where vk_x = ic[0] + Σ signal[i] · ic[i+1].

use soroban_sdk::{
    contract, contractimpl, symbol_short, Bytes, BytesN, Env, Symbol, vec,
};
use soroban_sdk::crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine};

const VK: Symbol = symbol_short!("VK");

const G1_LEN: u32 = 64;
const G2_LEN: u32 = 128;
const FR_LEN: u32 = 32;

fn read_array<const N: usize>(b: &Bytes, off: u32) -> [u8; N] {
    let mut buf = [0u8; N];
    b.slice(off..off + N as u32).copy_into_slice(&mut buf);
    buf
}

fn read_g1(env: &Env, b: &Bytes, off: u32) -> Bn254G1Affine {
    Bn254G1Affine::from_array(env, &read_array::<64>(b, off))
}

fn read_g2(env: &Env, b: &Bytes, off: u32) -> Bn254G2Affine {
    Bn254G2Affine::from_array(env, &read_array::<128>(b, off))
}

fn read_fr(env: &Env, b: &Bytes, off: u32) -> Bn254Fr {
    Bn254Fr::from_bytes(BytesN::from_array(env, &read_array::<32>(b, off)))
}

fn read_u32(b: &Bytes, off: u32) -> u32 {
    u32::from_be_bytes(read_array::<4>(b, off))
}

#[contract]
pub struct Groth16Verifier;

#[contractimpl]
impl Groth16Verifier {
    /// Store the verification key (raw framed bytes) in instance storage.
    pub fn set_vk(env: Env, vk_bytes: Bytes) {
        env.storage().instance().set(&VK, &vk_bytes);
    }

    /// Verify a Groth16 proof against the stored VK and the given public signals.
    pub fn verify(env: Env, proof_bytes: Bytes, public_bytes: Bytes) -> bool {
        let vkb: Bytes = env.storage().instance().get(&VK).expect("VK not set");
        let bn = env.crypto().bn254();

        // --- parse VK ---
        let alpha = read_g1(&env, &vkb, 0);
        let beta = read_g2(&env, &vkb, G1_LEN);
        let gamma = read_g2(&env, &vkb, G1_LEN + G2_LEN);
        let delta = read_g2(&env, &vkb, G1_LEN + 2 * G2_LEN);
        let ic_off = G1_LEN + 3 * G2_LEN; // 448
        let ic_len = read_u32(&vkb, ic_off);
        let ic0_off = ic_off + 4;

        // --- parse public signals ---
        let n = read_u32(&public_bytes, 0);
        assert!(ic_len == n + 1, "ic_len must equal nPublic + 1");

        // vk_x = ic[0] + Σ signal[i] · ic[i+1]
        let mut vk_x = read_g1(&env, &vkb, ic0_off);
        let mut i: u32 = 0;
        while i < n {
            let ic = read_g1(&env, &vkb, ic0_off + (i + 1) * G1_LEN);
            let s = read_fr(&env, &public_bytes, 4 + i * FR_LEN);
            vk_x = bn.g1_add(&vk_x, &bn.g1_mul(&ic, &s));
            i += 1;
        }

        // --- parse proof ---
        let a = read_g1(&env, &proof_bytes, 0);
        let b = read_g2(&env, &proof_bytes, G1_LEN);
        let c = read_g1(&env, &proof_bytes, G1_LEN + G2_LEN);

        let vp1 = vec![&env, -a, alpha, vk_x, c];
        let vp2 = vec![&env, b, beta, gamma, delta];
        bn.pairing_check(vp1, vp2)
    }
}
