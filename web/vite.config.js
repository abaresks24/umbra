import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The off-chain lib in ../client/lib is CommonJS; Rollup's commonjs plugin
// transforms it at build time. Node polyfills provide Buffer/process/crypto so
// the same lib runs in the browser, where snarkjs proves over served WASM+zkey.
export default defineConfig({
  root: __dirname,
  plugins: [nodePolyfills({ globals: { Buffer: true, process: true, global: true }, protocolImports: true })],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  preview: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: {
    target: "es2020",
    commonjsOptions: { include: [/client\/lib/, /scripts/, /node_modules/], transformMixedEsModules: true },
  },
});
