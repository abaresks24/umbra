// De-risk spike for ENFORCED auditor disclosure: prove the in-circuit Baby Jubjub
// ElGamal encryption (elgamal.circom) produces the SAME R + ciphertext as the
// off-chain encrypter, and that the auditor decrypts it back. If this matches,
// in-circuit enforcement is sound to integrate into transfer.circom.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const { initAuditor, newAuditorKey, encryptToAuditor, decryptAsAuditor, randomScalar } = require("../client/lib/auditor");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
let pass = 0, fail = 0;
const ck = (n, c) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

(async () => {
  await initAuditor();
  fs.mkdirSync(B, { recursive: true });

  console.log("compiling elgamal.circom…");
  execSync(`circom circuits/elgamal.circom --wasm --r1cs -o ${B} -l node_modules/circomlib/circuits`, { cwd: ROOT });

  const auditor = newAuditorKey();
  const msg = [123n, 456789n, 999999999999n]; // (amount, pubkey, blinding)-shaped
  const r = randomScalar();
  const off = encryptToAuditor(msg, auditor, r);

  // compute the witness from the circuit and read its public outputs
  const input = { r: r.toString(), msg: msg.map(String), auditorPub: [auditor.pubX, auditor.pubY] };
  const wtns = path.join(B, "elgamal.wtns");
  await snarkjs.wtns.calculate(input, path.join(B, "elgamal_js/elgamal.wasm"), wtns);
  const w = await snarkjs.wtns.exportJson(wtns); // [1, R0,R1, c0,c1,c2, auditorPubX,auditorPubY, ...]

  const circR = [w[1], w[2]];
  const circCipher = [w[3], w[4], w[5]];
  const circAud = [w[6], w[7]];

  ck("witness layout sane (auditorPub matches input)", circAud[0] === BigInt(auditor.pubX) && circAud[1] === BigInt(auditor.pubY));
  ck("in-circuit R == off-chain R", circR[0] === off.R[0] && circR[1] === off.R[1]);
  ck("in-circuit cipher == off-chain cipher", circCipher.every((c, j) => c === off.cipher[j]));

  // auditor decrypts the in-circuit ciphertext
  const dec = decryptAsAuditor(circR, circCipher, auditor.priv);
  ck("auditor decrypts in-circuit ciphertext back to msg", dec.every((m, j) => m === msg[j]));

  // a different (wrong) auditor key cannot recover msg
  const other = newAuditorKey();
  const bad = decryptAsAuditor(circR, circCipher, other.priv);
  ck("wrong auditor key does NOT recover msg", !bad.every((m, j) => m === msg[j]));

  console.log(`\n${fail === 0 ? "🎉" : "❌"} elgamal-match: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
