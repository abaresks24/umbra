// Testnet faucet for the Umbra Market: sends test USDC + EURC to a connected
// account so it can supply / swap / borrow. The market runs on self-issued test
// tokens (issuer = ISSUER_SECRET) precisely so liquidity can be funded reliably.
// The destination must already trust both assets (the UI adds the trustlines via
// Freighter first). No secrets are exposed; payments are signed by the issuer.
const { Asset, Operation, TransactionBuilder, rpc, Networks, Keypair, BASE_FEE } = require("stellar-sdk-relayer");
const CFG = require("./_config.js");

const G = /^G[A-Z2-7]{55}$/;
const AMOUNT = "500"; // 500 of each, in whole units

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const address = String(b.address || "");
  if (!G.test(address)) return res.status(400).json({ ok: false, error: "bad address" });
  const secret = process.env.ISSUER_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "faucet not configured (ISSUER_SECRET)" });
  const assets = CFG.marketAssets || [];
  if (!assets.length) return res.status(500).json({ ok: false, error: "market assets not configured" });

  try {
    const kp = Keypair.fromSecret(secret);
    const issuer = kp.publicKey();
    const server = new rpc.Server(CFG.rpc);
    const account = await server.getAccount(issuer);
    const b2 = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: CFG.networkPassphrase || Networks.TESTNET });
    for (const a of assets) b2.addOperation(Operation.payment({ destination: address, asset: new Asset(a.code, a.issuer), amount: AMOUNT }));
    const tx = b2.setTimeout(120).build();
    tx.sign(kp);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      const e = JSON.stringify(sent.errorResult || sent.status);
      const msg = /op_no_trust/.test(e) ? "Add the USDC and EURC trustlines first" : "faucet rejected: " + e.slice(0, 160);
      return res.status(400).json({ ok: false, error: msg });
    }
    return res.json({ ok: true, hash: sent.hash });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 240) });
  }
};
