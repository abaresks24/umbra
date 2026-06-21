// Provision a pool for the web wallet: deploy + init, generate the auditor
// viewing keypair, capture the scan start ledger, and copy the circuit artifacts
// the browser needs into web/public/. Writes circuits/build/web_config.json.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");
const { initAuditor, newAuditorKey } = require("../client/lib/auditor");
const { vkToHex } = require("./bn254_snark_hex");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const WASM = path.join(ROOT, "contracts/pool/target/wasm32v1-none/release/shielded_pool.wasm");
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8" }).trim();

(async () => {
  const e = Object.fromEntries(fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("=")));
  const VK = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));

  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const startLedger = (await server.getLatestLedger()).sequence - 1;

  await initAuditor();
  const auditor = newAuditorKey(); // Baby Jubjub — disclosure ENFORCED in-circuit

  console.log("deploying pool…");
  const poolId = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  const ip = (a) => sh(`stellar contract invoke --id ${poolId} --source shield --network testnet -- ${a}`);
  ip(`init --admin ${e.USER_ADDR} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);

  // register the assets the pool supports (query each token's decimals)
  const decimalsOf = (sac) => {
    try { return Number(sh(`stellar contract invoke --id ${sac} --source shield --network testnet -- decimals`).replace(/"/g, "")); }
    catch { return 7; } // classic Stellar assets default to 7
  };
  const assets = [{ id: 0, symbol: "USDC", sac: e.USDC_SAC, decimals: decimalsOf(e.USDC_SAC) }];
  if (e.WETH_SAC) assets.push({ id: 1, symbol: "WETH", sac: e.WETH_SAC, decimals: decimalsOf(e.WETH_SAC) });
  for (const a of assets) ip(`register_asset --asset_id ${a.id} --token ${a.sac}`);
  console.log("registered assets:", assets.map((a) => `${a.id}=${a.symbol}`).join(", "));

  // copy browser-served circuit artifacts
  fs.mkdirSync(path.join(ROOT, "web/public"), { recursive: true });
  fs.copyFileSync(path.join(B, "transfer_js/transfer.wasm"), path.join(ROOT, "web/public/transfer.wasm"));
  fs.copyFileSync(path.join(B, "transfer_final.zkey"), path.join(ROOT, "web/public/transfer_final.zkey"));

  const config = {
    poolId, relayer: "shield",
    assets, userAddr: e.USER_ADDR, recipAddr: e.RECIP_ADDR,
    auditorPubX: auditor.pubX, auditorPubY: auditor.pubY, startLedger,
    rpc: "https://soroban-testnet.stellar.org",
  };
  fs.writeFileSync(path.join(B, "web_config.json"), JSON.stringify(config, null, 2));

  console.log("\n✅ web pool ready:", poolId);
  console.log("config -> circuits/build/web_config.json");
  console.log("\nAUDITOR private key (paste into the Auditor panel to demo ENFORCED disclosure):");
  console.log("  " + auditor.priv);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
