pragma circom 2.1.6;

// Shielded SWAP circuit (USDC <-> EURC), forked from transfer.circom. Same note /
// nullifier / Merkle / ENFORCED-auditor machinery, but:
//   - each note carries its OWN assetId (a swap mixes two assets in one tx);
//   - value is conserved at a public oracle `rate` instead of per-asset, so a
//     USDC note can be converted into an EURC note of equal value.
// A swap is internal: no token crosses the pool boundary, so amounts stay hidden
// exactly like a private transfer. Liquidity is the pool's pre-funded reserves.
//
// Value unit: every note's value = amount * price(assetId), where price(1)=SCALE
// (USDC numeraire) and price(2)=rate (EURC in USDC, scaled by SCALE). Integer math
// only — no division — so conservation is exact:  sum(in value) == sum(out value) + feeValue.

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

// price(assetId) for a two-asset pool: assetId must be 1 (USDC) or 2 (EURC).
// returns SCALE for USDC, `rate` for EURC. SCALE is a compile-time constant so
// `is1.out * SCALE` is linear, keeping the constraint quadratic.
template Price(SCALE) {
    signal input assetId;
    signal input rate;
    signal output price;

    component is1 = IsEqual();
    is1.in[0] <== assetId; is1.in[1] <== 1;
    component is2 = IsEqual();
    is2.in[0] <== assetId; is2.in[1] <== 2;
    is1.out + is2.out === 1;            // assetId in {1,2}
    price <== is1.out * SCALE + is2.out * rate;
}

template Swap(levels, nIns, nOuts) {
    // --- public ---
    signal input root;
    signal input rate;             // EURC value in USDC, scaled by SCALE (oracle, contract-checked)
    signal input feeValue;         // protocol fee, in value units (>= 0); kept by the pool/LP
    signal input extDataHash;      // binds recipient/fee/ciphertexts
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // --- private: inputs ---
    signal input inAssetId[nIns];
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    // --- private: outputs ---
    signal input outAssetId[nOuts];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    // --- ENFORCED auditor disclosure (Baby Jubjub ElGamal) ---
    signal input auditorPubKey[2];
    signal input auditorR[2];
    signal input auditorCipher[nOuts][4];
    signal input encRandom;

    var SCALE = 1000000;           // 1e6 fixed-point for the rate

    // ---- inputs: commitment, nullifier, Merkle membership, value ----
    component inKeypair[nIns];
    component inCommitmentHasher[nIns];
    component inSignature[nIns];
    component inNullifierHasher[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inPrice[nIns];
    signal inValue[nIns];

    for (var tx = 0; tx < nIns; tx++) {
        inKeypair[tx] = Keypair();
        inKeypair[tx].privateKey <== inPrivateKey[tx];

        inCommitmentHasher[tx] = Poseidon(4);
        inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
        inCommitmentHasher[tx].inputs[1] <== inAssetId[tx];
        inCommitmentHasher[tx].inputs[2] <== inKeypair[tx].publicKey;
        inCommitmentHasher[tx].inputs[3] <== inBlinding[tx];

        inSignature[tx] = Signature();
        inSignature[tx].privateKey <== inPrivateKey[tx];
        inSignature[tx].commitment <== inCommitmentHasher[tx].out;
        inSignature[tx].merklePath <== inPathIndices[tx];

        inNullifierHasher[tx] = Poseidon(3);
        inNullifierHasher[tx].inputs[0] <== inCommitmentHasher[tx].out;
        inNullifierHasher[tx].inputs[1] <== inPathIndices[tx];
        inNullifierHasher[tx].inputs[2] <== inSignature[tx].out;
        inNullifierHasher[tx].out === inputNullifier[tx];

        inTree[tx] = MerkleProof(levels);
        inTree[tx].leaf <== inCommitmentHasher[tx].out;
        inTree[tx].pathIndices <== inPathIndices[tx];
        for (var i = 0; i < levels; i++) inTree[tx].pathElements[i] <== inPathElements[tx][i];
        inCheckRoot[tx] = ForceEqualIfEnabled();
        inCheckRoot[tx].in[0] <== root;
        inCheckRoot[tx].in[1] <== inTree[tx].root;
        inCheckRoot[tx].enabled <== inAmount[tx];

        inPrice[tx] = Price(SCALE);
        inPrice[tx].assetId <== inAssetId[tx];        inPrice[tx].rate <== rate;
        inValue[tx] <== inAmount[tx] * inPrice[tx].price;
    }

    // ---- outputs: commitment, range check, value ----
    component outCommitmentHasher[nOuts];
    component outAmountCheck[nOuts];
    component outPrice[nOuts];
    signal outValue[nOuts];

    for (var tx = 0; tx < nOuts; tx++) {
        outCommitmentHasher[tx] = Poseidon(4);
        outCommitmentHasher[tx].inputs[0] <== outAmount[tx];
        outCommitmentHasher[tx].inputs[1] <== outAssetId[tx];
        outCommitmentHasher[tx].inputs[2] <== outPubkey[tx];
        outCommitmentHasher[tx].inputs[3] <== outBlinding[tx];
        outCommitmentHasher[tx].out === outputCommitment[tx];

        outAmountCheck[tx] = Num2Bits(248);
        outAmountCheck[tx].in <== outAmount[tx];

        outPrice[tx] = Price(SCALE);
        outPrice[tx].assetId <== outAssetId[tx];        outPrice[tx].rate <== rate;
        outValue[tx] <== outAmount[tx] * outPrice[tx].price;
    }

    // distinct input nullifiers
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

    // VALUE conservation at the oracle rate (fee kept by the pool/LP).
    component feeCheck = Num2Bits(248);
    feeCheck.in <== feeValue;        // fee must be non-negative
    var sumInValue = 0;
    var sumOutValue = 0;
    for (var i = 0; i < nIns; i++) sumInValue += inValue[i];
    for (var j = 0; j < nOuts; j++) sumOutValue += outValue[j];
    sumInValue === sumOutValue + feeValue;

    // bind extDataHash
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;

    // ===== ENFORCED auditor encryption (per-output, incl. the per-note assetId) =====
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
    component encKs[nOuts][4];
    for (var t = 0; t < nOuts; t++) {
        encKey[t] = Poseidon(3);
        encKey[t].inputs[0] <== encS.out[0];
        encKey[t].inputs[1] <== encS.out[1];
        encKey[t].inputs[2] <== t;

        for (var j = 0; j < 4; j++) {
            encKs[t][j] = Poseidon(2);
            encKs[t][j].inputs[0] <== encKey[t].out;
            encKs[t][j].inputs[1] <== j;
        }
        auditorCipher[t][0] === outAmount[t] + encKs[t][0].out;
        auditorCipher[t][1] === outAssetId[t] + encKs[t][1].out;
        auditorCipher[t][2] === outPubkey[t] + encKs[t][2].out;
        auditorCipher[t][3] === outBlinding[t] + encKs[t][3].out;
    }
}

component main {public [root, rate, feeValue, extDataHash, inputNullifier, outputCommitment,
    auditorPubKey, auditorR, auditorCipher]} = Swap(16, 2, 2);
