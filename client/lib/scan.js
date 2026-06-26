// Read NewCommitment events from the pool and turn them into notes — both for a
// recipient (discover their own incoming notes) and for the auditor (reconstruct
// every note's amount + owner). This is how privacy ≠ opacity is demonstrated.
const { rpc, scValToNative } = require("@stellar/stellar-sdk");
const { tryDecrypt, unpackEnc } = require("./encryption");
const { Note, poseidon } = require("./crypto");
const { decryptAuditOutput } = require("./auditor");

const RPC_URL = process.env.STELLAR_RPC || "https://soroban-testnet.stellar.org";

// The Soroban RPC only retains events for a limited window. Clamp the requested
// startLedger up to the RPC's ACTUAL oldest retained ledger (from getHealth) so
// getEvents never hard-fails on a too-old start — but never higher, so we don't
// skip the pool's events. (A production deployment would persist events in an
// indexer and not depend on RPC retention at all.)
async function clampStart(server, startLedger) {
  try {
    const oldest = (await server.getHealth()).oldestLedger;
    return oldest ? Math.max(startLedger, oldest) : Math.max(1, startLedger);
  } catch {
    return Math.max(1, startLedger);
  }
}

// Ledger number encoded in a getEvents cursor TOID (high 32 bits).
function cursorLedger(c) {
  try { return Number(BigInt(String(c).split("-")[0]) >> 32n); } catch { return 0; }
}

// Fetch EVERY contract event since `startLedger`, paginating correctly.
// The Soroban RPC scans events in bounded ledger windows: a page can come back
// with fewer than `limit` events (even zero) while there are still more events
// in later ledgers. The only safe termination is to follow the response cursor
// until its window reaches the latest ledger — NOT to stop when a page is short
// (the old bug, which made the scan never reach recent deposits → balance 0).
async function getAllEvents(server, contractId, startLedger) {
  const out = [];
  let cursor = null, pages = 0;
  for (;;) {
    const req = { filters: [{ type: "contract", contractIds: [contractId] }], limit: 200 };
    if (cursor) req.cursor = cursor;
    else req.startLedger = Math.max(1, startLedger);
    const page = await server.getEvents(req);
    out.push(...(page.events || []));
    // The response-level cursor advances even across empty windows; the last
    // event's pagingToken is a fallback for older RPCs.
    const evs = page.events || [];
    const next = page.cursor || (evs.length ? evs[evs.length - 1].pagingToken : null);
    if (!next || next === cursor) break;                         // caught up to the tip
    cursor = next;
    if (page.latestLedger && cursorLedger(next) >= page.latestLedger) break;
    if (++pages > 2000) break;                                   // safety bound
  }
  return out;
}

// Fetch all `commit` events for `contractId` since `startLedger`.
// Returns [{ ledger, index, commitment(string), enc(hex) }] in tree order.
async function fetchCommitEvents(contractId, startLedger) {
  const server = new rpc.Server(RPC_URL);
  startLedger = await clampStart(server, startLedger);
  const out = [];
  for (const ev of await getAllEvents(server, contractId, startLedger)) {
    const topics = (ev.topic || []).map(scValToNative);
    if (topics[0] !== "commit") continue;
    const [commitment, enc] = scValToNative(ev.value);
    out.push({
      ledger: ev.ledger,
      index: Number(topics[1]),
      commitment: commitment.toString(),
      enc: Buffer.from(enc).toString("hex"),
    });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

// Recipient scan: which committed notes belong to me (decryptable with my view
// key AND whose commitment recomputes correctly under my spend key)?
function scanOwned(events, viewSecretHex, spendKeypair) {
  const owned = [];
  for (const ev of events) {
    try {
      const { recipCt } = unpackEnc(ev.enc);
      if (!recipCt) continue;
      const pt = tryDecrypt(viewSecretHex, recipCt);
      if (!pt) continue;
      const note = new Note({ amount: BigInt(pt.amount), assetId: BigInt(pt.assetId ?? 0), owner: spendKeypair, blinding: BigInt(pt.blinding) });
      if (note.commitment().toString() !== ev.commitment) continue; // not really ours
      owned.push({ note, index: ev.index, amount: BigInt(pt.amount), assetId: BigInt(pt.assetId ?? 0) });
    } catch { /* skip any malformed event — never abort the whole scan */ }
  }
  return owned;
}

// Fetch the ENFORCED auditor ciphertext events: per leaf, (R, c0, c1, c2).
async function fetchAuditEvents(contractId, startLedger) {
  const server = new rpc.Server(RPC_URL);
  startLedger = await clampStart(server, startLedger);
  const out = {};
  for (const ev of await getAllEvents(server, contractId, startLedger)) {
    const topics = (ev.topic || []).map(scValToNative);
    if (topics[0] !== "audit") continue;
    const d = scValToNative(ev.value).map((x) => BigInt(x)); // [Rx, Ry, c0, c1, c2, c3]
    out[Number(topics[1])] = { R: [d[0], d[1]], cipher: [d[2], d[3], d[4], d[5]] };
  }
  return out;
}

// 32-byte big-endian hex of a nullifier field element (matches the on-chain
// BytesN<32> emitted in `nullify` events).
function nullifierHex(big) {
  return BigInt(big).toString(16).padStart(64, "0");
}

// Authoritative spent-set from the chain: collect every nullifier the contract
// has marked spent (emitted in `nullify` events). Lets the wallet compute the
// real balance on ANY device — no local bookkeeping needed.
async function fetchSpentNullifiers(contractId, startLedger) {
  const server = new rpc.Server(RPC_URL);
  startLedger = await clampStart(server, startLedger);
  const set = new Set();
  for (const ev of await getAllEvents(server, contractId, startLedger)) {
    const topics = (ev.topic || []).map(scValToNative);
    if (topics[0] !== "nullify") continue;
    const [a, b] = scValToNative(ev.value); // two 32-byte BytesN
    set.add(Buffer.from(a).toString("hex"));
    set.add(Buffer.from(b).toString("hex"));
  }
  return set;
}

// ENFORCED auditor reconstruction: decrypt every note from the on-chain audit
// ciphertext (proof-guaranteed to be present and well-formed). Recovers the
// output slot by checking the decrypted note against its commitment.
function auditEnforced(commitEvents, auditMap, auditorPriv) {
  const decoded = [];
  for (const ev of commitEvents) {
    const a = auditMap[ev.index];
    if (!a) { decoded.push({ index: ev.index, commitment: ev.commitment, opaque: true }); continue; }
    let hit = null;
    for (const t of [0, 1]) {
      const m = decryptAuditOutput(a.R, a.cipher, t, auditorPriv); // [amount, assetId, pubkey, blinding]
      if (poseidon([m[0], m[1], m[2], m[3]]).toString() === ev.commitment) { hit = m; break; }
    }
    if (hit) decoded.push({ index: ev.index, commitment: ev.commitment, amount: hit[0], assetId: hit[1], owner: hit[2].toString() });
    else decoded.push({ index: ev.index, commitment: ev.commitment, opaque: true });
  }
  return decoded;
}

module.exports = { fetchCommitEvents, fetchAuditEvents, fetchSpentNullifiers, nullifierHex, scanOwned, auditEnforced, RPC_URL };
