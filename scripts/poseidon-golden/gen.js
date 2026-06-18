// Generate canonical circomlib Poseidon golden vectors (BN254) for arities 1,2,3.
// These are the exact values the circom circuit produces; the Soroban contract
// must reproduce them byte-for-byte via the native CAP-0075 permutation.
const { buildPoseidon } = require("circomlibjs");

const CASES = [
  { name: "poseidon1", inputs: [1n] },
  { name: "poseidon2", inputs: [1n, 2n] },
  { name: "poseidon2_big", inputs: [
      7n,
      21888242871839275222246405745257275088548364400416034343698204186575808495616n, // p-1
  ] },
  { name: "poseidon3", inputs: [1n, 2n, 3n] },
];

(async () => {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const out = {};
  for (const c of CASES) {
    const h = poseidon(c.inputs);
    const dec = F.toString(h); // decimal string of the field element
    out[c.name] = { inputs: c.inputs.map(String), hash: dec };
    console.log(`${c.name}(${c.inputs.join(",")}) = ${dec}`);
  }
  require("fs").writeFileSync(
    __dirname + "/golden.json",
    JSON.stringify(out, null, 2)
  );
  console.log("wrote golden.json");
})();
