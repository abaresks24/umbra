// Thin wrapper around the stellar CLI to deploy the Groth16 verifier, store a VK,
// and verify proofs on testnet. (The web client in Phase 3 will use the JS SDK;
// for the CLI lifecycle, shelling out to `stellar` is simplest.)
const { execSync } = require("child_process");
const path = require("path");
const { vkToHex, proofToHex, publicToHex } = require("../../scripts/bn254_snark_hex");

const ROOT = path.join(__dirname, "../..");
const WASM = path.join(ROOT, "contracts/groth16-verifier/target/wasm32v1-none/release/groth16_verifier.wasm");
const SOURCE = process.env.STELLAR_IDENT || "shield";
const NETWORK = process.env.STELLAR_NETWORK || "testnet";

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function deployVerifier() {
  const out = sh(`stellar contract deploy --wasm "${WASM}" --source ${SOURCE} --network ${NETWORK}`);
  return out.split("\n").pop().trim();
}

function setVk(cid, vkJson) {
  const hex = vkToHex(vkJson);
  sh(`stellar contract invoke --id ${cid} --source ${SOURCE} --network ${NETWORK} -- set_vk --vk_bytes ${hex}`);
}

// Returns true/false from the on-chain verifier (read-only simulation).
function verifyOnChain(cid, proof, publicSignals) {
  const p = proofToHex(proof);
  const pub = publicToHex(publicSignals);
  const out = sh(`stellar contract invoke --id ${cid} --source ${SOURCE} --network ${NETWORK} -- verify --proof_bytes ${p} --public_bytes ${pub}`);
  return out.replace(/"/g, "").trim() === "true";
}

module.exports = { deployVerifier, setVk, verifyOnChain, WASM, SOURCE, NETWORK };
