// Read NewCommitment events from the pool and turn them into notes — both for a
// recipient (discover their own incoming notes) and for the auditor (reconstruct
// every note's amount + owner). This is how privacy ≠ opacity is demonstrated.
const { rpc, scValToNative } = require("@stellar/stellar-sdk");
const { tryDecrypt, unpackEnc } = require("./encryption");
const { Note, Keypair, poseidon } = require("./crypto");

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

// Auditor scan: reconstruct EVERY note from the auditor ciphertext.
function auditAll(events, auditorSecretHex) {
  const decoded = [];
  for (const ev of events) {
    const { auditorCt } = unpackEnc(ev.enc);
    const pt = tryDecrypt(auditorSecretHex, auditorCt);
    if (!pt) { decoded.push({ index: ev.index, commitment: ev.commitment, opaque: true }); continue; }
    decoded.push({
      index: ev.index,
      commitment: ev.commitment,
      amount: BigInt(pt.amount),
      owner: pt.spendPub,
    });
  }
  return decoded;
}

module.exports = { fetchCommitEvents, scanOwned, auditAll, RPC_URL };
