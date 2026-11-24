// Lightning address (LNURL-pay) and BOLT11 invoice helpers. No packages.
// Works with a Lightning address from ANY wallet: Blink, Fedi, Aqua, Wallet of Satoshi, Phoenix, Coinos, ...
"use strict";
const dns = require("node:dns").promises;
const net = require("node:net");

class LnError extends Error {}

/* ------------------------------------------------------------------ BOLT11 */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
const hrpExpand = hrp => [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];
function wordsToBytes(words) {
  let acc = 0, bits = 0; const out = [];
  for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } acc &= (1 << bits) - 1; }
  return Buffer.from(out);
}

// Returns { network, amount_msat (or null), payment_hash (hex), timestamp }.
function decodeInvoice(pr) {
  const s = String(pr || "").trim().toLowerCase().replace(/^lightning:/, "");
  const pos = s.lastIndexOf("1");
  if (pos < 4 || s.length - pos < 8 || s.length > 7089) throw new LnError("Not a Lightning invoice");
  const hrp = s.slice(0, pos), data = [...s.slice(pos + 1)].map(c => CHARSET.indexOf(c));
  if (data.some(d => d < 0)) throw new LnError("Not a Lightning invoice");
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new LnError("Invoice checksum is wrong");
  const m = hrp.match(/^ln(bcrt|bc|tbs|tb)(\d+)?([munp])?$/);
  if (!m) throw new LnError("Not a Lightning invoice");
  let amount_msat = null;
  if (m[2]) {
    const n = BigInt(m[2]);
    const msat = !m[3] ? n * 100000000000n : m[3] === "m" ? n * 100000000n : m[3] === "u" ? n * 100000n : m[3] === "n" ? n * 100n : n / 10n;
    if (m[3] === "p" && n % 10n !== 0n) throw new LnError("Invoice amount is not valid");
    amount_msat = Number(msat);
  }
  const words = data.slice(0, -6);
  if (words.length < 7 + 104) throw new LnError("Invoice is too short");
  let timestamp = 0; for (let i = 0; i < 7; i++) timestamp = timestamp * 32 + words[i];
  const tags = words.slice(7, words.length - 104);
  let payment_hash = null, i = 0;
  while (i + 3 <= tags.length) {
    const type = tags[i], len = tags[i + 1] * 32 + tags[i + 2];
    const body = tags.slice(i + 3, i + 3 + len);
    if (type === 1 && len === 52) payment_hash = wordsToBytes(body).subarray(0, 32).toString("hex");
    i += 3 + len;
  }
  if (!payment_hash) throw new LnError("Invoice has no payment hash");
  return { network: m[1], amount_msat, payment_hash, timestamp };
}

/* ------------------------------------------------------------------ safe fetch (the address can be on any domain) */
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}
const allowLocal = () => process.env.LNURL_ALLOW_LOCAL === "1";   // tests only

async function getJson(url) {
  let u;
  try { u = new URL(url); } catch { throw new LnError("The wallet sent a broken link"); }
  if (!allowLocal()) {
    if (u.protocol !== "https:") throw new LnError("The wallet must use https");
    if (net.isIP(u.hostname) || /(^|\.)localhost$/i.test(u.hostname)) throw new LnError("That wallet address is not allowed");
    let addrs;
    try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw new LnError(`Wallet not found: ${u.hostname} does not exist`); }
    if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new LnError("That wallet address is not allowed");
  }
  let res;
  try { res = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" } }); }
  catch (e) { throw new LnError(e.name === "TimeoutError" ? `The wallet at ${u.hostname} did not answer in time` : `Could not reach the wallet at ${u.hostname}`); }
  const text = await res.text();
  if (text.length > 200000) throw new LnError("The wallet sent too much data");
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (body && String(body.status || "").toUpperCase() === "ERROR") throw new LnError(`The wallet said: ${String(body.reason || "error").slice(0, 200)}`);
  if (res.status === 404) throw new LnError("Wallet not found: this Lightning address does not exist");
  if (!res.ok || !body) throw new LnError(`The wallet at ${u.hostname} gave an error (${res.status})`);
  return body;
}

/* ------------------------------------------------------------------ Lightning address -> LNURL-pay */
const ADDR_RE = /^([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/;

async function resolveAddress(address) {
  const m = String(address || "").trim().toLowerCase().match(ADDR_RE);
  if (!m) throw new LnError("That Lightning address doesn't look right");
  const proto = allowLocal() && process.env.LNURL_TEST_BASE ? process.env.LNURL_TEST_BASE.replace("{domain}", m[2]) : `https://${m[2]}`;
  const p = await getJson(`${proto}/.well-known/lnurlp/${encodeURIComponent(m[1])}`);
  if (p.tag !== "payRequest" || typeof p.callback !== "string") throw new LnError("This address can't receive Lightning payments");
  const min = Math.ceil(Number(p.minSendable) / 1000), max = Math.floor(Number(p.maxSendable) / 1000);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < 1) throw new LnError("This address can't receive Lightning payments");
  return { address: m[0], domain: m[2], callback: p.callback, min_sats: Math.max(1, min), max_sats: max, raw: p };
}

// Checks an address can take this amount. Returns the address info.
async function checkAddress(address, sats) {
  const info = await resolveAddress(address);
  if (sats != null && (sats < info.min_sats || sats > info.max_sats))
    throw new LnError(`This wallet only accepts ${info.min_sats.toLocaleString("en-ZA")} to ${info.max_sats.toLocaleString("en-ZA")} sats per payment`);
  return info;
}

// Asks the owner's wallet for an invoice of exactly `sats`, and checks it.
async function invoiceFor(address, sats, comment) {
  const info = await checkAddress(address, sats);
  const cb = new URL(info.callback);
  cb.searchParams.set("amount", String(sats * 1000));
  const max = Number(info.raw.commentAllowed) || 0;
  if (comment && max > 0) cb.searchParams.set("comment", comment.slice(0, max));
  const r = await getJson(cb.toString());
  if (typeof r.pr !== "string") throw new LnError("The wallet did not send an invoice");
  const inv = decodeInvoice(r.pr);
  if (inv.network !== (process.env.LN_NETWORK || "bc")) throw new LnError("The wallet sent an invoice for the wrong network");
  if (inv.amount_msat !== sats * 1000) throw new LnError("The wallet sent an invoice for the wrong amount");
  return { payment_request: r.pr, payment_hash: inv.payment_hash, domain: info.domain };
}

module.exports = { decodeInvoice, resolveAddress, checkAddress, invoiceFor, LnError, privateIp, CHARSET, polymod, hrpExpand };
