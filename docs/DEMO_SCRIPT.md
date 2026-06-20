# Demo script (2–3 min)

The story: **everyday private payments on Stellar, with disclosure a regulator
can accept.** Split-screen: wallet/terminal on the left, Stellar explorer on the
right.

## Setup (before recording)
- `./scripts/setup_usdc.sh` already run; `shield` identity funded.
- Terminal ready to run `node scripts/demo.js`.
- A browser tab on `https://stellar.expert/explorer/testnet`.

## Beat 1 — the problem (15s)
> "On a public chain, every payment amount and counterparty is visible forever.
> That's a non-starter for real money. We built a shielded USDC wallet on Stellar
> where payments are private by default — but an auditor can still see
> everything. Privacy a regulator can accept."

## Beat 2 — a private payment (45s)
Run `node scripts/demo.js`. As it prints:
> "Alice shields 100 USDC into the pool. Then she pays Bob 60 USDC — privately.
> Then she unshields 40. Each of these is a zero-knowledge proof generated on her
> own machine. No operator, no shared secret — she proves her own state
> transition."

Point at the three ✓ lines.

## Beat 3 — the chain reveals nothing (30s)
Open the printed explorer link (the pool contract) on the right.
> "Here's what the entire world sees: a list of opaque commitments and
> nullifiers. No amounts. No sender. No recipient. The 60-USDC payment to Bob is
> in there — completely hidden."

Show the `WHAT THE BLOCKCHAIN SHOWS` block: `amount: ??? owner: ???`.

## Beat 4 — the recipient finds their money (20s)
Show the `BOB scans with his VIEWING KEY` block.
> "Bob scans the chain with his viewing key and instantly discovers his incoming
> note: 60 USDC. He didn't need Alice to message him — the encrypted note is
> right there in the event, readable only by him."

## Beat 5 — the auditor sees all (30s)  ← the differentiator
Show the `AUDITOR reconstructs` block.
> "Now the compliance part. An authorized auditor holds a view key. With it, they
> reconstruct every note: every amount, every owner — the full ledger. The public
> sees nothing; the auditor sees everything. That's the whole pitch: privacy is
> not opacity."

## Beat 6 — why it's trustworthy (20s)
> "Two things make this real. The zero-knowledge proof is load-bearing — a private
> transfer is *impossible* without it; we test that tampering, double-spends, and
> forged notes are all rejected. And it runs on Stellar's native BN254 and
> Poseidon host functions — the on-chain hash matches our circuit byte-for-byte.
> Every transfer verifies on testnet in about 72 million of the 100 million
> instruction budget."

## Beat 7 — close (10s)
> "Shielded USDC on Stellar. Private by default, auditable by design. All on
> testnet today."

## Honesty slide (hold 3s)
- Testnet, single asset, depth-8 tree.
- Auditor disclosure is voluntary (encryption-based); in-circuit enforcement is
  the next step.
- Groth16 trusted setup would need a real MPC ceremony in production.
