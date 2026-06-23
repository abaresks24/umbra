# Shielded USDC on Stellar — privacy a regulator can accept

A privacy-preserving USDC wallet on **Stellar (Soroban)**. Everyday payments are
private by default — **amounts and counterparties are hidden on-chain** — with
**client-side zero-knowledge proofs** and **selective disclosure to an auditor
via a view key**. The kind of privacy a regulator can live with: opaque to the
public, fully legible to an authorized auditor.

Built for *Stellar Hacks: Real-World ZK*. **Testnet only.** Multi-asset (USDC +
WETH), relayer fees, decimals, note consolidation, and a Create/Connect wallet UI.

> Security posture, trust assumptions, and the trusted-setup ceremony are
> documented in [`SECURITY.md`](./SECURITY.md).

---

## What it does

Three operations, all powered by **one** zero-knowledge circuit:

| Operation | What's public | What's hidden |
|---|---|---|
| **Shield**   | a deposit of N USDC enters the pool | nothing else |
| **Transfer** | *that a transaction happened* | amount, sender, recipient — everything |
| **Unshield** | a withdrawal of N USDC to an address | which shielded notes funded it |

Value is only ever visible at the **edges** of the pool (shield in / unshield
out) — inherent to any shielded pool, and acceptable. Everything in between is
private.

## The cryptographic model — encrypted UTXOs (notes)

A **note** is a unit of hidden value `(amount, owner_pubkey, blinding)`:

- **commitment** `= Poseidon(amount, owner_pubkey, blinding)` — the only thing
  stored on-chain (a Merkle leaf). Reveals nothing.
- **owner_pubkey** `= Poseidon(owner_privkey)`.
- **nullifier** `= Poseidon(commitment, leafIndex, signature)`, where
  `signature = Poseidon(privKey, commitment, leafIndex)`. Published when a note
  is spent to prevent double-spends; **not linkable** to its commitment.

This follows the open-source **Tornado-Nova / tornado-pool** UTXO design.

## One circuit, three operations (`circuits/transfer.circom`)

A **2-in / 2-out JoinSplit**. Shield, transfer, and unshield are the same circuit
with zero-value **dummy notes** filling unused slots and a signed `publicAmount`:

- `publicAmount > 0` → **shield** (contract pulls USDC in)
- `publicAmount < 0` → **unshield** (contract pays USDC out)
- `publicAmount == 0` → **pure private transfer**

**Public inputs:** `root`, `publicAmount`, `extDataHash`, `inputNullifier[2]`,
`outputCommitment[2]`. **Enforced in-circuit:** each input's commitment recomputes
and its Merkle path verifies to `root` (skipped for dummies); nullifiers recompute
correctly and are distinct; output commitments recompute; every amount is
range-checked (< 2²⁴⁸); **value is conserved**
(`inAmounts + publicAmount == outAmounts`); and `extDataHash` is bound so the
recipient/amounts can't be tampered with after proving.

## On-chain (`contracts/pool` — Soroban / Rust)

- **BN254 Groth16 verifier** using Stellar's **native BN254 host functions**
  (CAP-0074, Protocol 25+).
- **Incremental Merkle tree** (depth 8) hashed with the **native Poseidon host
  function** (CAP-0075) via [`soroban-poseidon`](https://github.com/stellar/rs-soroban-poseidon)
  — byte-for-byte identical to circomlib's Poseidon (proven in Phase 0).
- **Root-history ring buffer** (30 roots) so a proof built against a slightly
  stale root still validates.
- **Nullifier set** — a reused nullifier is rejected (double-spend prevention).
- **`transact`** verifies the proof, checks the root + nullifiers, inserts the two
  output commitments, moves USDC at the edges via the **USDC SAC**, and emits
  events carrying the encrypted note payloads.

Every `transact` costs **~85M / 100M** instructions at depth 8 (including the
in-circuit auditor encryption) — within Soroban's budget.

## Compliance — ENFORCED auditor disclosure (the differentiator)

Two independent mechanisms:

1. **Recipient discovery** — each output is encrypted to the recipient's viewing
   key (NaCl `box`, Curve25519), so they find incoming notes by scanning events.
2. **Auditor disclosure — enforced *inside the circuit*.** Each output is *also*
   encrypted to a fixed **auditor key** using **Baby Jubjub ElGamal + Poseidon**,
   and the circuit constrains that the ciphertext is a correct encryption of the
   *same* `(amount, pubkey, blinding)` committed in the note. The contract **pins
   the auditor's public key** and rejects any proof not encrypted to it. Result:
   **it is cryptographically impossible to mint a note the auditor cannot
   decrypt** — validators enforce it, not an honest client.

```
R = r·B8 ; S = r·auditorPub ; key_t = Poseidon(S.x, S.y, t)
cipher_t[j] = note_t[j] + Poseidon(key_t, j)      ← constrained in-circuit
auditor decrypts: S = auditorPriv·R ; note_t[j] = cipher_t[j] - Poseidon(key_t, j)
```

Run `node scripts/demo.js`: the chain shows only opaque commitments; the recipient
scans and finds exactly their note; the auditor reconstructs the whole ledger from
the on-chain ciphertext. `node test/08_enforcement.js` proves a proof encrypted to
a *different* auditor key is **rejected on-chain**. **Privacy ≠ opacity.**

---

## What the ZK proves — and what it does NOT

**Proves (load-bearing — a private transfer is impossible without it):**
- The spender owns the input notes (knows the private keys).
- The input notes exist in the pool's Merkle tree.
- The nullifiers are correctly derived (so double-spends are detectable).
- Value is conserved; no notes are created from nothing; no negative amounts.
- The external data (recipient, amounts, ciphertexts) is bound to the proof.
- **Every output note is encrypted to the pinned auditor key** — auditor
  completeness is cryptographically enforced, not voluntary.

**Does NOT prove / known limitations:**
- **Recipient discovery ciphertext is not circuit-enforced** — but that only
  affects whether the *recipient* can find their own note (their own interest),
  not auditability.
- **Note scanning** trial-decrypts every event (one ECDH each). Fast scanning
  needs a dedicated detection-key / fuzzy-message-detection scheme (future work) —
  a view-tag doesn't help here because the ECDH can't be skipped without leaking.
- **Trusted setup** — phase 1 uses the **real Perpetual Powers of Tau** ceremony
  (hundreds of contributors); phase 2 is a multi-party chain + beacon, verified
  (`snarkjs zkey verify`). For a production launch the phase-2 contributions must
  be a public ceremony with external participants. See `SECURITY.md`.
- **Shallow tree (depth 8 = 256 notes)** — bounded by the ~85M/100M instruction
  budget per `transact`; scaling to millions needs recursion / proof aggregation.
- **Asset type** is now **hidden for private transfers** (`revealedAssetId == 0`);
  it is revealed only at the pool edges (shield/unshield) or a fee-paying tx, where
  the real token movement reveals it anyway. The auditor always sees it.
- **Tree scaling** — depth 8, bounded by the ~89M/100M instruction budget per
  `transact` (on-chain Poseidon insertion). Deep trees need either insertion-in-
  circuit (+ a sequencer) or recursion. (Next work item.)
- **Testnet only.**
- Pool edges (shield/unshield) reveal the public amount and the on-chain caller /
  recipient — inherent to shielded pools.

---

## Verified on testnet

Soundness is tested, not assumed (`test/`):

- **Poseidon match** — on-chain Poseidon == circomlib, byte-for-byte (arities 1/2/3).
- **Soundness** — tampered amounts/commitments, value non-conservation,
  double-spend (duplicate nullifier), and forged Merkle membership are all rejected.
- **Full lifecycle** — shield → private transfer → unshield on testnet with real
  USDC moving; **double-spend rejected**; **stale-but-recent root accepted**.
- **In-circuit ElGamal** — the auditor encryption computed in-circuit matches the
  off-chain encrypter byte-for-byte and decrypts back.
- **Enforced disclosure** — the auditor reconstructs every note from the on-chain
  ciphertext, and a proof encrypted to a **different** auditor key is **rejected
  on-chain**.

## Repo layout

```
circuits/    transfer.circom + build scripts (trusted setup, VK)
contracts/   groth16-verifier · poseidon-match · pool (Soroban Rust)
client/lib/  off-chain core: crypto, tree, extdata, transaction, encryption, scan, onchain
scripts/     bn254 hex converter, USDC setup, lifecycle, demo
test/        poseidon-match, soundness, lifecycle, encryption tests
web/         minimal browser wallet (in-browser WASM proving) — see web/README.md
```

## How to run

Prereqs: `rust` + `wasm32v1-none`, `stellar-cli`, `circom`, `snarkjs`, `node`.

```bash
npm install

# 1. Trusted setup: real Perpetual Powers of Tau + multi-party phase-2 + beacon
./circuits/build_transfer.sh
circomspect circuits/transfer.circom -L node_modules/circomlib/circuits  # static analysis

# 2. Build contracts
(cd contracts/groth16-verifier && stellar contract build)
(cd contracts/pool            && stellar contract build)

# 3. A funded testnet identity named `shield`
stellar keys generate shield --network testnet --fund

# 4. Provision test assets (USDC + a second asset WETH) + trustlines (one-time)
./scripts/setup_usdc.sh && ./scripts/setup_weth.sh

# 5. The tests
(cd contracts/poseidon-match && cargo test) # Poseidon byte-match
node test/05_encryption.js                 # recipient encryption
node test/06_elgamal_match.js              # in-circuit BJJ ElGamal == off-chain
node test/07_enforced_audit.js             # auditor decrypts from public signals (offline)
node test/01_local_lifecycle.js            # ZK lifecycle (offline)
node test/02_negative.js                   # soundness
node scripts/lifecycle.js                  # proofs verified on testnet
node test/04_pool_lifecycle.js             # full pool lifecycle on testnet
node test/08_enforcement.js                # auditor enforcement REJECTED on-chain
node test/09_multiasset.js                 # one pool holds USDC + WETH
node test/10_onchain_spent.js              # balances derived from on-chain nullifiers
node test/11_fee_relayer.js                # third-party relayer paid from shielded value
node test/12_solvency.js                   # pool solvency invariant

# 6. The headline demo (private payment + recipient scan + auditor reconstruction)
node scripts/demo.js

# 7. The web wallet (Create/Connect, multi-asset, in-browser proving)
npm run web:init && npm run web:server   # terminal 1
npm run web:dev                          # terminal 2  -> http://localhost:5173
```

See `PROGRESS.md` for the phase-by-phase build log, measured costs, and the
live contract addresses.
