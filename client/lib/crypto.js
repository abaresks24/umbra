// Core crypto for the shielded pool — Poseidon (circomlib BN254, matches the
// circuit and the on-chain hash), keypairs, and notes (encrypted UTXOs).
// All values are BigInt field elements unless noted; tree/circuit I/O uses
// decimal strings.
const { buildPoseidon } = require("circomlibjs");
const crypto = require("crypto");

// BN254 scalar field modulus.
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let _poseidon = null;
async function initPoseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}
// Poseidon(inputs) -> BigInt. circomlib arity = inputs.length (t = inputs+1).
function poseidon(inputs) {
  const F = _poseidon.F;
  return BigInt(F.toString(_poseidon(inputs.map((x) => BigInt(x)))));
}

// Uniform random field element (rejection-free: 32 bytes mod P is negligibly biased for a demo).
function randomField() {
  return BigInt("0x" + crypto.randomBytes(32).toString("hex")) % P;
}

function toStr(x) {
  return BigInt(x).toString();
}

class Keypair {
  constructor(privkey) {
    this.privkey = privkey === undefined ? randomField() : BigInt(privkey);
    this.pubkey = poseidon([this.privkey]);
  }
  // signature = Poseidon(privKey, commitment, merklePath)
  sign(commitment, merklePath) {
    return poseidon([this.privkey, commitment, merklePath]);
  }
  // A public address shared with senders: just the pubkey (string).
  address() {
    return this.pubkey.toString();
  }
}

class Note {
  // owner: a Keypair (if we can spend it) OR a plain pubkey BigInt/string (output to someone else).
  constructor({ amount, assetId, owner, blinding }) {
    this.amount = BigInt(amount);
    this.assetId = BigInt(assetId ?? 0);
    if (owner instanceof Keypair) {
      this.keypair = owner;
      this.pubkey = owner.pubkey;
    } else {
      this.keypair = null;
      this.pubkey = BigInt(owner);
    }
    this.blinding = blinding === undefined ? randomField() : BigInt(blinding);
  }
  // commitment = Poseidon(amount, assetId, pubkey, blinding)
  commitment() {
    return poseidon([this.amount, this.assetId, this.pubkey, this.blinding]);
  }
  // nullifier = Poseidon(commitment, index, signature), signature = Poseidon(priv, commitment, index)
  // Requires the spending keypair (private key).
  nullifier(index) {
    if (!this.keypair) throw new Error("cannot compute nullifier without private key");
    const c = this.commitment();
    const sig = this.keypair.sign(c, BigInt(index));
    return poseidon([c, BigInt(index), sig]);
  }
  // A throwaway zero-value note to fill an unused input/output slot.
  static dummy(assetId = 0n) {
    return new Note({ amount: 0n, assetId, owner: new Keypair(), blinding: randomField() });
  }
}

module.exports = { P, initPoseidon, poseidon, randomField, toStr, Keypair, Note };
