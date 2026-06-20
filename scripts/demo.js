// Headline demo: a private shielded-USDC lifecycle on testnet, then the
// compliance reveal. Alice shields, privately pays Bob, and unshields. On-chain
// everything is opaque commitments. Then:
//   - BOB scans events with his viewing key and discovers his incoming note.
//   - the AUDITOR scans with the auditor key and reconstructs every amount+owner.
// This is the "privacy a regulator can accept" story, end to end.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { newViewingKeypair } = require("../client/lib/encryption");
const { initAuditor, newAuditorKey } = require("../client/lib/auditor");
const { fetchCommitEvents, fetchAuditEvents, scanOwned, auditEnforced } = require("../client/lib/scan");
const { proofToHex, publicToHex, vkToHex } = require("./bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const WASM = path.join(ROOT, "contracts/pool/target/wasm32v1-none/release/shielded_pool.wasm");
const VK = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));
const e = Object.fromEntries(fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("=")));
const { USDC_SAC, USER_ADDR, RECIP_ADDR } = e;

function sh(c) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { return execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
    catch (e) {
      const msg = String(e.stderr || e.message);
      if (!/Connect|timeout|503|429|temporarily/i.test(msg)) throw e; // only retry transient
      lastErr = e; execSync("sleep 3");
    }
  }
  throw lastErr;
}
let CID;
const inv = (a) => sh(`stellar contract invoke --id ${CID} --source shield --network testnet -- ${a}`).replace(/"/g, "");
const send = (a) => sh(`stellar contract invoke --id ${CID} --source shield --network testnet --send=yes -- ${a}`);

const line = (s = "") => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await initPoseidon();
  line("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  line("  Shielded USDC on Stellar — private payments a regulator can accept");
  line("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // identities: each party has a spend key (nullifiers) + a viewing key (scanning)
  await initAuditor();
  const alice = { spend: new Keypair(), view: newViewingKeypair() };
  const bob = { spend: new Keypair(), view: newViewingKeypair() };
  const auditor = newAuditorKey(); // Baby Jubjub — encryption ENFORCED in-circuit
  line(`auditor pubkey (Baby Jubjub, pinned in the contract): ${auditor.pubX.slice(0, 22)}…\n`);

  // deploy + init pool, capture the ledger to scan from
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const startLedger = (await server.getLatestLedger()).sequence - 1;
  CID = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  inv(`init --token ${USDC_SAC} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);
  line(`pool deployed: ${CID}\n`);

  const tree = buildTree([]);
  const enc = (recipients) => ({ senderViewPub: alice.view.viewPub, recipients });
  const auditorKey = { pubX: auditor.pubX, pubY: auditor.pubY };

  async function transact(label, params, extAmount, recipient) {
    const r = buildWitness({ ...params, auditor: auditorKey });
    const { proof, publicSignals } = await prove(r.witness);
    const args =
      `transact --caller ${USER_ADDR} --proof ${proofToHex(proof)} --public ${publicToHex(publicSignals)}` +
      ` --recipient ${recipient} --ext_amount=${extAmount} --fee=0 --enc1 ${r.enc1} --enc2 ${r.enc2}`;
    send(args);
    const base = tree.elements.length;
    tree.insert(r.outputCommitment[0]);
    tree.insert(r.outputCommitment[1]);
    line(`  ✓ ${label}`);
    return base;
  }

  line("Alice's actions (all amounts hidden on-chain):");
  // SHIELD 100 to Alice
  const A1 = new Note({ amount: 100n, owner: alice.spend });
  const a1i = await transact("SHIELD  100 USDC into the pool", {
    tree, inputs: [], outputs: [A1], publicAmount: 100n,
    extData: { recipient: USER_ADDR, extAmount: "100", fee: "0" }, enc: enc([alice.view.viewPub]),
  }, 100, USER_ADDR);

  // TRANSFER 60 to Bob, 40 change to Alice
  const toBob = new Note({ amount: 60n, owner: bob.spend.pubkey });
  const change = new Note({ amount: 40n, owner: alice.spend });
  const tIdx = await transact("SEND    60 USDC privately to Bob (+40 change)", {
    tree, inputs: [{ note: A1, index: a1i }], outputs: [toBob, change], publicAmount: 0n,
    extData: { recipient: USER_ADDR, extAmount: "0", fee: "0" }, enc: enc([bob.view.viewPub, alice.view.viewPub]),
  }, 0, USER_ADDR);
  const changeIdx = tIdx + 1;

  // UNSHIELD 40 to a public recipient
  await transact("UNSHIELD 40 USDC to a public address", {
    tree, inputs: [{ note: change, index: changeIdx }], outputs: [], publicAmount: -40n,
    extData: { recipient: RECIP_ADDR, extAmount: "-40", fee: "0" }, enc: enc([alice.view.viewPub]),
  }, -40, RECIP_ADDR);

  // wait for the RPC to index the events
  line("\nWaiting for events to be indexed…");
  let events = [];
  for (let i = 0; i < 20 && events.length < 6; i++) { await sleep(3000); events = await fetchCommitEvents(CID, startLedger); }

  // ── what the public chain shows ──
  line("\n┌─ WHAT THE BLOCKCHAIN SHOWS (anyone) ───────────────────────────");
  for (const ev of events)
    line(`│  leaf #${ev.index}  commitment ${ev.commitment.slice(0, 18)}…   amount: ??? owner: ???`);
  line("└────────────────────────────────────────────────────────────────");

  // ── Bob scans and finds his note ──
  const bobNotes = scanOwned(events, bob.view.viewSecret, bob.spend);
  line("\n┌─ BOB scans with his VIEWING KEY ───────────────────────────────");
  for (const n of bobNotes) line(`│  ✅ discovered an incoming note: ${n.amount} USDC at leaf #${n.index}`);
  line(`└─ Bob found ${bobNotes.length} note(s) totalling ${bobNotes.reduce((a, n) => a + n.amount, 0n)} USDC`);

  // ── Auditor reconstructs everything — from the ENFORCED on-chain ciphertext ──
  const auditMap = await fetchAuditEvents(CID, startLedger);
  const audited = auditEnforced(events, auditMap, auditor.priv);
  line("\n┌─ AUDITOR reconstructs (in-circuit ENFORCED disclosure) ─────────");
  for (const a of audited) {
    if (a.opaque) line(`│  leaf #${a.index}  (could not decrypt — should not happen)`);
    else line(`│  leaf #${a.index}  amount ${String(a.amount).padStart(4)} USDC   owner ${a.owner.slice(0, 14)}…`);
  }
  line("└─ ENFORCED: the proof itself guarantees every note is auditor-decryptable\n");

  line(`Explorer: https://stellar.expert/explorer/testnet/contract/${CID}`);
  fs.writeFileSync(path.join(B, "demo_pool_id.txt"), CID + "\n");
}
main().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
