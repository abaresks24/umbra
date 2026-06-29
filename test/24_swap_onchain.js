// FULL on-chain E2E of the shielded SWAP: A deposits 10 of asset-1, then swaps
// 5.4 of value into 5.0 of asset-2 at rate 1.08 (keeping 4.6 change) via the
// contract's `swap` entrypoint. Verifies the swap lands, A owns the new asset-2
// note, and the AUDITOR reconstructs it from the enforced ciphertext.
const { execSync } = require("child_process");
const fs = require("fs"); const path = require("path");
const { Keypair: SKeypair, Contract, TransactionBuilder, Networks, nativeToScVal, Address, rpc } = require("@stellar/stellar-sdk");
const { initPoseidon, Note } = require("../client/lib/crypto");
const { deriveIdentity } = require("../client/lib/identity");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove, buildSwapWitness, proveSwap, SWAP_SCALE } = require("../client/lib/transaction");
const { initAuditor } = require("../client/lib/auditor");
const { submitTransact } = require("../client/lib/soroban");
const { fetchTxGroups, fetchCommitEvents, fetchAuditEvents, scanOwned, auditEnforced, nullifierHex } = require("../client/lib/scan");
const { proofToHex, publicToHex } = require("../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits/build/swap_config.json"), "utf8"));
const auditKey = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits/build/swap_auditor.key.json"), "utf8"));
const A1 = cfg.assets[0]; // asset 1 = mintable test token
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shR = async (c, t = 5) => { for (let i = 0; i < t; i++) { try { return sh(c); } catch (e) { if (i === t - 1) throw e; await sleep(5000); } } };
const RPC = cfg.rpc;
const sB = (h) => nativeToScVal(Buffer.from(h, "hex"), { type: "bytes" });

// submit the contract's `swap(proof, public, enc1, enc2)`, signed by the relayer
async function submitSwap({ proofHex, publicHex, enc1, enc2 }) {
  const kp = SKeypair.fromSecret(sh(`stellar keys show shield`));
  const server = new rpc.Server(RPC);
  for (let attempt = 0; attempt < 4; attempt++) {
    const account = await server.getAccount(kp.publicKey());
    const op = new Contract(cfg.poolId).call("swap", sB(proofHex), sB(publicHex), sB(enc1), sB(enc2));
    let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.TESTNET }).addOperation(op).setTimeout(120).build();
    tx = await server.prepareTransaction(tx); tx.sign(kp);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") { if (/txBadSeq/i.test(JSON.stringify(sent.errorResult || "")) && attempt < 3) { await sleep(2500); continue; } throw new Error("swap rejected: " + JSON.stringify(sent.errorResult)); }
    let g = await server.getTransaction(sent.hash);
    for (let i = 0; i < 60 && g.status === "NOT_FOUND"; i++) { await sleep(2000); g = await server.getTransaction(sent.hash); }
    if (g.status !== "SUCCESS") throw new Error("swap tx " + g.status);
    return sent.hash;
  }
}
async function scanOwn(id) {
  const { commits, spent } = await fetchTxGroups(cfg.poolId, cfg.startLedger);
  const owned = scanOwned(commits, id.viewSecret, id.spend).filter((n) => !spent.has(nullifierHex(n.note.nullifier(n.index))));
  const bal = (a) => owned.filter((n) => Number(n.assetId) === a).reduce((s, n) => s + n.amount, 0n);
  return { owned, a1: bal(1), a2: bal(2) };
}

(async () => {
  await initPoseidon(); await initAuditor();
  const A = deriveIdentity(("a5a5" + Math.floor(Date.now() / 1000).toString(16)).padEnd(64, "0").slice(0, 64));
  console.log("pool:", cfg.poolId, "| auditor matches:", auditKey.pubX === cfg.auditorPubX);

  // fund + deposit 10 of asset-1
  const alias = "tmpsw" + Math.floor(Date.now() / 1000) % 100000;
  sh(`stellar keys generate ${alias} --network testnet --fund`);
  const addr = sh(`stellar keys address ${alias}`); const kp = SKeypair.fromSecret(sh(`stellar keys show ${alias}`));
  await sleep(8000);
  await shR(`stellar tx new change-trust --source ${alias} --line ${A1.code}:${A1.issuer} --network testnet`);
  let funded = 0n;
  for (let i = 0; i < 6 && funded < 100000000n; i++) {
    await shR(`stellar tx new payment --source usdc-issuer --destination ${addr} --asset ${A1.code}:${A1.issuer} --amount 2000000000 --network testnet`).catch(() => {});
    await sleep(5000);
    try { const ac = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${addr}`)).json(); const b = (ac.balances || []).find((x) => x.asset_code === A1.code); funded = b ? BigInt(Math.round(parseFloat(b.balance) * 1e7)) : 0n; } catch {}
  }
  if (funded < 100000000n) { console.log("⚠️ funding failed"); process.exit(2); }
  await sleep(4000);

  const dep = new Note({ amount: 100000000n, assetId: 1n, owner: A.spend });
  const dr = buildWitness({ tree: buildTree([]), inputs: [], outputs: [dep], publicAmount: 100000000n, assetId: 1n, extData: { recipient: addr, extAmount: "100000000", fee: "0" }, enc: { senderViewPub: A.viewPub, recipients: [A.viewPub] }, auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY } });
  const dp = await prove(dr.witness);
  const signXdr = async (x) => { const t = TransactionBuilder.fromXDR(x, Networks.TESTNET); t.sign(kp); return t.toXDR(); };
  console.log("deposit:", (await submitTransact({ poolId: cfg.poolId, caller: addr, recipient: addr, proofHex: proofToHex(dp.proof), publicHex: publicToHex(dp.publicSignals), extAmount: "100000000", fee: 0, enc1: dr.enc1, enc2: dr.enc2, signXdr })).slice(0, 12));

  let aw; for (let i = 0; i < 20; i++) { await sleep(4000); aw = await scanOwn(A); if (aw.a1 === 100000000n) break; }
  console.log(`A after deposit: asset1=${aw.a1} asset2=${aw.a2}`);
  if (aw.a1 !== 100000000n) { console.log("❌ deposit not scanned"); process.exit(1); }

  // SWAP: 10 asset-1 -> 5 asset-2 (EURC) + 4.6 asset-1 change, at rate 1.08
  const { groups } = await fetchTxGroups(cfg.poolId, cfg.startLedger);
  const tree = buildTree(groups.flatMap((g) => g.commits).sort((a, b) => a.index - b.index).map((c) => c.commitment));
  const depOwned = aw.owned.find((o) => o.amount === 100000000n);
  const rate = (108n * SWAP_SCALE) / 100n;
  const eurc = new Note({ amount: 50000000n, assetId: 2n, owner: A.spend });
  const change = new Note({ amount: 46000000n, assetId: 1n, owner: A.spend });
  const sw = buildSwapWitness({ tree, inputs: [{ note: depOwned.note, index: depOwned.index }], outputs: [eurc, change], rate, feeValue: 0n, extData: { recipient: "swap", extAmount: "0", fee: "0" }, enc: { senderViewPub: A.viewPub, recipients: [A.viewPub, A.viewPub] }, auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY } });
  const sp = await proveSwap(sw.witness);
  console.log("swap via contract:", (await submitSwap({ proofHex: proofToHex(sp.proof), publicHex: publicToHex(sp.publicSignals), enc1: sw.enc1, enc2: sw.enc2 })).slice(0, 12));

  // A should now hold the EURC (asset-2) note
  let af; for (let i = 0; i < 20; i++) { await sleep(4000); af = await scanOwn(A); if (af.a2 === 50000000n) break; }
  console.log(`A after swap: asset1=${af.a1} asset2=${af.a2}`);

  // AUDITOR reconstructs the asset-2 note
  const [commits, auditMap] = await Promise.all([fetchCommitEvents(cfg.poolId, cfg.startLedger), fetchAuditEvents(cfg.poolId, cfg.startLedger)]);
  const decoded = auditEnforced(commits, auditMap, auditKey.priv).filter((x) => !x.opaque);
  const eurcRow = decoded.find((x) => Number(x.assetId) === 2 && BigInt(x.amount) === 50000000n);

  const ok = af.a2 === 50000000n && af.a1 === 46000000n && !!eurcRow;
  if (ok) console.log("\n✅ SHIELDED SWAP ON-CHAIN WORKS: A swapped USDC→EURC privately; balances asset1=4.6 asset2=5.0; auditor reconstructed the EURC note.");
  else { console.log("\n❌ mismatch", { a1: String(af.a1), a2: String(af.a2), eurcDecoded: !!eurcRow }); process.exit(1); }
})().catch((e) => { console.error("\n❌", e.message || e); process.exit(1); });
