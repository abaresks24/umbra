#![no_std]
//! Shielded USDC pool on Soroban. A single `transact` entrypoint handles shield,
//! private transfer, and unshield: it verifies a BN254 Groth16 proof, checks the
//! Merkle root is recent and the nullifiers are unspent, inserts the two output
//! commitments into the on-chain incremental Merkle tree, moves USDC at the pool
//! edges (shield in / unshield out), and emits events carrying the encrypted note
//! payloads for client scanning.
mod extdata;
mod merkle;
mod verifier;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env, U256,
};
use soroban_sdk::crypto::bn254::Bn254Fr;

#[contracttype]
#[derive(Clone)]
pub enum Key {
    Vk,
    Token,
    Nullifier(BytesN<32>),
}

fn u256_from_u128(env: &Env, v: u128) -> U256 {
    let mut b = [0u8; 32];
    b[16..].copy_from_slice(&v.to_be_bytes());
    U256::from_be_bytes(env, &Bytes::from_array(env, &b))
}

// Field encoding of a signed net amount: positive -> itself, negative -> P - |x|.
fn expected_public_amount(env: &Env, net: i128) -> U256 {
    if net >= 0 {
        u256_from_u128(env, net as u128)
    } else {
        let bn = env.crypto().bn254();
        let zero = Bn254Fr::from_u256(U256::from_u32(env, 0));
        let mag = Bn254Fr::from_u256(u256_from_u128(env, (-net) as u128));
        bn.fr_sub(&zero, &mag).to_u256()
    }
}

#[contract]
pub struct ShieldedPool;

#[contractimpl]
impl ShieldedPool {
    /// One-time setup: store the USDC token (SAC) address and the transfer VK,
    /// and initialise the Merkle tree.
    pub fn init(env: Env, token: Address, vk_bytes: Bytes) {
        let s = env.storage().instance();
        assert!(!s.has(&Key::Vk), "already initialised");
        s.set(&Key::Token, &token);
        s.set(&Key::Vk, &vk_bytes);
        merkle::init(&env);
    }

    /// Shield / transfer / unshield. `ext_amount` is signed: >0 deposits USDC into
    /// the pool, <0 withdraws to `recipient`, 0 is a pure private transfer.
    pub fn transact(
        env: Env,
        caller: Address,
        proof: Bytes,
        public: Bytes,
        recipient: Address,
        ext_amount: i128,
        fee: i128,
        enc1: Bytes,
        enc2: Bytes,
    ) {
        caller.require_auth();
        let s = env.storage().instance();
        let vk: Bytes = s.get(&Key::Vk).expect("not initialised");

        // 1) the proof must verify
        assert!(verifier::verify(&env, &vk, &proof, &public), "invalid proof");

        // 2) the root must be one of the recent on-chain roots
        let root = verifier::root(&env, &public);
        assert!(merkle::is_known_root(&env, root), "unknown merkle root");

        // 3) bind external data (recipient/amounts/ciphertexts) to the proof
        let edh = extdata::ext_data_hash(&env, &recipient, ext_amount, fee, &enc1, &enc2);
        assert!(edh == verifier::ext_data_hash(&env, &public), "extData hash mismatch");

        // 4) bind the public amount: circuit publicAmount == field(ext_amount - fee)
        let expected = expected_public_amount(&env, ext_amount - fee);
        assert!(expected == verifier::public_amount(&env, &public), "public amount mismatch");

        // 5) nullifiers must be unspent; mark them spent (prevents double-spend)
        let nf0 = verifier::nullifier(&env, &public, 0);
        let nf1 = verifier::nullifier(&env, &public, 1);
        assert!(!s.has(&Key::Nullifier(nf0.clone())), "nullifier 0 already spent");
        assert!(!s.has(&Key::Nullifier(nf1.clone())), "nullifier 1 already spent");
        s.set(&Key::Nullifier(nf0.clone()), &true);
        s.set(&Key::Nullifier(nf1.clone()), &true);

        // 6) insert the two output commitments into the tree
        let c0 = verifier::commitment(&env, &public, 0);
        let c1 = verifier::commitment(&env, &public, 1);
        let i0 = merkle::insert(&env, c0.clone());
        let i1 = merkle::insert(&env, c1.clone());

        // 7) move USDC at the pool edges
        let token_addr: Address = s.get(&Key::Token).unwrap();
        let usdc = token::TokenClient::new(&env, &token_addr);
        let pool = env.current_contract_address();
        if ext_amount > 0 {
            usdc.transfer(&caller, &pool, &ext_amount); // shield in
        } else if ext_amount < 0 {
            usdc.transfer(&pool, &recipient, &(-ext_amount)); // unshield out
        }

        // 8) events: one NewCommitment per output (with ciphertext) + the nullifiers
        env.events().publish((symbol_short!("commit"), i0), (c0, enc1));
        env.events().publish((symbol_short!("commit"), i1), (c1, enc2));
        env.events().publish((symbol_short!("nullify"),), (nf0, nf1));
    }

    // --- views ---
    pub fn root(env: Env) -> U256 {
        merkle::current_root(&env)
    }
    pub fn known_root(env: Env, root: U256) -> bool {
        merkle::is_known_root(&env, root)
    }
    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().instance().has(&Key::Nullifier(nullifier))
    }
    /// Pure helper: recompute extDataHash (also lets clients precompute it).
    pub fn ext_hash(
        env: Env,
        recipient: Address,
        ext_amount: i128,
        fee: i128,
        enc1: Bytes,
        enc2: Bytes,
    ) -> U256 {
        extdata::ext_data_hash(&env, &recipient, ext_amount, fee, &enc1, &enc2)
    }
}
