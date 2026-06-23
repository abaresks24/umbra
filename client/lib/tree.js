// Off-chain incremental Merkle tree mirroring the on-chain pool tree.
// Uses Poseidon(2) for nodes and zero-leaf "0" — these MUST match the Soroban
// contract's tree (Phase 2) and the circuit's MerkleProof.
const { MerkleTree } = require("fixed-merkle-tree");
const { poseidon } = require("./crypto");

const LEVELS = 16; // 2^16 = 65,536 notes (pair-insertion on-chain keeps it within budget)
const ZERO = "0";

function poseidonHash2(left, right) {
  return poseidon([left, right]).toString();
}

// Build a tree from an array of commitment leaves (decimal strings).
function buildTree(leaves = []) {
  return new MerkleTree(LEVELS, leaves.map(String), {
    hashFunction: poseidonHash2,
    zeroElement: ZERO,
  });
}

// Merkle proof for the leaf at `index`, in circuit form:
//   pathIndices: the leaf index itself (Num2Bits unpacks it inside the circuit)
//   pathElements: sibling hashes bottom..top (decimal strings)
function merkleProof(tree, index) {
  const { pathElements } = tree.path(index);
  return { pathIndices: BigInt(index), pathElements: pathElements.map(String) };
}

// Dummy proof for a zero-value input (root check is disabled in-circuit).
function dummyProof() {
  return { pathIndices: 0n, pathElements: new Array(LEVELS).fill("0") };
}

module.exports = { LEVELS, ZERO, buildTree, merkleProof, dummyProof, poseidonHash2 };
