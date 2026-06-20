//! On-chain incremental Merkle tree with a root-history ring buffer, using the
//! native Poseidon(2) host hash. Must produce identical roots to the off-chain
//! `fixed-merkle-tree` (zero leaf = 0, node = Poseidon(left, right)) so that a
//! proof built off-chain finds its root in history.
use soroban_sdk::{contracttype, vec, Env, U256, Vec};
use soroban_poseidon::poseidon_hash;
use soroban_sdk::crypto::bn254::Bn254Fr;

pub const LEVELS: u32 = 8;
pub const ROOT_HISTORY: u32 = 30;

#[contracttype]
#[derive(Clone)]
pub enum TreeKey {
    NextIndex,
    Filled,   // Vec<U256> len LEVELS
    Zeros,    // Vec<U256> len LEVELS+1 (zeros[LEVELS] = empty root)
    Roots,    // Vec<U256> len ROOT_HISTORY (ring buffer)
    RootIdx,  // u32
}

pub fn hash2(env: &Env, l: U256, r: U256) -> U256 {
    poseidon_hash::<3, Bn254Fr>(env, &vec![env, l, r])
}

fn zero(env: &Env) -> U256 {
    U256::from_u32(env, 0)
}

/// Initialise the tree: compute zeros, seed filled subtrees, store the empty root.
pub fn init(env: &Env) {
    let s = env.storage().instance();
    // zeros[0] = 0 ; zeros[i] = hash(zeros[i-1], zeros[i-1])
    let mut zeros: Vec<U256> = vec![env];
    let mut cur = zero(env);
    zeros.push_back(cur.clone());
    let mut i = 0u32;
    while i < LEVELS {
        cur = hash2(env, cur.clone(), cur.clone());
        zeros.push_back(cur.clone());
        i += 1;
    }
    // filled subtrees start as zeros[0..LEVELS]
    let mut filled: Vec<U256> = vec![env];
    let mut j = 0u32;
    while j < LEVELS {
        filled.push_back(zeros.get(j).unwrap());
        j += 1;
    }
    // roots ring buffer seeded with the empty root
    let empty_root = zeros.get(LEVELS).unwrap();
    let mut roots: Vec<U256> = vec![env];
    let mut k = 0u32;
    while k < ROOT_HISTORY {
        roots.push_back(zero(env));
        k += 1;
    }
    roots.set(0, empty_root);

    s.set(&TreeKey::Zeros, &zeros);
    s.set(&TreeKey::Filled, &filled);
    s.set(&TreeKey::Roots, &roots);
    s.set(&TreeKey::NextIndex, &0u32);
    s.set(&TreeKey::RootIdx, &0u32);
}

/// Insert one leaf, update filled subtrees, push the new root. Returns leaf index.
pub fn insert(env: &Env, leaf: U256) -> u32 {
    let s = env.storage().instance();
    let next: u32 = s.get(&TreeKey::NextIndex).unwrap();
    assert!(next < (1u32 << LEVELS), "merkle tree full");

    let zeros: Vec<U256> = s.get(&TreeKey::Zeros).unwrap();
    let mut filled: Vec<U256> = s.get(&TreeKey::Filled).unwrap();

    let mut idx = next;
    let mut cur = leaf;
    let mut i = 0u32;
    while i < LEVELS {
        let (left, right);
        if idx % 2 == 0 {
            left = cur.clone();
            right = zeros.get(i).unwrap();
            filled.set(i, cur.clone());
        } else {
            left = filled.get(i).unwrap();
            right = cur.clone();
        }
        cur = hash2(env, left, right);
        idx /= 2;
        i += 1;
    }

    // push new root into ring buffer
    let mut root_idx: u32 = s.get(&TreeKey::RootIdx).unwrap();
    let mut roots: Vec<U256> = s.get(&TreeKey::Roots).unwrap();
    root_idx = (root_idx + 1) % ROOT_HISTORY;
    roots.set(root_idx, cur);

    s.set(&TreeKey::Filled, &filled);
    s.set(&TreeKey::Roots, &roots);
    s.set(&TreeKey::RootIdx, &root_idx);
    s.set(&TreeKey::NextIndex, &(next + 1));
    next
}

pub fn current_root(env: &Env) -> U256 {
    let s = env.storage().instance();
    let root_idx: u32 = s.get(&TreeKey::RootIdx).unwrap();
    let roots: Vec<U256> = s.get(&TreeKey::Roots).unwrap();
    roots.get(root_idx).unwrap()
}

/// True if `root` is any of the recent roots (and non-zero) — lets a proof built
/// against a slightly stale root still validate.
pub fn is_known_root(env: &Env, root: U256) -> bool {
    let zero = zero(env);
    if root == zero {
        return false;
    }
    let s = env.storage().instance();
    let roots: Vec<U256> = s.get(&TreeKey::Roots).unwrap();
    let mut i = 0u32;
    while i < ROOT_HISTORY {
        if roots.get(i).unwrap() == root {
            return true;
        }
        i += 1;
    }
    false
}
