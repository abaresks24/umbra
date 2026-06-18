// Phase 1 soundness tests — prove the ZK is load-bearing, not cosmetic.
// A verifier that always returns true would pass 01/lifecycle; these must fail
// in the right places.
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");

const VK = JSON.parse(fs.readFileSync(path.join(__dirname, "../circuits/build/transfer_vk.json")));
let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? "✅" : "❌"} ${name}`); cond ? pass++ : fail++; }

(async () => {
  await initPoseidon();
  const alice = new Keypair();
  const tree = buildTree([]);

  // Valid baseline shield proof.
  const A1 = new Note({ amount: 100n, owner: alice });
  const { witness } = buildWitness({
    tree, inputs: [], outputs: [A1, new Note({ amount: 0n, owner: alice })],
    publicAmount: 100n, extData: { recipient: "", extAmount: "100", fee: "0" },
  });
  const { proof, publicSignals } = await prove(witness);
  check("baseline proof verifies", await snarkjs.groth16.verify(VK, publicSignals, proof));

  // (1) Tamper publicAmount (claim to shield more than proven) -> reject.
  const tampered = publicSignals.slice();
  tampered[1] = (BigInt(tampered[1]) + 1n).toString();
  check("tampered publicAmount rejected", !(await snarkjs.groth16.verify(VK, tampered, proof)));

  // (2) Tamper an output commitment -> reject.
  const t2 = publicSignals.slice();
  t2[5] = (BigInt(t2[5]) + 1n).toString();
  check("tampered output commitment rejected", !(await snarkjs.groth16.verify(VK, t2, proof)));

  // (3) Value non-conservation must be impossible to prove (caught off-chain too).
  let conserved = false;
  try {
    buildWitness({ tree, inputs: [], outputs: [new Note({ amount: 100n, owner: alice })],
      publicAmount: 50n, extData: { recipient: "", extAmount: "50", fee: "0" } }); // 50 != 100
  } catch { conserved = true; }
  check("non-conserving tx rejected (in != out + public)", conserved);

  // (4) Double-spend in one tx: same note in both input slots -> circuit distinctness fails.
  const tree2 = buildTree([]);
  const N = new Note({ amount: 100n, owner: alice });
  tree2.insert(N.commitment().toString());
  let doubleSpendBlocked = false;
  try {
    const { witness: w } = buildWitness({
      tree: tree2,
      inputs: [{ note: N, index: 0 }, { note: N, index: 0 }], // same note twice
      outputs: [new Note({ amount: 200n, owner: alice })],
      publicAmount: 0n, extData: { recipient: "", extAmount: "0", fee: "0" },
    });
    await prove(w); // should throw: duplicate nullifier violates IsEqual===0
  } catch { doubleSpendBlocked = true; }
  check("double-spend (duplicate nullifier) unprovable", doubleSpendBlocked);

  // (5) Spending a note NOT in the tree (forged membership) -> unprovable.
  const emptyTree = buildTree([]);
  const ghost = new Note({ amount: 100n, owner: alice });
  let forgeBlocked = false;
  try {
    const { witness: w } = buildWitness({
      tree: emptyTree, inputs: [{ note: ghost, index: 0 }],
      outputs: [new Note({ amount: 100n, owner: alice })],
      publicAmount: 0n, extData: { recipient: "", extAmount: "0", fee: "0" },
    });
    const r = await prove(w);
    forgeBlocked = !(await snarkjs.groth16.verify(VK, r.publicSignals, r.proof));
  } catch { forgeBlocked = true; }
  check("spending a note absent from the tree unprovable", forgeBlocked);

  console.log(`\n${fail === 0 ? "🎉" : "⚠️"} soundness: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
