# Umbra — web wallet

The browser wallet for the shielded pool. **Proof generation runs in the browser**
(snarkjs over the served `transfer.wasm` + `transfer_final.zkey`), so the witness —
amounts, spend keys, blindings — never leaves the device.

Two submission paths, chosen for privacy:

```
DEPOSIT (self-custodial):
  browser (prove) ──signed by YOUR Freighter account──▶ Soroban pool
  Your own Stellar account funds the shield. You appear on-chain as the depositor
  (inherent — you're moving public funds in). Uses the real Circle testnet USDC.

SEND / WITHDRAW (private):
  browser (prove) ──proof+publicData──▶ relayer ──▶ Soroban pool
  A relayer submits so your address never appears on-chain — preserving the
  anonymity of private transfers. The relayer only sees public data.
```

Identity: each Umbra wallet is a shielded identity created in-app ("Create wallet"
→ a hex key). That is **separate** from your Stellar account (Freighter) — the
Stellar account holds public funds; the Umbra key owns private notes.

## Faucets (testnet)

- **XLM** (fees): Friendbot — `https://friendbot.stellar.org/?addr=<G…>`, or the
  link in the Deposit sheet once Freighter is connected.
- **USDC**: the pool uses the **real Circle testnet USDC**, so fund your own
  Freighter wallet at **faucet.circle.com**, then add the USDC trustline (button
  in the Deposit sheet) and deposit.
- **WETH** (second asset): self-issued — top up via the issuer (see repo scripts).

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

- **Deposits are self-custodial via Freighter** (your own account funds the
  shield, using real Circle testnet USDC). The on-chain mechanism is verified by
  `test/14` (a keypair signs the identical transaction); the in-browser Freighter
  connect/sign path itself requires the extension and was not driven headlessly.
- Send/withdraw still go through the relayer (a demo testnet account) to keep your
  address off-chain. A production relayer would be a decentralised set; the fee
  field (already in the circuit/contract) pays it.
- Spent-note tracking is derived ON-CHAIN from `nullify` events, so balances are
  correct on any device (verified by `test/10`). localStorage is only an
  optimistic hint to cover RPC indexing lag right after a spend.
- The verified, click-free demo is `node scripts/demo.js` at the repo root.
