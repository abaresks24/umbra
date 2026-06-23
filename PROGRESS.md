# PROGRESS — Shielded USDC Wallet on Stellar (Soroban)

Hackathon: *Stellar Hacks: Real-World ZK* · deadline **June 29, 12:00 PST** · testnet only.

## Legend
🟢 green/verified · 🟡 mocked/partial · 🔴 not started · ⚠️ risk/watch

---

## Confirmed tooling reality (June 2026) — verified via research, not assumed

| Fact | Status | Notes |
|---|---|---|
| Curve = **BN254** (circomlib default) | 🟢 decided | Lower-risk than BLS12-381; circomlib Poseidon matches `rs-soroban-poseidon` BN254 preset byte-for-byte |
| Native BN254 host fns (CAP-0074, Protocol 25, Jan 2026) | 🟢 confirmed | `env.crypto().bn254()`: g1_add, g1_mul, g1_msm, pairing_check. No native G2 arith (fine for Groth16 — G2 comes from VK) |
| Native Poseidon permutation (CAP-0075, Protocol 25) | 🟢 confirmed | Raw permutation behind SDK `hazmat-crypto` feature; wrap via `rs-soroban-poseidon` (README: "BN254 matches circomlib") |
| Testnet protocol | 🟢 P27 | Both BN254 + Poseidon host fns live |
| `groth16_verifier` example curve | ⚠️ BLS12-381 | NOT reusable as-is for BN254 — adapt to `env.crypto().bn254()` (Feb-2026 BN254 PR exists) |
| Versions | 🟢 | soroban-sdk 26.1.0 stable (27.0.0-rc.1); stellar-cli v27; snarkjs 0.7.6; rustc 1.95; node 20; wasm target `wasm32v1-none` |

### Risks retired in Phase 0
- 🟢 **Poseidon byte-match** (#1 risk): RETIRED. `soroban-poseidon` (native CAP-0075) matches circomlib byte-for-byte for arities 1/2/3 incl. near-modulus edge case. Verified by Rust unit test (real host fn via `Env::default()`) AND on testnet (`hash2(1,2)` returns the exact circomlib value).
- 🟢 **Instruction budget**: MEASURED on testnet (cap = 100M/tx):
  - Poseidon hash2 (t=3, Merkle node) = **4.49M**
  - Poseidon hash3 (t=4, commitment/nullifier) = **5.17M**  *(note: these run in-circuit off-chain; on-chain only hash2 for tree inserts)*
  - Groth16 verify (4 pairings + MSM) = **27.3M**
  - **Design constraint for Phase 2:** `transact` = 1 verify (~27M) + 2 output inserts (~2·depth·4.5M). Safe Merkle depth ≈ **≤8** (depth 8 ≈ 99M borderline; depth 5–6 ≈ 72–81M comfortable). Will benchmark the real insertion path in Phase 2 and pick depth accordingly. Brief mandates a small tree anyway (§10).

---

## Phases

### Phase 0 — De-risking spike  🟢 COMPLETE — both gates passed
- [x] Research & confirm tooling (curve, host fns, versions)
- [x] Scaffold repo, install snarkjs/circom/stellar-cli, add wasm32v1-none target
- [x] Testnet identity `shield` (friendbot-funded): `GDEVORC55W2NMLJQKZDI643XGFHBGDITUSAN53VKZFPTGYHONLI5RJ7J`
- [x] 🟢 **Gate (a):** BN254 Groth16 proof (a·b=c) verifies on testnet. Verifier `CC6UYLGPHKAALNNWQGZ662RCUE7TTIBI2LFOFSUM3IORY5KZ4PGOS3QJ`
- [x] 🟢 **Gate (b):** Poseidon byte-match passes (unit test + testnet). Poseidon contract `CD22F7OSQPJGRDN6LIXKKNMSWURFQD3LUXZS64VAN5FMUVRYUIUEH2SU`
- [x] Benchmarked instruction costs (see above)

**Repro:** `circuits/build_multiplier.sh` → `scripts/phase0_deploy_verify.sh` (gate a); `cd contracts/poseidon-match && cargo test` (gate b); `scripts/poseidon-golden/gen.js` regenerates golden vectors.

### Phase 1 — ZK core 🟢 COMPLETE — submittable
- [x] `transfer.circom` 2-in/2-out (shield/transfer/unshield via signed publicAmount + dummy notes); ~14.5k constraints, 7 public inputs
- [x] Trusted setup (powers-of-tau 2^15 + phase2), `transfer_final.zkey` + `transfer_vk.json`
- [x] Off-chain lib in `client/lib/` (reused by web in Phase 3): `crypto.js` (Poseidon/Keypair/Note), `tree.js` (incremental Merkle depth 8), `extdata.js`, `transaction.js` (witness+prove), `onchain.js`
- [x] 🟢 **Gate:** `scripts/lifecycle.js` runs shield→transfer→unshield with **all 3 proofs verified on testnet**. Verifier `CDWKLYTPXDFCRFIRFBX3NOSV6KGRYRVKTRBMV4DUOIDUJ74WTJ65VYVQ`
- [x] Soundness tests (`test/02_negative.js`): tampered publicAmount/commitment, non-conservation, double-spend (dup nullifier), forged membership — all correctly rejected
- [x] Local lifecycle (`test/01_local_lifecycle.js`) + on-chain lifecycle both green

**Repro:** `./circuits/build_transfer.sh` (setup) → `node test/01_local_lifecycle.js` (local) → `node scripts/lifecycle.js` (on testnet) → `node test/02_negative.js` (soundness).

### Phase 2 — On-chain integration 🟢 COMPLETE — TRIP-WIRE CLEARED
- [x] Pool contract (`contracts/pool`): on-chain incremental Merkle tree (host Poseidon, depth 8), root-history ring buffer (30), nullifier set, `transact` entrypoint
- [x] extDataHash recomputed on-chain (keccak, byte-matched to JS) — binds recipient/amounts to the proof; **verified matching on testnet**
- [x] publicAmount bound to `field(ext_amount - fee)`; USDC SAC shield-in / unshield-out (test USDC `CCDJQFER…27JY`)
- [x] Events: NewCommitment (per output, with ciphertext) + nullifiers
- [x] On-chain tree root verified identical to off-chain `fixed-merkle-tree` (was de-risked first; now subsumed by lifecycle)
- [x] 🟢 **Gate (`test/04_pool_lifecycle.js`):** shield→transfer→unshield on testnet, real USDC moved (user −100, recipient +40), **double-spend rejected**, **stale-but-recent root accepted**
- [x] **Budget measured:** each `transact` ≈ **72M / 100M** instructions at depth 8 — comfortable. Latest pool `CBK3S3D777EUJXUPIOIOIN3XNFM4E4GFV76P62VIE3MGXY4UL2PIVOP6`

**Repro:** `./scripts/setup_usdc.sh` (one-time) → `node test/04_pool_lifecycle.js`.
### Phase 3 — Compliance + web wallet 🟢 COMPLETE (upgraded to ENFORCED)
- [x] Recipient discovery: each output encrypted to the recipient's viewing key (NaCl box), bound by extDataHash (`client/lib/encryption.js`)
- [x] 🔒 **ENFORCED auditor disclosure (strong variant):** each output is encrypted to a fixed auditor key via **Baby Jubjub ElGamal + Poseidon, constrained IN-CIRCUIT** (`circuits/elgamal.circom` → integrated into `transfer.circom`). The contract **pins the auditor pubkey** and rejects any proof not encrypted to it. Cryptographically impossible to mint a note the auditor can't decrypt.
- [x] De-risk spike (`test/06_elgamal_match.js`): in-circuit BJJ ElGamal == off-chain, byte-for-byte; auditor decrypts back; wrong key fails
- [x] Offline integration (`test/07_enforced_audit.js`): auditor reconstructs note from PUBLIC SIGNALS; recovered note recomputes to the on-chain commitment
- [x] 🟢 **On-chain enforcement (`test/08_enforcement.js`):** proof to pinned auditor A accepted, proof to a different auditor B **REJECTED on-chain**
- [x] 🟢 **Gate (`scripts/demo.js`, testnet):** chain shows opaque commitments; **Bob scans → finds his 60 USDC note**; **auditor reconstructs every note from the ENFORCED on-chain ciphertext** (`audit` events)
- [x] Circuit now ~25k constraints (still fits power-15 ptau); each `transact` ≈ **85M / 100M** instructions (was 72M; +13M from 10 extra public inputs)
- [x] Web wallet (`web/`): in-browser snarkjs proving, scanning, enforced-auditor panel; `npm run web:build` passes; relayer tested

### Phase 4 — Demo 🟢 COMPLETE
- [x] `scripts/demo.js` — the split-screen narrative (chain opaque vs auditor reconstruction), runs reliably end-to-end on testnet
- [x] `docs/DEMO_SCRIPT.md` — 2–3 min video script with beats + honesty slide

### Phase 5 — Submission 🟢 COMPLETE
- [x] `README.md` — architecture, what the ZK proves / does NOT, honest limitations, run instructions, deployed addresses
- [x] `web/README.md` — web wallet architecture + run
- [x] This `PROGRESS.md` — full build log with measured costs

## Production-hardening pass (post-hackathon)

**P1 — security blockers**
- 🟢 Credible trusted setup: real **Perpetual Powers of Tau** (power 16, hundreds of contributors) + multi-party phase-2 chain + public beacon, verified (`snarkjs zkey verify` → ZKey Ok). No more single-party local setup. (`circuits/build_transfer.sh`)
- 🟢 `circomspect` static analysis: 2 warnings, both reviewed/intentional, no under-constrained vulns. (`SECURITY.md`)
- 🟢 Solvency invariant proven on testnet (`test/12`): pool balance == shielded − unshielded − fees == Σ unspent notes.
- 🟢 `SECURITY.md`: threat model, trust roles, honest limits.

**P2 — product**
- 🟢 Multi-asset (assetId in circuit; per-asset registry + balances). USDC + WETH. (`test/09`)
- 🟢 Relayer **fees**: `transact` pays the submitter from shielded value (publicAmount = extAmount − fee); third party relays so the user never touches the chain. (`test/11`)
- 🟢 On-chain spent tracking (balances correct on any device). (`test/10`)
- 🟢 Decimals (human amounts, e.g. 0.5 USDC) + note **consolidation** (anti-dust merge button).
- 🟡 Tree scaling (depth 8, budget-bound) and fast scanning (needs detection-key scheme) — documented as future work.

**Wallet UX**
- 🟢 Create/Connect flow (seed-derived identity, nothing hardcoded), Phantom-style UI, multi-asset, in-browser proving — verified headless (`web/smoke.cjs`).

## Status: all phases green + hardened. Core is credible for a testnet product.
Test suite: `node test/05_encryption.js`, `(cd contracts/poseidon-match && cargo test)`, `node test/01_local_lifecycle.js`, `node scripts/lifecycle.js`, `node test/02_negative.js`, `node test/04_pool_lifecycle.js`, `node scripts/demo.js`.

---

## Key reference URLs
- rs-soroban-poseidon (circomlib-matching BN254): https://github.com/stellar/rs-soroban-poseidon
- CAP-0074 (BN254 host fns): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md
- CAP-0075 (Poseidon host fns): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md
- groth16 on Soroban tutorial + repo: https://jamesbachini.com/circom-on-stellar/ · https://github.com/jamesbachini/CircomStellar
- Tornado-Nova reference circuits: https://github.com/tornadocash/tornado-pool
- Stellar Privacy Pools prototype (BLS path — what to avoid): https://github.com/ymcrcat/soroban-privacy-pools
- soroban-examples groth16_verifier: https://github.com/stellar/soroban-examples/tree/main/groth16_verifier
