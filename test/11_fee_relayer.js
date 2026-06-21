// Fee / relayer gate: a THIRD party submits the user's private transfer and is
// paid a fee out of the shielded value — so the user never touches the chain.
// publicAmount = extAmount - fee is enforced in-circuit; the contract pays `fee`
// of the asset to whoever submitted (the relayer).
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { initAuditor, newAuditorKey } = require("../client/lib/auditor");
const { proofToHex, publicToHex, vkToHex } = require("../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const WASM = path.join(ROOT, "contracts/pool/target/wasm32v1-none/release/shielded_pool.wasm");
const VK = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));
const e = Object.fromEntries(fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("=")));
function sh(c) { let last; for (let i = 0; i < 4; i++) { try { return execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch (err) { const m = String(err.stderr || err.message); if (!/Connect|SendRequest|timeout|503|429/i.test(m)) throw err; last = err; execSync("sleep 3"); } } throw last; }
let CID, pass = 0, fail = 0;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };
const inv = (a, src = "shield") => sh(`stellar contract invoke --id ${CID} --source ${src} --network testnet -- ${a}`).replace(/"/g, "");
const sendAs = (src, a) => sh(`stellar contract invoke --id ${CID} --source ${src} --network testnet --send=yes -- ${a}`);
const bal = (addr) => BigInt(sh(`stellar contract invoke --id ${e.USDC_SAC} --source shield --network testnet -- balance --id ${addr}`).replace(/"/g, ""));

(async () => {
  await initPoseidon(); await initAuditor();
  const auditor = newAuditorKey(); const alice = new Keypair(); const tree = buildTree([]);
  CID = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  inv(`init --admin ${e.USER_ADDR} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);
  inv(`register_asset --asset_id 0 --token ${e.USDC_SAC}`);
  console.log(`pool: ${CID}\n`);
  const aud = { pubX: auditor.pubX, pubY: auditor.pubY };

  // shield 100 (pool funded)
  const A = new Note({ amount: 100n, assetId: 0n, owner: alice });
  let r = buildWitness({ tree, inputs: [], outputs: [A], publicAmount: 100n, assetId: 0n, auditor: aud, extData: { recipient: e.USER_ADDR, extAmount: "100", fee: "0", encryptedOutput1: "00", encryptedOutput2: "00" } });
  let pr = await prove(r.witness);
  sendAs("shield", `transact --caller ${e.USER_ADDR} --proof ${proofToHex(pr.proof)} --public ${publicToHex(pr.publicSignals)} --recipient ${e.USER_ADDR} --ext_amount=100 --fee=0 --enc1 ${r.enc1} --enc2 ${r.enc2}`);
  tree.insert(r.outputCommitment[0]); tree.insert(r.outputCommitment[1]);
  console.log("  ✓ shielded 100 (pool funded)");

  // private transfer with fee=5, submitted by the RELAYER (recipient identity, != owner)
  const relayerBefore = bal(e.RECIP_ADDR), poolBefore = bal(CID);
  const toSelf = new Note({ amount: 95n, assetId: 0n, owner: alice }); // 100 - 5 fee
  r = buildWitness({ tree, inputs: [{ note: A, index: 0 }], outputs: [toSelf], publicAmount: -5n, assetId: 0n, auditor: aud,
    extData: { recipient: e.USER_ADDR, extAmount: "0", fee: "5", encryptedOutput1: "00", encryptedOutput2: "00" } });
  pr = await prove(r.witness);
  try {
    sendAs("recipient", `transact --caller ${e.RECIP_ADDR} --proof ${proofToHex(pr.proof)} --public ${publicToHex(pr.publicSignals)} --recipient ${e.USER_ADDR} --ext_amount=0 --fee=5 --enc1 ${r.enc1} --enc2 ${r.enc2}`);
    ck("relayer submitted the user's private transfer", true);
  } catch (err) { ck("relayer submit: " + String(err.message).slice(0, 80), false); }

  ck(`relayer earned the 5 fee (Δ=${bal(e.RECIP_ADDR) - relayerBefore})`, bal(e.RECIP_ADDR) - relayerBefore === 5n);
  ck(`pool paid 5 out (Δ=${poolBefore - bal(CID)})`, poolBefore - bal(CID) === 5n);

  console.log(`\n${fail === 0 ? "🎉 FEE/RELAYER WORKS" : "❌"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error("❌", err.message || err); process.exit(1); });
