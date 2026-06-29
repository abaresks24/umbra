const { execSync } = require("child_process");
const fs = require("fs"); const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");
const { initAuditor, newAuditorKey } = require("../client/lib/auditor");
const { vkToHex } = require("./bn254_snark_hex");
const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const WASM = path.join(ROOT, "contracts/pool/target/wasm32v1-none/release/shielded_pool.wasm");
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shR(c, t = 6) { for (let i = 0; i < t; i++) { try { return sh(c); } catch (e) { if (i === t - 1) throw e; await sleep(5000); } } }
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", USDC_ISS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const EURC_SAC = "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ", EURC_ISS = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";
(async () => {
  await initAuditor();
  const a = newAuditorKey();
  const tVk = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json"))), sVk = JSON.parse(fs.readFileSync(path.join(B, "swap_vk.json")));
  const USER = sh(`stellar keys address shield`);
  console.log("deploying swap+USDC/EURC pool…");
  const pool = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  await sleep(8000);
  const ip = (x) => shR(`stellar contract invoke --id ${pool} --source shield --network testnet -- ${x}`);
  await ip(`init --admin ${USER} --vk_bytes ${vkToHex(tVk)} --auditor_x ${a.pubX} --auditor_y ${a.pubY}`);
  await ip(`register_asset --asset_id 1 --token ${USDC_SAC}`);
  await ip(`register_asset --asset_id 2 --token ${EURC_SAC}`);
  await ip(`set_swap_vk --vk_bytes ${vkToHex(sVk)}`);
  const startLedger = (await new rpc.Server("https://soroban-testnet.stellar.org").getLatestLedger()).sequence - 1;
  const cfg = { poolId: pool, assets: [
    { id: 1, symbol: "USDC", sac: USDC_SAC, decimals: 7, code: "USDC", issuer: USDC_ISS, faucet: "circle" },
    { id: 2, symbol: "EURC", sac: EURC_SAC, decimals: 7, code: "EURC", issuer: EURC_ISS, faucet: "circle" },
  ], userAddr: USER, recipAddr: "GAOCIYB37AWRTW5C66L5KBJYY4Y4CUDMXPYE4BHICTTKXEUIO4DXA5QI",
    auditorPubX: a.pubX, auditorPubY: a.pubY, startLedger, hasSwap: true,
    rpc: "https://soroban-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015",
    friendbot: "https://friendbot.stellar.org", circleFaucet: "https://faucet.circle.com" };
  fs.writeFileSync(path.join(B, "web_config.json"), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(B, "auditor.key.json"), JSON.stringify({ poolId: pool, priv: a.priv, pubX: a.pubX, pubY: a.pubY }, null, 2));
  fs.writeFileSync(path.join(ROOT, "api/_config.js"), "module.exports = " + JSON.stringify(cfg, null, 2) + ";\n");
  console.log("\n✅ swap-enabled demo pool:", pool, "\nAUDITOR KEY:", a.priv);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
