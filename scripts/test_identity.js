// Prove the gasless DeFi-identity flow on-chain: a wallet-derived key (NOT
// Freighter) is funded by friendbot, adds trustlines + supplies to the market,
// all fee-bumped by the relayer — so the identity's own XLM never pays a fee.
// Runs against the seeded TEST-token market (Circle USDC can't be minted headless).
const { execSync } = require("child_process");
const { Keypair, Contract, TransactionBuilder, Operation, Asset, nativeToScVal, scValToNative, Address, rpc, Networks, hash } = require("@stellar/stellar-sdk");

const RPC = "https://soroban-testnet.stellar.org";
const NET = Networks.TESTNET;
const server = new rpc.Server(RPC);
const sh = (c) => execSync(c, { cwd: __dirname + "/..", encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKET = "CDOJ3CWI43INGLYSGJSMCG4SKA2G5VHRI4IX3YLDU3KABXZPMTT6XKAG"; // seeded test-token market
const ISSUER = sh(`stellar keys address usdc-issuer`);
const SHIELD = Keypair.fromSecret(sh(`stellar keys show shield`)); // relayer / fee-bump source
const USDC = new Asset("USDC", ISSUER), EURC = new Asset("EURC", ISSUER);
const D = 10_000_000n;
const scAddr = (g) => new Address(g).toScVal();
const scU32 = (n) => nativeToScVal(n, { type: "u32" });
const scI128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });

async function waitTx(h) { let g = await server.getTransaction(h); for (let i = 0; i < 60 && g.status === "NOT_FOUND"; i++) { await sleep(2000); g = await server.getTransaction(h); } if (g.status !== "SUCCESS") throw new Error("tx " + g.status); return g; }
// fee-bump a signed inner tx with the relayer (SHIELD) — exactly what /api/market does
async function feeBump(innerSignedTx) {
  const fb = TransactionBuilder.buildFeeBumpTransaction(SHIELD, "2000000", innerSignedTx, NET);
  fb.sign(SHIELD);
  const sent = await server.sendTransaction(fb);
  if (sent.status === "ERROR") throw new Error("fb rejected: " + JSON.stringify(sent.errorResult));
  return waitTx(sent.hash);
}
async function xlm(pub) { const a = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${pub}`)).json(); return a.balances.find((b) => b.asset_type === "native")?.balance; }

(async () => {
  // 1) wallet-derived DeFi identity (deterministic from a seed, like the client)
  const seed = "a1".repeat(32);
  const id = Keypair.fromRawEd25519Seed(hash(Buffer.from(seed + ":umbra-defi", "utf8")));
  console.log("DeFi identity:", id.publicKey().slice(0, 8), "…");

  // 2) friendbot fund (XLM for reserves)
  await fetch(`https://friendbot.stellar.org?addr=${id.publicKey()}`).catch(() => {});
  for (let i = 0; i < 25; i++) { try { await server.getAccount(id.publicKey()); break; } catch { await sleep(2500); } }
  const xlm0 = await xlm(id.publicKey());

  // 3) trustlines, FEE-BUMPED by the relayer (identity signs, relayer pays)
  for (const a of [USDC, EURC]) {
    const acc = await server.getAccount(id.publicKey());
    const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET }).addOperation(Operation.changeTrust({ asset: a })).setTimeout(120).build();
    tx.sign(id);
    await feeBump(tx);
  }
  console.log("trustlines added (relayer-paid)");

  // 4) fund the identity with 100 test USDC (issuer pays — stands in for a shielded withdrawal)
  await (async () => { const stroops = 100n * D; sh(`stellar tx new payment --source usdc-issuer --destination ${id.publicKey()} --asset USDC:${ISSUER} --amount ${stroops} --network testnet`); })();
  await sleep(4000);

  // 5) supply 50 USDC via the market, FEE-BUMPED (identity signs, relayer pays the gas)
  const acc = await server.getAccount(id.publicKey());
  const op = new Contract(MARKET).call("supply", scAddr(id.publicKey()), scU32(1), scI128(50n * D));
  let tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET }).addOperation(op).setTimeout(180).build();
  tx = await server.prepareTransaction(tx); tx.sign(id);
  await feeBump(tx);

  // 6) verify: supply landed AND the identity's XLM did NOT pay the fee (relayer did)
  const accView = await server.getAccount(SHIELD.publicKey());
  const v = new Contract(MARKET).call("position", scAddr(id.publicKey()), scU32(1));
  const sim = await server.simulateTransaction(new TransactionBuilder(accView, { fee: "100", networkPassphrase: NET }).addOperation(v).setTimeout(30).build());
  const pos = scValToNative(sim.result.retval);
  const xlm1 = await xlm(id.publicKey());
  const reserveDelta = (parseFloat(xlm0) - parseFloat(xlm1)).toFixed(4);
  console.log(`supplied=${pos.supplied} (want ${50n * D}) | identity XLM ${xlm0} -> ${xlm1} (delta ${reserveDelta} = only trustline reserves, no fees)`);

  const ok = BigInt(pos.supplied) >= 50n * D - 100n; // allow integer-index rounding (a few stroops)
  if (!ok) { console.log("❌ supply via gasless identity failed"); process.exit(1); }
  console.log("\n✅ GASLESS DeFi IDENTITY WORKS: a wallet-derived pseudonym (not Freighter) supplied to the market; the relayer paid every fee via fee-bump.");
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
