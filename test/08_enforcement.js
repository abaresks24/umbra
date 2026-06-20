// Proves auditor disclosure is ENFORCED on-chain, not voluntary: the pool pins
// auditor A; a proof that encrypts to a different auditor B is REJECTED by the
// contract (validators), while the same proof under A is accepted. Uses
// simulation only (no sends / no funds moved).
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
const RPC = "https://soroban-testnet.stellar.org";
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
let CID, pass = 0, fail = 0;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

function simTransact(args) {
  const xdr = sh(`stellar contract invoke --build-only --id ${CID} --source shield --network testnet -- ${args}`);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: { transaction: xdr } });
  const r = JSON.parse(execSync(`curl -s -X POST ${RPC} -H 'Content-Type: application/json' -d '${body}'`, { encoding: "utf8" })).result;
  return r.error ? { ok: false, error: String(r.error) } : { ok: true };
}

async function shieldArgs(auditor) {
  const tree = buildTree([]);
  const note = new Note({ amount: 100n, owner: new Keypair() });
  const r = buildWitness({
    tree, inputs: [], outputs: [note], publicAmount: 100n,
    extData: { recipient: e.USER_ADDR, extAmount: "100", fee: "0" },
    auditor: { pubX: auditor.pubX, pubY: auditor.pubY },
  });
  const { proof, publicSignals } = await prove(r.witness);
  return `transact --caller ${e.USER_ADDR} --proof ${proofToHex(proof)} --public ${publicToHex(publicSignals)}` +
    ` --recipient ${e.USER_ADDR} --ext_amount=100 --fee=0 --enc1 ${r.enc1} --enc2 ${r.enc2}`;
}

(async () => {
  await initPoseidon();
  await initAuditor();
  const auditorA = newAuditorKey(); // the pinned auditor
  const auditorB = newAuditorKey(); // an impostor

  CID = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  sh(`stellar contract invoke --id ${CID} --source shield --network testnet -- init --token ${e.USDC_SAC} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditorA.pubX} --auditor_y ${auditorA.pubY}`);
  console.log(`pool pinned to auditor A: ${CID}\n`);

  // proof encrypted to A → accepted
  const rA = simTransact(await shieldArgs(auditorA));
  ck("proof encrypted to the pinned auditor A is accepted (sim ok)", rA.ok);

  // proof encrypted to B → rejected by the contract
  const rB = simTransact(await shieldArgs(auditorB));
  ck("proof encrypted to a DIFFERENT auditor B is REJECTED", !rB.ok);
  if (!rB.ok) console.log(`     rejection: ${rB.error.slice(0, 70)}…`);

  console.log(`\n${fail === 0 ? "🎉 ENFORCEMENT PROVEN" : "❌"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
