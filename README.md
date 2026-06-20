# Shielded USDC on Stellar — privacy a regulator can accept

A privacy-preserving USDC wallet on **Stellar (Soroban)**. Everyday payments are
private by default — **amounts and counterparties are hidden on-chain** — with
**client-side zero-knowledge proofs** and **selective disclosure to an auditor
via a view key**. The kind of privacy a regulator can live with: opaque to the
public, fully legible to an authorized auditor.

Built for *Stellar Hacks: Real-World ZK*. **Testnet only, single asset (test USDC).**

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

Every `transact` costs **~72M / 100M** instructions at depth 8 — comfortably
within Soroban's budget.

## Compliance — the view key (the differentiator)

Each output note is encrypted to **two** keys (NaCl `box`, Curve25519):

1. the **recipient's viewing key** — so they *discover* incoming notes by scanning
   events and trial-decrypting;
2. a fixed **auditor viewing key** — so an authorized auditor can reconstruct
   **every amount and owner**.

Run `node scripts/demo.js` to see it: the blockchain shows only opaque
commitments; the recipient scans and finds exactly their note; the auditor
reconstructs the whole ledger. **Privacy ≠ opacity.**

> **Honest limitation.** This is the *voluntary/encryption-based* variant: the
> auditor ciphertext is produced by the honest sender's client, **not enforced in
> the circuit**. A malicious sender could omit it. The **strong** variant —
> constraining the auditor ciphertext's well-formedness *inside* the circuit, so
> it is cryptographically impossible to mint a note the auditor can't decrypt —
> is the natural next step (see *Limitations* below).

---

## What the ZK proves — and what it does NOT

**Proves (load-bearing — a private transfer is impossible without it):**
- The spender owns the input notes (knows the private keys).
- The input notes exist in the pool's Merkle tree.
- The nullifiers are correctly derived (so double-spends are detectable).
- Value is conserved; no notes are created from nothing; no negative amounts.
- The external data (recipient, amounts, ciphertexts) is bound to the proof.

**Does NOT prove / known limitations:**
- **Auditor completeness is not circuit-enforced** (voluntary disclosure variant).
- **Note scanning is simplified** — clients trial-decrypt all events; no optimized
  indexer.
- **Trusted setup** — Groth16 needs a per-circuit setup; this demo runs a local
  Powers-of-Tau + phase-2. Production needs a proper multi-party ceremony.
- **Shallow tree (depth 8 = 256 notes)** for the demo; scaling to millions of
  notes needs recursion / proof aggregation.
- **Testnet only, single asset**, amounts in token base units.
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
- **Encryption** — recipient + auditor decrypt; a stranger learns nothing.

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

# 1. Trusted setup for the transfer circuit (Powers-of-Tau + phase 2)
./circuits/build_transfer.sh

# 2. Build contracts
(cd contracts/groth16-verifier && stellar contract build)
(cd contracts/pool            && stellar contract build)

# 3. A funded testnet identity named `shield`
stellar keys generate shield --network testnet --fund

# 4. Provision a test USDC SAC + trustlines (one-time)
./scripts/setup_usdc.sh

# 5. The tests
node test/05_encryption.js                 # encryption + auditor
(cd contracts/poseidon-match && cargo test) # Poseidon byte-match
node test/01_local_lifecycle.js            # ZK lifecycle (offline)
node scripts/lifecycle.js                  # proofs verified on testnet
node test/02_negative.js                   # soundness
node test/04_pool_lifecycle.js             # full pool lifecycle on testnet

# 6. The headline demo (private payment + recipient scan + auditor reconstruction)
node scripts/demo.js
```

See `PROGRESS.md` for the phase-by-phase build log, measured costs, and the
live contract addresses.
