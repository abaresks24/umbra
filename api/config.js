// Vercel serverless: serve the public wallet config (mirrors the local relayer's
// /api/config). No secrets — pool id, asset registry, auditor PUBLIC key, RPC.
const CONFIG = require("./_config.js");
module.exports = (req, res) => {
  res.setHeader("content-type", "application/json");
  // never cache: the pool id / auditor key can change on a re-provision, and a
  // stale config would point the wallet (and the Auditor view) at the wrong pool.
  res.setHeader("cache-control", "no-store, max-age=0");
  res.end(JSON.stringify(CONFIG));
};
