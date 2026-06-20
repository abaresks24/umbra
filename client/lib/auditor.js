// Baby Jubjub ElGamal + Poseidon — the off-chain side of ENFORCED auditor
// disclosure. Matches circuits/elgamal.circom exactly. The auditor holds a BJJ
// keypair; senders encrypt each note to it; the in-circuit constraints guarantee
// the ciphertext is well-formed, so every note is auditor-decryptable.
const { buildBabyjub, buildPoseidon } = require("circomlibjs");
const crypto = require("crypto");
const { P } = require("./crypto");

let bj, pos;
async function initAuditor() {
  if (!bj) { bj = await buildBabyjub(); pos = await buildPoseidon(); }
  return { bj, pos };
}
const f2big = (x) => BigInt(bj.F.toString(x));
const poseidon = (arr) => BigInt(pos.F.toString(pos(arr.map((x) => BigInt(x)))));

function randomScalar() {
  // uniform-ish in [1, subOrder)
  return (BigInt("0x" + crypto.randomBytes(32).toString("hex")) % (bj.subOrder - 1n)) + 1n;
}

// New auditor keypair (BJJ). priv is a scalar; pub = priv·B8.
function newAuditorKey() {
  const priv = randomScalar();
  const pub = bj.mulPointEscalar(bj.Base8, priv);
  return { priv: priv.toString(), pubX: f2big(pub[0]).toString(), pubY: f2big(pub[1]).toString() };
}

// Encrypt msg (array of field BigInts) to the auditor pubkey with ephemeral r.
// Returns { R:[x,y], cipher:[...] } — all field BigInts, ready as circuit public signals.
function encryptToAuditor(msg, pub, r) {
  const R = bj.mulPointEscalar(bj.Base8, r);
  const A = [bj.F.e(pub.pubX), bj.F.e(pub.pubY)];
  const S = bj.mulPointEscalar(A, r);
  const k = poseidon([f2big(S[0]), f2big(S[1])]);
  const cipher = msg.map((m, j) => (((BigInt(m) + poseidon([k, BigInt(j)])) % P) + P) % P);
  return { R: [f2big(R[0]), f2big(R[1])], cipher };
}

// Auditor decrypts using its private scalar: S = priv·R ; recover msg.
function decryptAsAuditor(R, cipher, priv) {
  const Rp = [bj.F.e(BigInt(R[0]).toString()), bj.F.e(BigInt(R[1]).toString())];
  const S = bj.mulPointEscalar(Rp, BigInt(priv));
  const k = poseidon([f2big(S[0]), f2big(S[1])]);
  return cipher.map((c, j) => (((BigInt(c) - poseidon([k, BigInt(j)])) % P) + P) % P);
}

// Multi-output encryption matching transfer.circom: one ephemeral key per tx,
// per-output key = Poseidon(S.x, S.y, t), cipher[j] = msg[j] + Poseidon(key, j).
// msgs: array (per output) of [amount, pubkey, blinding] BigInts.
function encryptOutputsToAuditor(msgs, pub, r) {
  const R = bj.mulPointEscalar(bj.Base8, r);
  const A = [bj.F.e(pub.pubX), bj.F.e(pub.pubY)];
  const S = bj.mulPointEscalar(A, r);
  const Sx = f2big(S[0]), Sy = f2big(S[1]);
  const ciphers = msgs.map((msg, t) => {
    const key = poseidon([Sx, Sy, BigInt(t)]);
    return msg.map((m, j) => (((BigInt(m) + poseidon([key, BigInt(j)])) % P) + P) % P);
  });
  return { R: [f2big(R[0]), f2big(R[1])], ciphers };
}

// Decrypt one output slot t given the tx's R and that output's ciphertext.
function decryptAuditOutput(R, cipher, t, priv) {
  const Rp = [bj.F.e(BigInt(R[0]).toString()), bj.F.e(BigInt(R[1]).toString())];
  const S = bj.mulPointEscalar(Rp, BigInt(priv));
  const key = poseidon([f2big(S[0]), f2big(S[1]), BigInt(t)]);
  return cipher.map((c, j) => (((BigInt(c) - poseidon([key, BigInt(j)])) % P) + P) % P);
}

module.exports = {
  initAuditor, newAuditorKey, encryptToAuditor, decryptAsAuditor, randomScalar,
  encryptOutputsToAuditor, decryptAuditOutput,
};
