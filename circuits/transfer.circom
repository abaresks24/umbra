pragma circom 2.1.6;

// Shielded USDC — 2-in / 2-out JoinSplit transfer circuit (Tornado-Nova family).
// One circuit handles shield / private-transfer / unshield via a signed
// `publicAmount` and zero-value dummy notes. All Poseidon calls use circomlib's
// BN254 parameters, which match the on-chain `soroban-poseidon` hash byte-for-byte
// (proven in Phase 0).
//
// note            = (amount, pubkey, blinding)
// commitment      = Poseidon(amount, pubkey, blinding)            // Poseidon(3)
// pubkey          = Poseidon(privKey)                             // Poseidon(1)
// signature       = Poseidon(privKey, commitment, pathIndices)    // Poseidon(3)
// nullifier       = Poseidon(commitment, pathIndices, signature)  // Poseidon(3)
// merkle node     = Poseidon(left, right)                         // Poseidon(2)

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";
include "switcher.circom";
include "escalarmulany.circom";
include "escalarmulfix.circom";

template Keypair() {
    signal input privateKey;
    signal output publicKey;
    component h = Poseidon(1);
    h.inputs[0] <== privateKey;
    publicKey <== h.out;
}

template Signature() {
    signal input privateKey;
    signal input commitment;
    signal input merklePath;
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== privateKey;
    h.inputs[1] <== commitment;
    h.inputs[2] <== merklePath;
    out <== h.out;
}

// Verifies a Merkle path. `pathIndices` is a single field, unpacked to `levels`
// bits selecting left/right at each level.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathIndices;
    signal input pathElements[levels];
    signal output root;

    component indexBits = Num2Bits(levels);
    indexBits.in <== pathIndices;

    component switcher[levels];
    component hasher[levels];
    for (var i = 0; i < levels; i++) {
        switcher[i] = Switcher();
        switcher[i].L <== i == 0 ? leaf : hasher[i - 1].out;
        switcher[i].R <== pathElements[i];
        switcher[i].sel <== indexBits.out[i];

        hasher[i] = Poseidon(2);
        hasher[i].inputs[0] <== switcher[i].outL;
        hasher[i].inputs[1] <== switcher[i].outR;
    }
    root <== hasher[levels - 1].out;
}

template Transaction(levels, nIns, nOuts) {
    // --- public ---
    signal input root;
    signal input publicAmount;     // signed: >0 shield, <0 unshield (field-wrapped), 0 transfer
    signal input extDataHash;      // binds recipient/fee/ciphertexts; tamper => invalid proof
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // --- private: inputs ---
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    // --- private: outputs ---
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    // --- ENFORCED auditor disclosure (Baby Jubjub ElGamal) ---
    // Public so the contract can pin the auditor key and emit the ciphertext.
    signal input auditorPubKey[2];          // fixed auditor BJJ pubkey (contract-pinned)
    signal input auditorR[2];               // ephemeral pubkey R = r·B8
    signal input auditorCipher[nOuts][3];   // ciphertext of (amount,pubkey,blinding) per output
    signal input encRandom;                 // ephemeral scalar r (private)

    component inKeypair[nIns];
    component inCommitmentHasher[nIns];
    component inSignature[nIns];
    component inNullifierHasher[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    var sumIns = 0;

    for (var tx = 0; tx < nIns; tx++) {
        // derive pubkey from privkey, recompute the input commitment
        inKeypair[tx] = Keypair();
        inKeypair[tx].privateKey <== inPrivateKey[tx];

        inCommitmentHasher[tx] = Poseidon(3);
        inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
        inCommitmentHasher[tx].inputs[1] <== inKeypair[tx].publicKey;
        inCommitmentHasher[tx].inputs[2] <== inBlinding[tx];

        // signature then nullifier; constrain to public nullifier
        inSignature[tx] = Signature();
        inSignature[tx].privateKey <== inPrivateKey[tx];
        inSignature[tx].commitment <== inCommitmentHasher[tx].out;
        inSignature[tx].merklePath <== inPathIndices[tx];

        inNullifierHasher[tx] = Poseidon(3);
        inNullifierHasher[tx].inputs[0] <== inCommitmentHasher[tx].out;
        inNullifierHasher[tx].inputs[1] <== inPathIndices[tx];
        inNullifierHasher[tx].inputs[2] <== inSignature[tx].out;
        inNullifierHasher[tx].out === inputNullifier[tx];

        // Merkle membership — enforced only for real notes (amount != 0).
        inTree[tx] = MerkleProof(levels);
        inTree[tx].leaf <== inCommitmentHasher[tx].out;
        inTree[tx].pathIndices <== inPathIndices[tx];
        for (var i = 0; i < levels; i++) {
            inTree[tx].pathElements[i] <== inPathElements[tx][i];
        }
        inCheckRoot[tx] = ForceEqualIfEnabled();
        inCheckRoot[tx].in[0] <== root;
        inCheckRoot[tx].in[1] <== inTree[tx].root;
        inCheckRoot[tx].enabled <== inAmount[tx];

        sumIns += inAmount[tx];
    }

    component outCommitmentHasher[nOuts];
    component outAmountCheck[nOuts];
    var sumOuts = 0;
    for (var tx = 0; tx < nOuts; tx++) {
        outCommitmentHasher[tx] = Poseidon(3);
        outCommitmentHasher[tx].inputs[0] <== outAmount[tx];
        outCommitmentHasher[tx].inputs[1] <== outPubkey[tx];
        outCommitmentHasher[tx].inputs[2] <== outBlinding[tx];
        outCommitmentHasher[tx].out === outputCommitment[tx];

        // range-check outputs to forbid negative/overflow values
        outAmountCheck[tx] = Num2Bits(248);
        outAmountCheck[tx].in <== outAmount[tx];

        sumOuts += outAmount[tx];
    }

    // all input nullifiers must be distinct (prevents spending one note twice in a tx)
    component sameNullifiers[nIns * (nIns - 1) / 2];
    var idx = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifiers[idx] = IsEqual();
            sameNullifiers[idx].in[0] <== inputNullifier[i];
            sameNullifiers[idx].in[1] <== inputNullifier[j];
            sameNullifiers[idx].out === 0;
            idx++;
        }
    }

    // value conservation
    sumIns + publicAmount === sumOuts;

    // bind extDataHash into the proof (keeps optimizer from dropping it)
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;

    // ===== ENFORCED auditor encryption =====
    // Prove each output note is encrypted to the fixed auditor key, so a valid
    // proof is IMPOSSIBLE unless every note is auditor-decryptable. One ephemeral
    // key for the tx: R = r·B8 (public), S = r·auditorPubKey (shared secret),
    // per-output key = Poseidon(S.x,S.y,t), cipher[j] = msg[j] + Poseidon(key,j).
    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
    component encBits = Num2Bits(251);
    encBits.in <== encRandom;

    component encR = EscalarMulFix(251, BASE8);
    for (var i = 0; i < 251; i++) encR.e[i] <== encBits.out[i];
    encR.out[0] === auditorR[0];
    encR.out[1] === auditorR[1];

    component encS = EscalarMulAny(251);
    for (var i = 0; i < 251; i++) encS.e[i] <== encBits.out[i];
    encS.p[0] <== auditorPubKey[0];
    encS.p[1] <== auditorPubKey[1];

    component encKey[nOuts];
    component encKs[nOuts][3];
    for (var t = 0; t < nOuts; t++) {
        encKey[t] = Poseidon(3);
        encKey[t].inputs[0] <== encS.out[0];
        encKey[t].inputs[1] <== encS.out[1];
        encKey[t].inputs[2] <== t;

        for (var j = 0; j < 3; j++) {
            encKs[t][j] = Poseidon(2);
            encKs[t][j].inputs[0] <== encKey[t].out;
            encKs[t][j].inputs[1] <== j;
        }
        auditorCipher[t][0] === outAmount[t] + encKs[t][0].out;
        auditorCipher[t][1] === outPubkey[t] + encKs[t][1].out;
        auditorCipher[t][2] === outBlinding[t] + encKs[t][2].out;
    }
}

component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment,
    auditorPubKey, auditorR, auditorCipher]} = Transaction(8, 2, 2);
