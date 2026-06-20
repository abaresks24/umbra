// Recipient note-discovery encryption (NaCl). The recipient decrypts their note;
// a stranger learns nothing. (Auditor disclosure is separate and ENFORCED
// in-circuit — see test/07 + test/08.)
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { newViewingKeypair, encryptOutput, unpackEnc, tryDecrypt } = require("../client/lib/encryption");

let pass = 0, fail = 0;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

(async () => {
  await initPoseidon();
  const aliceSpend = new Keypair();
  const alice = newViewingKeypair();
  const bob = newViewingKeypair();

  const note = new Note({ amount: 60n, owner: aliceSpend });
  const enc = encryptOutput(note, alice.viewPub);
  const { recipCt } = unpackEnc(enc);

  const a = tryDecrypt(alice.viewSecret, recipCt);
  ck("recipient decrypts amount", a && BigInt(a.amount) === 60n);
  ck("recipient sees owner pubkey", a && a.spendPub === note.pubkey.toString());
  ck("stranger cannot decrypt recipient ct", tryDecrypt(bob.viewSecret, recipCt) === null);

  console.log(`\n${fail === 0 ? "🎉" : "⚠️"} encryption: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e); process.exit(1); });
