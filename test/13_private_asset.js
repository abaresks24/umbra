// Private asset type: for a PURE TRANSFER the asset is hidden from the public
// (revealedAssetId == 0), yet (a) it is provably preserved (you can't turn USDC
// into WETH) and (b) the auditor still reconstructs it. At an edge it's revealed.
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
const ASSET = 2n; // some non-zero asset (e.g. WETH)

(async () => {
  await initPoseidon(); await initAuditor();
  const alice = new Keypair();
  const auditor = newAuditorKey();
  const aud = { pubX: auditor.pubX, pubY: auditor.pubY };
  const tree = buildTree([]);

  // shield 100 of asset 2 -> note A  (edge: asset revealed)
  const A = new Note({ amount: 100n, assetId: ASSET, owner: alice });
  let r = buildWitness({ tree, inputs: [], outputs: [A], publicAmount: 100n, assetId: ASSET, auditor: aud, extData: { recipient: "x", extAmount: "100", fee: "0" } });
  let pr = await prove(r.witness);
  ck("shield proof verifies", await snarkjs.groth16.verify(VK, pr.publicSignals, pr.proof));
  ck("at the shield edge, asset IS revealed (= 2)", pr.publicSignals[3] === "2");
  tree.insert(r.outputCommitment[0]); tree.insert(r.outputCommitment[1]);

  // PURE TRANSFER: spend A -> new 100 note to self, publicAmount 0 (asset hidden)
  const A2 = new Note({ amount: 100n, assetId: ASSET, owner: alice });
  r = buildWitness({ tree, inputs: [{ note: A, index: 0 }], outputs: [A2], publicAmount: 0n, assetId: ASSET, auditor: aud, extData: { recipient: "x", extAmount: "0", fee: "0" } });
  pr = await prove(r.witness);
  ck("transfer proof verifies", await snarkjs.groth16.verify(VK, pr.publicSignals, pr.proof));
  ck("on a private transfer the asset is HIDDEN (revealedAssetId == 0)", pr.publicSignals[3] === "0");

  // the auditor still recovers the asset from the ciphertext
  const R = [pr.publicSignals[10], pr.publicSignals[11]];
  const c0 = [pr.publicSignals[12], pr.publicSignals[13], pr.publicSignals[14], pr.publicSignals[15]];
  const m = decryptAuditOutput(R, c0, 0, auditor.priv); // [amount, assetId, pubkey, blinding]
  ck("auditor still sees the asset on a hidden transfer", m[1] === ASSET);
  ck("recovered note matches the on-chain commitment", poseidon([m[0], m[1], m[2], m[3]]).toString() === pr.publicSignals[6]);

  // soundness: can't change the asset across a transfer (would break Merkle membership)
  let crossAsset = false;
  try {
    const wrong = buildWitness({ tree, inputs: [{ note: A, index: 0 }], outputs: [new Note({ amount: 100n, assetId: 99n, owner: alice })], publicAmount: 0n, assetId: 99n, auditor: aud, extData: { recipient: "x", extAmount: "0", fee: "0" } });
    const wp = await prove(wrong.witness);
    crossAsset = !(await snarkjs.groth16.verify(VK, wp.publicSignals, wp.proof));
  } catch { crossAsset = true; }
  ck("can't spend an asset-2 note as asset-99 (no cross-asset minting)", crossAsset);

  console.log(`\n${fail === 0 ? "🎉 PRIVATE ASSET WORKS" : "❌"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
