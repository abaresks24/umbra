// Builds the witness for the 2-in/2-out transfer circuit and produces a Groth16
// proof. Shield / transfer / unshield all route through here — the only
// difference is publicAmount and which slots hold real vs dummy notes.
const snarkjs = require("snarkjs");
const { P, Note, toStr } = require("./crypto");
const { merkleProof, dummyProof } = require("./tree");
const { extDataHash } = require("./extdata");
const { encryptOutput } = require("./encryption");
const { encryptOutputsToAuditor, randomScalar } = require("./auditor");

const N_INS = 2;
const N_OUTS = 2;

// Resolved lazily (Node only) so this module also imports cleanly in the browser,
// where the web wallet calls snarkjs with URLs instead of file paths.
function nodeArtifacts() {
  const path = require("path");
  return {
    WASM: path.join(__dirname, "../../circuits/build/transfer_js/transfer.wasm"),
    ZKEY: path.join(__dirname, "../../circuits/build/transfer_final.zkey"),
  };
}

// Wrap a signed BigInt into the field (negative -> P - |x|).
function wrap(x) {
  const v = BigInt(x) % P;
  return v < 0n ? v + P : v;
}

// inputs:  [{ note: Note(with keypair), index: leafIndex }]  (0..2 real)
// outputs: [Note]  (0..2 real, recipient pubkey or own)
// publicAmount: signed BigInt (shield > 0, unshield < 0, transfer = 0)
// extData: { recipient, extAmount, fee, encryptedOutput1, encryptedOutput2 }
// `enc` (optional) drives the compliance layer:
//   { auditorViewPub, senderViewPub, recipients: [viewPubForOutput0, ...] }
// Each output is encrypted to its recipient's viewing key AND the auditor's key;
// the resulting ciphertexts are bound into the proof via extDataHash. Dummy
// (padded) outputs are encrypted to the sender's own viewing key.
// Tests/flows that don't exercise auditing can set a default auditor key once.
let _defaultAuditor = null;
function setDefaultAuditor(a) { _defaultAuditor = a; }

// `auditor` = { pubX, pubY } is the contract-pinned auditor BJJ pubkey. Each
// output is ALSO encrypted to it inside the circuit (ENFORCED disclosure).
function buildWitness({ tree, inputs, outputs, publicAmount, extData, enc, auditor, assetId }) {
  auditor = auditor || _defaultAuditor;
  if (!auditor) throw new Error("auditor pubkey { pubX, pubY } is required");
  const asset = BigInt(assetId ?? 0);
  const realIns = inputs.slice();
  const nRealOuts = outputs.length;
  const realOuts = outputs.slice();
  while (realIns.length < N_INS) realIns.push({ note: Note.dummy(asset), index: 0 });
  while (realOuts.length < N_OUTS) realOuts.push(Note.dummy(asset));
  if (realIns.length > N_INS || realOuts.length > N_OUTS) throw new Error("too many notes");
  for (const x of realIns) if (x.note.amount !== 0n && x.note.assetId !== asset)
    throw new Error(`input note asset ${x.note.assetId} != tx asset ${asset}`);
  for (const n of realOuts) if (n.amount !== 0n && n.assetId !== asset)
    throw new Error(`output note asset ${n.assetId} != tx asset ${asset}`);

  // build the two output ciphertext blobs and bind them via extData
  extData = { ...extData };
  let encOut;
  if (enc) {
    encOut = realOuts.map((note, i) => {
      const recipientView = i < nRealOuts ? enc.recipients[i] : enc.senderViewPub;
      return encryptOutput(note, recipientView);
    });
  } else {
    encOut = [extData.encryptedOutput1 || "00", extData.encryptedOutput2 || "00"];
  }
  extData.encryptedOutput1 = encOut[0];
  extData.encryptedOutput2 = encOut[1];

  const root = tree.root.toString();
  const pubAmt = wrap(publicAmount);
  const edHash = extDataHash(extData);

  // Conservation sanity-check off-chain (clearer error than a circuit failure).
  const sumIn = realIns.reduce((a, x) => a + x.note.amount, 0n);
  const sumOut = realOuts.reduce((a, n) => a + n.amount, 0n);
  if (wrap(sumIn + BigInt(publicAmount)) !== wrap(sumOut)) {
    throw new Error(`value not conserved: in=${sumIn} + pub=${publicAmount} != out=${sumOut}`);
  }

  const inputNullifier = [];
  const inAmount = [], inPrivateKey = [], inBlinding = [], inPathIndices = [], inPathElements = [];
  for (const { note, index } of realIns) {
    const isReal = note.amount !== 0n;
    const proof = isReal ? merkleProof(tree, index) : dummyProof();
    inputNullifier.push(toStr(note.nullifier(proof.pathIndices)));
    inAmount.push(toStr(note.amount));
    inPrivateKey.push(toStr(note.keypair.privkey));
    inBlinding.push(toStr(note.blinding));
    inPathIndices.push(toStr(proof.pathIndices));
    inPathElements.push(proof.pathElements);
  }

  const outputCommitment = [], outAmount = [], outPubkey = [], outBlinding = [];
  for (const note of realOuts) {
    outputCommitment.push(toStr(note.commitment()));
    outAmount.push(toStr(note.amount));
    outPubkey.push(toStr(note.pubkey));
    outBlinding.push(toStr(note.blinding));
  }

  // ENFORCED auditor encryption (Baby Jubjub ElGamal) — must match transfer.circom.
  const encRandom = randomScalar();
  const msgs = realOuts.map((n) => [n.amount, n.pubkey, n.blinding]);
  const aud = encryptOutputsToAuditor(msgs, auditor, encRandom);
  const auditorPubKey = [String(auditor.pubX), String(auditor.pubY)];
  const auditorR = aud.R.map(String);
  const auditorCipher = aud.ciphers.map((row) => row.map(String));

  const witness = {
    root,
    publicAmount: pubAmt.toString(),
    extDataHash: edHash.toString(),
    assetId: asset.toString(),
    inputNullifier,
    outputCommitment,
    inAmount,
    inPrivateKey,
    inBlinding,
    inPathIndices,
    inPathElements,
    outAmount,
    outPubkey,
    outBlinding,
    auditorPubKey,
    auditorR,
    auditorCipher,
    encRandom: encRandom.toString(),
  };

  // Public signals in snarkjs order (matches the contract's parsing order).
  const expectedPublic = [
    witness.root,
    witness.publicAmount,
    witness.extDataHash,
    witness.assetId,
    ...inputNullifier,
    ...outputCommitment,
    ...auditorPubKey,
    ...auditorR,
    ...auditorCipher.flat(),
  ];

  return { witness, expectedPublic, outputs: realOuts, outputCommitment, inputNullifier,
    enc1: extData.encryptedOutput1, enc2: extData.encryptedOutput2,
    auditorR: aud.R, auditorCipher: aud.ciphers, assetId: asset };
}

// Node: prove with on-disk artifacts. Browser: call snarkjs.groth16.fullProve
// directly with served URLs (see web/src/wallet.js).
async function prove(witness, artifacts) {
  const { WASM, ZKEY } = artifacts || nodeArtifacts();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
  return { proof, publicSignals };
}

module.exports = { N_INS, N_OUTS, wrap, buildWitness, prove, setDefaultAuditor };
