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
### Phase 3 — View-key compliance + web wallet 🔴
### Phase 4 — Polish + demo 🔴
### Phase 5 — Submission 🔴

---

## Key reference URLs
- rs-soroban-poseidon (circomlib-matching BN254): https://github.com/stellar/rs-soroban-poseidon
- CAP-0074 (BN254 host fns): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md
- CAP-0075 (Poseidon host fns): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md
- groth16 on Soroban tutorial + repo: https://jamesbachini.com/circom-on-stellar/ · https://github.com/jamesbachini/CircomStellar
- Tornado-Nova reference circuits: https://github.com/tornadocash/tornado-pool
- Stellar Privacy Pools prototype (BLS path — what to avoid): https://github.com/ymcrcat/soroban-privacy-pools
- soroban-examples groth16_verifier: https://github.com/stellar/soroban-examples/tree/main/groth16_verifier
