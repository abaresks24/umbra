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
  // Every output of a tx is the SAME asset (single-asset-per-tx) — assign it here
  // so the commitment + ciphertext use the tx asset.
  for (const n of realOuts) n.assetId = asset;

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
  // 4 fields now: the asset is encrypted to the auditor (it's hidden from the public).
  const encRandom = randomScalar();
  const msgs = realOuts.map((n) => [n.amount, n.assetId, n.pubkey, n.blinding]);
  const aud = encryptOutputsToAuditor(msgs, auditor, encRandom);
  const auditorPubKey = [String(auditor.pubX), String(auditor.pubY)];
  const auditorR = aud.R.map(String);
  const auditorCipher = aud.ciphers.map((row) => row.map(String));

  // Asset is revealed only at an edge / fee-paying tx (publicAmount != 0); else hidden.
  const revealedAssetId = pubAmt === 0n ? 0n : asset;

  const witness = {
    root,
    publicAmount: pubAmt.toString(),
    extDataHash: edHash.toString(),
    revealedAssetId: revealedAssetId.toString(),
    assetId: asset.toString(), // private
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
    witness.revealedAssetId,
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

// ============================ SWAP ============================
// Witness for the swap circuit (per-note assetId, value-conserved at `rate`).
// rate = EURC value in USDC, scaled by SCALE (1e6). price(USDC)=SCALE, price(EURC)=rate.
const SWAP_SCALE = 1000000n;
const priceOf = (assetId, rate) => (BigInt(assetId) === 2n ? BigInt(rate) : SWAP_SCALE);

function swapNodeArtifacts() {
  const path = require("path");
  return {
    WASM: path.join(__dirname, "../../circuits/build/swap_js/swap.wasm"),
    ZKEY: path.join(__dirname, "../../circuits/build/swap_final.zkey"),
  };
}

// inputs: [{ note, index }] (real input note, e.g. a USDC note) + auto dummy.
// outputs: [Note] (e.g. the EURC note then the USDC change), each with its assetId set.
// rate: scaled int. feeValue: value units kept by the pool (>=0).
function buildSwapWitness({ tree, inputs, outputs, rate, feeValue = 0n, extData, enc, auditor }) {
  auditor = auditor || _defaultAuditor;
  if (!auditor) throw new Error("auditor pubkey { pubX, pubY } is required");
  const realIns = inputs.slice();
  const nRealOuts = outputs.length;
  const realOuts = outputs.slice();
  // dummies are USDC (assetId 1) amount 0 so Price() stays valid and value is 0
  while (realIns.length < N_INS) realIns.push({ note: Note.dummy(1n), index: 0 });
  while (realOuts.length < N_OUTS) realOuts.push(Note.dummy(1n));
  if (realIns.length > N_INS || realOuts.length > N_OUTS) throw new Error("too many notes");

  // value conservation (off-chain check for a clearer error)
  const valIn = realIns.reduce((a, x) => a + x.note.amount * priceOf(x.note.assetId, rate), 0n);
  const valOut = realOuts.reduce((a, n) => a + n.amount * priceOf(n.assetId, rate), 0n);
  if (valIn !== valOut + BigInt(feeValue)) throw new Error(`swap value not conserved: in=${valIn} != out=${valOut} + fee=${feeValue}`);

  extData = { ...extData };
  let encOut;
  if (enc) encOut = realOuts.map((note, i) => encryptOutput(note, i < nRealOuts ? enc.recipients[i] : enc.senderViewPub));
  else encOut = [extData.encryptedOutput1 || "00", extData.encryptedOutput2 || "00"];
  extData.encryptedOutput1 = encOut[0];
  extData.encryptedOutput2 = encOut[1];

  const inputNullifier = [], inAssetId = [], inAmount = [], inPrivateKey = [], inBlinding = [], inPathIndices = [], inPathElements = [];
  for (const { note, index } of realIns) {
    const proof = note.amount !== 0n ? merkleProof(tree, index) : dummyProof();
    inputNullifier.push(toStr(note.nullifier(proof.pathIndices)));
    inAssetId.push(toStr(note.assetId));
    inAmount.push(toStr(note.amount));
    inPrivateKey.push(toStr(note.keypair.privkey));
    inBlinding.push(toStr(note.blinding));
    inPathIndices.push(toStr(proof.pathIndices));
    inPathElements.push(proof.pathElements);
  }
  const outputCommitment = [], outAssetId = [], outAmount = [], outPubkey = [], outBlinding = [];
  for (const note of realOuts) {
    outputCommitment.push(toStr(note.commitment()));
    outAssetId.push(toStr(note.assetId));
    outAmount.push(toStr(note.amount));
    outPubkey.push(toStr(note.pubkey));
    outBlinding.push(toStr(note.blinding));
  }

  const encRandom = randomScalar();
  const msgs = realOuts.map((n) => [n.amount, n.assetId, n.pubkey, n.blinding]);
  const aud = encryptOutputsToAuditor(msgs, auditor, encRandom);
  const auditorPubKey = [String(auditor.pubX), String(auditor.pubY)];
  const auditorR = aud.R.map(String);
  const auditorCipher = aud.ciphers.map((row) => row.map(String));
  const edHash = extDataHash(extData);

  const witness = {
    root: tree.root.toString(), rate: BigInt(rate).toString(), feeValue: BigInt(feeValue).toString(),
    extDataHash: edHash.toString(), inputNullifier, outputCommitment,
    inAssetId, inAmount, inPrivateKey, inBlinding, inPathIndices, inPathElements,
    outAssetId, outAmount, outPubkey, outBlinding,
    auditorPubKey, auditorR, auditorCipher, encRandom: encRandom.toString(),
  };
  const expectedPublic = [
    witness.root, witness.rate, witness.feeValue, witness.extDataHash,
    ...inputNullifier, ...outputCommitment, ...auditorPubKey, ...auditorR, ...auditorCipher.flat(),
  ];
  return { witness, expectedPublic, outputs: realOuts, outputCommitment, inputNullifier,
    enc1: extData.encryptedOutput1, enc2: extData.encryptedOutput2, auditorR: aud.R, auditorCipher: aud.ciphers };
}

// Node: prove with on-disk artifacts. Browser: call snarkjs.groth16.fullProve
// directly with served URLs (see web/src/wallet.js).
async function prove(witness, artifacts) {
  const { WASM, ZKEY } = artifacts || nodeArtifacts();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
  return { proof, publicSignals };
}
async function proveSwap(witness) { return prove(witness, swapNodeArtifacts()); }

module.exports = { N_INS, N_OUTS, wrap, buildWitness, buildSwapWitness, prove, proveSwap, setDefaultAuditor, SWAP_SCALE };
