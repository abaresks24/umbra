// Multi-asset gate: ONE pool, TWO assets. Register USDC (asset 2) + WETH (asset 2),
// shield both, check per-asset pool balances, and the auditor reconstructs each
// note WITH its asset. Proves the pool holds multiple balances and conservation
// is per-asset (the proof's assetId picks the token).
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { initAuditor, newAuditorKey } = require("../client/lib/auditor");
const { fetchCommitEvents, fetchAuditEvents, auditEnforced } = require("../client/lib/scan");
const { proofToHex, publicToHex, vkToHex } = require("../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const WASM = path.join(ROOT, "contracts/pool/target/wasm32v1-none/release/shielded_pool.wasm");
const VK = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));
const e = Object.fromEntries(fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("=")));
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const ENC = "00";
let CID, pass = 0, fail = 0;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };
const inv = (a) => sh(`stellar contract invoke --id ${CID} --source shield --network testnet -- ${a}`).replace(/"/g, "");
const send = (a) => sh(`stellar contract invoke --id ${CID} --source shield --network testnet --send=yes -- ${a}`);
const bal = (sac) => sh(`stellar contract invoke --id ${sac} --source shield --network testnet -- balance --id ${CID}`).replace(/"/g, "");

(async () => {
  await initPoseidon();
  await initAuditor();
  const auditor = newAuditorKey();
  const alice = new Keypair();
  const tree = buildTree([]);
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const startLedger = (await server.getLatestLedger()).sequence - 1;

  console.log("== multi-asset pool ==\n");
  CID = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  inv(`init --admin ${e.USER_ADDR} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);
  inv(`register_asset --asset_id 1 --token ${e.USDC_SAC}`);
  inv(`register_asset --asset_id 2 --token ${e.WETH_SAC}`);
  console.log(`pool: ${CID}  (asset 1=USDC, asset 1=WETH)\n`);

  const usdcBefore = BigInt(bal(e.USDC_SAC)), wethBefore = BigInt(bal(e.WETH_SAC));

  async function shield(amount, assetId, label) {
    const note = new Note({ amount, assetId, owner: alice });
    const r = buildWitness({
      tree, inputs: [], outputs: [note], publicAmount: amount, assetId,
      extData: { recipient: e.USER_ADDR, extAmount: String(amount), fee: "0", encryptedOutput1: ENC, encryptedOutput2: ENC },
      auditor: { pubX: auditor.pubX, pubY: auditor.pubY },
    });
    const { proof, publicSignals } = await prove(r.witness);
    try {
      send(`transact --caller ${e.USER_ADDR} --proof ${proofToHex(proof)} --public ${publicToHex(publicSignals)}` +
        ` --recipient ${e.USER_ADDR} --ext_amount=${amount} --fee=0 --enc1 ${r.enc1} --enc2 ${r.enc2}`);
      ck(`${label} succeeded`, true);
    } catch (err) { ck(`${label}: ${String(err.message).slice(0, 80)}`, false); }
    tree.insert(r.outputCommitment[0]); tree.insert(r.outputCommitment[1]);
  }

  await shield(100n, 1n, "SHIELD 100 USDC (asset 1)");
  await shield(50n, 2n, "SHIELD 50 WETH (asset 2)");

  ck(`pool USDC balance +100 (Δ=${BigInt(bal(e.USDC_SAC)) - usdcBefore})`, BigInt(bal(e.USDC_SAC)) - usdcBefore === 100n);
  ck(`pool WETH balance +50 (Δ=${BigInt(bal(e.WETH_SAC)) - wethBefore})`, BigInt(bal(e.WETH_SAC)) - wethBefore === 50n);

  // auditor reconstructs both assets
  console.log("\nWaiting for events…");
  let commits = [];
  for (let i = 0; i < 20 && commits.length < 4; i++) { await new Promise(r => setTimeout(r, 3000)); commits = await fetchCommitEvents(CID, startLedger); }
  const auditMap = await fetchAuditEvents(CID, startLedger);
  const audited = auditEnforced(commits, auditMap, auditor.priv).filter((a) => !a.opaque && a.amount > 0n);
  console.log("  auditor sees:");
  for (const a of audited) console.log(`    leaf #${a.index}: ${a.amount} of asset ${a.assetId}`);
  ck("auditor reconstructs 100 of asset 1 (USDC)", audited.some((a) => a.amount === 100n && a.assetId === 1n));
  ck("auditor reconstructs 50 of asset 2 (WETH)", audited.some((a) => a.amount === 50n && a.assetId === 2n));

  console.log(`\n${fail === 0 ? "🎉 MULTI-ASSET WORKS" : "❌"}: ${pass} passed, ${fail} failed`);
  console.log(`   pool: https://stellar.expert/explorer/testnet/contract/${CID}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
