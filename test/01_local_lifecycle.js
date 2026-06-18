// Phase 1 local gate: shield -> private transfer -> unshield, each proof verified
// locally with snarkjs against the transfer VK. No chain yet (that's 02_*).
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");

const VK = JSON.parse(fs.readFileSync(path.join(__dirname, "../circuits/build/transfer_vk.json")));

async function step(name, params) {
  const { witness, expectedPublic, outputCommitment, inputNullifier } = buildWitness(params);
  const { proof, publicSignals } = await prove(witness);
  // public signals must match what we expect, in order
  for (let i = 0; i < expectedPublic.length; i++) {
    if (publicSignals[i] !== expectedPublic[i])
      throw new Error(`${name}: public[${i}] mismatch ${publicSignals[i]} != ${expectedPublic[i]}`);
  }
  const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
  if (!ok) throw new Error(`${name}: snarkjs verify FAILED`);
  console.log(`  ✅ ${name}: proof verified locally (nullifiers=${inputNullifier.length}, outCommits=${outputCommitment.length})`);
  return { outputCommitment, inputNullifier };
}

(async () => {
  await initPoseidon();
  const alice = new Keypair();
  const bob = new Keypair();
  const tree = buildTree([]);
  console.log("Phase 1 local lifecycle (depth 8 tree)\n");

  // 1) SHIELD 100 -> Alice note A1
  const A1 = new Note({ amount: 100n, owner: alice });
  await step("SHIELD 100", {
    tree, inputs: [], outputs: [A1], publicAmount: 100n,
    extData: { recipient: "", extAmount: "100", fee: "0" },
  });
  tree.insert(A1.commitment().toString());
  const A1index = tree.elements.length - 1;

  // 2) TRANSFER: Alice spends A1 -> Bob 60, change to Alice 40
  const toBob = new Note({ amount: 60n, owner: bob.pubkey });
  const change = new Note({ amount: 40n, owner: alice });
  await step("TRANSFER 60 to Bob", {
    tree, inputs: [{ note: A1, index: A1index }], outputs: [toBob, change], publicAmount: 0n,
    extData: { recipient: bob.address(), extAmount: "0", fee: "0" },
  });
  tree.insert(toBob.commitment().toString());
  tree.insert(change.commitment().toString());
  const changeIndex = tree.elements.length - 1;

  // 3) UNSHIELD 40: Alice spends her change note, pays out publicly
  await step("UNSHIELD 40", {
    tree, inputs: [{ note: change, index: changeIndex }], outputs: [], publicAmount: -40n,
    extData: { recipient: "GPUBLIC...", extAmount: "-40", fee: "0" },
  });

  console.log("\n🎉 Phase 1 LOCAL gate passed: shield -> transfer -> unshield all verify.");
  process.exit(0);
})().catch((e) => { console.error("❌", e); process.exit(1); });
