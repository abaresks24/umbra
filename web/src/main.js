// Umbra — privacy wallet on Stellar. Proving runs IN THE BROWSER (snarkjs over
// the served WASM+zkey); the witness never leaves the device. The relayer only
// submits public data. The visual identity is the eclipse: balances rest in the
// umbra (shadow) and a corona of light reveals them — to the owner on a tap, to
// the auditor by view key. All wallet logic is unchanged; this is presentation.
import * as snarkjs from "snarkjs";
import { initPoseidon, Note } from "../../client/lib/crypto";
import { buildTree } from "../../client/lib/tree";
import { buildWitness } from "../../client/lib/transaction";
import { initAuditor } from "../../client/lib/auditor";
import { randomSeed, deriveIdentity, decodeAddress } from "../../client/lib/identity";
import { fetchCommitEvents, fetchAuditEvents, fetchSpentNullifiers, nullifierHex, scanOwned, auditEnforced } from "../../client/lib/scan";
import { proofToHex, publicToHex } from "../../scripts/bn254_snark_hex";
import { submitTransact } from "../../client/lib/soroban";
import { connectFreighter, assetStatus, addTrustline, freighterSign, freighterInstalled } from "../../client/lib/wallet-connect";

const WASM_URL = "/transfer.wasm", ZKEY_URL = "/transfer_final.zkey";
const SEED_KEY = "umbra-seed";
const $ = (s) => document.querySelector(s);

let CFG, ME = null, notes = [], log = [], history = [];
let view = "landing", sheet = null, tmpSeed = "";
let asset = 1, proving = false, revealBalance = false, reveals = new Set();
let discCanvas = null, disc = null, heartbeat = 0;
let fr = null; // { address, status: {hasTrust, raw} } — connected Freighter account

// ---------- amount helpers ----------
const assetById = (id) => (CFG.assets || []).find((a) => Number(a.id) === Number(id));
const decOf = (id) => assetById(id)?.decimals ?? 7;
const symOf = (id) => assetById(id)?.symbol || `#${id}`;
function toRaw(human, d) {
  const s = String(human).trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) throw new Error("enter a valid amount");
  const [int, frac = ""] = s.split(".");
  if (frac.length > d) throw new Error(`${symOf(asset)} allows at most ${d} decimals`);
  return BigInt((int || "0") + frac.padEnd(d, "0"));
}
function toHuman(raw, d) {
  const s = BigInt(raw).toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d), frac = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}
const balanceOf = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
const noteCount = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).length;
const short = (s, n = 5) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || "");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// status line — patch in place during proving so the disc canvas is never torn down
const say = (m) => { log.unshift(`${new Date().toLocaleTimeString().slice(0, 8)}  ${m}`); const el = $("#prove-status"); if (proving && el) el.textContent = m.replace(/^[^ ]+ +/, ""); else render(); };

// ---------- identity ----------
const histKey = () => `umbra-hist-${ME.seed.slice(0, 8)}`;
const spentKey = () => `umbra-spent-${ME.seed.slice(0, 8)}`;
function connect(seed) {
  ME = deriveIdentity(seed);
  localStorage.setItem(SEED_KEY, ME.seed);
  history = JSON.parse(localStorage.getItem(histKey()) || "[]");
  view = "home"; sheet = null; notes = []; revealBalance = false;
  // heartbeat: keep balances converging even if testnet indexing lags the action
  clearInterval(heartbeat);
  heartbeat = setInterval(() => { if (ME && !proving) rescan(); }, 20000);
  render(); rescan();
}
function disconnect() { clearInterval(heartbeat); localStorage.removeItem(SEED_KEY); ME = null; notes = []; view = "landing"; sheet = null; render(); }
function pushHistory(e) { history.unshift({ ...e, ts: Date.now() }); localStorage.setItem(histKey(), JSON.stringify(history.slice(0, 50))); }

// ---------- chain ----------
async function rescan() {
  if (!ME) return;
  say("reading the horizon…");
  try {
    const [events, onchainSpent] = await Promise.all([
      fetchCommitEvents(CFG.poolId, CFG.startLedger),
      fetchSpentNullifiers(CFG.poolId, CFG.startLedger),
    ]);
    window.__tree = buildTree(events.sort((a, b) => a.index - b.index).map((e) => e.commitment));
    const localSpent = new Set(JSON.parse(localStorage.getItem(spentKey()) || "[]"));
    notes = scanOwned(events, ME.viewSecret, ME.spend).filter((n) => {
      const h = nullifierHex(n.note.nullifier(n.index));
      return !onchainSpent.has(h) && !localSpent.has(h);
    });
    say(`${notes.length} note${notes.length === 1 ? "" : "s"} in shadow`);
  } catch (e) { say("could not reach the network — retrying soon"); }
  if (!proving) render();
}
function scheduleRescans() { [6000, 14000, 25000, 40000].forEach((ms) => setTimeout(rescan, ms)); }
function markSpent(ns) {
  const s = new Set(JSON.parse(localStorage.getItem(spentKey()) || "[]"));
  ns.forEach((n) => s.add(nullifierHex(n.note.nullifier(n.index))));
  localStorage.setItem(spentKey(), JSON.stringify([...s]));
}
function selectInputs(amount, assetId) {
  const mine = notes.filter((n) => Number(n.assetId) === Number(assetId)).sort((a, b) => (a.amount < b.amount ? 1 : -1));
  const chosen = []; let sum = 0n;
  for (const n of mine) { if (sum >= amount) break; chosen.push(n); sum += n.amount; }
  if (sum < amount) throw new Error(`not enough ${symOf(assetId)} in shadow`);
  if (chosen.length > 2) throw new Error("this amount spans more than 2 notes — merge first");
  return { chosen, sum };
}

async function proveAndSubmit(params, { recipient, extAmount, assetId }) {
  say("entering the umbra — proving privately…");
  const r = buildWitness({ ...params, assetId, auditor: { pubX: CFG.auditorPubX, pubY: CFG.auditorPubY } });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(r.witness, WASM_URL, ZKEY_URL);
  say("proof formed — crossing the horizon…");
  const res = await fetch("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proof: proofToHex(proof), public: publicToHex(publicSignals), caller: CFG.userAddr, recipient, extAmount: String(extAmount), fee: "0", enc1: r.enc1, enc2: r.enc2 }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  say("settled in shadow");
}
const enc = (recipients) => ({ senderViewPub: ME.viewPub, recipients });

async function doShield(amount, assetId) {
  const note = new Note({ amount, assetId, owner: ME.spend });
  await proveAndSubmit({ tree: window.__tree, inputs: [], outputs: [note], publicAmount: amount, extData: { recipient: CFG.userAddr, extAmount: String(amount), fee: "0" }, enc: enc([ME.viewPub]) }, { recipient: CFG.userAddr, extAmount: amount, assetId });
  scheduleRescans();
}
async function doSend(amount, assetId, addr) {
  const { chosen, sum } = selectInputs(amount, assetId);
  const rcpt = decodeAddress(addr);
  const toR = new Note({ amount, assetId, owner: rcpt.spendPub });
  const change = new Note({ amount: sum - amount, assetId, owner: ME.spend });
  await proveAndSubmit({ tree: window.__tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })), outputs: [toR, change], publicAmount: 0n, extData: { recipient: CFG.userAddr, extAmount: "0", fee: "0" }, enc: enc([rcpt.viewPub, ME.viewPub]) }, { recipient: CFG.userAddr, extAmount: 0, assetId });
  markSpent(chosen); scheduleRescans();
}
async function doUnshield(amount, assetId, stellarAddr) {
  const { chosen, sum } = selectInputs(amount, assetId);
  const change = new Note({ amount: sum - amount, assetId, owner: ME.spend });
  await proveAndSubmit({ tree: window.__tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })), outputs: [change], publicAmount: -amount, extData: { recipient: stellarAddr, extAmount: String(-amount), fee: "0" }, enc: enc([ME.viewPub]) }, { recipient: stellarAddr, extAmount: -amount, assetId });
  markSpent(chosen); scheduleRescans();
}
async function doConsolidate(assetId) {
  const mine = notes.filter((n) => Number(n.assetId) === Number(assetId)).sort((a, b) => (a.amount < b.amount ? -1 : 1));
  if (mine.length < 2) throw new Error("nothing to merge");
  const [n1, n2] = mine;
  const merged = new Note({ amount: n1.amount + n2.amount, assetId, owner: ME.spend });
  await proveAndSubmit({ tree: window.__tree, inputs: [{ note: n1.note, index: n1.index }, { note: n2.note, index: n2.index }], outputs: [merged], publicAmount: 0n, extData: { recipient: CFG.userAddr, extAmount: "0", fee: "0" }, enc: enc([ME.viewPub]) }, { recipient: CFG.userAddr, extAmount: 0, assetId });
  markSpent([n1, n2]); scheduleRescans();
}

// ---------- Freighter (self-custodial deposits) ----------
async function refreshFr() {
  if (!fr) return;
  const a = assetById(asset);
  try { fr.status = await assetStatus(fr.address, a.code, a.issuer, a.decimals); } catch { fr.status = { hasTrust: false, raw: 0n }; }
}
async function doConnectFreighter() {
  if (!(await freighterInstalled())) { toast("Install the Freighter wallet extension"); window.open("https://www.freighter.app/", "_blank"); return; }
  fr = { address: await connectFreighter(), status: null };
  await refreshFr();
  render();
}

// Deposit (shield) — signed and paid BY THE USER via Freighter. caller == the
// user's Stellar account; their own public USDC moves into the pool.
async function runDeposit(amt, assetId) {
  if (proving) return;
  if (!fr) { toast("Connect Freighter first"); return; }
  proving = true; render(); disc?.occult();
  try {
    await rescan();
    const note = new Note({ amount: amt, assetId, owner: ME.spend });
    const r = buildWitness({
      tree: window.__tree, inputs: [], outputs: [note], publicAmount: amt, assetId,
      extData: { recipient: fr.address, extAmount: String(amt), fee: "0" }, enc: enc([ME.viewPub]),
      auditor: { pubX: CFG.auditorPubX, pubY: CFG.auditorPubY },
    });
    say("entering the umbra — proving privately…");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(r.witness, WASM_URL, ZKEY_URL);
    say("sign the deposit in Freighter…");
    await submitTransact({
      poolId: CFG.poolId, caller: fr.address, recipient: fr.address,
      proofHex: proofToHex(proof), publicHex: publicToHex(publicSignals),
      extAmount: amt.toString(), fee: 0, enc1: r.enc1, enc2: r.enc2,
      signXdr: freighterSign, rpcUrl: CFG.rpc,
    });
    say("settled in shadow");
    pushHistory({ dir: "deposit", amount: amt.toString(), assetId });
    disc?.settle(); sheet = null; await refreshFr();
  } catch (e) { say(e.message || String(e)); disc?.idle(); proving = false; render(); return; }
  proving = false; setTimeout(() => disc?.idle(), 1400); scheduleRescans(); render();
}

// orchestrated action runner — drives the occultation around the proof
async function runAction(kind, args) {
  if (proving) return;
  proving = true; render(); disc?.occult();
  try {
    await rescan();
    if (kind === "deposit") await doShield(args.amt, args.assetId);
    else if (kind === "send") await doSend(args.amt, args.assetId, args.addr);
    else if (kind === "withdraw") await doUnshield(args.amt, args.assetId, args.addr);
    else if (kind === "merge") await doConsolidate(args.assetId);
    if (kind !== "merge") pushHistory({ dir: kind, amount: args.amt.toString(), assetId: args.assetId });
    disc?.settle();
    sheet = null;
  } catch (e) { say(e.message || String(e)); disc?.idle(); proving = false; render(); return; }
  proving = false;
  setTimeout(() => disc?.idle(), 1400);
  render();
}

async function runAudit(priv) {
  const out = $("#audit-out");
  out.innerHTML = `<div class="muted small">reconstructing the ledger…</div>`;
  try {
    const [events, auditMap] = await Promise.all([fetchCommitEvents(CFG.poolId, CFG.startLedger), fetchAuditEvents(CFG.poolId, CFG.startLedger)]);
    const rows = auditEnforced(events, auditMap, priv).filter((r) => r.opaque || r.amount > 0n);
    if (!rows.length) { out.innerHTML = `<div class="muted small">No notes to disclose yet.</div>`; return; }
    out.innerHTML = rows.map((r) => r.opaque
      ? `<div class="arow"><span class="leaf">leaf ${r.index}</span><span class="muted">sealed</span><span></span></div>`
      : `<div class="arow lit"><span class="leaf">leaf ${r.index}</span><span class="amt">${esc(toHuman(r.amount, decOf(r.assetId)))} ${esc(symOf(r.assetId))}</span><span class="owner">${esc(short(r.owner, 6))}</span></div>`).join("");
  } catch (e) { out.innerHTML = `<div class="muted small">${esc(e.message || "could not read events")}</div>`; }
}

// ============================ rendering ============================
const mark = "•••";
const brand = `<div class="brand"><img class="brand-logo" src="/logo.png" alt="" aria-hidden="true"/>Umbra</div>`;

// Editorial direction: the eclipse is the logo (a dark umbra on cream paper),
// not a WebGL disc. These remain as harmless no-ops so the proving-animation
// hooks (disc?.occult() etc.) don't need to be threaded out of the action paths.
function placeDisc() {}

function render() {
  const app = $("#app");
  if (!CFG) { app.innerHTML = `<div class="screen center"><img class="hero-eclipse" src="/logo.png" alt="" style="opacity:.6"/></div>`; return; }
  if (CFG.error) { app.innerHTML = `<div class="screen center"><p class="muted">${esc(CFG.error)}</p></div>`; return; }

  if (proving) { app.innerHTML = provingView(); return; }
  if (view === "landing") return void (app.innerHTML = landingView(), wireLanding());
  if (view === "create") return void (app.innerHTML = createView(), wireCreate());
  if (view === "connect") return void (app.innerHTML = connectView(), wireConnect());
  if (view === "auditor") return void (app.innerHTML = auditorView(), wireAuditor());

  app.innerHTML = homeView() + (sheet ? sheetView() : "");
  placeDisc();
  wireHome();
  if (sheet) wireSheet();
}

// ---- landing ----
const landingView = () => `<div class="screen center landing">
  <img class="hero-logo" src="/logo.png" alt="Umbra" />
  <h1 class="title">Umbra</h1>
  <p class="phonetic">/ˈʌm.brə/</p>
  <p class="lede">The fully shaded inner region of a shadow — and a wallet where your money lives there. Private payments on Stellar; amounts and counterparties stay hidden, disclosed only to an auditor who holds the key.</p>
  <div class="stack">
    <button class="btn primary" id="go-create">Create wallet</button>
    <button class="btn ghost" id="go-connect">I have a private key</button>
  </div>
  <span class="net">Stellar testnet</span>
</div>`;
function wireLanding() {
  $("#go-create").onclick = () => { tmpSeed = randomSeed(); view = "create"; render(); };
  $("#go-connect").onclick = () => { view = "connect"; render(); };
}

const createView = () => `<div class="screen center pane">
  ${brand}
  <h2 class="title sm">Your private key</h2>
  <p class="lede">This single key is the only way back to your wallet. Keep it somewhere safe — it cannot be recovered.</p>
  <div class="keybox"><code id="seedval">${esc(tmpSeed)}</code></div>
  <button class="btn ghost wide" id="copyseed">Copy key</button>
  <label class="check"><input type="checkbox" id="saved"/> <span>I've saved my private key</span></label>
  <button class="btn primary" id="open" disabled>Open wallet</button>
  <button class="btn link" id="back">Back</button>
</div>`;
function wireCreate() {
  $("#copyseed").onclick = () => { navigator.clipboard?.writeText(tmpSeed); $("#copyseed").textContent = "Copied"; };
  $("#saved").onchange = (e) => { $("#open").disabled = !e.target.checked; };
  $("#open").onclick = () => connect(tmpSeed);
  $("#back").onclick = () => { view = "landing"; render(); };
}

const connectView = () => `<div class="screen center pane">
  ${brand}
  <h2 class="title sm">Connect wallet</h2>
  <p class="lede">Paste your private key to step back into the shadow.</p>
  <textarea id="seedin" class="field mono" rows="3" placeholder="private key"></textarea>
  <button class="btn primary" id="do-connect">Connect</button>
  <button class="btn link" id="back">Back</button>
</div>`;
function wireConnect() {
  $("#do-connect").onclick = () => { try { connect($("#seedin").value); } catch (e) { toast(e.message); } };
  $("#back").onclick = () => { view = "landing"; render(); };
}

// ---- home ----
function homeView() {
  const assets = CFG.assets || [];
  const bal = revealBalance ? toHuman(balanceOf(asset), decOf(asset)) : mark;
  const nc = noteCount(asset);
  return `<div class="screen home">
    <header class="bar">
      ${brand}
      <div class="bar-r">
        <button class="chip" id="copyaddr" title="copy your address">${esc(short(ME.address, 5))}</button>
        <button class="icon-btn" id="disconnect" title="disconnect" aria-label="disconnect">⏻</button>
      </div>
    </header>

    <section class="hero">
      <img class="hero-eclipse" src="/logo.png" alt="" aria-hidden="true" />
      <button class="hero-balance ${revealBalance ? "lit" : ""}" id="reveal-bal" aria-label="reveal balance">
        <span class="amt">${esc(bal)}</span>
        <span class="sym">${esc(symOf(asset))}</span>
      </button>
      <p class="hero-cap">${revealBalance ? "Tap to return to shadow" : "Your balance rests in shadow — tap to reveal"}</p>
      ${assets.length > 1 ? `<div class="asset-tabs">${assets.map((a) => `<button class="asset-tab ${a.id === asset ? "on" : ""}" data-asset="${a.id}">${esc(a.symbol)}</button>`).join("")}</div>` : ""}
      ${nc > 1 ? `<button class="merge-link" id="merge">Merge ${nc} notes</button>` : ""}
    </section>

    <nav class="actions">
      <button class="act" data-sheet="send"><span class="act-i">↗</span>Send</button>
      <button class="act" data-sheet="deposit"><span class="act-i">↧</span>Deposit</button>
      <button class="act" data-sheet="withdraw"><span class="act-i">↥</span>Withdraw</button>
      <button class="act" data-sheet="receive"><span class="act-i">◎</span>Receive</button>
    </nav>

    <div class="terminator"></div>

    <section class="activity">
      <div class="sec-h"><span>Activity</span><button class="link sm" id="go-audit">Auditor view</button></div>
      ${history.length ? history.slice(0, 8).map(activityRow).join("") : `<p class="empty">Nothing has crossed the horizon yet.</p>`}
    </section>
  </div>`;
}
function activityRow(e, i) {
  const dirIcon = { deposit: "↧", withdraw: "↥", send: "↗" }[e.dir] || "◐";
  const lit = reveals.has("h" + i);
  const amt = lit ? `${toHuman(e.amount, decOf(e.assetId))} ${symOf(e.assetId)}` : mark;
  const label = { deposit: "Deposited", withdraw: "Withdrew", send: "Sent" }[e.dir] || e.dir;
  const when = new Date(e.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `<button class="arow row-reveal ${lit ? "lit" : ""}" data-rev="h${i}">
    <span class="ecl ${e.dir}">${dirIcon}</span>
    <span class="arow-main"><span class="dir">${label}</span><span class="when">${esc(when)}</span></span>
    <span class="amt">${esc(amt)}</span>
  </button>`;
}
function wireHome() {
  placeDisc();
  $("#disconnect").onclick = disconnect;
  $("#copyaddr").onclick = () => { navigator.clipboard?.writeText(ME.address); toast("Address copied"); };
  $("#reveal-bal").onclick = () => { revealBalance = !revealBalance; disc?.reveal(revealBalance); render(); };
  $("#go-audit").onclick = () => { view = "auditor"; render(); };
  const m = $("#merge"); if (m) m.onclick = () => runAction("merge", { assetId: asset });
  document.querySelectorAll(".asset-tab").forEach((b) => b.onclick = () => { asset = Number(b.dataset.asset); revealBalance = false; render(); });
  document.querySelectorAll(".act").forEach((b) => b.onclick = async () => { sheet = b.dataset.sheet; render(); if (sheet === "deposit" && fr) { await refreshFr(); render(); } });
  document.querySelectorAll(".row-reveal").forEach((b) => b.onclick = () => { const k = b.dataset.rev; reveals.has(k) ? reveals.delete(k) : reveals.add(k); render(); });
}

// ---- sheets (send / deposit / withdraw / receive) ----
function sheetView() {
  const assets = CFG.assets || [];
  const sel = assets.length > 1 ? `<label class="lbl">Asset</label><div class="seg">${assets.map((a) => `<button class="seg-b ${a.id === asset ? "on" : ""}" data-sasset="${a.id}">${esc(a.symbol)}</button>`).join("")}</div>` : "";
  const amount = `<label class="lbl">Amount</label><input id="s-amt" class="field" inputmode="decimal" placeholder="0.0" autocomplete="off"/>`;
  let title, body, btn, hint;
  if (sheet === "send") {
    title = "Send in shadow"; btn = "Send";
    hint = "Amount and recipient stay hidden on-chain.";
    body = `${sel}<label class="lbl">Recipient</label><input id="s-addr" class="field mono" placeholder="umbra address (shld_…)" autocomplete="off"/>${amount}`;
  } else if (sheet === "deposit") {
    title = "Into nightfall"; btn = null; // wired separately to Freighter
    hint = "Deposit from your own Stellar wallet — public tokens enter the umbra.";
    const a = assetById(asset);
    if (!fr) {
      body = `${sel}<button class="btn primary" id="fr-connect">Connect Freighter</button>
        <p class="faucet">No ${esc(a.symbol)} yet? ${a.faucet === "circle"
          ? `Get testnet USDC at <a href="${esc(CFG.circleFaucet)}" target="_blank">faucet.circle.com</a>`
          : `ask the issuer to send you ${esc(a.symbol)}`} · XLM for fees at <a href="${esc(CFG.friendbot)}?addr=" target="_blank" id="xlm-faucet">friendbot</a>.</p>`;
    } else {
      const st = fr.status || { hasTrust: false, raw: 0n };
      const wallet = `<div class="fr-row"><span class="muted small">Freighter · <span class="mono">${esc(short(fr.address, 4))}</span></span><button class="link sm" id="fr-disc">Disconnect</button></div>
        <div class="fr-row"><span class="muted small">${esc(a.symbol)} available</span><span class="mono small">${st.hasTrust ? esc(toHuman(st.raw, a.decimals)) : "no trustline"} <button class="link sm" id="fr-refresh" title="refresh">↻</button></span></div>`;
      if (!st.hasTrust) {
        body = `${sel}${wallet}<button class="btn ghost" id="fr-trust">Add ${esc(a.symbol)} trustline</button>
          <p class="faucet">Then fund it: ${a.faucet === "circle" ? `<a href="${esc(CFG.circleFaucet)}" target="_blank">faucet.circle.com</a>` : `issuer top-up`}.</p>`;
      } else {
        body = `${sel}${wallet}${amount}<button class="btn primary" id="fr-deposit">Deposit</button>`;
      }
    }
  } else if (sheet === "withdraw") {
    title = "Toward daybreak"; btn = "Withdraw";
    hint = "Value returns to the public light.";
    body = `${sel}<label class="lbl">Destination</label><input id="s-addr" class="field mono" placeholder="Stellar address (G…)" value="${esc(CFG.recipAddr || "")}" autocomplete="off"/>${amount}`;
  } else {
    title = "A point of light"; btn = null;
    hint = "Share this address so others can find you in the dark.";
    body = `<div class="addr-box"><code>${esc(ME.address)}</code></div>`;
  }
  return `<div class="sheet-scrim" id="scrim"><div class="sheet" role="dialog" aria-label="${esc(title)}">
    <div class="sheet-grip"></div>
    <h3 class="sheet-title">${title}</h3>
    <p class="sheet-hint">${hint}</p>
    ${body}
    <div class="sheet-actions">
      ${sheet === "receive" ? `<button class="btn primary" id="s-copy">Copy</button><button class="btn ghost" id="s-cancel">Done</button>`
        : sheet === "deposit" ? `<button class="btn ghost" id="s-cancel">Close</button>`
        : `<button class="btn primary" id="s-go">${btn}</button><button class="btn ghost" id="s-cancel">Cancel</button>`}
    </div>
  </div></div>`;
}
function wireSheet() {
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") { sheet = null; render(); } };
  $("#s-cancel").onclick = () => { sheet = null; render(); };
  document.querySelectorAll(".seg-b").forEach((b) => b.onclick = async () => { asset = Number(b.dataset.sasset); if (fr) await refreshFr(); render(); });
  const copy = $("#s-copy"); if (copy) copy.onclick = () => { navigator.clipboard?.writeText(ME.address); copy.textContent = "Copied"; };
  // Freighter deposit controls
  const xf = $("#xlm-faucet"); if (xf && fr) xf.href = `${CFG.friendbot}?addr=${fr.address}`;
  const conn = $("#fr-connect"); if (conn) conn.onclick = async () => { try { await doConnectFreighter(); } catch (e) { toast(e.message || "connect failed"); } };
  const fdisc = $("#fr-disc"); if (fdisc) fdisc.onclick = () => { fr = null; toast("Freighter disconnected — switch account in Freighter, then reconnect"); render(); };
  const fref = $("#fr-refresh"); if (fref) fref.onclick = async () => { fref.textContent = "…"; await refreshFr(); render(); };
  const trust = $("#fr-trust"); if (trust) trust.onclick = async () => {
    const a = assetById(asset);
    try { trust.textContent = "Confirm in Freighter…"; await addTrustline(fr.address, a.code, a.issuer); await refreshFr(); render(); }
    catch (e) { toast(e.message || "trustline failed"); render(); }
  };
  const dep = $("#fr-deposit"); if (dep) dep.onclick = () => {
    let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(asset)); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    if (fr.status && amt > fr.status.raw) return toast(`Only ${toHuman(fr.status.raw, decOf(asset))} ${symOf(asset)} available`);
    runDeposit(amt, asset);
  };
  // send / withdraw (relayer)
  const go = $("#s-go"); if (!go) return;
  go.onclick = () => {
    let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(asset)); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    const addr = $("#s-addr") ? $("#s-addr").value.trim() : "";
    if (!addr) return toast("Enter a destination");
    runAction(sheet, { amt, assetId: asset, addr });
  };
}

// ---- auditor (corona mode — cool, lawful light) ----
const auditorView = () => `<div class="screen auditor">
  <header class="bar">
    <button class="icon-btn" id="audit-back" aria-label="back">←</button>
    <div class="brand"><img class="brand-logo" src="/logo.png" alt="" aria-hidden="true"/>Corona</div>
    <span></span>
  </header>
  <div class="aud-intro">
    <h2 class="title sm">Lawful light</h2>
    <p class="lede">The view key breaks one ring of light through the shadow. With it, an auditor reconstructs every note — amounts and parties — while the public sees nothing. Disclosure is enforced inside the proof itself.</p>
  </div>
  <label class="lbl">Auditor private key</label>
  <textarea id="audit-key" class="field mono" rows="2" placeholder="auditor key"></textarea>
  <button class="btn gold" id="b-audit">Reveal ledger</button>
  <div class="aud-out" id="audit-out"><p class="empty cool">The ledger waits in shadow.</p></div>
</div>`;
function wireAuditor() {
  disc?.idle();
  $("#audit-back").onclick = () => { view = "home"; render(); };
  $("#b-audit").onclick = () => runAudit($("#audit-key").value.trim());
}

// ---- proving (the occultation) ----
const provingView = () => `<div class="screen center proving">
  <img class="prove-eclipse" src="/logo.png" alt="" aria-hidden="true" />
  <p class="prove-status" id="prove-status">entering the umbra…</p>
  <p class="prove-sub">Generating your zero-knowledge proof. This happens on your device.</p>
</div>`;

// ---- toast ----
let toastT = 0;
function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600);
}

// ============================ boot ============================
(async () => {
  await initPoseidon();
  await initAuditor();
  try { CFG = await (await fetch("/api/config")).json(); } catch { CFG = { error: "Run the relayer (npm run web:server) and init the pool (npm run web:init)." }; }
  if (CFG.assets?.length) asset = CFG.assets[0].id;
  const saved = localStorage.getItem(SEED_KEY);
  if (saved && !CFG.error) { try { ME = deriveIdentity(saved); history = JSON.parse(localStorage.getItem(histKey()) || "[]"); view = "home"; heartbeat = setInterval(() => { if (ME && !proving) rescan(); }, 20000); } catch { localStorage.removeItem(SEED_KEY); } }
  render();
  if (ME) rescan();
})();
