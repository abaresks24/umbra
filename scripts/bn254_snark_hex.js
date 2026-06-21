// snarkjs (bn128/BN254) JSON -> Soroban native BN254 byte blobs (hex).
//
// Byte layout (all big-endian) — must match contracts/groth16-verifier/src/lib.rs:
//   Fq coord  : 32 bytes BE
//   G1 affine : X || Y                                  (64 bytes)
//   G2 affine : X.c1 || X.c0 || Y.c1 || Y.c0            (128 bytes)  <- c1 FIRST
//   Fr scalar : 32 bytes BE
//   vk_bytes  : alpha(G1) beta(G2) gamma(G2) delta(G2) u32be(IC.len) IC...(G1)
//   proof     : A(G1) B(G2) C(G1)        (A NOT negated; contract negates it)
//   public    : u32be(n) Fr...
//
// snarkjs emits projective points with a trailing coord ("1" for G1/C, ["1","0"]
// for G2); we drop it (points are already affine, Z=1). G2 Fq2 is [c0, c1] in
// snarkjs JSON; Soroban native encoding wants c1 first — hence the swap.

const FQ = 32, FR = 32;

function toBE(dec, len) {
  const v = BigInt(String(dec).trim());
  if (v < 0n) throw new Error("negative field element");
  if (v >= 1n << BigInt(len * 8)) throw new Error(`overflow ${len}B: ${dec}`);
  return v.toString(16).padStart(len * 2, "0");
}
function u32be(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("bad u32");
  return n.toString(16).padStart(8, "0");
}
// [x, y, "1"] -> BE(x) || BE(y)
const g1Hex = ([x, y]) => toBE(x, FQ) + toBE(y, FQ);
// [[x_c0, x_c1], [y_c0, y_c1], ["1","0"]] -> BE(x_c1)||BE(x_c0)||BE(y_c1)||BE(y_c0)
const g2Hex = ([[x0, x1], [y0, y1]]) =>
  toBE(x1, FQ) + toBE(x0, FQ) + toBE(y1, FQ) + toBE(y0, FQ);

function proofToHex(p) {
  return (g1Hex(p.pi_a) + g2Hex(p.pi_b) + g1Hex(p.pi_c)).toLowerCase();
}
function vkToHex(vk) {
  let out =
    g1Hex(vk.vk_alpha_1) + g2Hex(vk.vk_beta_2) +
    g2Hex(vk.vk_gamma_2) + g2Hex(vk.vk_delta_2) + u32be(vk.IC.length);
  for (const ic of vk.IC) out += g1Hex(ic);
  return out.toLowerCase();
}
function publicToHex(signals) {
  let out = u32be(signals.length);
  for (const s of signals) out += toBE(s, FR);
  return out.toLowerCase();
}

module.exports = { proofToHex, vkToHex, publicToHex };
