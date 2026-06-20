//! Recompute extDataHash on-chain and bind it to the proof. The transfer circuit
//! commits to `extDataHash` as a public input; recomputing it here from the
//! actual recipient/amount/fee/ciphertexts the contract acts on prevents a valid
//! proof from being replayed with a different recipient (malleability).
//!
//! Canonical encoding (must match client/lib/extdata.js exactly):
//!   u32_be(len(recipient_strkey)) || recipient_strkey_utf8
//!   || i128_be(ext_amount) || i128_be(fee)
//!   || u32_be(len(enc1)) || enc1 || u32_be(len(enc2)) || enc2
//! hash = keccak256(buffer) reduced mod P (BN254 scalar field).
use soroban_sdk::{Address, Bytes, Env, String, U256};

// BN254 scalar field modulus, big-endian.
const P_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

fn append(env: &Env, buf: &mut Bytes, slice: &[u8]) {
    buf.append(&Bytes::from_slice(env, slice));
}

// big-endian compare a >= b
fn ge(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut i = 0;
    while i < 32 {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
        i += 1;
    }
    true
}
// big-endian a - b (assumes a >= b)
fn sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut r = [0u8; 32];
    let mut borrow: i16 = 0;
    let mut i: i32 = 31;
    while i >= 0 {
        let mut d = a[i as usize] as i16 - b[i as usize] as i16 - borrow;
        if d < 0 {
            d += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        r[i as usize] = d as u8;
        i -= 1;
    }
    r
}

pub fn ext_data_hash(
    env: &Env,
    recipient: &Address,
    ext_amount: i128,
    fee: i128,
    enc1: &Bytes,
    enc2: &Bytes,
) -> U256 {
    let mut buf = Bytes::new(env);

    // recipient strkey (all Stellar strkeys are 56 chars)
    let s: String = recipient.to_string();
    let slen = s.len();
    let mut sbuf = [0u8; 56];
    s.copy_into_slice(&mut sbuf);
    append(env, &mut buf, &slen.to_be_bytes());
    append(env, &mut buf, &sbuf[..slen as usize]);

    append(env, &mut buf, &ext_amount.to_be_bytes());
    append(env, &mut buf, &fee.to_be_bytes());

    let l1 = enc1.len();
    append(env, &mut buf, &l1.to_be_bytes());
    buf.append(enc1);
    let l2 = enc2.len();
    append(env, &mut buf, &l2.to_be_bytes());
    buf.append(enc2);

    // keccak256 then reduce mod P (quotient <= 4, so few subtractions)
    let digest = env.crypto().keccak256(&buf);
    let mut h = digest.to_array();
    while ge(&h, &P_BE) {
        h = sub(&h, &P_BE);
    }
    U256::from_be_bytes(env, &Bytes::from_array(env, &h))
}
