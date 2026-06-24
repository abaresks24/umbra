// Client-side submission of a `transact` invocation signed by the USER (their own
// Stellar account), used for DEPOSITS — so funds come from the user's wallet, not
// a shared relayer. The signer is injected: Freighter in the browser, a Keypair
// in the node test. (Private transfers / withdrawals still go via the relayer to
// keep the user's address off-chain.)
const { Contract, TransactionBuilder, nativeToScVal, Address, rpc, Networks } = require("@stellar/stellar-sdk");

const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const NET = Networks.TESTNET;

const scBytes = (hex) => nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
const scAddr = (g) => new Address(g).toScVal();
const scI128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });

// Build + simulate/assemble (auth + resource fees) + sign + submit a transact.
// signXdr: (unsignedXdr) => Promise<signedXdr>. Returns the tx hash on success.
async function submitTransact(args) {
  const { poolId, caller, proofHex, publicHex, recipient, extAmount, fee = 0, enc1, enc2, signXdr } = args;
  const server = new rpc.Server(args.rpcUrl || DEFAULT_RPC);
  const account = await server.getAccount(caller);
  const op = new Contract(poolId).call(
    "transact",
    scAddr(caller), scBytes(proofHex), scBytes(publicHex), scAddr(recipient),
    scI128(extAmount), scI128(fee), scBytes(enc1), scBytes(enc2),
  );
  const built = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NET })
    .addOperation(op).setTimeout(120).build();
  // prepareTransaction simulates, assembles the Soroban auth entries (the token
  // transfer's caller-auth becomes a source-account credential, covered by the
  // tx signature) and sets the resource fee.
  const prepared = await server.prepareTransaction(built);
  const signedXdr = await signXdr(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, NET);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") throw new Error("submit rejected: " + JSON.stringify(sent.errorResult || sent.status));
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) { await new Promise((r) => setTimeout(r, 2000)); g = await server.getTransaction(sent.hash); }
  if (g.status !== "SUCCESS") throw new Error("transaction " + g.status);
  return sent.hash;
}

module.exports = { submitTransact, DEFAULT_RPC, NET };
