import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { cpSync } from "node:fs";
import { resolve } from "node:path";

// Builds the SAME single-page wallet as the web app, but for the MV3 extension:
//  - VITE_EXT=1            → prove single-threaded, route deposits to the web app
//  - VITE_API_BASE=…       → talk to the deployed relayer instead of same-origin
//  - output to ../extension/dist, then drop the manifest + icon alongside it
// The circuit artifacts (transfer.wasm, transfer_final.zkey) and logo come from
// web/public and are emitted at the dist root, exactly where the popup expects.
const OUT = resolve(__dirname, "../extension/dist");

export default defineConfig({
  root: __dirname,
  define: {
    "import.meta.env.VITE_EXT": JSON.stringify("1"),
    "import.meta.env.VITE_API_BASE": JSON.stringify("https://umbra-wallet.vercel.app"),
  },
  plugins: [
    nodePolyfills({ globals: { Buffer: true, process: true, global: true }, protocolImports: true }),
    {
      name: "umbra-ext-static",
      closeBundle() {
        const src = resolve(__dirname, "../extension/static");
        cpSync(src, OUT, { recursive: true });
      },
    },
  ],
  build: {
    target: "es2020",
    outDir: OUT,
    emptyOutDir: true,
    commonjsOptions: { include: [/client\/lib/, /scripts/, /node_modules/], transformMixedEsModules: true },
  },
});
