// Deploy + init the Umbra Market on the REAL Circle testnet USDC/EURC (the same
// SACs the shielded pool uses), and write the config. No minting, no seeding — the
// operator funds the pools and wallets themselves via the Circle faucet. Admin =
// `shield` key (also the EUR/USD price keeper).
const { execSync } = require("child_process");
const fs = require("fs"); const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");

const ROOT = path.join(__dirname, "..");
const WASM = path.join(ROOT, "contracts/market/target/wasm32v1-none/release/umbra_market.wasm");
const RPC = "https://soroban-testnet.stellar.org";
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shR(c, t = 8) { for (let i = 0; i < t; i++) { try { return sh(c); } catch (e) { if (i === t - 1) throw e; await sleep(5000); } } }

// the market trades the SAME Circle assets as the shielded pool
const baseCfg = require(path.join(ROOT, "api/_config.js"));
const USDC = baseCfg.assets.find((a) => a.id === 1);
const EURC = baseCfg.assets.find((a) => a.id === 2);
// Reflector SEP-40 forex feed on testnet (base USD, EUR available, 14 decimals)
const ORACLE = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";

async function liveEurUsd() {
  try { const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd")).json(); if (j?.["euro-coin"]?.usd) return Math.round(j["euro-coin"].usd * 1e7); } catch {}
  return Math.round(1.08 * 1e7);
}

(async () => {
  const ADMIN = sh(`stellar keys address shield`);
  const price = await liveEurUsd();
  console.log("deploying market on Circle USDC/EURC… price 1e7 =", price);
  const market = (await shR(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`)).split("\n").pop();
  for (let i = 0; i < 20; i++) { try { await new rpc.Server(RPC).getContractData(market, "Admin"); break; } catch { await sleep(4000); } }
  await sleep(4000);
  await shR(`stellar contract invoke --id ${market} --source shield --network testnet -- init --admin ${ADMIN} --usdc ${USDC.sac} --eurc ${EURC.sac} --eurc_price ${price}`);
  // wire the Reflector forex oracle: EUR/USD is now read live on-chain
  await shR(`stellar contract invoke --id ${market} --source shield --network testnet -- set_oracle --oracle ${ORACLE} --div 10000000`);

  const marketAssets = [
    { id: 1, symbol: "USDC", sac: USDC.sac, code: USDC.code, issuer: USDC.issuer, decimals: 7 },
    { id: 2, symbol: "EURC", sac: EURC.sac, code: EURC.code, issuer: EURC.issuer, decimals: 7 },
  ];
  fs.writeFileSync(path.join(ROOT, "circuits/build/market_config.json"), JSON.stringify({ market, marketAssets, oracle: ORACLE, eurcPrice: price, admin: ADMIN, rpc: RPC }, null, 2));
  const cfgPath = path.join(ROOT, "api/_config.js");
  let src = fs.readFileSync(cfgPath, "utf8");
  src = /"market":/.test(src) ? src.replace(/"market":\s*"[^"]*"/, `"market": "${market}"`) : src.replace(/("hasSwap":)/, `"market": "${market}",\n  $1`);
  if (/"marketAssets":/.test(src)) src = src.replace(/"marketAssets":\s*\[[\s\S]*?\]/, `"marketAssets": ${JSON.stringify(marketAssets)}`);
  else src = src.replace(/("hasSwap":)/, `"marketAssets": ${JSON.stringify(marketAssets)},\n  $1`);
  fs.writeFileSync(cfgPath, src);

  console.log("\n✅ market deployed + initialised on Circle assets:", market);
  console.log("   Fund liquidity yourself: supply USDC/EURC from a Circle-funded wallet (Earn tab).");
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
