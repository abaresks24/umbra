// ENFORCED auditor disclosure — integration test (offline). Prove a real transfer
// with the upgraded circuit, then show the auditor reconstructs the output notes
// directly from the proof's PUBLIC SIGNALS (so it's enforced by proof, not by an
// honest client). Also checks the auditor pubkey is pinned in the public signals.
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const { initPoseidon, poseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { initAuditor, newAuditorKey, decryptAuditOutput } = require("../client/lib/auditor");

const VK = JSON.parse(fs.readFileSync(path.join(__dirname, "../circuits/build/transfer_vk.json")));
let pass = 0, fail = 0;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

(async () => {
  await initPoseidon();
  await initAuditor();
  const alice = new Keypair(), bob = new Keypair();
  const auditor = newAuditorKey();
  const tree = buildTree([]);

  // SHIELD 100 of asset #2 to Alice (output 0 = real, output 1 = dummy)
  const ASSET = 2n;
  const A1 = new Note({ amount: 100n, assetId: ASSET, owner: alice });
  const r = buildWitness({
    tree, inputs: [], outputs: [A1], publicAmount: 100n, assetId: ASSET,
    extData: { recipient: "x", extAmount: "100", fee: "0" }, auditor,
  });
  const { proof, publicSignals } = await prove(r.witness);

  ck("proof verifies (with enforced auditor encryption)", await snarkjs.groth16.verify(VK, publicSignals, proof));
  ck("public-signal order matches builder", JSON.stringify(publicSignals) === JSON.stringify(r.expectedPublic));
  // shield is an edge, so the asset IS revealed here (= ASSET)
  ck("revealedAssetId == asset at an edge", publicSignals[3] === ASSET.toString());

  // signals: root(0) pubAmt(1) edHash(2) revealedAsset(3) null(4,5) commit(6,7)
  //          audPub(8,9) R(10,11) c0(12-15) c1(16-19)   [cipher is 4 fields now]
  const audPub = [publicSignals[8], publicSignals[9]];
  ck("auditor pubkey pinned in public signals", audPub[0] === auditor.pubX && audPub[1] === auditor.pubY);

  const R = [publicSignals[10], publicSignals[11]];
  const cipher0 = [publicSignals[12], publicSignals[13], publicSignals[14], publicSignals[15]];

  // Auditor decrypts output 0 -> [amount, assetId, pubkey, blinding] from the proof.
  const m0 = decryptAuditOutput(R, cipher0, 0, auditor.priv);
  ck("auditor recovers output-0 amount = 100", m0[0] === 100n);
  ck("auditor recovers the (otherwise hidden) asset", m0[1] === ASSET);
  ck("recovered note recomputes to the on-chain commitment", poseidon([m0[0], m0[1], m0[2], m0[3]]).toString() === publicSignals[6]);

  // Output 1 is the dummy (amount 0).
  const cipher1 = [publicSignals[16], publicSignals[17], publicSignals[18], publicSignals[19]];
  const m1 = decryptAuditOutput(R, cipher1, 1, auditor.priv);
  ck("auditor recovers output-1 (dummy) amount = 0", m1[0] === 0n);

  // A wrong auditor key cannot recover the amount.
  const other = newAuditorKey();
  const bad = decryptAuditOutput(R, cipher0, 0, other.priv);
  ck("wrong auditor key fails", bad[0] !== 100n);

  console.log(`\n${fail === 0 ? "🎉" : "❌"} enforced-audit: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
