pragma circom 2.1.6;

// In-circuit ElGamal-style encryption over Baby Jubjub + Poseidon — the building
// block for ENFORCED auditor disclosure. The circuit proves that `cipher` is a
// correct encryption of `msg` to `auditorPub`, so a valid proof is impossible
// unless every output note is decryptable by the auditor.
//
//   R = r·B8                      (ephemeral pubkey, public)
//   S = r·auditorPub              (shared secret, = auditorPriv·R off-chain)
//   k = Poseidon(S.x, S.y)
//   cipher[j] = msg[j] + Poseidon(k, j)      (additive Poseidon keystream)
//
// Auditor decrypts: S = auditorPriv·R ; k = Poseidon(S) ; msg[j] = cipher[j] - Poseidon(k, j).

include "escalarmulany.circom";
include "escalarmulfix.circom";
include "poseidon.circom";
include "bitify.circom";

template ElGamalEncrypt(nMsg, nBits) {
    signal input r;               // ephemeral scalar (private)
    signal input msg[nMsg];       // plaintext fields (private)
    signal input auditorPub[2];   // auditor BJJ public key (public)
    signal output R[2];           // ephemeral public key (public)
    signal output cipher[nMsg];   // ciphertext (public)

    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    component rbits = Num2Bits(nBits);
    rbits.in <== r;

    // R = r · B8
    component mulFix = EscalarMulFix(nBits, BASE8);
    for (var i = 0; i < nBits; i++) mulFix.e[i] <== rbits.out[i];
    R[0] <== mulFix.out[0];
    R[1] <== mulFix.out[1];

    // S = r · auditorPub
    component mulAny = EscalarMulAny(nBits);
    for (var i = 0; i < nBits; i++) mulAny.e[i] <== rbits.out[i];
    mulAny.p[0] <== auditorPub[0];
    mulAny.p[1] <== auditorPub[1];

    // k = Poseidon(S.x, S.y)
    component kHash = Poseidon(2);
    kHash.inputs[0] <== mulAny.out[0];
    kHash.inputs[1] <== mulAny.out[1];

    // cipher[j] = msg[j] + Poseidon(k, j)
    component ks[nMsg];
    for (var j = 0; j < nMsg; j++) {
        ks[j] = Poseidon(2);
        ks[j].inputs[0] <== kHash.out;
        ks[j].inputs[1] <== j;
        cipher[j] <== msg[j] + ks[j].out;
    }
}

component main {public [auditorPub]} = ElGamalEncrypt(3, 251);
