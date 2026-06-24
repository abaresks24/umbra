// Freighter (browser wallet) connection + public-asset helpers, for SELF-CUSTODIAL
// deposits: the user funds their own shield from their own Stellar account. Read
// balances/trustlines from Horizon; sign with Freighter. Browser-only.
import { requestAccess, getAddress, signTransaction, isConnected } from "@stellar/freighter-api";
import { Horizon, TransactionBuilder, Operation, Asset, Networks, BASE_FEE } from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const NET = Networks.TESTNET;

export async function freighterInstalled() {
  try { const r = await isConnected(); return !!(r && (r.isConnected ?? r)); } catch { return false; }
}

// Connect and return the user's testnet address (throws with a clear message).
export async function connectFreighter() {
  const access = await requestAccess();
  const address = access?.address || (await getAddress())?.address;
  if (!address) throw new Error("Freighter did not return an address");
  if (!address.startsWith("G")) throw new Error("unexpected address");
  return address;
}

// Public balance + trustline status of a classic asset for `address` (via Horizon).
// Returns { hasTrust, raw } where raw is the balance in base units (per decimals).
export async function assetStatus(address, code, issuer, decimals) {
  const server = new Horizon.Server(HORIZON);
  let acct;
  try { acct = await server.loadAccount(address); }
  catch { return { exists: false, hasTrust: false, raw: 0n }; }
  const line = acct.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer);
  if (!line) return { exists: true, hasTrust: false, raw: 0n };
  const [int, frac = ""] = line.balance.split(".");
  return { exists: true, hasTrust: true, raw: BigInt(int + frac.padEnd(decimals, "0").slice(0, decimals)) };
}

// Add a trustline to a classic asset, signed by Freighter, submitted via Horizon.
export async function addTrustline(address, code, issuer) {
  const server = new Horizon.Server(HORIZON);
  const acct = await server.loadAccount(address);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(Operation.changeTrust({ asset: new Asset(code, issuer) }))
    .setTimeout(120).build();
  const signed = await freighterSign(tx.toXDR());
  await server.submitTransaction(TransactionBuilder.fromXDR(signed, NET));
}

// A signXdr callback for soroban.submitTransact, backed by Freighter.
export async function freighterSign(xdr) {
  const res = await signTransaction(xdr, { networkPassphrase: NET });
  return typeof res === "string" ? res : res.signedTxXdr;
}
