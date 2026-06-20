// Phase 3 unit test: note encryption round-trips for the recipient, the auditor
// can decrypt everything, and a stranger learns nothing.
const { initPoseidon, Keypair, Note } = require("../client/lib/crypto");
const { newViewingKeypair, encryptOutput, unpackEnc, tryDecrypt } = require("../client/lib/encryption");

let pass = 0, fail = 0;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

(async () => {
  await initPoseidon();
  const aliceSpend = new Keypair();
  const alice = newViewingKeypair();
  const bob = newViewingKeypair();
  const auditor = newViewingKeypair();

  const note = new Note({ amount: 60n, owner: aliceSpend });
  const enc = encryptOutput(note, alice.viewPub, auditor.viewPub);
  const { recipCt, auditorCt } = unpackEnc(enc);

  // recipient (alice) decrypts
  const a = tryDecrypt(alice.viewSecret, recipCt);
  ck("recipient decrypts amount", a && BigInt(a.amount) === 60n);

  // auditor decrypts the auditor ciphertext
  const au = tryDecrypt(auditor.viewSecret, auditorCt);
  ck("auditor decrypts amount", au && BigInt(au.amount) === 60n);
  ck("auditor sees owner pubkey", au && au.spendPub === note.pubkey.toString());

  // stranger (bob) cannot read the recipient ciphertext
  ck("stranger cannot decrypt recipient ct", tryDecrypt(bob.viewSecret, recipCt) === null);
  // and cannot read the auditor ciphertext
  ck("stranger cannot decrypt auditor ct", tryDecrypt(bob.viewSecret, auditorCt) === null);

  console.log(`\n${fail === 0 ? "🎉" : "❌"} encryption: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e); process.exit(1); });
