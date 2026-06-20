// Phase 2 gate: full shielded-pool lifecycle on testnet through the real
// `transact` entrypoint — shield, private transfer, unshield (real USDC moves),
// plus double-spend rejection and stale-root acceptance. Prints the measured
// instruction cost of each transact (budget = 100M).
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
const RPC = "https://soroban-testnet.stellar.org";

const env = Object.fromEntries(
  fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("="))
);
const { USDC_SAC, USER_ADDR, RECIP_ADDR } = env;
const ENC = "00"; // placeholder ciphertext (Phase 3 makes it real)

const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const inv = (args, src = "shield") =>
  sh(`stellar contract invoke --id ${CID} --source ${src} --network testnet -- ${args}`).replace(/"/g, "");
let CID;

function rpcSim(xdr) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: { transaction: xdr } });
  const out = execSync(`curl -s -X POST ${RPC} -H 'Content-Type: application/json' -d '${body}'`, { encoding: "utf8" });
  return JSON.parse(out).result;
}
function instructionsOf(buildArgs) {
  const xdr = sh(`stellar contract invoke --build-only --id ${CID} --source shield --network testnet -- ${buildArgs}`);
  const r = rpcSim(xdr);
  if (r.error) return { err: r.error };
  const td = sh(`echo '${r.transactionData}' | stellar xdr decode --type SorobanTransactionData`);
  return { insns: Number(JSON.parse(td).resources.instructions) };
}
function balance(addr) {
  return inv(`balance --id ${addr}`); // via... actually query SAC, see below
}
function sacBalance(addr) {
  return sh(`stellar contract invoke --id ${USDC_SAC} --source shield --network testnet -- balance --id ${addr}`).replace(/"/g, "");
}

function transactArgs({ proof, publicSignals, recipient, extAmount, fee = 0 }) {
  const p = proofToHex(proof), pub = publicToHex(publicSignals);
  return `transact --caller ${USER_ADDR} --proof ${p} --public ${pub}` +
    ` --recipient ${recipient} --ext_amount=${extAmount} --fee=${fee} --enc1 ${ENC} --enc2 ${ENC}`;
}

(async () => {
  await initPoseidon();
  await initAuditor();
  const auditor = newAuditorKey();
  console.log("== Phase 2 pool lifecycle ==\n");
  console.log(`USDC SAC: ${USDC_SAC}`);

  CID = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  inv(`init --token ${USDC_SAC} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);
  fs.writeFileSync(path.join(B, "pool_id.txt"), CID + "\n");
  console.log(`pool: ${CID}\n`);

  const alice = new Keypair(), bob = new Keypair();
  const tree = buildTree([]);
  let pass = 0, fail = 0;
  const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

  // sanity: on-chain extData hash matches off-chain encoder
  {
    const { extDataHash } = require("../client/lib/extdata");
    const off = extDataHash({ recipient: USER_ADDR, extAmount: "100", fee: "0", encryptedOutput1: ENC, encryptedOutput2: ENC }).toString();
    const on = inv(`ext_hash --recipient ${USER_ADDR} --ext_amount 100 --fee 0 --enc1 ${ENC} --enc2 ${ENC}`);
    ck(`extDataHash matches off-chain (${on.slice(0, 12)}...)`, on === off);
  }

  // Insert BOTH output commitments (real + dummy) exactly as the contract does,
  // keeping the off-chain tree perfectly in sync. Returns [index0, index1].
  function syncInsert(oc) {
    const base = tree.elements.length;
    tree.insert(oc[0]);
    tree.insert(oc[1]);
    return [base, base + 1];
  }

  async function doTransact(label, params, { send = true, expectFail = false } = {}) {
    const { witness, outputCommitment } = buildWitness({ ...params.build, auditor: { pubX: auditor.pubX, pubY: auditor.pubY } });
    const { proof, publicSignals } = await prove(witness);
    const args = transactArgs({ proof, publicSignals, recipient: params.recipient, extAmount: params.extAmount });
    const cost = instructionsOf(args);
    if (cost.err) {
      if (expectFail) { console.log(`  ✅ ${label}: rejected as expected (${JSON.stringify(cost.err).slice(0, 60)})`); pass++; return null; }
      console.log(`  ❌ ${label}: simulation error ${JSON.stringify(cost.err).slice(0, 120)}`); fail++; return null;
    }
    console.log(`     ${label}: ${cost.insns.toLocaleString()} instructions (${(cost.insns / 1e6).toFixed(1)}M / 100M)`);
    if (!send) return { proof, publicSignals };
    try {
      sh(`stellar contract invoke --id ${CID} --source shield --network testnet --send=yes -- ${args}`);
      if (expectFail) { console.log(`  ❌ ${label}: expected failure but succeeded`); fail++; }
      else { console.log(`  ✅ ${label}: transact succeeded on-chain`); pass++; }
    } catch (e) {
      if (expectFail) { console.log(`  ✅ ${label}: rejected on-chain as expected`); pass++; }
      else { console.log(`  ❌ ${label}: ${String(e.message).slice(0, 140)}`); fail++; }
    }
    return { proof, publicSignals, outputCommitment };
  }

  const balUserBefore = sacBalance(USER_ADDR);
  const balRecipBefore = sacBalance(RECIP_ADDR);

  // 1) SHIELD 100
  const A1 = new Note({ amount: 100n, owner: alice });
  let r = await doTransact("SHIELD 100", {
    build: { tree, inputs: [], outputs: [A1], publicAmount: 100n,
      extData: { recipient: USER_ADDR, extAmount: "100", fee: "0", encryptedOutput1: ENC, encryptedOutput2: ENC } },
    recipient: USER_ADDR, extAmount: 100,
  });
  const [A1i] = syncInsert(r.outputCommitment); // A1 is output 0
  const rootAfterShield = tree.root.toString();

  // 2) TRANSFER 60 to Bob (+40 change)
  const toBob = new Note({ amount: 60n, owner: bob.pubkey });
  const change = new Note({ amount: 40n, owner: alice });
  r = await doTransact("TRANSFER 60→Bob", {
    build: { tree, inputs: [{ note: A1, index: A1i }], outputs: [toBob, change], publicAmount: 0n,
      extData: { recipient: USER_ADDR, extAmount: "0", fee: "0", encryptedOutput1: ENC, encryptedOutput2: ENC } },
    recipient: USER_ADDR, extAmount: 0,
  });
  const [, changeI] = syncInsert(r.outputCommitment); // change is output 1

  // 3) UNSHIELD 40 to the recipient account
  r = await doTransact("UNSHIELD 40", {
    build: { tree, inputs: [{ note: change, index: changeI }], outputs: [], publicAmount: -40n,
      extData: { recipient: RECIP_ADDR, extAmount: "-40", fee: "0", encryptedOutput1: ENC, encryptedOutput2: ENC } },
    recipient: RECIP_ADDR, extAmount: -40,
  });
  syncInsert(r.outputCommitment);

  // balances moved by the net shielded-then-unshielded amount
  const balUserAfter = sacBalance(USER_ADDR);
  const balRecipAfter = sacBalance(RECIP_ADDR);
  ck(`user paid 100 in (Δ=${balUserBefore - balUserAfter})`, BigInt(balUserBefore) - BigInt(balUserAfter) === 100n);
  ck(`recipient received 40 (Δ=${balRecipAfter - balRecipBefore})`, BigInt(balRecipAfter) - BigInt(balRecipBefore) === 40n);

  // 4) DOUBLE-SPEND: replay the transfer (A1 already spent) -> reject
  await doTransact("DOUBLE-SPEND A1", {
    build: { tree, inputs: [{ note: A1, index: A1i }], outputs: [new Note({ amount: 100n, owner: alice }), Note.dummy()], publicAmount: 0n,
      extData: { recipient: USER_ADDR, extAmount: "0", fee: "0", encryptedOutput1: ENC, encryptedOutput2: ENC } },
    recipient: USER_ADDR, extAmount: 0,
  }, { expectFail: true });

  // 5) STALE ROOT: a root from before the latest inserts is still accepted
  ck(`stale post-shield root still known`, inv(`known_root --root ${rootAfterShield}`) === "true");

  console.log(`\n${fail === 0 ? "🎉" : "❌"} Phase 2: ${pass} passed, ${fail} failed`);
  console.log(`   pool: https://stellar.expert/explorer/testnet/contract/${CID}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
