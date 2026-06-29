// Seed the Umbra Market with real liquidity + run an on-chain E2E
// (supply -> swap -> borrow). Classic ops (fund / trustline / mint) go through the
// stellar CLI (reliable, synchronous); contract calls go through the SDK. Reads
// circuits/build/market_config.json (from scripts/deploy_market.js).
const { execSync } = require("child_process");
const fs = require("fs"); const path = require("path");
const { Keypair, Contract, TransactionBuilder, nativeToScVal, scValToNative, Address, rpc, Networks } = require("@stellar/stellar-sdk");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits/build/market_config.json"), "utf8"));
const RPC = cfg.rpc || "https://soroban-testnet.stellar.org";
const NET = Networks.TESTNET;
const server = new rpc.Server(RPC);
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shR(c, t = 8) { for (let i = 0; i < t; i++) { try { return sh(c); } catch (e) { if (i === t - 1) throw e; await sleep(5000); } } }
const MARKET = cfg.market;
const ISSUER = sh(`stellar keys address usdc-issuer`);
const D = 10_000_000n;

const scAddr = (g) => new Address(g).toScVal();
const scU32 = (n) => nativeToScVal(n, { type: "u32" });
const scI128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });
const enc = (a) => (a.t === "a" ? scAddr(a.v) : a.t === "u" ? scU32(a.v) : scI128(a.v));

async function waitForAccount(addr) { for (let i = 0; i < 30; i++) { try { await server.getAccount(addr); return; } catch { await sleep(3000); } } throw new Error("never funded: " + addr); }
async function fundAccount(alias) {
  sh(`stellar keys generate ${alias} --network testnet --fund`);
  const addr = sh(`stellar keys address ${alias}`);
  const kp = Keypair.fromSecret(sh(`stellar keys show ${alias}`));
  await waitForAccount(addr);
  for (const code of ["USDC", "EURC"]) await shR(`stellar tx new change-trust --source ${alias} --line ${code}:${ISSUER} --network testnet`);
  return { alias, addr, kp };
}
async function mint(toAddr, code, units) {
  const stroops = BigInt(units) * 10_000_000n;
  await shR(`stellar tx new payment --source usdc-issuer --destination ${toAddr} --asset ${code}:${ISSUER} --amount ${stroops} --network testnet`);
}
async function invoke(kp, fn, args) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let acc; try { acc = await server.getAccount(kp.publicKey()); } catch { await sleep(3000); continue; }
    const op = new Contract(MARKET).call(fn, ...args.map(enc));
    const built = new TransactionBuilder(acc, { fee: "5000000", networkPassphrase: NET }).addOperation(op).setTimeout(180).build();
    let prepared; try { prepared = await server.prepareTransaction(built); } catch (e) { if (attempt < 7) { await sleep(4000); continue; } throw e; }
    prepared.sign(kp);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR") { if (/txBadSeq/i.test(JSON.stringify(sent.errorResult || "")) && attempt < 7) { await sleep(4000); continue; } throw new Error(fn + " rejected: " + JSON.stringify(sent.errorResult)); }
    let g = await server.getTransaction(sent.hash);
    for (let i = 0; i < 90 && g.status === "NOT_FOUND"; i++) { await sleep(3000); g = await server.getTransaction(sent.hash); }
    if (g.status === "NOT_FOUND" && attempt < 7) { await sleep(3000); continue; } // resubmit fresh
    if (g.status !== "SUCCESS") throw new Error(fn + " tx " + g.status);
    return sent.hash;
  }
  throw new Error(fn + " exhausted retries");
}
async function view(fn, args) {
  const acc = await server.getAccount(ISSUER);
  const op = new Contract(MARKET).call(fn, ...args.map(enc));
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: NET }).addOperation(op).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result.retval);
}

(async () => {
  const t = Date.now();
  console.log("market:", MARKET);
  // --- seed: LP supplies 5000 USDC + 5000 EURC ---
  console.log("funding LP + supplying liquidity…");
  const lp = await fundAccount("mlp" + (t % 100000));
  await mint(lp.addr, "USDC", 6000); await mint(lp.addr, "EURC", 6000); await sleep(5000);
  await invoke(lp.kp, "supply", [{ t: "a", v: lp.addr }, { t: "u", v: 1 }, { t: "i", v: 5000n * D }]);
  await invoke(lp.kp, "supply", [{ t: "a", v: lp.addr }, { t: "u", v: 2 }, { t: "i", v: 5000n * D }]);
  console.log("reserves USDC/EURC:", String(await view("reserve", [{ t: "u", v: 1 }])), "/", String(await view("reserve", [{ t: "u", v: 2 }])));

  // --- E2E: trader swaps 100 USDC -> EURC ---
  console.log("trader swap…");
  const trader = await fundAccount("mtr" + (t % 100000));
  await mint(trader.addr, "USDC", 200); await sleep(5000);
  await invoke(trader.kp, "swap", [{ t: "a", v: trader.addr }, { t: "u", v: 1 }, { t: "i", v: 100n * D }, { t: "i", v: 0n }]);
  console.log("after swap: EURC reserve =", String(await view("reserve", [{ t: "u", v: 2 }])), "| USDC cum_fees =", String(await view("cum_fees", [{ t: "u", v: 1 }])));

  // --- E2E: borrower supplies 1000 EURC, borrows 500 USDC ---
  console.log("borrower flow…");
  const bob = await fundAccount("mbob" + (t % 100000));
  await mint(bob.addr, "EURC", 1000); await sleep(5000);
  await invoke(bob.kp, "supply", [{ t: "a", v: bob.addr }, { t: "u", v: 2 }, { t: "i", v: 1000n * D }]);
  await invoke(bob.kp, "borrow", [{ t: "a", v: bob.addr }, { t: "u", v: 1 }, { t: "i", v: 500n * D }]);
  const debt = await view("position", [{ t: "a", v: bob.addr }, { t: "u", v: 1 }]);
  const util = await view("utilization_bps", [{ t: "u", v: 1 }]);
  const bApy = await view("borrow_rate_bps", [{ t: "u", v: 1 }]);
  const sApy = await view("supply_rate_bps", [{ t: "u", v: 1 }]);
  const cumFees = await view("cum_fees", [{ t: "u", v: 1 }]);
  const health = await view("health", [{ t: "a", v: bob.addr }]);
  console.log(`bob debt=${debt.borrowed} util_bps=${util} borrowApy_bps=${bApy} supplyApy_bps=${sApy} cumFees=${cumFees} health=${health}`);

  const ok = BigInt(debt.borrowed) >= 500n * D && BigInt(util) > 0n && BigInt(bApy) > 0n && BigInt(sApy) > 0n && BigInt(cumFees) > 0n;
  if (!ok) { console.log("❌ E2E assertions failed"); process.exit(1); }
  console.log("\n✅ MARKET SEEDED + E2E PASSED — reserves honoured the swap, LP fees accrued, borrowing raised utilisation -> APY > 0.");
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
