// Verify the Auditor view works on the NEW pool with the SAVED auditor key:
// deposit a note, then reconstruct its amount + owner from the on-chain audit
// ciphertexts using circuits/build/auditor.key.json. This is exactly what the
// "Auditor view" screen does when you paste the auditor private key.
const { execSync } = require("child_process");
const fs = require("fs"); const path = require("path");
const { Keypair: SKeypair, TransactionBuilder, Networks } = require("@stellar/stellar-sdk");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { deriveIdentity } = require("../client/lib/identity");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { initAuditor } = require("../client/lib/auditor");
const { submitTransact } = require("../client/lib/soroban");
const { fetchCommitEvents, fetchAuditEvents, auditEnforced } = require("../client/lib/scan");
const { proofToHex, publicToHex } = require("../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits/build/web_config.json"), "utf8"));
const auditKey = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits/build/auditor.key.json"), "utf8"));
const test = cfg.assets.find((a) => a.faucet === "issuer"); // mintable headless asset
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shRetry = async (c, t = 5) => { for (let i = 0; i < t; i++) { try { return sh(c); } catch (e) { if (i === t - 1) throw e; await sleep(5000); } } };

(async () => {
  await initPoseidon(); await initAuditor();
  console.log("pool:", cfg.poolId, "| auditor pubX matches config:", auditKey.pubX === cfg.auditorPubX);
  const A = deriveIdentity(("add17e" + Math.floor(Date.now()/1000).toString(16)).padEnd(64,"0").slice(0,64));

  const alias = "tmpaud" + Math.floor(Date.now() / 1000) % 100000;
  sh(`stellar keys generate ${alias} --network testnet --fund`);
  const addr = sh(`stellar keys address ${alias}`); const kp = SKeypair.fromSecret(sh(`stellar keys show ${alias}`));
  await sleep(8000);
  await shRetry(`stellar tx new change-trust --source ${alias} --line ${test.code}:${test.issuer} --network testnet`);
  let funded = 0n;
  for (let i = 0; i < 6 && funded < 70000000n; i++) {
    await shRetry(`stellar tx new payment --source usdc-issuer --destination ${addr} --asset ${test.code}:${test.issuer} --amount 1000000000 --network testnet`).catch(() => {});
    await sleep(5000);
    try { const ac = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${addr}`)).json(); const b = (ac.balances || []).find((x) => x.asset_code === test.code); funded = b ? BigInt(Math.round(parseFloat(b.balance) * 1e7)) : 0n; } catch {}
  }
  if (funded < 70000000n) { console.log("⚠️ funding failed (plumbing)"); process.exit(2); }
  await sleep(4000);

  // deposit 7.0 of the test asset
  const amount = 70000000n;
  const note = new Note({ amount, assetId: BigInt(test.id), owner: A.spend });
  const r = buildWitness({ tree: buildTree([]), inputs: [], outputs: [note], publicAmount: amount, assetId: BigInt(test.id), extData: { recipient: addr, extAmount: String(amount), fee: "0" }, enc: { senderViewPub: A.viewPub, recipients: [A.viewPub] }, auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY } });
  const pr = await prove(r.witness);
  const signXdr = async (x) => { const t = TransactionBuilder.fromXDR(x, Networks.TESTNET); t.sign(kp); return t.toXDR(); };
  console.log("deposit:", (await submitTransact({ poolId: cfg.poolId, caller: addr, recipient: addr, proofHex: proofToHex(pr.proof), publicHex: publicToHex(pr.publicSignals), extAmount: String(amount), fee: 0, enc1: r.enc1, enc2: r.enc2, signXdr })).slice(0, 12));

  // AUDITOR reconstruction with the SAVED key (this is what the Auditor view does)
  let decoded = null;
  for (let i = 0; i < 20 && !decoded; i++) {
    await sleep(4000);
    const [commits, auditMap] = await Promise.all([fetchCommitEvents(cfg.poolId, cfg.startLedger), fetchAuditEvents(cfg.poolId, cfg.startLedger)]);
    const rows = auditEnforced(commits, auditMap, auditKey.priv).filter((x) => !x.opaque && x.amount !== undefined);
    const hit = rows.find((x) => BigInt(x.amount) === amount && Number(x.assetId) === Number(test.id));
    console.log(`  audit scan[${i}] decoded ${rows.length} notes, looking for ${amount}`);
    if (hit) decoded = hit;
  }
  if (!decoded) { console.log("❌ auditor could not reconstruct the deposited note"); process.exit(1); }
  const ownerOk = decoded.owner.toString() === A.spend.pubkey.toString();
  console.log(`\n✅ AUDITOR VIEW WORKS: reconstructed amount=${decoded.amount} assetId=${decoded.assetId} owner matches depositor=${ownerOk}`);
  process.exit(ownerOk ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
