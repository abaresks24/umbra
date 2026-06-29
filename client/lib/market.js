// Client for the Umbra Market contract (transparent money-market + AMM). Views are
// read by simulating a call (no fees, no signature); mutations are built, prepared
// (sim assembles auth + resource fee), signed by the USER (Freighter / Keypair)
// and submitted. Amounts are raw 7-decimal i128. Asset ids: USDC = 1, EURC = 2.
const { Contract, TransactionBuilder, nativeToScVal, scValToNative, Address, rpc, Networks } = require("@stellar/stellar-sdk");

const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const NET = Networks.TESTNET;
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

module.exports = { readViewAs, invokeMarket, A, U, I, WAD, PRICE_SCALE, DEFAULT_RPC, NET };
