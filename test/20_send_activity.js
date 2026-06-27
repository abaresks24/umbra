// FULL real-chain E2E of the activity feature: A deposits 5, A sends 2 to B via
// the PRODUCTION relayer, then BOTH wallets rebuild their history from chain.
// Verifies: balances (A=3, B=2), and chain-derived activity (A: deposit + sent 2;
// B: received 2). Deterministic identities so notes are reproducible.
const { execSync } = require("child_process");
const fs = require("fs"); const path = require("path");
const { Keypair: SKeypair, TransactionBuilder, Networks } = require("@stellar/stellar-sdk");
const { initPoseidon, Note } = require("../client/lib/crypto");
const { deriveIdentity, decodeAddress } = require("../client/lib/identity");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { initAuditor } = require("../client/lib/auditor");
const { submitTransact } = require("../client/lib/soroban");
const { fetchTxGroups, scanOwned, nullifierHex } = require("../client/lib/scan");
const { proofToHex, publicToHex } = require("../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits/build/web_config.json"), "utf8"));
const weth = cfg.assets.find((a) => a.faucet === "issuer");
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shRetry = async (c, t = 5) => { for (let i = 0; i < t; i++) { try { return sh(c); } catch (e) { if (i === t - 1) throw e; await sleep(5000); } } };

// faithful copy of web/src/main.js deriveActivity
function deriveActivity(groups, owned) {
  const byCommit = new Map(owned.map((o) => [o.commitment, o]));
  const byNull = new Map(owned.map((o) => [nullifierHex(o.note.nullifier(o.index)), o]));
  const acts = [];
  for (const g of groups) {
    const myOuts = g.commits.map((c) => byCommit.get(c.commitment)).filter(Boolean).filter((o) => o.amount > 0n);
    const mySpent = g.nullifiers.map((n) => byNull.get(n)).filter(Boolean);
    if (!myOuts.length && !mySpent.length) continue;
    if (mySpent.length) {
      const net = mySpent.reduce((s, o) => s + o.amount, 0n) - myOuts.reduce((s, o) => s + o.amount, 0n);
      if (net <= 0n) continue;
      acts.push({ dir: "send", amount: net.toString(), assetId: Number(mySpent[0].assetId) });
    } else for (const o of myOuts) acts.push({ dir: "receive", amount: o.amount.toString(), assetId: Number(o.assetId) });
  }
  return acts;
}
async function scanWallet(id) {
  const { groups, commits, spent } = await fetchTxGroups(cfg.poolId, cfg.startLedger);
  const owned = scanOwned(commits, id.viewSecret, id.spend);
  const unspent = owned.filter((n) => !spent.has(nullifierHex(n.note.nullifier(n.index))));
  const bal = (a) => unspent.filter((n) => Number(n.assetId) === a).reduce((s, n) => s + n.amount, 0n);
  return { groups, owned, activity: deriveActivity(groups, owned), wethBal: bal(Number(weth.id)) };
}

(async () => {
  await initPoseidon(); await initAuditor();
  const A = deriveIdentity("aaaa".repeat(4) + Math.floor(Date.now() / 1000).toString(16));
  const B = deriveIdentity("bbbb".repeat(4) + Math.floor(Date.now() / 1000).toString(16));
  console.log("A:", A.address.slice(0, 18), "| B:", B.address.slice(0, 18));

  // fund a Stellar account for A's self-signed deposit
  const alias = "tmpa" + Math.floor(Date.now() / 1000) % 100000;
  sh(`stellar keys generate ${alias} --network testnet --fund`);
  const addr = sh(`stellar keys address ${alias}`); const kp = SKeypair.fromSecret(sh(`stellar keys show ${alias}`));
  await sleep(8000);
  await shRetry(`stellar tx new change-trust --source ${alias} --line ${weth.code}:${weth.issuer} --network testnet`);
  let funded = 0n;
  for (let i = 0; i < 6 && funded < 50000000n; i++) {
    await shRetry(`stellar tx new payment --source usdc-issuer --destination ${addr} --asset ${weth.code}:${weth.issuer} --amount 1000000000 --network testnet`).catch(() => {});
    await sleep(5000);
    try { const ac = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${addr}`)).json(); const b = (ac.balances || []).find((x) => x.asset_code === weth.code); funded = b ? BigInt(Math.round(parseFloat(b.balance) * 1e7)) : 0n; } catch {}
  }
  if (funded < 50000000n) { console.log("⚠️ funding failed (plumbing)"); process.exit(2); }
  await sleep(4000);

  // A DEPOSITS 5
  const dep = new Note({ amount: 50000000n, assetId: BigInt(weth.id), owner: A.spend });
  const dr = buildWitness({ tree: buildTree([]), inputs: [], outputs: [dep], publicAmount: 50000000n, assetId: BigInt(weth.id), extData: { recipient: addr, extAmount: "50000000", fee: "0" }, enc: { senderViewPub: A.viewPub, recipients: [A.viewPub] }, auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY } });
  const dp = await prove(dr.witness);
  const signXdr = async (x) => { const t = TransactionBuilder.fromXDR(x, Networks.TESTNET); t.sign(kp); return t.toXDR(); };
  console.log("deposit:", (await submitTransact({ poolId: cfg.poolId, caller: addr, recipient: addr, proofHex: proofToHex(dp.proof), publicHex: publicToHex(dp.publicSignals), extAmount: "50000000", fee: 0, enc1: dr.enc1, enc2: dr.enc2, signXdr })).slice(0, 12));

  // wait until A sees the deposit
  let aw; for (let i = 0; i < 20; i++) { await sleep(4000); aw = await scanWallet(A); if (aw.wethBal === 50000000n) break; }
  console.log(`A after deposit: balance=${aw.wethBal} activity=${JSON.stringify(aw.activity)}`);
  if (aw.wethBal !== 50000000n) { console.log("❌ deposit not scanned"); process.exit(1); }

  // A SENDS 2 to B via PROD relayer
  const tree = buildTree(aw.groups.flatMap((g) => g.commits).sort((a, b) => a.index - b.index).map((c) => c.commitment));
  const depOwned = aw.owned.find((o) => o.amount === 50000000n);
  const rcpt = decodeAddress(B.address);
  const toB = new Note({ amount: 20000000n, assetId: BigInt(weth.id), owner: rcpt.spendPub });
  const change = new Note({ amount: 30000000n, assetId: BigInt(weth.id), owner: A.spend });
  const sr = buildWitness({ tree, inputs: [{ note: depOwned.note, index: depOwned.index }], outputs: [toB, change], publicAmount: 0n, assetId: BigInt(weth.id), extData: { recipient: addr, extAmount: "0", fee: "0" }, enc: { senderViewPub: A.viewPub, recipients: [rcpt.viewPub, A.viewPub] }, auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY } });
  const sp = await prove(sr.witness);
  const res = await fetch("https://umbra-wallet.vercel.app/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proof: proofToHex(sp.proof), public: publicToHex(sp.publicSignals), recipient: addr, extAmount: "0", fee: "0", enc1: sr.enc1, enc2: sr.enc2 }) });
  const j = await res.json(); if (!j.ok) { console.log("❌ relayer:", j.error); process.exit(1); }
  console.log("send via prod relayer:", j.hash.slice(0, 12));

  // wait until B sees the received note AND A sees the spend reflected (testnet
  // RPC is eventually-consistent across nodes, so each wallet retries — exactly
  // what the real wallet's heartbeat does)
  let bw; for (let i = 0; i < 20; i++) { await sleep(4000); bw = await scanWallet(B); if (bw.wethBal === 20000000n) break; }
  let af; for (let i = 0; i < 20; i++) { af = await scanWallet(A); if (af.wethBal === 30000000n) break; await sleep(4000); }
  console.log(`\nA final: balance=${af.wethBal} activity=${JSON.stringify(af.activity)}`);
  console.log(`B final: balance=${bw.wethBal} activity=${JSON.stringify(bw.activity)}`);

  const ok = af.wethBal === 30000000n && bw.wethBal === 20000000n
    && af.activity.some((a) => a.dir === "receive" && a.amount === "50000000")
    && af.activity.some((a) => a.dir === "send" && a.amount === "20000000")
    && bw.activity.some((a) => a.dir === "receive" && a.amount === "20000000");
  if (ok) console.log("\n✅ SEND + ACTIVITY + BALANCE all correct end-to-end (A=3 WETH, B=2 WETH; A: deposit+sent2, B: received2)");
  else { console.log("\n❌ mismatch"); process.exit(1); }
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
