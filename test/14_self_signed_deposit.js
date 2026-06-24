// Proves the FREIGHTER deposit path: a user's OWN Stellar account signs and pays
// for its own shield (caller == the user, not the relayer). Here we sign with a
// keypair; in the browser Freighter signs the identical transaction. Verifies the
// Soroban auth model works (caller.require_auth + the token transfer both covered
// by the user's single tx signature) and that the user's USDC actually moves.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Keypair, TransactionBuilder, Networks } = require("@stellar/stellar-sdk");
const { initPoseidon, Keypair: UKey, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { buildWitness, prove } = require("../client/lib/transaction");
const { initAuditor } = require("../client/lib/auditor");
const { submitTransact } = require("../client/lib/soroban");
const { proofToHex, publicToHex } = require("../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const cfg = JSON.parse(fs.readFileSync(path.join(B, "web_config.json"), "utf8"));
const env = Object.fromEntries(fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("=")));
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
// Use the self-issued asset (faucet:"issuer", e.g. WETH) — Circle USDC can't be
// funded headlessly. The deposit mechanism is identical for any SAC.
const usdc = cfg.assets.find((a) => a.faucet === "issuer") || cfg.assets.find((a) => a.symbol === "WETH");
const bal = (addr) => BigInt(sh(`stellar contract invoke --id ${usdc.sac} --source shield --network testnet -- balance --id ${addr}`).replace(/"/g, ""));
let pass = 0, fail = 0;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

(async () => {
  await initPoseidon(); await initAuditor();
  console.log("pool:", cfg.poolId, "| USDC asset id:", usdc.id, "\n");

  // 1) a brand-new user account, funded with XLM (friendbot) + given USDC
  const alias = "tmpdep" + Math.floor(Date.now() / 1000) % 100000;
  sh(`stellar keys generate ${alias} --network testnet --fund`);
  const userAddr = sh(`stellar keys address ${alias}`);
  const userKp = Keypair.fromSecret(sh(`stellar keys show ${alias}`));
  sh(`stellar tx new change-trust --source ${alias} --line ${usdc.code}:${usdc.issuer} --network testnet`);
  sh(`stellar tx new payment --source usdc-issuer --destination ${userAddr} --asset ${usdc.code}:${usdc.issuer} --amount 1000000000 --network testnet`); // 100 USDC
  console.log("  fresh user:", userAddr, "(100 USDC, XLM funded)");

  const userBefore = bal(userAddr), poolBefore = bal(cfg.poolId);

  // 2) the user owns a fresh Umbra (shielded) identity; build the shield proof
  const me = new UKey();
  const tree = buildTree([]); // a deposit's input is a dummy; an empty tree is fine
  const amount = 100000000n; // 10 USDC (7 decimals)
  const note = new Note({ amount, assetId: BigInt(usdc.id), owner: me });
  const r = buildWitness({
    tree, inputs: [], outputs: [note], publicAmount: amount, assetId: BigInt(usdc.id),
    extData: { recipient: userAddr, extAmount: String(amount), fee: "0" },
    auditor: { pubX: cfg.auditorPubX, pubY: cfg.auditorPubY },
  });
  const { proof, publicSignals } = await prove(r.witness);
  console.log("  shield proof generated (10 USDC)");

  // 3) the USER signs and submits — no relayer involved
  const signXdr = async (xdr) => { const t = TransactionBuilder.fromXDR(xdr, Networks.TESTNET); t.sign(userKp); return t.toXDR(); };
  let hash;
  try {
    hash = await submitTransact({
      poolId: cfg.poolId, caller: userAddr,
      proofHex: proofToHex(proof), publicHex: publicToHex(publicSignals),
      recipient: userAddr, extAmount: amount.toString(), fee: 0, enc1: r.enc1, enc2: r.enc2, signXdr,
    });
    ck("user-signed deposit accepted on testnet", true);
  } catch (e) { ck("user-signed deposit: " + String(e.message).slice(0, 100), false); }

  // 4) the user's OWN USDC moved into the pool (not the relayer's)
  ck(`user paid 10 USDC from their own account (Δ=${(userBefore - bal(userAddr)) / 10000000n})`, userBefore - bal(userAddr) === amount);
  ck(`pool received 10 USDC (Δ=${(bal(cfg.poolId) - poolBefore) / 10000000n})`, bal(cfg.poolId) - poolBefore === amount);

  if (hash) console.log(`\n  tx: https://stellar.expert/explorer/testnet/tx/${hash}`);
  console.log(`\n${fail === 0 ? "🎉 SELF-SIGNED DEPOSIT WORKS (Freighter path proven)" : "❌"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
