# Security model & analysis

This documents the trust assumptions, what is verified, and the known limits.
It is **not** a substitute for a professional audit — see *Limits* at the bottom.

## What the system guarantees (and on what assumption)

| Property | Mechanism | Trust assumption |
|---|---|---|
| No notes minted from nothing; value conserved | In-circuit `sumIns + publicAmount == sumOuts` + range checks | Circuit soundness + trusted setup (below) |
| No double-spend | On-chain nullifier set; in-circuit nullifier derivation | Same |
| Funds only spendable by owner | In-circuit ownership (`pubkey = Poseidon(privKey)`) + Merkle membership | Same |
| Auditor can decrypt **every** note | In-circuit Baby Jubjub ElGamal; contract pins the auditor key | Circuit soundness |
| Recipient / amount can't be swapped after proving | `extDataHash` binds recipient, amounts, fee, ciphertexts | keccak256 collision resistance |
| Pool solvency: `pool token balance == Σ unspent notes` (per asset) | Follows from conservation + nullifier set | Circuit soundness + setup |

## Trusted setup (Groth16)

Soundness of Groth16 depends on the setup's "toxic waste" being destroyed.

- **Phase 1 (universal):** the **real Perpetual Powers of Tau** ceremony
  (`powersOfTau28_hez_final_16.ptau`, hundreds of independent contributors). We do
  **not** generate phase 1 locally. The transcript is verified
  (`snarkjs powersoftau verify`) in `circuits/build_transfer.sh`.
- **Phase 2 (circuit-specific):** a multi-party contribution chain + a public
  beacon (see `build_transfer.sh`). Soundness holds if **at least one** phase-2
  contributor was honest.
- **Verification:** anyone can re-check the final key with
  `snarkjs zkey verify transfer.r1cs ppot_final_16.ptau transfer_final.zkey`.

⚠️ For a production launch the phase-2 contributions must be run as a **public
ceremony with external participants**, and the beacon must be an unbiasable future
value (e.g. a Bitcoin/drand block hash). The script demonstrates the mechanics;
the contributors here are local.

## Circuit static analysis (circomspect)

`circomspect circuits/transfer.circom -L node_modules/circomlib/circuits` reports
**2 warnings, both reviewed and intentional**:

1. `Num2Bits` "aliasing" on the Merkle path index / range checks. Safe here: all
   widths (8, 248, 251 bits) are **below** the BN254 field size (~254 bits), so the
   recomposition constraint forbids aliasing. The 248-bit cap on output amounts is a
   deliberate range check; the 251-bit cap bounds the ElGamal scalar.
2. `extDataSquare` "under-constrained intermediate". Intentional: the
   `extDataHash * extDataHash` term is the standard Tornado-Nova binding that forces
   the public `extDataHash` to be used (so the optimizer can't drop it).

No under-constrained-signal vulnerabilities were found.

## Trust roles (centralisation to remove for production)

- **Admin** (`register_asset`) — can map an assetId to a malicious token. Needs
  governance / timelock / immutability.
- **Auditor** — a single key. Should be threshold/multisig with key rotation and a
  legal access process.
- **Relayer** — single submitter today. Needs a decentralised relayer set. Note:
  the `fee` is paid to whoever submits (`caller`), so a different relayer could
  front-run and steal the fee (the transfer still executes correctly). Production
  should bind the intended relayer address into `extDataHash`.

## Known limits (NOT yet production-grade)

- No professional audit; no formal verification of the circuit.
- Phase-2 ceremony contributors are local (see above).
- Merkle depth 8 (256 notes) — see README "scaling" note.
- `assetId` is public (asset type leaks); pool edges reveal the on-chain
  caller/recipient and the public amount.
- Anonymity-set quality depends on pool usage; no fixed denominations or timing
  defences yet.
- Testnet only.
