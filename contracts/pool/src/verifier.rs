//! BN254 Groth16 verification (same construction proven in Phase 0) plus typed
//! parsing of the transfer circuit's 7 public signals.
use soroban_sdk::{vec, Bytes, BytesN, Env, U256};
use soroban_sdk::crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine};

const G1_LEN: u32 = 64;
const G2_LEN: u32 = 128;
const FR_LEN: u32 = 32;

fn arr<const N: usize>(b: &Bytes, off: u32) -> [u8; N] {
    let mut buf = [0u8; N];
    b.slice(off..off + N as u32).copy_into_slice(&mut buf);
    buf
}
fn g1(env: &Env, b: &Bytes, off: u32) -> Bn254G1Affine {
    Bn254G1Affine::from_array(env, &arr::<64>(b, off))
}
fn g2(env: &Env, b: &Bytes, off: u32) -> Bn254G2Affine {
    Bn254G2Affine::from_array(env, &arr::<128>(b, off))
}
fn fr(env: &Env, b: &Bytes, off: u32) -> Bn254Fr {
    Bn254Fr::from_bytes(BytesN::from_array(env, &arr::<32>(b, off)))
}
fn u32be(b: &Bytes, off: u32) -> u32 {
    u32::from_be_bytes(arr::<4>(b, off))
}

/// Verify a Groth16 proof against a framed VK and public-signal blob.
/// (vk = alpha|beta|gamma|delta|u32(ic_len)|ic..., proof = A|B|C, public = u32(n)|Fr...)
pub fn verify(env: &Env, vkb: &Bytes, proof: &Bytes, public: &Bytes) -> bool {
    let bn = env.crypto().bn254();
    let alpha = g1(env, vkb, 0);
    let beta = g2(env, vkb, G1_LEN);
    let gamma = g2(env, vkb, G1_LEN + G2_LEN);
    let delta = g2(env, vkb, G1_LEN + 2 * G2_LEN);
    let ic_off = G1_LEN + 3 * G2_LEN;
    let ic_len = u32be(vkb, ic_off);
    let ic0 = ic_off + 4;

    let n = u32be(public, 0);
    assert!(ic_len == n + 1, "ic_len must equal nPublic + 1");

    let mut vk_x = g1(env, vkb, ic0);
    let mut i: u32 = 0;
    while i < n {
        let ic = g1(env, vkb, ic0 + (i + 1) * G1_LEN);
        let s = fr(env, public, 4 + i * FR_LEN);
        vk_x = bn.g1_add(&vk_x, &bn.g1_mul(&ic, &s));
        i += 1;
    }
    let a = g1(env, proof, 0);
    let b = g2(env, proof, G1_LEN);
    let c = g1(env, proof, G1_LEN + G2_LEN);
    bn.pairing_check(vec![env, -a, alpha, vk_x, c], vec![env, b, beta, gamma, delta])
}

// --- typed accessors for the 18 transfer public signals ---
// order: root, publicAmount, extDataHash, assetId, nullifier[2], commitment[2],
//        auditorPubKey[2], auditorR[2], auditorCipher[2][3]
fn sig_u256(env: &Env, public: &Bytes, i: u32) -> U256 {
    let off = 4 + i * FR_LEN;
    U256::from_be_bytes(env, &public.slice(off..off + FR_LEN))
}
pub fn root(env: &Env, p: &Bytes) -> U256 { sig_u256(env, p, 0) }
pub fn public_amount(env: &Env, p: &Bytes) -> U256 { sig_u256(env, p, 1) }
pub fn ext_data_hash(env: &Env, p: &Bytes) -> U256 { sig_u256(env, p, 2) }
pub fn asset_id(env: &Env, p: &Bytes) -> U256 { sig_u256(env, p, 3) }
pub fn nullifier(env: &Env, p: &Bytes, k: u32) -> BytesN<32> {
    BytesN::from_array(env, &arr::<32>(p, 4 + (4 + k) * FR_LEN))
}
pub fn commitment(env: &Env, p: &Bytes, k: u32) -> U256 { sig_u256(env, p, 6 + k) }
// Enforced-auditor signals: pubkey (8,9), ephemeral R (10,11), cipher[out][j] (12 + out*3 + j).
pub fn auditor_pub(env: &Env, p: &Bytes, k: u32) -> U256 { sig_u256(env, p, 8 + k) }
pub fn auditor_r(env: &Env, p: &Bytes, k: u32) -> U256 { sig_u256(env, p, 10 + k) }
pub fn auditor_cipher(env: &Env, p: &Bytes, out: u32, j: u32) -> U256 { sig_u256(env, p, 12 + out * 3 + j) }
