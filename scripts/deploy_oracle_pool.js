// Redeploy the shielded pool with ORACLE-BOUND swaps. Reuses the EXISTING auditor
// key (so the auditor login keeps working) and PRESERVES every other field in
// api/_config.js (market, marketAssets, oracle, etc.) — only poolId + startLedger
// change. Wires the Reflector forex oracle so the swap rate is bound on-chain.
const { execSync } = require("child_process");
const fs = require("fs"); const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");
const { vkToHex } = require("./bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const WASM = path.join(ROOT, "contracts/pool/target/wasm32v1-none/release/shielded_pool.wasm");
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shR(c, t = 8) { for (let i = 0; i < t; i++) { try { return sh(c); } catch (e) { if (i === t - 1) throw e; await sleep(5000); } } }

const ORACLE = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W"; // Reflector forex (testnet)
const ORACLE_DIV = 100000000; // 14 -> 6 decimals (SWAP_SCALE = 1e6)

(async () => {
  const cfg = require(path.join(ROOT, "api/_config.js")); // current config (keep most of it)
  const aud = JSON.parse(fs.readFileSync(path.join(B, "auditor.key.json"), "utf8")); // REUSE auditor key
  if (aud.pubX !== cfg.auditorPubX) throw new Error("auditor.key.json does not match the live config — refusing to break the auditor login");
  const tVk = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));
  const sVk = JSON.parse(fs.readFileSync(path.join(B, "swap_vk.json")));
  const USER = sh(`stellar keys address shield`);
  const USDC = cfg.assets.find((a) => a.id === 1), EURC = cfg.assets.find((a) => a.id === 2);

  console.log("deploying oracle-bound shielded pool…");
  const pool = (await shR(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`)).split("\n").pop();
  for (let i = 0; i < 20; i++) { try { await new rpc.Server(cfg.rpc).getContractData(pool, "Admin"); break; } catch { await sleep(4000); } }
  await sleep(4000);
  const ip = (x) => shR(`stellar contract invoke --id ${pool} --source shield --network testnet -- ${x}`);
  await ip(`init --admin ${USER} --vk_bytes ${vkToHex(tVk)} --auditor_x ${aud.pubX} --auditor_y ${aud.pubY}`);
  await ip(`register_asset --asset_id 1 --token ${USDC.sac}`);
  await ip(`register_asset --asset_id 2 --token ${EURC.sac}`);
  await ip(`set_swap_vk --vk_bytes ${vkToHex(sVk)}`);
  await ip(`set_oracle --oracle ${ORACLE} --div ${ORACLE_DIV}`);
  const oracleRate = await ip(`oracle_rate`).catch(() => "?");
  const startLedger = (await new rpc.Server(cfg.rpc).getLatestLedger()).sequence - 1;

  // preserve everything; update only poolId + startLedger (+ record the swap oracle)
  const next = { ...cfg, poolId: pool, startLedger, swapOracle: ORACLE };
  fs.writeFileSync(path.join(ROOT, "api/_config.js"), "module.exports = " + JSON.stringify(next, null, 2) + ";\n");
  fs.writeFileSync(path.join(B, "auditor.key.json"), JSON.stringify({ ...aud, poolId: pool }, null, 2));

  console.log("\n✅ oracle-bound pool:", pool, "| oracle_rate (1e6):", oracleRate);
  console.log("   auditor key preserved; market fields preserved. Re-deposit to use it.");
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
