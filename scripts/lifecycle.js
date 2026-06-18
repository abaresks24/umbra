// Phase 1 ON-CHAIN gate: a full shield -> private transfer -> unshield lifecycle
// where every proof is verified by the Groth16 verifier contract on Stellar
// testnet. This is the Phase 1 acceptance test — submittable on its own.
const fs = require("fs");
const path = require("path");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { deployVerifier, setVk, verifyOnChain } = require("../client/lib/onchain");

const B = path.join(__dirname, "../circuits/build");
const VK = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));

(async () => {
  await initPoseidon();
  console.log("== Phase 1 on-chain lifecycle ==\n");

  console.log("Deploying transfer verifier + storing VK on testnet...");
  const cid = deployVerifier();
  setVk(cid, VK);
  fs.writeFileSync(path.join(B, "transfer_verifier_id.txt"), cid + "\n");
  console.log(`verifier: ${cid}\n`);

  const alice = new Keypair();
  const bob = new Keypair();
  const tree = buildTree([]);

  async function run(name, params) {
    const { witness, expectedPublic } = buildWitness(params);
    const { proof, publicSignals } = await prove(witness);
    if (JSON.stringify(publicSignals) !== JSON.stringify(expectedPublic))
      throw new Error(`${name}: public signal order mismatch`);
    const ok = verifyOnChain(cid, proof, publicSignals);
    console.log(`  ${ok ? "✅" : "❌"} ${name}: on-chain verify = ${ok}`);
    if (!ok) throw new Error(`${name} rejected on-chain`);
    return publicSignals;
  }

  // 1) SHIELD 100
  const A1 = new Note({ amount: 100n, owner: alice });
  await run("SHIELD 100", {
    tree, inputs: [], outputs: [A1], publicAmount: 100n,
    extData: { recipient: "", extAmount: "100", fee: "0" },
  });
  tree.insert(A1.commitment().toString());
  const A1i = tree.elements.length - 1;

  // 2) TRANSFER 60 to Bob (+40 change to Alice), fully private
  const toBob = new Note({ amount: 60n, owner: bob.pubkey });
  const change = new Note({ amount: 40n, owner: alice });
  await run("TRANSFER 60 to Bob", {
    tree, inputs: [{ note: A1, index: A1i }], outputs: [toBob, change], publicAmount: 0n,
    extData: { recipient: bob.address(), extAmount: "0", fee: "0" },
  });
  tree.insert(toBob.commitment().toString());
  tree.insert(change.commitment().toString());
  const ci = tree.elements.length - 1;

  // 3) UNSHIELD 40 (Alice withdraws her change publicly)
  await run("UNSHIELD 40", {
    tree, inputs: [{ note: change, index: ci }], outputs: [], publicAmount: -40n,
    extData: { recipient: "GPUBLIC...", extAmount: "-40", fee: "0" },
  });

  console.log(`\n🎉 Phase 1 ON-CHAIN gate passed. Verifier: ${cid}`);
  console.log(`   https://stellar.expert/explorer/testnet/contract/${cid}`);
  process.exit(0);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
