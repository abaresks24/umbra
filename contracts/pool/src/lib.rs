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
    Admin,
    AuditorX,
    AuditorY,
    Asset(U256),         // assetId -> token (SAC) address
    Nullifier(BytesN<32>),
    SwapVk,              // VK for the shielded-swap circuit
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
    pub fn init(env: Env, admin: Address, vk_bytes: Bytes, auditor_x: U256, auditor_y: U256) {
        let s = env.storage().instance();
        assert!(!s.has(&Key::Vk), "already initialised");
        s.set(&Key::Admin, &admin);
        s.set(&Key::Vk, &vk_bytes);
        s.set(&Key::AuditorX, &auditor_x);
        s.set(&Key::AuditorY, &auditor_y);
        merkle::init(&env);
    }

    /// Register (or update) the token backing an asset id. Admin only.
    pub fn register_asset(env: Env, asset_id: U256, token: Address) {
        let s = env.storage().instance();
        let admin: Address = s.get(&Key::Admin).expect("not initialised");
        admin.require_auth();
        s.set(&Key::Asset(asset_id), &token);
    }

    pub fn asset_token(env: Env, asset_id: U256) -> Option<Address> {
        env.storage().instance().get(&Key::Asset(asset_id))
    }

    /// Configure the shielded-swap verification key. Admin only.
    pub fn set_swap_vk(env: Env, vk_bytes: Bytes) {
        let s = env.storage().instance();
        let admin: Address = s.get(&Key::Admin).expect("not initialised");
        admin.require_auth();
        s.set(&Key::SwapVk, &vk_bytes);
    }

    /// Shielded SWAP: convert value between assets (e.g. USDC -> EURC) at the
    /// proof's oracle rate, all amounts hidden. A swap is INTERNAL: no token
    /// crosses the pool boundary (reserves stay; liquidity is pre-funded), so it
    /// emits the same opaque commit/nullify/audit events as a private transfer and
    /// the enforced auditor ciphertext still covers each (per-asset) output.
    /// NOTE (demo): the public `rate` signal is trusted here; production would bind
    /// it to an on-chain oracle so a swapper can't pick a favourable price.
    pub fn swap(env: Env, proof: Bytes, public: Bytes, enc1: Bytes, enc2: Bytes) {
        let s = env.storage().instance();
        let vk: Bytes = s.get(&Key::SwapVk).expect("swap not configured");
        assert!(verifier::verify(&env, &vk, &proof, &public), "invalid swap proof");

        let root = verifier::root(&env, &public);
        assert!(merkle::is_known_root(&env, root), "unknown merkle root");

        let ax: U256 = s.get(&Key::AuditorX).unwrap();
        let ay: U256 = s.get(&Key::AuditorY).unwrap();
        assert!(verifier::auditor_pub(&env, &public, 0) == ax, "wrong auditor key");
        assert!(verifier::auditor_pub(&env, &public, 1) == ay, "wrong auditor key");

        let nf0 = verifier::nullifier(&env, &public, 0);
        let nf1 = verifier::nullifier(&env, &public, 1);
        assert!(!s.has(&Key::Nullifier(nf0.clone())), "nullifier 0 already spent");
        assert!(!s.has(&Key::Nullifier(nf1.clone())), "nullifier 1 already spent");
        s.set(&Key::Nullifier(nf0.clone()), &true);
        s.set(&Key::Nullifier(nf1.clone()), &true);

        let c0 = verifier::commitment(&env, &public, 0);
        let c1 = verifier::commitment(&env, &public, 1);
        let (i0, i1) = merkle::insert_pair(&env, c0.clone(), c1.clone());

        env.events().publish((symbol_short!("commit"), i0), (c0, enc1));
        env.events().publish((symbol_short!("commit"), i1), (c1, enc2));
        env.events().publish((symbol_short!("nullify"),), (nf0, nf1));

        let rx = verifier::auditor_r(&env, &public, 0);
        let ry = verifier::auditor_r(&env, &public, 1);
        env.events().publish((symbol_short!("audit"), i0),
            (rx.clone(), ry.clone(), verifier::auditor_cipher(&env, &public, 0, 0),
             verifier::auditor_cipher(&env, &public, 0, 1), verifier::auditor_cipher(&env, &public, 0, 2), verifier::auditor_cipher(&env, &public, 0, 3)));
        env.events().publish((symbol_short!("audit"), i1),
            (rx, ry, verifier::auditor_cipher(&env, &public, 1, 0),
             verifier::auditor_cipher(&env, &public, 1, 1), verifier::auditor_cipher(&env, &public, 1, 2), verifier::auditor_cipher(&env, &public, 1, 3)));
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

        // 4b) ENFORCED auditor disclosure: the proof must encrypt every output to
        // THE pinned auditor key. Validators reject any proof that does not.
        let ax: U256 = s.get(&Key::AuditorX).unwrap();
        let ay: U256 = s.get(&Key::AuditorY).unwrap();
        assert!(verifier::auditor_pub(&env, &public, 0) == ax, "wrong auditor key");
        assert!(verifier::auditor_pub(&env, &public, 1) == ay, "wrong auditor key");

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
        let (i0, i1) = merkle::insert_pair(&env, c0.clone(), c1.clone());

        // 7) move the asset's token at the pool edges. The asset is revealed only
        // when there is movement (publicAmount != 0); for a PURE private transfer
        // `revealed_asset == 0` and the asset stays hidden — no token logic at all.
        assert!(fee >= 0, "negative fee");
        let asset = verifier::revealed_asset(&env, &public);
        let pool = env.current_contract_address();
        if asset != U256::from_u32(&env, 0) {
            let token_addr: Address = s.get(&Key::Asset(asset.clone())).expect("unknown asset");
            let tok = token::TokenClient::new(&env, &token_addr);
            if ext_amount > 0 {
                tok.transfer(&caller, &pool, &ext_amount); // shield in
            } else if ext_amount < 0 {
                tok.transfer(&pool, &recipient, &(-ext_amount)); // unshield out
            }
            // Pay the relayer a fee from the shielded value (publicAmount = ext_amount
            // - fee), so a third party can relay. Paying a fee reveals the asset.
            if fee > 0 {
                tok.transfer(&pool, &caller, &fee);
            }
        }

        // 8) events: NewCommitment per output (recipient ciphertext) + nullifiers
        env.events().publish((symbol_short!("commit"), i0), (c0, enc1));
        env.events().publish((symbol_short!("commit"), i1), (c1, enc2));
        env.events().publish((symbol_short!("nullify"),), (nf0, nf1));

        // audit events: the ENFORCED auditor ciphertext per output (R, c0, c1, c2, assetId)
        let rx = verifier::auditor_r(&env, &public, 0);
        let ry = verifier::auditor_r(&env, &public, 1);
        env.events().publish((symbol_short!("audit"), i0),
            (rx.clone(), ry.clone(), verifier::auditor_cipher(&env, &public, 0, 0),
             verifier::auditor_cipher(&env, &public, 0, 1), verifier::auditor_cipher(&env, &public, 0, 2), verifier::auditor_cipher(&env, &public, 0, 3)));
        env.events().publish((symbol_short!("audit"), i1),
            (rx, ry, verifier::auditor_cipher(&env, &public, 1, 0),
             verifier::auditor_cipher(&env, &public, 1, 1), verifier::auditor_cipher(&env, &public, 1, 2), verifier::auditor_cipher(&env, &public, 1, 3)));
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
