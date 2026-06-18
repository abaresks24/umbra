// Builds the witness for the 2-in/2-out transfer circuit and produces a Groth16
// proof. Shield / transfer / unshield all route through here — the only
// difference is publicAmount and which slots hold real vs dummy notes.
const path = require("path");
const snarkjs = require("snarkjs");
const { P, Note, toStr } = require("./crypto");
const { merkleProof, dummyProof } = require("./tree");
const { extDataHash } = require("./extdata");

const N_INS = 2;
const N_OUTS = 2;

const WASM = path.join(__dirname, "../../circuits/build/transfer_js/transfer.wasm");
const ZKEY = path.join(__dirname, "../../circuits/build/transfer_final.zkey");

// Wrap a signed BigInt into the field (negative -> P - |x|).
function wrap(x) {
  const v = BigInt(x) % P;
  return v < 0n ? v + P : v;
}

// inputs:  [{ note: Note(with keypair), index: leafIndex }]  (0..2 real)
// outputs: [Note]  (0..2 real, recipient pubkey or own)
// publicAmount: signed BigInt (shield > 0, unshield < 0, transfer = 0)
// extData: { recipient, extAmount, fee, encryptedOutput1, encryptedOutput2 }
function buildWitness({ tree, inputs, outputs, publicAmount, extData }) {
  const realIns = inputs.slice();
  const realOuts = outputs.slice();
  while (realIns.length < N_INS) realIns.push({ note: Note.dummy(), index: 0 });
  while (realOuts.length < N_OUTS) realOuts.push(Note.dummy());
  if (realIns.length > N_INS || realOuts.length > N_OUTS) throw new Error("too many notes");

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

  const witness = {
    root,
    publicAmount: pubAmt.toString(),
    extDataHash: edHash.toString(),
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
  };

  // Public signals in snarkjs order (matches the contract's parsing order).
  const expectedPublic = [
    witness.root,
    witness.publicAmount,
    witness.extDataHash,
    ...inputNullifier,
    ...outputCommitment,
  ];

  return { witness, expectedPublic, outputs: realOuts, outputCommitment, inputNullifier };
}

async function prove(witness) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
  return { proof, publicSignals };
}

module.exports = { N_INS, N_OUTS, wrap, buildWitness, prove, WASM, ZKEY };
