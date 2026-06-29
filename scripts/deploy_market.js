// Deploy + init the Umbra Market on mintable testnet USDC/EURC (self-issued by
// `usdc-issuer`), and write the config. Seeding liquidity + the on-chain E2E live
// in scripts/market_seed.js (run after this). Reliable: long propagation waits.
const { execSync } = require("child_process");
const fs = require("fs"); const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");

const ROOT = path.join(__dirname, "..");
const WASM = path.join(ROOT, "contracts/market/target/wasm32v1-none/release/umbra_market.wasm");
const RPC = "https://soroban-testnet.stellar.org";
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shR(c, t = 8) { for (let i = 0; i < t; i++) { try { return sh(c); } catch (e) { if (i === t - 1) throw e; await sleep(5000); } } }

const ISSUER = sh(`stellar keys address usdc-issuer`);
const USDC_SAC = "CCDJQFER3F56PVF3HNY3IQ6F7BQQHTQFJV4J7QN7NTAP4C75OVZR27JY";
const EURC_SAC = "CBNPZ4HUG2S6SRO7KRBHTNLDATIKRK7OY5QOYBRUYJZWRMKTBUSBUA4E";

async function liveEurUsd() {
  try { const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd")).json(); if (j?.["euro-coin"]?.usd) return Math.round(j["euro-coin"].usd * 1e7); } catch {}
  return Math.round(1.08 * 1e7);
}

(async () => {
  for (const code of ["USDC", "EURC"]) { try { sh(`stellar contract asset deploy --asset ${code}:${ISSUER} --source usdc-issuer --network testnet`); } catch {} }
  const ADMIN = sh(`stellar keys address shield`);
  const price = await liveEurUsd();
  console.log("deploying market on test USDC/EURC… price 1e7 =", price);
  const market = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  // wait for the new contract instance to be queryable before init
  for (let i = 0; i < 20; i++) { try { await new rpc.Server(RPC).getContractData(market, "Admin"); break; } catch { await sleep(4000); } }
  await sleep(4000);
  await shR(`stellar contract invoke --id ${market} --source shield --network testnet -- init --admin ${ADMIN} --usdc ${USDC_SAC} --eurc ${EURC_SAC} --eurc_price ${price}`);

  const marketAssets = [
    { id: 1, symbol: "USDC", sac: USDC_SAC, code: "USDC", issuer: ISSUER, decimals: 7 },
    { id: 2, symbol: "EURC", sac: EURC_SAC, code: "EURC", issuer: ISSUER, decimals: 7 },
  ];
  fs.writeFileSync(path.join(ROOT, "circuits/build/market_config.json"), JSON.stringify({ market, marketAssets, eurcPrice: price, admin: ADMIN, issuer: ISSUER, rpc: RPC }, null, 2));
  const cfgPath = path.join(ROOT, "api/_config.js");
  let src = fs.readFileSync(cfgPath, "utf8");
  src = /"market":/.test(src) ? src.replace(/"market":\s*"[^"]*"/, `"market": "${market}"`) : src.replace(/("hasSwap":)/, `"market": "${market}",\n  $1`);
  if (/"marketAssets":/.test(src)) src = src.replace(/"marketAssets":\s*\[[\s\S]*?\]/, `"marketAssets": ${JSON.stringify(marketAssets)}`);
  else src = src.replace(/("hasSwap":)/, `"marketAssets": ${JSON.stringify(marketAssets)},\n  $1`);
  fs.writeFileSync(cfgPath, src);

  console.log("\n✅ market deployed + initialised:", market);
  console.log("   config written; api/_config.js patched. Next: node scripts/market_seed.js");
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
