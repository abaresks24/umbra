# Umbra — Chrome extension

The full Umbra wallet, packaged as an MV3 browser extension. Same client-side ZK
proving as the web app — the witness never leaves your machine; the popup proves
the Groth16 transfer circuit locally (single-threaded, to stay inside the
extension CSP) and only the proof + ciphertexts reach the relayer.

## Build

```bash
npm install
npm run ext:build      # → extension/dist  (manifest + popup + circuit artifacts)
```

The build reuses `web/src` with two compile-time flags:

- `VITE_EXT=1` — prove single-threaded (no blob: Workers) and route deposits to
  the web app (Freighter, a page-injected wallet, isn't reachable from a popup).
- `VITE_API_BASE=https://umbra-wallet.vercel.app` — talk to the deployed relayer
  instead of same-origin `/api`.

## Load in Chrome

1. `npm run ext:build`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `extension/dist`.
4. Click the Umbra icon. Create or restore a wallet — balance, send, withdraw and
   receive all work in the popup. **Deposit** opens the web app (Freighter signs
   there); the new note appears in the popup automatically on the next rescan.

## What's enforced by the manifest

`content_security_policy.extension_pages` allows `wasm-unsafe-eval` (for snarkjs
WASM) and pins `connect-src` to the relayer, the Soroban RPC, CoinGecko, and the
font CDN — nothing else. No remote scripts, no `eval`.
