// Reproduce the "balance doesn't update after deposit" bug: self-sign a deposit
// (exactly like the Freighter path), then scanOwned with the depositor's viewing
// key — does the note show up? If yes, the UI bug is timing/heartbeat; if no,
// the scan/encryption is broken for the deposit path.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Keypair: SKeypair, TransactionBuilder, Networks } = require("@stellar/stellar-sdk");
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
const env = Object.fromEntries(fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("=")));
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const weth = cfg.assets.find((a) => a.faucet === "issuer"); // self-issued, fundable

(async () => {
  await initPoseidon(); await initAuditor();
  // a wallet identity (spend + view), like an Umbra user
  const seed = "deadbeef".repeat(8);
  const spend = new Keypair(BigInt("0x" + require("js-sha3").keccak256("shielded:spend:" + seed)) % (2n ** 250n));
  const view = newViewingKeypair();
  console.log("pool:", cfg.poolId, "| asset:", weth.symbol, weth.id);

  // funded Stellar account to self-sign the deposit
  const alias = "tmpd" + Math.floor(Date.now() / 1000) % 100000;
  sh(`stellar keys generate ${alias} --network testnet --fund`);
  const addr = sh(`stellar keys address ${alias}`);
  const kp = SKeypair.fromSecret(sh(`stellar keys show ${alias}`));
  sh(`stellar tx new change-trust --source ${alias} --line ${weth.code}:${weth.issuer} --network testnet`);
  sh(`stellar tx new payment --source usdc-issuer --destination ${addr} --asset ${weth.code}:${weth.issuer} --amount 500000000 --network testnet`);

  // build + submit the deposit (50 units), encrypting the note to the view key
  const tree = buildTree([]);
  const amount = 50000000n; // 5.0
  const note = new Note({ amount, assetId: BigInt(weth.id), owner: spend });
  const r = buildWitness({
    tree, inputs: [], outputs: [note], publicAmount: amount, assetId: BigInt(weth.id),
    extData: { recipient: addr, extAmount: String(amount), fee: "0" },
    enc: { senderViewPub: view.viewPub, recipients: [view.viewPub] },
    auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY },
  });
  const pr = await prove(r.witness);
  const signXdr = async (xdr) => { const t = TransactionBuilder.fromXDR(xdr, Networks.TESTNET); t.sign(kp); return t.toXDR(); };
  const hash = await submitTransact({ poolId: cfg.poolId, caller: addr, recipient: addr, proofHex: proofToHex(pr.proof), publicHex: publicToHex(pr.publicSignals), extAmount: amount.toString(), fee: 0, enc1: r.enc1, enc2: r.enc2, signXdr });
  console.log("deposit submitted:", hash);

  // wait for indexing, then scan exactly like the wallet does
  console.log("waiting for the note to be indexed + scanned…");
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 4000));
    const [events, spent] = await Promise.all([fetchCommitEvents(cfg.poolId, cfg.startLedger), fetchSpentNullifiers(cfg.poolId, cfg.startLedger)]);
    const owned = scanOwned(events, view.viewSecret, spend).filter((n) => !spent.has(nullifierHex(n.note.nullifier(n.index))));
    const mine = owned.filter((n) => Number(n.assetId) === Number(weth.id));
    const bal = mine.reduce((a, n) => a + n.amount, 0n);
    console.log(`  [${i}] events=${events.length} owned=${owned.length} ${weth.symbol}-balance=${bal}`);
    if (bal === amount) { console.log("\n✅ SCAN FINDS THE DEPOSIT — balance updates correctly. The UI bug is timing/heartbeat."); process.exit(0); }
  }
  console.log("\n❌ SCAN NEVER FOUND THE DEPOSIT — the scan/encryption is broken for deposits.");
  process.exit(1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
