// MAKE-OR-BREAK: prove the shielded SWAP circuit works end to end, locally.
// A holds a 10 USDC note. They swap 5.4 USD of value into 5.0 EURC at rate 1.08,
// keeping 4.6 USDC change. The proof must verify, conserve value, and carry the
// ENFORCED auditor ciphertext for the per-note asset.
const fs = require("fs"); const path = require("path");
const snarkjs = require("snarkjs");
const assert = require("assert");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { buildTree } = require("../client/lib/tree");
const { initAuditor, newAuditorKey } = require("../client/lib/auditor");
const { buildSwapWitness, proveSwap, SWAP_SCALE } = require("../client/lib/transaction");

const VK = JSON.parse(fs.readFileSync(path.join(__dirname, "../circuits/build/swap_vk.json"), "utf8"));

(async () => {
  await initPoseidon(); await initAuditor();
  const A = new Keypair();
  const auditor = newAuditorKey();

  // A's 10 USDC note (7 decimals -> 10.0 = 1e8), asset 1
  const usdc = new Note({ amount: 100000000n, assetId: 1n, owner: A });
  const tree = buildTree([usdc.commitment().toString()]);

  // rate: 1 EURC = 1.08 USD -> 1.08 * SCALE
  const rate = (108n * SWAP_SCALE) / 100n; // 1,080,000

  // swap 5.4 USD of value: out = 5.0 EURC + 4.6 USDC change
  const eurc = new Note({ amount: 50000000n, assetId: 2n, owner: A });   // 5.0 EURC
  const change = new Note({ amount: 46000000n, assetId: 1n, owner: A }); // 4.6 USDC

  const built = buildSwapWitness({
    tree,
    inputs: [{ note: usdc, index: 0 }],
    outputs: [eurc, change],
    rate, feeValue: 0n,
    extData: { recipient: "swap", extAmount: "0", fee: "0" }, // recipient enc not needed for the circuit test
    auditor: { pubX: auditor.pubX, pubY: auditor.pubY },
  });

  console.log("value in (USD·SCALE):", 100000000n * SWAP_SCALE, "= out 5 EURC·rate + 4.6 USDC·SCALE:", 50000000n * rate + 46000000n * SWAP_SCALE);
  console.log("proving the swap…");
  const { proof, publicSignals } = await proveSwap(built.witness);

  // public signals must match what we expect (and what a contract would parse)
  assert.deepStrictEqual(publicSignals.map(String), built.expectedPublic.map(String), "public signals mismatch");
  const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
  assert.ok(ok, "groth16 verify failed");

  console.log("\n✅ SHIELDED SWAP PROOF VERIFIES — USDC→EURC, value conserved at the oracle rate, auditor ciphertext enforced.");
  process.exit(0);
})().catch((e) => { console.error("\n❌", e.message || e); process.exit(1); });
