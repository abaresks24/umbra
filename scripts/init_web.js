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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// retry a CLI call (a freshly-deployed contract can take a few seconds to be
// visible to the RPC, which otherwise fails with "Contract not found")
async function shRetry(c, tries = 6) {
  for (let i = 0; i < tries; i++) { try { return sh(c); } catch (e) { if (i === tries - 1) throw e; await sleep(5000); } }
}

(async () => {
  const e = Object.fromEntries(fs.readFileSync(path.join(B, "usdc.env"), "utf8").trim().split("\n").map((l) => l.split("=")));
  const VK = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));

  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const startLedger = (await server.getLatestLedger()).sequence - 1;

  await initAuditor();
  const auditor = newAuditorKey(); // Baby Jubjub — disclosure ENFORCED in-circuit
  // SAVE THE KEY FIRST, before any on-chain step can fail. It is a random scalar;
  // if it is lost, this pool's audit ciphertexts can never be decrypted again.
  fs.writeFileSync(path.join(B, "auditor.key.json"), JSON.stringify({ priv: auditor.priv, pubX: auditor.pubX, pubY: auditor.pubY }, null, 2));

  console.log("deploying pool…");
  const poolId = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  await sleep(8000); // let the new contract instance propagate to the RPC
  const ip = (a) => shRetry(`stellar contract invoke --id ${poolId} --source shield --network testnet -- ${a}`);
  await ip(`init --admin ${e.USER_ADDR} --vk_bytes ${vkToHex(VK)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);

  // Both assets are REAL Circle testnet stablecoins (issuer home_domain circle.com),
  // so users fund their own Freighter wallet from faucet.circle.com.
  const CIRCLE_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  const CIRCLE_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const CIRCLE_EURC_SAC = "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ";
  const CIRCLE_EURC_ISSUER = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";
  const assets = [
    { id: 1, symbol: "USDC", sac: CIRCLE_USDC_SAC, decimals: 7, code: "USDC", issuer: CIRCLE_USDC_ISSUER, faucet: "circle" },
    { id: 2, symbol: "EURC", sac: CIRCLE_EURC_SAC, decimals: 7, code: "EURC", issuer: CIRCLE_EURC_ISSUER, faucet: "circle" },
  ];
  for (const a of assets) await ip(`register_asset --asset_id ${a.id} --token ${a.sac}`);
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
    networkPassphrase: "Test SDF Network ; September 2015",
    friendbot: "https://friendbot.stellar.org",
    circleFaucet: "https://faucet.circle.com",
  };
  fs.writeFileSync(path.join(B, "web_config.json"), JSON.stringify(config, null, 2));
  // re-save the key file now that we know the poolId (the priv was already saved above)
  fs.writeFileSync(path.join(B, "auditor.key.json"), JSON.stringify({ poolId, priv: auditor.priv, pubX: auditor.pubX, pubY: auditor.pubY }, null, 2));

  console.log("\n✅ web pool ready:", poolId);
  console.log("config -> circuits/build/web_config.json");
  console.log("auditor key SAVED -> circuits/build/auditor.key.json");
  console.log("\nAUDITOR private key (paste into the Auditor panel to demo ENFORCED disclosure):");
  console.log("  " + auditor.priv);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
