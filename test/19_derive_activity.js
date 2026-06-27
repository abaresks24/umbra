// Unit-test the chain-derived activity classifier with real Note objects:
// model a deposit (A) and a transfer A→B, then check that A sees "Sent 2" and
// "deposit(=receive without token data)", and B sees "Received 2". This is the
// nullifier-ownership trick that lets each wallet rebuild its history from chain.
const assert = require("assert");
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { nullifierHex } = require("../client/lib/scan");

// faithful copy of web/src/main.js deriveActivity (pure function)
function deriveActivity(groups, owned) {
  const byCommit = new Map(owned.map((o) => [o.commitment || o.note.commitment().toString(), o]));
  const byNull = new Map(owned.map((o) => [nullifierHex(o.note.nullifier(o.index)), o]));
  const acts = [];
  for (const g of groups) {
    const myOuts = g.commits.map((c) => byCommit.get(c.commitment)).filter(Boolean).filter((o) => o.amount > 0n);
    const mySpent = g.nullifiers.map((n) => byNull.get(n)).filter(Boolean);
    if (!myOuts.length && !mySpent.length) continue;
    const ts = Date.parse(g.ts) || 0;
    if (mySpent.length) {
      const net = mySpent.reduce((s, o) => s + o.amount, 0n) - myOuts.reduce((s, o) => s + o.amount, 0n);
      if (net <= 0n) continue;
      acts.push({ dir: "send", amount: net.toString(), assetId: Number(mySpent[0].assetId), ts, hash: g.hash });
    } else {
      for (const o of myOuts) acts.push({ dir: "receive", amount: o.amount.toString(), assetId: Number(o.assetId), ts, hash: g.hash });
    }
  }
  return acts;
}
const own = (note, index) => ({ note, index, amount: note.amount, assetId: note.assetId, commitment: note.commitment().toString() });

(async () => {
  await initPoseidon();
  const A = new Keypair(), B = new Keypair();
  const ZERO = new Keypair();

  // A deposits 5 (tx1): outputs = [depositNote(5), dummy(0)]; nullifies two dummy inputs
  const dep = new Note({ amount: 5n, assetId: 1n, owner: A });
  const dep0 = new Note({ amount: 0n, assetId: 1n, owner: A });
  const dN0 = new Note({ amount: 0n, assetId: 1n, owner: ZERO }), dN1 = new Note({ amount: 0n, assetId: 1n, owner: ZERO });
  const tx1 = { hash: "tx1", ts: "2026-01-01T00:00:00Z",
    commits: [{ index: 0, commitment: dep.commitment().toString() }, { index: 1, commitment: dep0.commitment().toString() }],
    nullifiers: [nullifierHex(dN0.nullifier(98)), nullifierHex(dN1.nullifier(99))] };

  // A sends 2 to B (tx2): spends depositNote(5); outputs = [toB(2), change(3)]
  const toB = new Note({ amount: 2n, assetId: 1n, owner: B });
  const change = new Note({ amount: 3n, assetId: 1n, owner: A });
  const tx2 = { hash: "tx2", ts: "2026-01-02T00:00:00Z",
    commits: [{ index: 2, commitment: toB.commitment().toString() }, { index: 3, commitment: change.commitment().toString() }],
    nullifiers: [nullifierHex(dep.nullifier(0)), nullifierHex(dN0.nullifier(50))] };

  const groups = [tx1, tx2];
  const ownedA = [own(dep, 0), own(dep0, 1), own(change, 3)]; // A can decrypt its outputs (incl. spent dep)
  const ownedB = [own(toB, 2)];

  const actA = deriveActivity(groups, ownedA);
  const actB = deriveActivity(groups, ownedB);
  console.log("A activity:", actA.map((a) => `${a.dir} ${a.amount}`));
  console.log("B activity:", actB.map((a) => `${a.dir} ${a.amount}`));

  // A: tx1 → receive 5 (deposit; overlay relabels to "deposit"); tx2 → send 2 (5 in − 3 change)
  assert.deepStrictEqual(actA.map((a) => `${a.dir}:${a.amount}`), ["receive:5", "send:2"], "A wrong");
  // B: tx1 → nothing; tx2 → received 2
  assert.deepStrictEqual(actB.map((a) => `${a.dir}:${a.amount}`), ["receive:2"], "B wrong");
  console.log("\n✅ deriveActivity classifies deposit / send (net) / received correctly");
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
