// Deploy a TEST pool from the swap-enabled WASM: init (transfer VK + saved
// auditor key), register asset 1 to a mintable token (so deposits work headless),
// and set the swap VK. Writes circuits/build/swap_config.json + swap_auditor.key.json.
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

// asset 1 = our self-issued, mintable test token (so the headless test can deposit).
const TEST_TOKEN_SAC = "CBNPZ4HUG2S6SRO7KRBHTNLDATIKRK7OY5QOYBRUYJZWRMKTBUSBUA4E"; // EURC:GDSYUUUB wrapper
const ISSUER = "GDSYUUUBVAALYG2TMZE6RHKLHGXQQBGIDZIXND23S5O54H7WGUGT73NF";

(async () => {
  await initAuditor();
  const auditor = newAuditorKey();
  const transferVk = JSON.parse(fs.readFileSync(path.join(B, "transfer_vk.json")));
  const swapVk = JSON.parse(fs.readFileSync(path.join(B, "swap_vk.json")));
  const USER = sh(`stellar keys address shield`);

  console.log("deploying swap-enabled pool…");
  const pool = sh(`stellar contract deploy --wasm "${WASM}" --source shield --network testnet`).split("\n").pop();
  await sleep(8000);
  const ip = (a) => shR(`stellar contract invoke --id ${pool} --source shield --network testnet -- ${a}`);
  await ip(`init --admin ${USER} --vk_bytes ${vkToHex(transferVk)} --auditor_x ${auditor.pubX} --auditor_y ${auditor.pubY}`);
  await ip(`register_asset --asset_id 1 --token ${TEST_TOKEN_SAC}`);
  await ip(`set_swap_vk --vk_bytes ${vkToHex(swapVk)}`);
  await ip(`set_oracle --oracle CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W --div 100000000`); // Reflector forex

  const config = {
    poolId: pool, relayer: "shield",
    assets: [
      { id: 1, symbol: "tUSD", sac: TEST_TOKEN_SAC, decimals: 7, code: "EURC", issuer: ISSUER, faucet: "issuer" },
    ],
    userAddr: USER, auditorPubX: auditor.pubX, auditorPubY: auditor.pubY,
    startLedger: (await new rpc.Server("https://soroban-testnet.stellar.org").getLatestLedger()).sequence - 1,
    rpc: "https://soroban-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015",
    friendbot: "https://friendbot.stellar.org",
  };
  fs.writeFileSync(path.join(B, "swap_config.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(B, "swap_auditor.key.json"), JSON.stringify({ poolId: pool, priv: auditor.priv, pubX: auditor.pubX, pubY: auditor.pubY }, null, 2));
  console.log("\n✅ swap pool ready:", pool);
  console.log("config -> circuits/build/swap_config.json ; auditor key saved");
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
