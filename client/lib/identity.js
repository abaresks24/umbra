// Deterministic wallet identity from a single private key (a 32-byte seed).
// From the seed we derive BOTH the spending key (Poseidon, for nullifiers) and
// the viewing key (x25519, for note discovery). "Create wallet" generates a
// random seed; "Connect wallet" restores everything from it.
const { keccak256 } = require("js-sha3");
const nacl = require("tweetnacl");
const crypto = require("crypto");
const { P, Keypair } = require("./crypto");

function randomBytes(n) {
  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.getRandomValues) {
    const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return Buffer.from(a);
  }
  return crypto.randomBytes(n);
}

function randomSeed() {
  return randomBytes(32).toString("hex");
}

// seed (hex) -> { seed, spend: Keypair, viewSecret, viewPub, address }
function deriveIdentity(seedHex) {
  const seed = String(seedHex || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{8,128}$/.test(seed)) throw new Error("invalid private key");
  const spendPriv = BigInt("0x" + keccak256("shielded:spend:" + seed)) % P;
  const spend = new Keypair(spendPriv);
  const vsBytes = Buffer.from(keccak256("shielded:view:" + seed), "hex"); // 32 bytes
  const vkp = nacl.box.keyPair.fromSecretKey(vsBytes);
  const viewSecret = Buffer.from(vkp.secretKey).toString("hex");
  const viewPub = Buffer.from(vkp.publicKey).toString("hex");
  return { seed, spend, viewSecret, viewPub, address: encodeAddress(spend.pubkey.toString(), viewPub) };
}

// A shareable receive address bundles the spend pubkey + viewing pubkey.
function encodeAddress(spendPub, viewPub) {
  return "shld_" + Buffer.from(JSON.stringify({ s: spendPub, v: viewPub })).toString("base64");
}
function decodeAddress(addr) {
  const j = JSON.parse(Buffer.from(String(addr).trim().replace(/^shld_/, ""), "base64").toString());
  return { spendPub: BigInt(j.s), viewPub: j.v };
}

module.exports = { randomSeed, deriveIdentity, encodeAddress, decodeAddress };
