// Vercel serverless: serve the public wallet config (mirrors the local relayer's
// /api/config). No secrets — pool id, asset registry, auditor PUBLIC key, RPC.
const CONFIG = require("./_config.js");
module.exports = (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "public, max-age=60");
  res.end(JSON.stringify(CONFIG));
};
