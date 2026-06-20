// Note encryption for the compliance layer. Each output note is encrypted to
// (a) the recipient's viewing key — so they can DISCOVER incoming notes by
// scanning events — and (b) a fixed AUDITOR viewing key — so a regulator can
// reconstruct amounts and parties. Both ciphertexts ride in the output's `enc`
// blob, which is bound into the proof via extDataHash.
//
// Scheme: ephemeral-static ECIES with NaCl box (Curve25519-XSalsa20-Poly1305).
// blob = ephemeralPub(32) || nonce(24) || box(ciphertext+MAC).
//
// NOTE (honest limitation): the auditor encryption is enforced by the honest
// sender's client, not in-circuit. A malicious sender could omit it. The strong
// (in-circuit-enforced) variant is documented as future work in the README.
const nacl = require("tweetnacl");
const naclUtil = require("tweetnacl-util");

function newViewingKeypair() {
  const kp = nacl.box.keyPair();
  return { viewPub: Buffer.from(kp.publicKey).toString("hex"), viewSecret: Buffer.from(kp.secretKey).toString("hex") };
}

// plaintext object -> hex blob, encrypted to `recipientViewPubHex`.
function encryptTo(recipientViewPubHex, plaintextObj) {
  const msg = naclUtil.decodeUTF8(JSON.stringify(plaintextObj));
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(msg, nonce, Buffer.from(recipientViewPubHex, "hex"), eph.secretKey);
  return Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(nonce), Buffer.from(box)]).toString("hex");
}

// hex blob -> plaintext object, or null if not ours / undecryptable.
function tryDecrypt(viewSecretHex, blobHex) {
  try {
    const blob = Buffer.from(blobHex, "hex");
    const ephPub = blob.subarray(0, 32);
    const nonce = blob.subarray(32, 32 + nacl.box.nonceLength);
    const box = blob.subarray(32 + nacl.box.nonceLength);
    const msg = nacl.box.open(box, nonce, ephPub, Buffer.from(viewSecretHex, "hex"));
    if (!msg) return null;
    return JSON.parse(naclUtil.encodeUTF8(msg));
  } catch {
    return null;
  }
}

// Pack the two per-output ciphertexts (recipient + auditor) into one enc blob:
//   u16(len recipCt) || recipCt || u16(len audCt) || audCt   (hex string)
function packEnc(recipCtHex, auditorCtHex) {
  const r = Buffer.from(recipCtHex, "hex");
  const a = Buffer.from(auditorCtHex, "hex");
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  return Buffer.concat([u16(r.length), r, u16(a.length), a]).toString("hex");
}
function unpackEnc(encHex) {
  const b = Buffer.from(encHex, "hex");
  const rl = b.readUInt16BE(0);
  const recip = b.subarray(2, 2 + rl);
  const al = b.readUInt16BE(2 + rl);
  const aud = b.subarray(2 + rl + 2, 2 + rl + 2 + al);
  return { recipCt: recip.toString("hex"), auditorCt: aud.toString("hex") };
}

// Build the enc blob for one output note, encrypted to recipient + auditor.
function encryptOutput(note, recipientViewPubHex, auditorViewPubHex) {
  const plaintext = {
    amount: note.amount.toString(),
    blinding: note.blinding.toString(),
    spendPub: note.pubkey.toString(),
  };
  const recipCt = encryptTo(recipientViewPubHex, plaintext);
  const auditorCt = encryptTo(auditorViewPubHex, plaintext);
  return packEnc(recipCt, auditorCt);
}

module.exports = { newViewingKeypair, encryptTo, tryDecrypt, packEnc, unpackEnc, encryptOutput };
