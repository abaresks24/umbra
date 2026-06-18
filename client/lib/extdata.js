// extDataHash binds external (non-private) transaction data into the proof so it
// can't be tampered with after proving: recipient, public amount, fee, and the
// encrypted note payloads. Hash = keccak256(canonical-encoding) mod P.
//
// Stellar has no ABI encoder, so we define a canonical byte encoding here. The
// Phase 2 contract recomputes this same hash from the submitted extData.
const { keccak256 } = require("js-sha3");
const { P } = require("./crypto");

// Canonical encoding: length-prefixed UTF-8 fields in a fixed order.
function encodeExtData(extData) {
  const parts = [
    extData.recipient || "",
    String(extData.extAmount ?? "0"),
    String(extData.fee ?? "0"),
    extData.encryptedOutput1 || "",
    extData.encryptedOutput2 || "",
  ];
  const chunks = [];
  for (const p of parts) {
    const buf = Buffer.from(p, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    chunks.push(len, buf);
  }
  return Buffer.concat(chunks);
}

function extDataHash(extData) {
  const bytes = encodeExtData(extData);
  return BigInt("0x" + keccak256(bytes)) % P;
}

module.exports = { encodeExtData, extDataHash };
