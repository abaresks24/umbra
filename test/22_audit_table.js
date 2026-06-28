// Unit-test the auditor disclosure table: given decoded output notes (what the
// auditor recovers from the enforced ciphertexts) grouped by transaction, it must
// read off deposit rows and transfer rows (from = sender's change owner, to =
// recipient, amount = the sent amount).
const assert = require("assert");

// faithful copy of web/src/main.js auditTable
function auditTable(groups, decoded) {
  const byIdx = new Map(decoded.map((d) => [d.index, d]));
  const rows = [];
  for (const g of groups) {
    const outs = g.commits.map((c) => byIdx.get(c.index)).filter(Boolean).sort((a, b) => a.index - b.index);
    if (!outs.length) continue;
    const base = { ts: g.ts, ledger: g.ledger, hash: g.hash };
    if (outs.some((o) => o.opaque)) { rows.push({ ...base, sealed: true }); continue; }
    const nz = outs.filter((o) => BigInt(o.amount) > 0n);
    if (nz.length >= 2) rows.push({ ...base, from: outs[1].owner, to: outs[0].owner, amount: outs[0].amount, assetId: outs[0].assetId });
    else if (nz.length === 1) rows.push({ ...base, deposit: true, to: nz[0].owner, amount: nz[0].amount, assetId: nz[0].assetId });
  }
  return rows.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
}

const A = "111aaa", B = "222bbb";
// tx1 deposit: out0 = depositA(5), out1 = dummy(0)
const tx1 = { ts: "2026-01-01T10:00:00Z", ledger: 100, hash: "tx1", commits: [{ index: 0 }, { index: 1 }] };
// tx2 transfer A->B 2: out0 = toB(2), out1 = changeA(3)  (recipient first, change second)
const tx2 = { ts: "2026-01-02T10:00:00Z", ledger: 200, hash: "tx2", commits: [{ index: 2 }, { index: 3 }] };
const decoded = [
  { index: 0, amount: 5n, assetId: 1n, owner: A },
  { index: 1, amount: 0n, assetId: 1n, owner: A },
  { index: 2, amount: 2n, assetId: 2n, owner: B },
  { index: 3, amount: 3n, assetId: 2n, owner: A },
];

const rows = auditTable([tx1, tx2], decoded);
console.log(rows.map((r) => r.deposit ? `deposit → ${r.to} : ${r.amount} (asset ${r.assetId}, block ${r.ledger})` : `${r.from} → ${r.to} : ${r.amount} (asset ${r.assetId}, block ${r.ledger})`));

// newest first: tx2 transfer, then tx1 deposit
assert.strictEqual(rows.length, 2);
assert.deepStrictEqual({ from: rows[0].from, to: rows[0].to, amt: String(rows[0].amount), asset: String(rows[0].assetId), block: rows[0].ledger }, { from: A, to: B, amt: "2", asset: "2", block: 200 }, "transfer row wrong");
assert.ok(rows[1].deposit && rows[1].to === A && String(rows[1].amount) === "5" && rows[1].ledger === 100, "deposit row wrong");
console.log("\n✅ auditTable reads transfers (A→B, sent amount, block) and deposits correctly");
