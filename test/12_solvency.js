// Solvency invariant: after ANY sequence of operations, the pool's on-chain token
// balance equals exactly (total shielded - total unshielded - total fees), which
// also equals the sum of unspent notes. The pool can never hold less than it owes
// (over-draining) nor more (value created from nothing) — the core safety property.
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
let CID, pass = 0, fail = 0, auditor;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };
const inv = (a) => sh(`stellar contract invoke --id ${CID} --source shield --network testnet -- ${a}`).replace(/"/g, "");
const send = (a) => sh(`stellar contract invoke --id ${CID} --source shield --network testnet --send=yes -- ${a}`);
const poolBal = () => BigInt(sh(`stellar contract invoke --id ${e.USDC_SAC} --source shield --network testnet -- balance --id ${CID}`).replace(/"/g, ""));

(async () => {
  await initPoseidon(); await initAuditor();
  auditor = newAuditorKey();
  const alice = new Keypair(), bob = new Keypair();
  const tree = buildTree([]);
  const aud = { pubX: auditor.pubX, pubY: auditor.pubY };
  let deposited = 0n, withdrawn = 0n, fees = 0n;
  const ledger = []; // ground-truth { note, index, spent }

  CID = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  inv(`init --admin ${e.USER_ADDR} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);
  inv(`register_asset --asset_id 1 --token ${e.USDC_SAC}`);
  const start = poolBal();
  console.log(`pool: ${CID}\n`);

  // run one transact; record real outputs into the ledger
  async function op(label, { inputs = [], outputs, extAmount, fee = 0 }) {
    for (const x of inputs) x.entry.spent = true;
    const r = buildWitness({
      tree, inputs: inputs.map((x) => ({ note: x.entry.note, index: x.entry.index })),
      outputs: outputs.map((o) => o.note), publicAmount: BigInt(extAmount) - BigInt(fee), assetId: 1n, auditor: aud,
      extData: { recipient: e.USER_ADDR, extAmount: String(extAmount), fee: String(fee), encryptedOutput1: "00", encryptedOutput2: "00" },
    });
    const pr = await prove(r.witness);
    send(`transact --caller ${e.USER_ADDR} --proof ${proofToHex(pr.proof)} --public ${publicToHex(pr.publicSignals)} --recipient ${e.USER_ADDR} --ext_amount=${extAmount} --fee=${fee} --enc1 ${r.enc1} --enc2 ${r.enc2}`);
    const base = tree.elements.length; tree.insert(r.outputCommitment[0]); tree.insert(r.outputCommitment[1]);
    outputs.forEach((o, i) => { o.entry = { note: o.note, index: base + i, spent: false }; ledger.push(o.entry); });
    if (extAmount > 0) deposited += BigInt(extAmount);
    if (extAmount < 0) withdrawn += BigInt(-extAmount);
    fees += BigInt(fee);
    console.log(`  ✓ ${label}`);
  }

  const N = (amt, owner) => ({ note: new Note({ amount: BigInt(amt), assetId: 1n, owner }) });
  const A = N(100, alice), Bn = N(50, alice);
  await op("shield 100", { outputs: [A], extAmount: 100 });
  await op("shield 50", { outputs: [Bn], extAmount: 50 });
  const toBob = N(60, bob.pubkey), change = N(40, alice);
  await op("transfer: A -> Bob 60 + change 40", { inputs: [A], outputs: [toBob, change], extAmount: 0 });
  await op("unshield 40 (spend change)", { inputs: [change], outputs: [N(0, alice)], extAmount: -40 });
  const self45 = N(45, alice);
  await op("transfer+fee: B -> self 45, fee 5", { inputs: [Bn], outputs: [self45], extAmount: 0, fee: 5 });

  const pool = poolBal() - start;
  const net = deposited - withdrawn - fees;
  const unspent = ledger.filter((x) => !x.spent).reduce((a, x) => a + x.note.amount, 0n);
  console.log(`\n  pool balance Δ = ${pool} | net (in-out-fees) = ${net} | Σ unspent notes = ${unspent}`);
  ck("pool balance == total shielded - unshielded - fees", pool === net);
  ck("pool balance == sum of unspent notes (solvency)", pool === unspent);

  console.log(`\n${fail === 0 ? "🎉 SOLVENCY HOLDS" : "❌"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error("❌", err.message || err); process.exit(1); });
