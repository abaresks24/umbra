// Relayer + config server for the web wallet. It only ever sees PUBLIC data —
// the proof, the public signals (nullifiers/commitments/root), the encrypted
// ciphertexts, and the public recipient/amount. Proving happens in the browser,
// so the witness (amounts, keys, blindings) never leaves the user's machine.
const express = require("express");
const cors = require("cors");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const CONFIG = path.join(B, "web_config.json");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const HEX = /^[0-9a-fA-F]+$/;
const ADDR = /^[GC][A-Z0-9]{55}$/;
const INT = /^-?[0-9]+$/;

app.get("/api/config", (_req, res) => {
  if (!fs.existsSync(CONFIG)) return res.status(503).json({ error: "run scripts/init_web.js first" });
  res.json(JSON.parse(fs.readFileSync(CONFIG, "utf8")));
});

app.post("/api/submit", (req, res) => {
  const { proof, public: pub, caller, recipient, extAmount, fee, enc1, enc2 } = req.body || {};
  // strict validation — these go into a shell command
  for (const [k, v, re] of [
    ["proof", proof, HEX], ["public", pub, HEX], ["caller", caller, ADDR],
    ["recipient", recipient, ADDR], ["extAmount", String(extAmount), INT],
    ["fee", String(fee), INT], ["enc1", enc1, HEX], ["enc2", enc2, HEX],
  ]) {
    if (!v || !re.test(v)) return res.status(400).json({ ok: false, error: `bad field: ${k}` });
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const cmd =
    `stellar contract invoke --id ${cfg.poolId} --source ${cfg.relayer || "shield"} --network testnet --send=yes -- ` +
    `transact --caller ${caller} --proof ${proof} --public ${pub} --recipient ${recipient} ` +
    `--ext_amount=${extAmount} --fee=${fee} --enc1 ${enc1} --enc2 ${enc2}`;
  try {
    const out = execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.stderr || e.message).slice(0, 400) });
  }
});

app.listen(8787, () => console.log("relayer + config server on http://localhost:8787"));
