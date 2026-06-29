// Client for the Umbra Market contract (transparent money-market + AMM). Views are
// read by simulating a call (no fees, no signature); mutations are built, prepared
// (sim assembles auth + resource fee), signed by the USER (Freighter / Keypair)
// and submitted. Amounts are raw 7-decimal i128. Asset ids: USDC = 1, EURC = 2.
const { Contract, TransactionBuilder, nativeToScVal, scValToNative, Address, rpc, Networks, Keypair, hash, Operation, Asset } = require("@stellar/stellar-sdk");

const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const NET = Networks.TESTNET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAD = 1000000000000n; // 1e12 (index/rate scale in the contract)
const PRICE_SCALE = 10000000n; // 1e7

const scAddr = (g) => new Address(g).toScVal();
const scU32 = (n) => nativeToScVal(Number(n), { type: "u32" });
const scI128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });
const enc = (a) => (a.type === "addr" ? scAddr(a.v) : a.type === "u32" ? scU32(a.v) : scI128(a.v));

// Simulate a (view) call and decode its return value to native JS. `src` is any
// funded account (simulations cost nothing and aren't signed).
async function readViewAs(marketId, src, fn, args = [], rpcUrl = DEFAULT_RPC) {
  const server = new rpc.Server(rpcUrl);
  const op = new Contract(marketId).call(fn, ...args.map(enc));
  const account = await server.getAccount(src);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NET }).addOperation(op).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result.retval);
}

// Build + prepare + sign + submit a market mutation. signXdr: (xdr)=>Promise<xdr>.
async function invokeMarket({ marketId, caller, fn, args, signXdr, rpcUrl = DEFAULT_RPC }) {
  const server = new rpc.Server(rpcUrl);
  const op = new Contract(marketId).call(fn, ...args.map(enc));
  let sent;
  for (let attempt = 0; attempt < 4; attempt++) {
    const account = await server.getAccount(caller);
    const built = new TransactionBuilder(account, { fee: "2000000", networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
    const prepared = await server.prepareTransaction(built);
    const signedXdr = await signXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, NET);
    sent = await server.sendTransaction(signed);
    if (sent.status !== "ERROR") break;
    const e = JSON.stringify(sent.errorResult || "");
    if (/txBadSeq|bad_seq/i.test(e) && attempt < 3) { await new Promise((r) => setTimeout(r, 2500)); continue; }
    throw new Error("rejected: " + e.slice(0, 200));
  }
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 75 && g.status === "NOT_FOUND"; i++) { await new Promise((r) => setTimeout(r, 2000)); g = await server.getTransaction(sent.hash); }
  if (g.status !== "SUCCESS") throw new Error("transaction " + g.status);
  return sent.hash;
}

// Convenience builders (args are typed tuples consumed by enc()).
const A = (v) => ({ type: "addr", v });
const U = (v) => ({ type: "u32", v });
const I = (v) => ({ type: "i128", v });

// ---------- DeFi identity (gasless, relayer-sponsored, not Freighter) ----------
// The market is operated by a Stellar keypair DERIVED from the Umbra wallet seed —
// a fresh pseudonym, never the user's real account. It signs the inner tx; the
// relayer fee-bumps it, so the user pays no gas and their real account never
// appears. Funded privately by withdrawing shielded USDC to this address.
function deriveMarketKey(seed) {
  const raw = hash(Buffer.from(String(seed) + ":umbra-defi", "utf8")); // deterministic 32-byte sha256
  return Keypair.fromRawEd25519Seed(raw);
}
async function waitConfirm(server, hashHex) {
  let g = await server.getTransaction(hashHex);
  for (let i = 0; i < 75 && g.status === "NOT_FOUND"; i++) { await sleep(2000); g = await server.getTransaction(hashHex); }
  if (g.status !== "SUCCESS") throw new Error("transaction " + g.status);
  return g;
}
// fee-bump a signed inner tx through the relayer (which pays the gas)
async function relayFeeBump(apiBase, signedXdr, rpcUrl) {
  const r = await fetch(`${apiBase}/api/market`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ xdr: signedXdr }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "relayer rejected");
  await waitConfirm(new rpc.Server(rpcUrl), j.hash);
  return j.hash;
}
// Bootstrap the identity: fund with friendbot (XLM for reserves), then add the
// market-asset trustlines (relayer-sponsored fee-bump, so the identity pays nothing).
async function bootstrapIdentity({ kp, assets, apiBase, rpcUrl = DEFAULT_RPC, friendbot = "https://friendbot.stellar.org" }) {
  const server = new rpc.Server(rpcUrl);
  let exists = true;
  try { await server.getAccount(kp.publicKey()); } catch { exists = false; }
  if (!exists) {
    await fetch(`${friendbot}?addr=${encodeURIComponent(kp.publicKey())}`).catch(() => {});
    for (let i = 0; i < 25 && !exists; i++) { try { await server.getAccount(kp.publicKey()); exists = true; } catch { await sleep(2500); } }
    if (!exists) throw new Error("could not activate the DeFi identity (friendbot)");
  }
  for (const a of assets) {
    const acc = await server.getAccount(kp.publicKey());
    const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET })
      .addOperation(Operation.changeTrust({ asset: new Asset(a.code, a.issuer) })).setTimeout(120).build();
    tx.sign(kp);
    await relayFeeBump(apiBase, tx.toXDR(), rpcUrl);
  }
}
// Build a market call signed by the identity key, then submit it gasless via the
// relayer fee-bump. Returns the tx hash.
async function submitViaRelayer({ marketId, kp, fn, args, apiBase, rpcUrl = DEFAULT_RPC }) {
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(kp.publicKey());
  const op = new Contract(marketId).call(fn, ...args.map(enc));
  let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NET }).addOperation(op).setTimeout(180).build();
  tx = await server.prepareTransaction(tx); // simulate: source-account auth + resource fee
  tx.sign(kp);
  return relayFeeBump(apiBase, tx.toXDR(), rpcUrl);
}

module.exports = { readViewAs, invokeMarket, deriveMarketKey, bootstrapIdentity, submitViaRelayer, A, U, I, WAD, PRICE_SCALE, DEFAULT_RPC, NET };
