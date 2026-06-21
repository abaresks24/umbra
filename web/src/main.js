// Shielded wallet — Create/Connect flow, multi-asset, Phantom/Rabby-style UI.
// Proving runs IN THE BROWSER (snarkjs over served WASM+zkey); the witness never
// leaves the device. The relayer only submits public data.
import * as snarkjs from "snarkjs";
import { initPoseidon, poseidon, Note } from "../../client/lib/crypto";
import { buildTree } from "../../client/lib/tree";
import { buildWitness } from "../../client/lib/transaction";
import { initAuditor } from "../../client/lib/auditor";
import { randomSeed, deriveIdentity, decodeAddress } from "../../client/lib/identity";
import { fetchCommitEvents, fetchAuditEvents, fetchSpentNullifiers, nullifierHex, scanOwned, auditEnforced } from "../../client/lib/scan";
import { proofToHex, publicToHex } from "../../scripts/bn254_snark_hex";

const WASM_URL = "/transfer.wasm", ZKEY_URL = "/transfer_final.zkey";
const SEED_KEY = "shielded-seed";
const $ = (id) => document.getElementById(id);

let CFG, ME = null, notes = [], log = [], busy = false;
let screen = "landing", tmpSeed = "", action = "shield", asset = 0;

const assetById = (id) => (CFG.assets || []).find((a) => Number(a.id) === Number(id));
const decOf = (id) => assetById(id)?.decimals ?? 7;
// human "1.5" <-> raw base-unit BigInt, per the asset's decimals
function toRaw(human, d) {
  const s = String(human).trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) throw new Error("invalid amount");
  const [int, frac = ""] = s.split(".");
  if (frac.length > d) throw new Error(`max ${d} decimals`);
  return BigInt((int || "0") + frac.padEnd(d, "0"));
}
function toHuman(raw, d) {
  const s = BigInt(raw).toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d), frac = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}
const noteCount = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).length;
const say = (m) => { log.unshift(`${new Date().toLocaleTimeString().slice(0, 8)}  ${m}`); render(); };
const short = (s, n = 6) => s.length > 2 * n + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;

// ---------- identity ----------
function connect(seed) {
  ME = deriveIdentity(seed);
  localStorage.setItem(SEED_KEY, ME.seed);
  screen = "wallet"; notes = []; render(); rescan();
}
function disconnect() { localStorage.removeItem(SEED_KEY); ME = null; notes = []; screen = "landing"; render(); }

// ---------- chain ----------
const spentKey = () => `shielded-spent-${ME.seed.slice(0, 8)}`;
async function rescan() {
  if (!ME) return;
  say("scanning chain…");
  try {
    const [events, onchainSpent] = await Promise.all([
      fetchCommitEvents(CFG.poolId, CFG.startLedger),
      fetchSpentNullifiers(CFG.poolId, CFG.startLedger), // authoritative spent-set
    ]);
    window.__tree = buildTree(events.sort((a, b) => a.index - b.index).map((e) => e.commitment));
    // local set is only an optimistic hint to cover RPC indexing lag right after a spend
    const localSpent = new Set(JSON.parse(localStorage.getItem(spentKey()) || "[]"));
    notes = scanOwned(events, ME.viewSecret, ME.spend).filter((n) => {
      const h = nullifierHex(n.note.nullifier(n.index));
      return !onchainSpent.has(h) && !localSpent.has(h);
    });
    say(`found ${notes.length} note(s)`);
  } catch (e) { say("scan error: " + (e.message || e)); }
  render();
}
// RPC event indexing lags the tx by ~10-30s; poll a few times so balances catch up.
function scheduleRescans() { [6000, 14000, 25000, 40000].forEach((ms) => setTimeout(rescan, ms)); }
const balanceOf = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
function markSpent(ns) {
  const s = new Set(JSON.parse(localStorage.getItem(spentKey()) || "[]"));
  ns.forEach((n) => s.add(nullifierHex(n.note.nullifier(n.index))));
  localStorage.setItem(spentKey(), JSON.stringify([...s]));
}
function selectInputs(amount, assetId) {
  const mine = notes.filter((n) => Number(n.assetId) === Number(assetId)).sort((a, b) => (a.amount < b.amount ? 1 : -1));
  const chosen = []; let sum = 0n;
  for (const n of mine) { if (sum >= amount) break; chosen.push(n); sum += n.amount; }
  if (sum < amount) throw new Error(`insufficient ${assetById(assetId).symbol} balance`);
  if (chosen.length > 2) throw new Error("amount needs >2 notes — consolidate first");
  return { chosen, sum };
}

async function proveAndSubmit(params, { recipient, extAmount, assetId }) {
  say("generating zero-knowledge proof in your browser…");
  const r = buildWitness({ ...params, assetId, auditor: { pubX: CFG.auditorPubX, pubY: CFG.auditorPubY } });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(r.witness, WASM_URL, ZKEY_URL);
  say("proof ready — submitting…");
  const res = await fetch("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      proof: proofToHex(proof), public: publicToHex(publicSignals),
      caller: CFG.userAddr, recipient, extAmount: String(extAmount), fee: "0", enc1: r.enc1, enc2: r.enc2,
    }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  say("✅ confirmed on Stellar testnet");
}

const enc = (recipients) => ({ senderViewPub: ME.viewPub, recipients });

async function doShield(amount, assetId) {
  const note = new Note({ amount, assetId, owner: ME.spend });
  await proveAndSubmit({
    tree: window.__tree, inputs: [], outputs: [note], publicAmount: amount,
    extData: { recipient: CFG.userAddr, extAmount: String(amount), fee: "0" }, enc: enc([ME.viewPub]),
  }, { recipient: CFG.userAddr, extAmount: amount, assetId });
  scheduleRescans();
}
async function doSend(amount, assetId, addr) {
  const { chosen, sum } = selectInputs(amount, assetId);
  const rcpt = decodeAddress(addr);
  const toR = new Note({ amount, assetId, owner: rcpt.spendPub });
  const change = new Note({ amount: sum - amount, assetId, owner: ME.spend });
  await proveAndSubmit({
    tree: window.__tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })),
    outputs: [toR, change], publicAmount: 0n,
    extData: { recipient: CFG.userAddr, extAmount: "0", fee: "0" }, enc: enc([rcpt.viewPub, ME.viewPub]),
  }, { recipient: CFG.userAddr, extAmount: 0, assetId });
  markSpent(chosen); scheduleRescans();
}
async function doUnshield(amount, assetId, stellarAddr) {
  const { chosen, sum } = selectInputs(amount, assetId);
  const change = new Note({ amount: sum - amount, assetId, owner: ME.spend });
  await proveAndSubmit({
    tree: window.__tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })),
    outputs: [change], publicAmount: -amount,
    extData: { recipient: stellarAddr, extAmount: String(-amount), fee: "0" }, enc: enc([ME.viewPub]),
  }, { recipient: stellarAddr, extAmount: -amount, assetId });
  markSpent(chosen); scheduleRescans();
}

// Merge the two smallest notes of an asset into one (anti-dust). The pool is
// 2-in/2-out, so this halves note count per call; repeat to fully consolidate.
async function doConsolidate(assetId) {
  const mine = notes.filter((n) => Number(n.assetId) === Number(assetId)).sort((a, b) => (a.amount < b.amount ? -1 : 1));
  if (mine.length < 2) throw new Error("nothing to merge");
  const [n1, n2] = mine;
  const merged = new Note({ amount: n1.amount + n2.amount, assetId, owner: ME.spend });
  await proveAndSubmit({
    tree: window.__tree, inputs: [{ note: n1.note, index: n1.index }, { note: n2.note, index: n2.index }],
    outputs: [merged], publicAmount: 0n,
    extData: { recipient: CFG.userAddr, extAmount: "0", fee: "0" }, enc: enc([ME.viewPub]),
  }, { recipient: CFG.userAddr, extAmount: 0, assetId });
  markSpent([n1, n2]); scheduleRescans();
}

async function runAudit(priv) {
  const events = await fetchCommitEvents(CFG.poolId, CFG.startLedger);
  const auditMap = await fetchAuditEvents(CFG.poolId, CFG.startLedger);
  const rows = auditEnforced(events, auditMap, priv);
  $("audit-out").innerHTML = rows.map((r) => r.opaque
    ? `<tr><td>#${r.index}</td><td colspan=2 class="mut">opaque</td></tr>`
    : `<tr><td>#${r.index}</td><td><b>${toHuman(r.amount, decOf(r.assetId))}</b> ${assetById(r.assetId)?.symbol || `asset ${r.assetId}`}</td><td class="mut">${short(r.owner, 8)}</td></tr>`).join("");
}

// ---------- UI ----------
const logo = `<div class="logo"><span class="shield">🛡</span> <b>Shielded</b></div>`;

function render() {
  const app = $("app");
  if (!CFG) { app.innerHTML = `<div class="center"><div class="spinner"></div></div>`; return; }

  if (screen === "landing") {
    app.innerHTML = `<div class="center"><div class="hero">
      ${logo}
      <h1>Private payments<br/>on Stellar</h1>
      <p class="sub">Amounts and counterparties hidden on-chain. Auditable by design.</p>
      <button class="btn primary big" id="go-create">Create a new wallet</button>
      <button class="btn ghost big" id="go-connect">I already have a private key</button>
      <div class="net-pill">Stellar testnet</div>
    </div></div>`;
    $("go-create").onclick = () => { tmpSeed = randomSeed(); screen = "create"; render(); };
    $("go-connect").onclick = () => { screen = "connect"; render(); };
    return;
  }

  if (screen === "create") {
    app.innerHTML = `<div class="center"><div class="card narrow">
      ${logo}
      <h2>Your private key</h2>
      <p class="sub">This is the only way to access your wallet. Save it somewhere safe — we can't recover it.</p>
      <div class="keybox"><code id="seedval">${tmpSeed}</code><button class="btn tiny" id="copyseed">Copy</button></div>
      <label class="check"><input type="checkbox" id="saved"/> I've saved my private key</label>
      <button class="btn primary big" id="open" disabled>Open wallet</button>
      <button class="btn link" id="back">← Back</button>
    </div></div>`;
    $("copyseed").onclick = () => { navigator.clipboard.writeText(tmpSeed); $("copyseed").textContent = "Copied!"; };
    $("saved").onchange = (e) => { $("open").disabled = !e.target.checked; };
    $("open").onclick = () => connect(tmpSeed);
    $("back").onclick = () => { screen = "landing"; render(); };
    return;
  }

  if (screen === "connect") {
    app.innerHTML = `<div class="center"><div class="card narrow">
      ${logo}
      <h2>Connect wallet</h2>
      <p class="sub">Paste your private key to access your wallet.</p>
      <textarea id="seedin" rows="3" placeholder="your private key (hex)"></textarea>
      <button class="btn primary big" id="do-connect">Connect</button>
      <button class="btn link" id="back">← Back</button>
    </div></div>`;
    $("do-connect").onclick = () => { try { connect($("seedin").value); } catch (e) { say("❌ " + e.message); } };
    $("back").onclick = () => { screen = "landing"; render(); };
    return;
  }

  // ---- wallet ----
  const assets = CFG.assets || [];
  const recipField = action === "send"
    ? `<input id="f-addr" placeholder="recipient wallet address (shld_…)"/>`
    : action === "unshield" ? `<input id="f-addr" placeholder="public Stellar address (G…)" value="${CFG.recipAddr || ""}"/>` : "";
  app.innerHTML = `
    <header class="topbar">
      ${logo}
      <div class="right">
        <span class="net-pill">testnet</span>
        <button class="chip" id="copyaddr" title="copy your address">${short(ME.address, 8)} ⧉</button>
        <button class="btn tiny ghost" id="disc">Disconnect</button>
      </div>
    </header>
    <div class="wrap">
      <section class="balances">
        ${assets.map((a) => `<div class="asset-card">
          <div class="asset-top"><span class="asset-ico">${a.symbol[0]}</span><span>${a.symbol}</span>
            ${noteCount(a.id) > 1 ? `<button class="merge" data-merge="${a.id}" title="merge ${noteCount(a.id)} notes into fewer">⤵ ${noteCount(a.id)}</button>` : ""}</div>
          <div class="asset-bal">${toHuman(balanceOf(a.id), a.decimals)}<small>shielded</small></div>
        </div>`).join("")}
      </section>

      <section class="card pay">
        <div class="seg">
          ${["shield", "send", "unshield"].map((t) => `<button class="${action === t ? "on" : ""}" data-act="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
        </div>
        <div class="row">
          <select id="f-asset">${assets.map((a) => `<option value="${a.id}" ${a.id === asset ? "selected" : ""}>${a.symbol}</option>`).join("")}</select>
          <input id="f-amt" type="number" placeholder="0.0" min="0"/>
        </div>
        ${recipField}
        <button class="btn primary big" id="f-go" ${busy ? "disabled" : ""}>${busy ? "Working…" : action[0].toUpperCase() + action.slice(1)}</button>
        <p class="hint">${action === "shield" ? "Deposit public tokens into the shielded pool."
          : action === "send" ? "Send privately — amount & parties hidden on-chain."
          : "Withdraw from the pool to a public address."}</p>
      </section>

      <section class="card">
        <div class="card-h">Activity</div>
        <pre class="logbox">${log.slice(0, 10).join("\n") || "—"}</pre>
      </section>

      <section class="card">
        <div class="card-h">🔍 Auditor view <span class="mut">— enforced in-circuit</span></div>
        <p class="hint">Paste the auditor's private key to reconstruct every note (provably complete).</p>
        <textarea id="audit-key" rows="2" placeholder="auditor private key"></textarea>
        <button class="btn ghost" id="b-audit">Reconstruct ledger</button>
        <table class="audit"><thead><tr><th>leaf</th><th>amount</th><th>owner</th></tr></thead><tbody id="audit-out"></tbody></table>
      </section>
    </div>`;

  $("disc").onclick = disconnect;
  $("copyaddr").onclick = () => { navigator.clipboard.writeText(ME.address); $("copyaddr").textContent = "copied!"; setTimeout(render, 800); };
  app.querySelectorAll(".seg button").forEach((b) => b.onclick = () => { action = b.dataset.act; render(); });
  $("f-asset").onchange = (e) => { asset = Number(e.target.value); };
  app.querySelectorAll(".merge").forEach((btn) => btn.onclick = async () => {
    if (busy) return; busy = true; render();
    try { await rescan(); await doConsolidate(Number(btn.dataset.merge)); } catch (e) { say("❌ " + (e.message || e)); }
    finally { busy = false; render(); }
  });
  $("f-go").onclick = async () => {
    // capture form values BEFORE render() (which rebuilds the inputs)
    const a = Number($("f-asset").value);
    let amt; try { amt = toRaw($("f-amt").value || "0", decOf(a)); } catch (e) { say("❌ " + e.message); return; }
    const addr = $("f-addr") ? $("f-addr").value.trim() : "";
    if (amt <= 0n) { say("❌ enter an amount"); return; }
    if (action !== "shield" && !addr) { say("❌ enter a recipient address"); return; }
    if (busy) return;
    busy = true; render();
    try {
      await rescan(); // ensure the Merkle tree + notes reflect current chain state
      if (action === "shield") await doShield(amt, a);
      else if (action === "send") await doSend(amt, a, addr);
      else await doUnshield(amt, a, addr);
    } catch (e) { say("❌ " + (e.message || e)); }
    finally { busy = false; render(); }
  };
  $("b-audit").onclick = async () => { try { await runAudit($("audit-key").value.trim()); } catch (e) { say("❌ " + e.message); } };
}

(async () => {
  await initPoseidon();
  await initAuditor();
  CFG = await (await fetch("/api/config")).json();
  if (CFG.error) { $("app").innerHTML = `<div class="center"><pre>${CFG.error}</pre></div>`; return; }
  const saved = localStorage.getItem(SEED_KEY);
  if (saved) { try { ME = deriveIdentity(saved); screen = "wallet"; } catch { localStorage.removeItem(SEED_KEY); } }
  render();
  if (ME) rescan();
})();
