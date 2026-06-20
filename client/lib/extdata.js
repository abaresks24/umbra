// extDataHash binds external (non-private) transaction data into the proof.
// Encoding MUST match contracts/pool/src/extdata.rs byte-for-byte:
//   u32_be(len(recipient_strkey)) || recipient_strkey_utf8
//   || i128_be(ext_amount) || i128_be(fee)
//   || u32_be(len(enc1)) || enc1 || u32_be(len(enc2)) || enc2
// hash = keccak256(buffer) mod P. `recipient` is a Stellar strkey (G... / C...).
const { keccak256 } = require("js-sha3");
const { P } = require("./crypto");

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
// i128 two's complement, 16-byte big-endian (matches Rust i128::to_be_bytes).
function i128be(x) {
  const v = BigInt.asUintN(128, BigInt(x));
  return Buffer.from(v.toString(16).padStart(32, "0"), "hex");
}

function encodeExtData(ed) {
  const rec = Buffer.from(ed.recipient || "", "utf8");
  const e1 = ed.encryptedOutput1 ? Buffer.from(ed.encryptedOutput1, "hex") : Buffer.alloc(0);
  const e2 = ed.encryptedOutput2 ? Buffer.from(ed.encryptedOutput2, "hex") : Buffer.alloc(0);
  return Buffer.concat([
    u32be(rec.length), rec,
    i128be(ed.extAmount ?? 0),
    i128be(ed.fee ?? 0),
    u32be(e1.length), e1,
    u32be(e2.length), e2,
  ]);
}

function extDataHash(ed) {
  return BigInt("0x" + keccak256(encodeExtData(ed))) % P;
}

module.exports = { encodeExtData, extDataHash };
