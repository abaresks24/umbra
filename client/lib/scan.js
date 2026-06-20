// Read NewCommitment events from the pool and turn them into notes — both for a
// recipient (discover their own incoming notes) and for the auditor (reconstruct
// every note's amount + owner). This is how privacy ≠ opacity is demonstrated.
const { rpc, scValToNative } = require("@stellar/stellar-sdk");
const { tryDecrypt, unpackEnc } = require("./encryption");
const { Note, poseidon } = require("./crypto");
const { decryptAuditOutput } = require("./auditor");

const RPC_URL = process.env.STELLAR_RPC || "https://soroban-testnet.stellar.org";

// Fetch all `commit` events for `contractId` since `startLedger`.
// Returns [{ ledger, index, commitment(string), enc(hex) }] in tree order.
async function fetchCommitEvents(contractId, startLedger) {
  const server = new rpc.Server(RPC_URL);
  const out = [];
  let cursor;
  for (;;) {
    const req = { filters: [{ type: "contract", contractIds: [contractId] }], limit: 100 };
    if (cursor) req.cursor = cursor;
    else req.startLedger = Math.max(1, startLedger);
    const page = await server.getEvents(req);
    const evs = page.events || [];
    for (const ev of evs) {
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
    if (evs.length < 100) break;
    cursor = evs[evs.length - 1].pagingToken;
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

// Recipient scan: which committed notes belong to me (decryptable with my view
// key AND whose commitment recomputes correctly under my spend key)?
function scanOwned(events, viewSecretHex, spendKeypair) {
  const owned = [];
  for (const ev of events) {
    const { recipCt } = unpackEnc(ev.enc);
    const pt = tryDecrypt(viewSecretHex, recipCt);
    if (!pt) continue;
    const note = new Note({ amount: BigInt(pt.amount), owner: spendKeypair, blinding: BigInt(pt.blinding) });
    if (note.commitment().toString() !== ev.commitment) continue; // not really ours
    owned.push({ note, index: ev.index, amount: BigInt(pt.amount) });
  }
  return owned;
}

// Fetch the ENFORCED auditor ciphertext events: per leaf, (R, c0, c1, c2).
async function fetchAuditEvents(contractId, startLedger) {
  const server = new rpc.Server(RPC_URL);
  const out = {};
  let cursor;
  for (;;) {
    const req = { filters: [{ type: "contract", contractIds: [contractId] }], limit: 100 };
    if (cursor) req.cursor = cursor;
    else req.startLedger = Math.max(1, startLedger);
    const page = await server.getEvents(req);
    const evs = page.events || [];
    for (const ev of evs) {
      const topics = (ev.topic || []).map(scValToNative);
      if (topics[0] !== "audit") continue;
      const d = scValToNative(ev.value).map((x) => BigInt(x)); // [Rx, Ry, c0, c1, c2]
      out[Number(topics[1])] = { R: [d[0], d[1]], cipher: [d[2], d[3], d[4]] };
    }
    if (evs.length < 100) break;
    cursor = evs[evs.length - 1].pagingToken;
  }
  return out;
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
      const m = decryptAuditOutput(a.R, a.cipher, t, auditorPriv); // [amount, pubkey, blinding]
      if (poseidon(m).toString() === ev.commitment) { hit = m; break; }
    }
    if (hit) decoded.push({ index: ev.index, commitment: ev.commitment, amount: hit[0], owner: hit[1].toString() });
    else decoded.push({ index: ev.index, commitment: ev.commitment, opaque: true });
  }
  return decoded;
}

module.exports = { fetchCommitEvents, fetchAuditEvents, scanOwned, auditEnforced, RPC_URL };
