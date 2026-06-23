// Proves the wallet can compute "spent" from the CHAIN (no local bookkeeping):
// shield two notes, spend one, and verify only the spent note's nullifier shows
// up in the on-chain `nullify` events — so balance is correct on any device.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { initAuditor, newAuditorKey } = require("../client/lib/auditor");
const { fetchSpentNullifiers, nullifierHex } = require("../client/lib/scan");
const { proofToHex, publicToHex, vkToHex } = require("../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const WASM = path.join(ROOT, "contracts/pool/target/wasm32v1-none/release/shielded_pool.wasm");
const VK = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));
const e = Object.fromEntries(fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("=")));
function sh(c) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
    catch (err) {
      const m = String(err.stderr || err.message);
      if (!/Connect|SendRequest|timeout|503|429|temporarily/i.test(m)) throw err;
      last = err; execSync("sleep 3");
    }
  }
  throw last;
}
let CID, pass = 0, fail = 0, auditor;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };
const inv = (a) => sh(`stellar contract invoke --id ${CID} --source shield --network testnet -- ${a}`).replace(/"/g, "");
const send = (a) => sh(`stellar contract invoke --id ${CID} --source shield --network testnet --send=yes -- ${a}`);

(async () => {
  await initPoseidon();
  await initAuditor();
  auditor = newAuditorKey();
  const alice = new Keypair();
  const tree = buildTree([]);
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const startLedger = (await server.getLatestLedger()).sequence - 1;

  CID = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  inv(`init --admin ${e.USER_ADDR} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);
  inv(`register_asset --asset_id 1 --token ${e.USDC_SAC}`);
  console.log(`pool: ${CID}\n`);

  async function tx(label, params, ext, recipient) {
    const r = buildWitness({ ...params, assetId: 1n, auditor: { pubX: auditor.pubX, pubY: auditor.pubY } });
    const { proof, publicSignals } = await prove(r.witness);
    send(`transact --caller ${e.USER_ADDR} --proof ${proofToHex(proof)} --public ${publicToHex(publicSignals)}` +
      ` --recipient ${recipient} --ext_amount=${ext} --fee=0 --enc1 ${r.enc1} --enc2 ${r.enc2}`);
    const base = tree.elements.length; tree.insert(r.outputCommitment[0]); tree.insert(r.outputCommitment[1]);
    console.log(`  ✓ ${label}`); return base;
  }

  const ed = (amt) => ({ recipient: e.USER_ADDR, extAmount: String(amt), fee: "0", encryptedOutput1: "00", encryptedOutput2: "00" });
  // shield A=100 and B=50
  const A = new Note({ amount: 100n, assetId: 1n, owner: alice });
  const ai = await tx("SHIELD A=100", { tree, inputs: [], outputs: [A], publicAmount: 100n, extData: ed(100) }, 100, e.USER_ADDR);
  const Bn = new Note({ amount: 50n, assetId: 1n, owner: alice });
  const bi = await tx("SHIELD B=50", { tree, inputs: [], outputs: [Bn], publicAmount: 50n, extData: ed(50) }, 50, e.USER_ADDR);

  // spend A (unshield 100); leave B unspent
  await tx("UNSHIELD A (spend A)", { tree, inputs: [{ note: A, index: ai }], outputs: [], publicAmount: -100n, extData: { ...ed(-100), recipient: e.RECIP_ADDR } }, -100, e.RECIP_ADDR);

  console.log("\nwaiting for nullify events…");
  let spent = new Set();
  const aHex = nullifierHex(A.nullifier(ai)), bHex = nullifierHex(Bn.nullifier(bi));
  for (let i = 0; i < 20 && !spent.has(aHex); i++) { await new Promise((r) => setTimeout(r, 3000)); spent = await fetchSpentNullifiers(CID, startLedger); }

  ck("spent note A's nullifier is on-chain (detected without localStorage)", spent.has(aHex));
  ck("unspent note B's nullifier is NOT marked spent", !spent.has(bHex));
  console.log(`  (on-chain spent-set size: ${spent.size})`);

  console.log(`\n${fail === 0 ? "🎉 ON-CHAIN SPENT-TRACKING WORKS" : "❌"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error("❌", err.message || err); process.exit(1); });
