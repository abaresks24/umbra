# Web wallet

A minimal browser wallet for the shielded USDC pool. **Proof generation runs in
the browser** (snarkjs over the served `transfer.wasm` + `transfer_final.zkey`),
so the witness — amounts, spend keys, blindings — never leaves the device. A thin
relayer (`server.js`) only submits the resulting transaction; it sees the proof,
the public signals, and the (encrypted) note payloads — all public data.

```
browser (prove + scan + audit)  ──proof+publicData──▶  relayer  ──▶  Soroban pool
        ▲ witness stays local                          (signs/submits)
```

## Run

From the repo root, after `./scripts/setup_usdc.sh` and building the pool contract:

```bash
npm run web:init     # deploy+init a pool for the web, copy circuit artifacts,
                     # print the AUDITOR viewing secret (for the auditor panel)
npm run web:server   # relayer + config API on :8787   (terminal 1)
npm run web:dev      # Vite dev server on :5173          (terminal 2)
```

Open http://localhost:5173.

- **Shield** deposits public USDC into the pool as a private note.
- **Send privately** pays another address (paste their wallet address) — amount
  and parties hidden on-chain.
- **Unshield** withdraws to a public Stellar address.
- **Auditor view** — paste the auditor secret printed by `web:init` to
  reconstruct every note's amount and owner from on-chain events.

`npm run web:build` produces a static bundle in `web/dist`.

## Honesty

- The relayer signs with a demo testnet account; a production wallet would sign
  in-browser (e.g. Freighter). Privacy is unaffected — the relayer never sees the
  witness.
- Spent-note tracking in the browser is a local approximation (a real wallet
  derives it from on-chain nullifiers). Re-scan reflects on-chain truth.
- The verified, click-free demo is `node scripts/demo.js` at the repo root.
