// Blink wallet (https://api.blink.sv/graphql). Used only to PAY invoices from Bitcoin Ekasi's payout wallet.
// The API key comes from the environment (systemd reads /etc/painted-shacks/blink.env). It is never stored in
// the database, never sent to a browser, and never written to a log.
"use strict";

const API = () => process.env.BLINK_API_URL || "https://api.blink.sv/graphql";
const KEY = () => process.env.BLINK_API_KEY || "";

class BlinkError extends Error { constructor(msg, unknown) { super(msg); this.unknown = !!unknown; } }

async function gql(query, variables, timeoutMs = 20000) {
  if (!KEY()) throw new BlinkError("The Blink key is not set on the server yet.");
  let res;
  try {
    res = await fetch(API(), { method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "X-API-KEY": KEY() }, body: JSON.stringify({ query, variables }) });
  } catch (e) {
    // We don't know if Blink got the request. Callers that send money treat this as "unknown" and check later.
    throw new BlinkError(e.name === "TimeoutError" ? "Blink did not answer in time." : "Could not reach Blink.", true);
  }
  let body; try { body = await res.json(); } catch { body = null; }
  if (res.status === 401 || res.status === 403) throw new BlinkError("Blink refused the key. Check the key on the server.");
  if (!res.ok || !body) throw new BlinkError(`Blink gave an error (${res.status}).`, res.status >= 500);
  if (body.errors?.length) throw new BlinkError(`Blink: ${body.errors.map(e => e.message).join("; ").slice(0, 300)}`);
  return body.data;
}

let walletCache = null;
// The BTC wallet to pay from (BLINK_WALLET_ID, or the account's BTC wallet).
async function wallet() {
  const d = await gql("query { authorization { scopes } me { defaultAccount { wallets { id walletCurrency balance } } } }");
  const wallets = d.me?.defaultAccount?.wallets || [];
  const want = process.env.BLINK_WALLET_ID;
  const w = want ? wallets.find(x => x.id === want) : wallets.find(x => x.walletCurrency === "BTC");
  if (!w) throw new BlinkError(want ? "The Blink wallet id on the server was not found." : "This Blink account has no Bitcoin wallet.");
  if (w.walletCurrency !== "BTC") throw new BlinkError("The payout wallet must be the Bitcoin (BTC) wallet, not the Stablesats (USD) wallet.");
  walletCache = w.id;
  return { id: w.id, balance_sats: Number(w.balance), scopes: d.authorization?.scopes || [] };
}
const walletId = async () => walletCache || (await wallet()).id;

async function feeProbe(paymentRequest) {
  const d = await gql(`mutation($input: LnInvoiceFeeProbeInput!) { lnInvoiceFeeProbe(input: $input) { amount errors { message } } }`,
    { input: { walletId: await walletId(), paymentRequest } });
  const r = d.lnInvoiceFeeProbe;
  if (r.errors?.length) throw new BlinkError(`Blink: ${r.errors.map(e => e.message).join("; ").slice(0, 300)}`);
  return Number(r.amount) || 0;
}

// Pays an invoice. Returns { status: SUCCESS | ALREADY_PAID | PENDING | FAILURE, tx_id, fee_sats, message }.
// Throws BlinkError with .unknown = true when we can't tell whether it was paid.
async function payInvoice(paymentRequest, memo) {
  const d = await gql(`mutation($input: LnInvoicePaymentInput!) { lnInvoicePaymentSend(input: $input) {
      status errors { message } transaction { id status settlementFee } } }`,
    { input: { walletId: await walletId(), paymentRequest, memo } }, Number(process.env.BLINK_SEND_TIMEOUT_MS || 60000));
  const r = d.lnInvoicePaymentSend;
  return { status: r.status || "FAILURE", tx_id: r.transaction?.id || null, fee_sats: Math.abs(Number(r.transaction?.settlementFee) || 0),
           message: r.errors?.map(e => e.message).join("; ").slice(0, 300) || null };
}

// Looks up an earlier payment by its payment hash. Returns null if Blink has no record of it.
async function lookup(paymentHash) {
  const d = await gql(`query($w: WalletId!, $h: PaymentHash!) { me { defaultAccount { walletById(walletId: $w) {
      ... on BTCWallet { transactionsByPaymentHash(paymentHash: $h) { id status direction settlementFee } } } } } }`,
    { w: await walletId(), h: paymentHash });
  const list = (d.me?.defaultAccount?.walletById?.transactionsByPaymentHash || []).filter(t => t.direction === "SEND");
  const t = list.find(x => x.status === "SUCCESS") || list.find(x => x.status === "PENDING") || list[0];
  return t ? { status: t.status, tx_id: t.id, fee_sats: Math.abs(Number(t.settlementFee) || 0) } : null;
}

const configured = () => !!KEY();
module.exports = { wallet, feeProbe, payInvoice, lookup, configured, BlinkError, _reset: () => { walletCache = null; } };
