// Vercel serverless relayer for shielded SWAPS. Receives PUBLIC data only (proof,
// public signals, the two output ciphertexts) and submits the pool's `swap`
// entrypoint signed by the relayer (SHIELD_SECRET) — the swapper's address never
// touches the chain. A swap moves no token (it is internal), so this is simpler
// than /api/submit: just proof + ciphertexts.
const { Contract, TransactionBuilder, nativeToScVal, rpc, Networks, Keypair } = require("stellar-sdk-relayer");
const CFG = require("./_config.js");

const HEX = /^[0-9a-fA-F]+$/;
const scBytes = (h) => nativeToScVal(Buffer.from(h, "hex"), { type: "bytes" });

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { proof, public: pub, enc1, enc2 } = b;
  for (const [k, v] of [["proof", proof], ["public", pub], ["enc1", enc1], ["enc2", enc2]]) {
    if (!v || !HEX.test(v)) return res.status(400).json({ ok: false, error: "bad field: " + k });
  }
  const secret = process.env.SHIELD_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "relayer not configured (SHIELD_SECRET)" });

  try {
    const kp = Keypair.fromSecret(secret);
    const server = new rpc.Server(CFG.rpc);
    const account = await server.getAccount(kp.publicKey());
    const op = new Contract(CFG.poolId).call("swap", scBytes(proof), scBytes(pub), scBytes(enc1), scBytes(enc2));
    let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: CFG.networkPassphrase || Networks.TESTNET })
      .addOperation(op).setTimeout(120).build();
    tx = await server.prepareTransaction(tx);
    tx.sign(kp);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") return res.status(400).json({ ok: false, error: "swap rejected: " + JSON.stringify(sent.errorResult || sent.status).slice(0, 200) });
    return res.json({ ok: true, hash: sent.hash, status: sent.status });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
