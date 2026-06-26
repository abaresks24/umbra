// Vercel serverless relayer (replaces the local Express relayer). Used only for
// private transfers + withdrawals — the user's address never appears on-chain
// (deposits are self-custodial via Freighter, client-side). It receives PUBLIC
// data only (proof, public signals, ciphertexts) and submits the transact signed
// by the relayer account (SHIELD_SECRET env). Returns once the network accepts
// the tx (PENDING) — the wallet polls the chain for confirmation — so the
// function stays well under the serverless time limit.
// Use an aliased stellar-sdk 14.x for the relayer: its CJS build resolves
// @noble/hashes to a CommonJS version, so it loads under Vercel's require-only
// serverless loader (sdk 16's CJS require()s an ESM-only @noble/hashes and
// crashes the function with ERR_REQUIRE_ESM). The browser keeps sdk 16. The
// relayer only builds/simulates/submits, so it doesn't need 16's meta decoding.
const { Contract, TransactionBuilder, nativeToScVal, Address, rpc, Networks, Keypair } = require("stellar-sdk-relayer");
const CFG = require("./_config.js");

const HEX = /^[0-9a-fA-F]+$/, ADDR = /^[GC][A-Z0-9]{55}$/, INT = /^-?[0-9]+$/;
const scBytes = (h) => nativeToScVal(Buffer.from(h, "hex"), { type: "bytes" });
const scAddr = (g) => new Address(g).toScVal();
const scI128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { proof, public: pub, recipient, extAmount, fee, enc1, enc2 } = b;
  for (const [k, v, re] of [
    ["proof", proof, HEX], ["public", pub, HEX], ["recipient", recipient, ADDR],
    ["extAmount", String(extAmount), INT], ["fee", String(fee ?? "0"), INT], ["enc1", enc1, HEX], ["enc2", enc2, HEX],
  ]) {
    if (!v || !re.test(v)) return res.status(400).json({ ok: false, error: "bad field: " + k });
  }
  const secret = process.env.SHIELD_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "relayer not configured (SHIELD_SECRET)" });

  try {
    const kp = Keypair.fromSecret(secret);
    const server = new rpc.Server(CFG.rpc);
    const account = await server.getAccount(kp.publicKey());
    const op = new Contract(CFG.poolId).call(
      "transact",
      scAddr(kp.publicKey()), scBytes(proof), scBytes(pub), scAddr(recipient),
      scI128(extAmount), scI128(fee ?? "0"), scBytes(enc1), scBytes(enc2),
    );
    let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: CFG.networkPassphrase || Networks.TESTNET })
      .addOperation(op).setTimeout(120).build();
    tx = await server.prepareTransaction(tx);
    tx.sign(kp);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") return res.status(400).json({ ok: false, error: "submit rejected: " + JSON.stringify(sent.errorResult || sent.status).slice(0, 200) });
    return res.json({ ok: true, hash: sent.hash, status: sent.status });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
