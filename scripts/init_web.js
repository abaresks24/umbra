// Provision a pool for the web wallet: deploy + init, generate the auditor
// viewing keypair, capture the scan start ledger, and copy the circuit artifacts
// the browser needs into web/public/. Writes circuits/build/web_config.json.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { rpc } = require("@stellar/stellar-sdk");
const { newViewingKeypair } = require("../client/lib/encryption");
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

  console.log("deploying pool…");
  const poolId = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  sh(`stellar contract invoke --id ${poolId} --source shield --network testnet -- init --token ${e.USDC_SAC} --vk_bytes ${vkToHex(VK)}`);

  const auditor = newViewingKeypair();

  // copy browser-served circuit artifacts
  fs.mkdirSync(path.join(ROOT, "web/public"), { recursive: true });
  fs.copyFileSync(path.join(B, "transfer_js/transfer.wasm"), path.join(ROOT, "web/public/transfer.wasm"));
  fs.copyFileSync(path.join(B, "transfer_final.zkey"), path.join(ROOT, "web/public/transfer_final.zkey"));

  const config = {
    poolId, relayer: "shield",
    sac: e.USDC_SAC, userAddr: e.USER_ADDR, recipAddr: e.RECIP_ADDR,
    auditorViewPub: auditor.viewPub, startLedger,
    rpc: "https://soroban-testnet.stellar.org",
  };
  fs.writeFileSync(path.join(B, "web_config.json"), JSON.stringify(config, null, 2));

  console.log("\n✅ web pool ready:", poolId);
  console.log("config -> circuits/build/web_config.json");
  console.log("\nAUDITOR viewing SECRET (paste into the Auditor panel to demo disclosure):");
  console.log("  " + auditor.viewSecret);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
