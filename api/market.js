// Fee-bump relayer for the DeFi market. The user signs an inner transaction with
// their wallet-derived MARKET identity (never their real Freighter account); this
// endpoint wraps it in a fee-bump paid by the relayer (SHIELD_SECRET) and submits.
// Result: market activity is signed by a fresh, privately-funded pseudonym and the
// gas is paid by the relayer — the user's real account never appears or pays.
// Only single-operation Soroban market calls or trustlines for the market assets
// are sponsored (so the relayer can't be abused to pay for arbitrary traffic).
const { TransactionBuilder, rpc, Networks, Keypair } = require("stellar-sdk-relayer");
const CFG = require("./_config.js");

const NET = CFG.networkPassphrase || Networks.TESTNET;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const xdr = b.xdr;
  if (!xdr || typeof xdr !== "string") return res.status(400).json({ ok: false, error: "missing xdr" });
  const secret = process.env.SHIELD_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "relayer not configured (SHIELD_SECRET)" });

  let inner;
  try { inner = TransactionBuilder.fromXDR(xdr, NET); } catch { return res.status(400).json({ ok: false, error: "bad xdr" }); }
  // only sponsor a single market-related operation
  const ops = inner.operations || [];
  const okAssets = new Set((CFG.marketAssets || []).map((a) => `${a.code}:${a.issuer}`));
  const allowed = ops.length === 1 && ops.every((o) =>
    o.type === "invokeHostFunction" ||
    (o.type === "changeTrust" && o.line && okAssets.has(`${o.line.code}:${o.line.issuer}`)));
  if (!allowed) return res.status(400).json({ ok: false, error: "only market calls / market trustlines are sponsored" });

  try {
    const kp = Keypair.fromSecret(secret);
    const server = new rpc.Server(CFG.rpc);
    const fb = TransactionBuilder.buildFeeBumpTransaction(kp, "2000000", inner, NET);
    fb.sign(kp);
    const sent = await server.sendTransaction(fb);
    if (sent.status === "ERROR") return res.status(400).json({ ok: false, error: "rejected: " + JSON.stringify(sent.errorResult || sent.status).slice(0, 220) });
    return res.json({ ok: true, hash: sent.hash, status: sent.status });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
