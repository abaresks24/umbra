// Shielded USDC web wallet. Proving runs IN THE BROWSER (snarkjs over the served
// WASM+zkey), so the witness — amounts, keys, blindings — never leaves the
// device. The relayer only receives the proof + public signals + ciphertexts.
import * as snarkjs from "snarkjs";
import { initPoseidon, Keypair, Note } from "../../client/lib/crypto";
import { buildTree, merkleProof } from "../../client/lib/tree";
import { buildWitness } from "../../client/lib/transaction";
import { newViewingKeypair } from "../../client/lib/encryption";
import { initAuditor } from "../../client/lib/auditor";
import { fetchCommitEvents, fetchAuditEvents, scanOwned, auditEnforced } from "../../client/lib/scan";
import { proofToHex, publicToHex } from "../../scripts/bn254_snark_hex";

const WASM_URL = "/transfer.wasm";
const ZKEY_URL = "/transfer_final.zkey";
const $ = (id) => document.getElementById(id);
let CFG, ME, notes = [], log = [];

// ---- identity (persisted) ----
function loadIdentity() {
  let s = localStorage.getItem("shielded-id");
  if (!s) {
    const spend = new Keypair();
    const view = newViewingKeypair();
    s = JSON.stringify({ spend: spend.privkey.toString(), viewSecret: view.viewSecret, viewPub: view.viewPub });
    localStorage.setItem("shielded-id", s);
  }
  const j = JSON.parse(s);
  const spend = new Keypair(BigInt(j.spend));
  return { spend, viewSecret: j.viewSecret, viewPub: j.viewPub };
}
const myAddress = () => btoa(JSON.stringify({ s: ME.spend.pubkey.toString(), v: ME.viewPub }));
const parseAddress = (a) => { const j = JSON.parse(atob(a.trim())); return { spendPub: BigInt(j.s), viewPub: j.v }; };

function say(m) { log.unshift(`${new Date().toLocaleTimeString()}  ${m}`); render(); }

// ---- chain state ----
async function rescan() {
  say("scanning chain…");
  const events = await fetchCommitEvents(CFG.poolId, CFG.startLedger);
  const tree = buildTree(events.sort((a, b) => a.index - b.index).map((e) => e.commitment));
  const owned = scanOwned(events, ME.viewSecret, ME.spend);
  // keep only unspent: a note is spent if a later event reused... we approximate
  // by tracking nullifiers we've spent locally (demo simplification).
  const spent = new Set(JSON.parse(localStorage.getItem("spent") || "[]"));
  notes = owned.filter((n) => !spent.has(n.note.nullifier(n.index).toString()));
  window.__tree = tree;
  say(`found ${notes.length} spendable note(s), balance ${balance()} USDC`);
  render();
}
const balance = () => notes.reduce((a, n) => a + n.amount, 0n);
function markSpent(ns) {
  const spent = new Set(JSON.parse(localStorage.getItem("spent") || "[]"));
  for (const n of ns) spent.add(n.note.nullifier(n.index).toString());
  localStorage.setItem("spent", JSON.stringify([...spent]));
}

// ---- prove in-browser + submit via relayer ----
async function proveAndSubmit(params, { recipient, extAmount }) {
  say("building proof in-browser (this takes a few seconds)…");
  const r = buildWitness({ ...params, auditor: { pubX: CFG.auditorPubX, pubY: CFG.auditorPubY } });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(r.witness, WASM_URL, ZKEY_URL);
  say("proof generated — submitting to relayer…");
  const body = {
    proof: proofToHex(proof), public: publicToHex(publicSignals),
    caller: CFG.userAddr, recipient, extAmount: String(extAmount), fee: "0",
    enc1: r.enc1, enc2: r.enc2,
  };
  const res = await fetch("/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  say("✅ transaction confirmed on testnet");
  return params.inputs || [];
}

function selectInputs(amount) {
  const sorted = [...notes].sort((a, b) => (a.amount < b.amount ? 1 : -1));
  const chosen = []; let sum = 0n;
  for (const n of sorted) { if (sum >= amount) break; chosen.push(n); sum += n.amount; }
  if (sum < amount) throw new Error(`insufficient shielded balance (have ${sum}, need ${amount})`);
  if (chosen.length > 2) throw new Error("amount needs >2 notes; consolidate first (demo limit)");
  return { chosen, sum };
}

const enc = (recipients) => ({ senderViewPub: ME.viewPub, recipients });

async function shield(amount) {
  const tree = window.__tree;
  const note = new Note({ amount, owner: ME.spend });
  await proveAndSubmit({
    tree, inputs: [], outputs: [note], publicAmount: amount,
    extData: { recipient: CFG.userAddr, extAmount: String(amount), fee: "0" }, enc: enc([ME.viewPub]),
  }, { recipient: CFG.userAddr, extAmount: amount });
  setTimeout(rescan, 6000);
}

async function send(amount, addr) {
  const tree = window.__tree;
  const { chosen, sum } = selectInputs(amount);
  const rcpt = parseAddress(addr);
  const toR = new Note({ amount, owner: rcpt.spendPub });
  const change = new Note({ amount: sum - amount, owner: ME.spend });
  await proveAndSubmit({
    tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })),
    outputs: [toR, change], publicAmount: 0n,
    extData: { recipient: CFG.userAddr, extAmount: "0", fee: "0" }, enc: enc([rcpt.viewPub, ME.viewPub]),
  }, { recipient: CFG.userAddr, extAmount: 0 });
  markSpent(chosen);
  setTimeout(rescan, 6000);
}

async function unshield(amount, stellarAddr) {
  const tree = window.__tree;
  const { chosen, sum } = selectInputs(amount);
  const change = new Note({ amount: sum - amount, owner: ME.spend });
  await proveAndSubmit({
    tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })),
    outputs: [change], publicAmount: -amount,
    extData: { recipient: stellarAddr, extAmount: String(-amount), fee: "0" }, enc: enc([ME.viewPub]),
  }, { recipient: stellarAddr, extAmount: -amount });
  markSpent(chosen);
  setTimeout(rescan, 6000);
}

// ---- auditor panel ---- (ENFORCED disclosure: decrypt the in-circuit ciphertext)
async function runAudit(auditorPriv) {
  const events = await fetchCommitEvents(CFG.poolId, CFG.startLedger);
  const auditMap = await fetchAuditEvents(CFG.poolId, CFG.startLedger);
  const rows = auditEnforced(events, auditMap, auditorPriv);
  $("audit-out").innerHTML = rows.map((r) =>
    r.opaque ? `<tr><td>#${r.index}</td><td colspan=2>opaque</td></tr>`
      : `<tr><td>#${r.index}</td><td>${r.amount} USDC</td><td>${r.owner.slice(0, 16)}…</td></tr>`).join("");
}

// ---- UI ----
function render() {
  if (!CFG) return;
  $("app").innerHTML = `
    <h1>🛡️ Shielded USDC <span class="net">testnet</span></h1>
    <div class="grid">
      <section class="card">
        <h2>Your wallet</h2>
        <div class="bal">${balance()} <small>USDC shielded · ${notes.length} notes</small></div>
        <label>Your address (share to receive)</label>
        <textarea readonly rows=3>${myAddress()}</textarea>
        <button id="b-rescan">Rescan chain</button>
        <hr/>
        <div class="row"><input id="i-shield" type="number" placeholder="amount"/><button id="b-shield">Shield ▸</button></div>
        <div class="row"><input id="i-send" type="number" placeholder="amount"/><input id="a-send" placeholder="recipient address"/><button id="b-send">Send privately ▸</button></div>
        <div class="row"><input id="i-unshield" type="number" placeholder="amount"/><button id="b-unshield">Unshield to public ▸</button></div>
      </section>
      <section class="card">
        <h2>🔍 Auditor view</h2>
        <p class="muted">Paste the auditor's private key to reconstruct every note (disclosure is enforced in-circuit).</p>
        <textarea id="audit-key" rows=2 placeholder="auditor private key"></textarea>
        <button id="b-audit">Reconstruct ledger</button>
        <table><thead><tr><th>leaf</th><th>amount</th><th>owner</th></tr></thead><tbody id="audit-out"></tbody></table>
      </section>
    </div>
    <section class="card"><h2>Activity</h2><pre id="logbox">${log.slice(0, 12).join("\n")}</pre></section>`;

  const guard = (fn) => async () => { try { await fn(); } catch (e) { say("❌ " + (e.message || e)); } };
  $("b-rescan").onclick = guard(rescan);
  $("b-shield").onclick = guard(() => shield(BigInt($("i-shield").value || "0")));
  $("b-send").onclick = guard(() => send(BigInt($("i-send").value || "0"), $("a-send").value));
  $("b-unshield").onclick = guard(() => unshield(BigInt($("i-unshield").value || "0"), CFG.recipAddr));
  $("b-audit").onclick = guard(() => runAudit($("audit-key").value.trim()));
}

(async () => {
  await initPoseidon();
  await initAuditor();
  ME = loadIdentity();
  CFG = await (await fetch("/api/config")).json();
  if (CFG.error) { document.getElementById("app").innerHTML = `<pre>${CFG.error}</pre>`; return; }
  render();
  await rescan();
})();
