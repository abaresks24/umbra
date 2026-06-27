// Reproduce the "withdrawals don't work" bug end-to-end against the LIVE pool:
// deposit (self-signed) → scan to find the note → withdraw via the RELAYER path
// (transact with negative extAmount, signed by SHIELD_SECRET) → confirm the
// payout lands. Prints the exact on-chain error if the withdraw reverts.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Keypair: SKeypair, Contract, TransactionBuilder, Networks, nativeToScVal, Address, rpc } = require("@stellar/stellar-sdk");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { newViewingKeypair } = require("../client/lib/encryption");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { initAuditor } = require("../client/lib/auditor");
const { submitTransact } = require("../client/lib/soroban");
const { fetchCommitEvents, fetchSpentNullifiers, scanOwned, nullifierHex } = require("../client/lib/scan");
const { proofToHex, publicToHex } = require("../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const cfg = JSON.parse(fs.readFileSync(path.join(B, "web_config.json"), "utf8"));
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shRetry = async (c, tries = 5) => { for (let i = 0; i < tries; i++) { try { return sh(c); } catch (e) { if (i === tries - 1) throw e; await sleep(5000); } } };
const weth = cfg.assets.find((a) => a.faucet === "issuer");
const RPC = cfg.rpc || "https://soroban-testnet.stellar.org";

const scBytes = (h) => nativeToScVal(Buffer.from(h, "hex"), { type: "bytes" });
const scAddr = (g) => new Address(g).toScVal();
const scI128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });

// Mirror api/submit.js: the relayer builds + signs + submits the transact.
async function relayerSubmit({ proof, pub, recipient, extAmount, fee, enc1, enc2 }) {
  const r = await fetch("https://umbra-wallet.vercel.app/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proof, public: pub, recipient, extAmount, fee, enc1, enc2 }) });
  const j = await r.json(); if (!j.ok) throw new Error("relayer: " + j.error); return j.hash;
}
async function _unused_local({ proof, pub, recipient, extAmount, fee, enc1, enc2 }) {
  const secret = sh(`stellar keys show shield`); // SHIELD_SECRET in prod
  const kp = SKeypair.fromSecret(secret);
  const server = new rpc.Server(RPC);
  const account = await server.getAccount(kp.publicKey());
  const op = new Contract(cfg.poolId).call(
    "transact",
    scAddr(kp.publicKey()), scBytes(proof), scBytes(pub), scAddr(recipient),
    scI128(extAmount), scI128(fee ?? "0"), scBytes(enc1), scBytes(enc2),
  );
  let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: cfg.networkPassphrase || Networks.TESTNET }).addOperation(op).setTimeout(120).build();
  tx = await server.prepareTransaction(tx); // simulation — reverts surface here
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error("submit rejected: " + JSON.stringify(sent.errorResult || sent.status));
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 60 && g.status === "NOT_FOUND"; i++) { await sleep(2000); g = await server.getTransaction(sent.hash); }
  if (g.status !== "SUCCESS") throw new Error("transaction " + g.status);
  return sent.hash;
}

(async () => {
  await initPoseidon(); await initAuditor();
  const seed = "withdraw1".repeat(7);
  const spend = new Keypair(BigInt("0x" + require("js-sha3").keccak256("shielded:spend:" + seed)) % (2n ** 250n));
  const view = newViewingKeypair();
  console.log("pool:", cfg.poolId, "| asset:", weth.symbol, weth.id, "| relayer:", sh(`stellar keys address shield`));

  // funded account with a WETH trustline — used to deposit AND as the withdraw destination
  const alias = "tmpw" + Math.floor(Date.now() / 1000) % 100000;
  sh(`stellar keys generate ${alias} --network testnet --fund`);
  const addr = sh(`stellar keys address ${alias}`);
  const kp = SKeypair.fromSecret(sh(`stellar keys show ${alias}`));
  await sleep(8000);
  await shRetry(`stellar tx new change-trust --source ${alias} --line ${weth.code}:${weth.issuer} --network testnet`);
  let funded = 0n;
  for (let i = 0; i < 6 && funded < 50000000n; i++) {
    await shRetry(`stellar tx new payment --source usdc-issuer --destination ${addr} --asset ${weth.code}:${weth.issuer} --amount 1000000000 --network testnet`).catch(() => {});
    await sleep(5000);
    try { const acct = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${addr}`)).json(); const bal = (acct.balances || []).find((b) => b.asset_code === weth.code); funded = bal ? BigInt(Math.round(parseFloat(bal.balance) * 1e7)) : 0n; } catch {}
    console.log(`  funding ${weth.symbol}: balance=${funded}`);
  }
  if (funded < 50000000n) { console.log("⚠️  could not fund test wallet — aborting (plumbing)"); process.exit(2); }
  await sleep(4000);

  // DEPOSIT 5.0
  const amount = 50000000n;
  const dnote = new Note({ amount, assetId: BigInt(weth.id), owner: spend });
  const dr = buildWitness({ tree: buildTree([]), inputs: [], outputs: [dnote], publicAmount: amount, assetId: BigInt(weth.id), extData: { recipient: addr, extAmount: String(amount), fee: "0" }, enc: { senderViewPub: view.viewPub, recipients: [view.viewPub] }, auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY } });
  const dpr = await prove(dr.witness);
  const signXdr = async (xdr) => { const t = TransactionBuilder.fromXDR(xdr, Networks.TESTNET); t.sign(kp); return t.toXDR(); };
  console.log("deposit:", await submitTransact({ poolId: cfg.poolId, caller: addr, recipient: addr, proofHex: proofToHex(dpr.proof), publicHex: publicToHex(dpr.publicSignals), extAmount: amount.toString(), fee: 0, enc1: dr.enc1, enc2: dr.enc2, signXdr }));

  // SCAN for the note
  let mine = null;
  for (let i = 0; i < 20 && !mine; i++) {
    await sleep(4000);
    const [events, spent] = await Promise.all([fetchCommitEvents(cfg.poolId, cfg.startLedger), fetchSpentNullifiers(cfg.poolId, cfg.startLedger)]);
    const owned = scanOwned(events, view.viewSecret, spend).filter((n) => !spent.has(nullifierHex(n.note.nullifier(n.index))) && Number(n.assetId) === Number(weth.id));
    console.log(`  scan[${i}] owned=${owned.length}`);
    if (owned.length) { mine = owned[0]; var allEvents = events; }
  }
  if (!mine) { console.log("❌ deposit note never scanned"); process.exit(1); }

  // WITHDRAW 5.0 back to `addr` via the relayer (negative extAmount, change = 0)
  console.log("withdrawing", amount.toString(), "to", addr, "via relayer…");
  const tree = buildTree(allEvents.sort((a, b) => a.index - b.index).map((e) => e.commitment));
  const change = new Note({ amount: 0n, assetId: BigInt(weth.id), owner: spend });
  const wr = buildWitness({
    tree, inputs: [{ note: mine.note, index: mine.index }], outputs: [change],
    publicAmount: -amount, assetId: BigInt(weth.id),
    extData: { recipient: addr, extAmount: String(-amount), fee: "0" },
    enc: { senderViewPub: view.viewPub, recipients: [view.viewPub] },
    auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY },
  });
  const wpr = await prove(wr.witness);
  const whash = await relayerSubmit({ proof: proofToHex(wpr.proof), pub: publicToHex(wpr.publicSignals), recipient: addr, extAmount: (-amount).toString(), fee: "0", enc1: wr.enc1, enc2: wr.enc2 });
  console.log("\n✅ WITHDRAW SUCCEEDED:", whash);
  process.exit(0);
})().catch((e) => { console.error("\n❌", e.message || e); process.exit(1); });
