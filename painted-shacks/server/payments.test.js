// Tests for Lightning payouts, with a fake Blink and fake owner wallets. No real money, no internet.
// Run:  node --test --disable-warning=ExperimentalWarning payments.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { CHARSET, polymod, hrpExpand, decodeInvoice } = require("./lightning");
const { lastFriday } = require("./payments");

/* ---------------------------------------------------------------- a valid-looking BOLT11 invoice */
function toWords(buf) { let acc = 0, bits = 0; const out = []; for (const b of buf) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } acc &= (1 << bits) - 1; } if (bits) out.push((acc << (5 - bits)) & 31); return out; }
function makeInvoice(sats, hash) {
  const hrp = `lnbc${sats * 10}n`;
  const ts = []; let t = Math.floor(Date.now() / 1000); for (let i = 0; i < 7; i++) { ts.unshift(t & 31); t = Math.floor(t / 32); }
  const data = [...ts, 1, 1, 20, ...toWords(hash), ...new Array(104).fill(0)];
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = []; for (let i = 0; i < 6; i++) sum.push((chk >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...sum].map(w => CHARSET[w]).join("");
}

/* ---------------------------------------------------------------- fake world */
const world = { balance: 2_000_000, sent: [], txs: new Map(), behaviour: {}, probes: 0 };
let base;
const fake = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o, s = 200) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  let m = u.pathname.match(/^\/d\/([^/]+)\/\.well-known\/lnurlp\/([^/]+)$/);
  if (m) {
    const [, domain, name] = m;
    if (name === "nobody") return json({ status: "ERROR", reason: "User not found" }, 404);
    return json({ tag: "payRequest", callback: `${base}/cb/${domain}/${name}`, minSendable: 1000, maxSendable: (name === "small" ? 10000 : 1e11), metadata: "[]" });
  }
  m = u.pathname.match(/^\/cb\/([^/]+)\/([^/]+)$/);
  if (m) {
    const sats = Number(u.searchParams.get("amount")) / 1000;
    const pre = crypto.randomBytes(32), hash = crypto.createHash("sha256").update(pre).digest();
    return json({ pr: makeInvoice(m[2] === "wrongamt" ? sats + 1 : sats, hash), routes: [] });
  }
  if (u.pathname === "/graphql") {
    if (req.headers["x-api-key"] !== "test-key") return json({ errors: [{ message: "Not authorized" }] }, 401);
    let body = ""; for await (const c of req) body += c;
    const { query, variables } = JSON.parse(body);
    if (/authorization/.test(query)) return json({ data: { authorization: { scopes: world.behaviour.readOnly ? ["READ"] : ["READ", "WRITE"] },
      me: { defaultAccount: { wallets: [{ id: "usd1", walletCurrency: "USD", balance: 5 }, { id: "btc1", walletCurrency: "BTC", balance: world.balance }] } } } });
    if (/lnInvoiceFeeProbe/.test(query)) { world.probes++; return json({ data: { lnInvoiceFeeProbe: { amount: world.behaviour.fee ?? 2, errors: [] } } }); }
    if (/lnInvoicePaymentSend/.test(query)) {
      const pr = variables.input.paymentRequest, inv = decodeInvoice(pr), sats = inv.amount_msat / 1000;
      const mode = world.behaviour.pay || "ok";
      if (mode === "timeout") { world.txs.set(inv.payment_hash, { id: "tx" + world.sent.length, status: "SUCCESS", direction: "SEND", settlementFee: -2 }); world.sent.push(sats); world.balance -= sats + 2; return setTimeout(() => res.destroy(), 1000); /* answer is lost */ }
      if (mode === "fail") return json({ data: { lnInvoicePaymentSend: { status: "FAILURE", errors: [{ message: "No route found" }], transaction: null } } });
      if (world.txs.has(inv.payment_hash)) return json({ data: { lnInvoicePaymentSend: { status: "ALREADY_PAID", errors: [], transaction: null } } });
      const tx = { id: "tx" + world.sent.length, status: mode === "pending" ? "PENDING" : "SUCCESS", direction: "SEND", settlementFee: -2 };
      world.txs.set(inv.payment_hash, tx); world.sent.push(sats); world.balance -= sats + 2;
      return json({ data: { lnInvoicePaymentSend: { status: tx.status, errors: [], transaction: tx } } });
    }
    if (/transactionsByPaymentHash/.test(query)) {
      const t = world.txs.get(variables.h);
      return json({ data: { me: { defaultAccount: { walletById: { transactionsByPaymentHash: t ? [t] : [] } } } } });
    }
    return json({ errors: [{ message: "unknown query" }] });
  }
  json({}, 404);
});

/* ---------------------------------------------------------------- app */
let app, server, appUrl, cookie = "";
async function api(method, p, body) {
  const res = await fetch(appUrl + p, { method, headers: { "Content-Type": "application/json", "X-PS-Admin": "1", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const waitIdle = async () => { for (let i = 0; i < 200 && (app.pay.isSending() || app.db.prepare("select 1 from payouts where status = 'approved'").get()); i++) await new Promise(r => setTimeout(r, 20)); };

test.before(async () => {
  await new Promise(r => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${fake.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-pay-"));
  Object.assign(process.env, { DB_PATH: path.join(dir, "t.db"), COOKIE_SECURE: "0", LNURL_ALLOW_LOCAL: "1", LNURL_TEST_BASE: `${base}/d/{domain}`,
    BLINK_API_URL: `${base}/graphql`, BLINK_API_KEY: "test-key", PAYOUT_GAP_MS: "0" });
  app = require("./server");
  server = http.createServer(async (req, res) => { try { await app.handle(req, res); } catch (e) {
    res.writeHead(e.status || 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${server.address().port}`;
  const { db, hashPassword } = app;
  db.prepare("insert into staff(id,email,full_name,role,pw_hash) values ('a1','admin@x.co','Admin One','admin',?)").run(hashPassword("correct horse battery"));
  db.prepare("insert into staff(id,email,full_name,role,pw_hash) values ('i1','insp@x.co','Inspector','inspector',?)").run(hashPassword("correct horse battery"));
  const owners = [["owner-o1", "Thandi", "thandi@fedi.xyz"], ["owner-o2", "Sipho", "sipho@walletofsatoshi.com"], ["owner-o3", "Lindiwe", "nobody@blink.sv"], ["owner-o4", "Ayanda", null], ["owner-o5", "Zola", "small@coinos.io"]];
  for (const [id, name, ln] of owners) db.prepare("insert into owners(id, full_name, lightning_address) values (?,?,?)").run(id, name, ln);
  db.prepare("insert into shacks(id, shack_no, owner_id) values ('s1', 3, 'owner-o1'), ('s2', 7, 'owner-o2')").run();
  db.prepare("insert into sponsors(id, name) values ('sp1','Fedi')").run();
  db.prepare("insert into sponsor_payments(id, sponsor_id, received_on, amount_sats) values ('f1','sp1','2026-11-17',3095490)").run();
});
test.after(() => { server.close(); fake.close(); });

test("last Friday of the month", () => {
  assert.equal(lastFriday("2026-11"), "2026-11-27");
  assert.equal(lastFriday("2026-12"), "2026-12-25");
  assert.equal(lastFriday("2027-01"), "2027-01-29");
  assert.equal(lastFriday("2026-07"), "2026-07-31");
});

test("invoice decoding", () => {
  const h = crypto.randomBytes(32);
  const d = decodeInvoice(makeInvoice(28000, h));
  assert.equal(d.amount_msat, 28_000_000);
  assert.equal(d.payment_hash, h.toString("hex"));
  assert.throws(() => decodeInvoice(makeInvoice(28000, h).slice(0, -1) + "q"), /checksum/);
});

test("inspectors can't reach payments", async () => {
  await api("POST", "/api/login", { email: "insp@x.co", password: "correct horse battery" });
  assert.equal((await api("GET", "/api/payments/overview")).status, 403);
  assert.equal((await api("POST", "/api/payouts/approve", { ids: ["x"], password: "correct horse battery" })).status, 403);
  await api("POST", "/api/login", { email: "admin@x.co", password: "correct horse battery" });
});

test("overview shows the wallet and never the key", async () => {
  const r = await api("GET", "/api/payments/overview");
  assert.equal(r.status, 200);
  assert.equal(r.data.wallet.balance_sats, 2_000_000);
  assert.equal(r.data.wallet.can_send, true);
  assert.ok(!JSON.stringify(r.data).includes("test-key"));
});

test("address checks work for any wallet and explain failures", async () => {
  const ok = await api("POST", "/api/owners/owner-o2/check-address");
  assert.equal(ok.data.ok, true);
  const bad = await api("POST", "/api/owners/owner-o3/check-address");
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.message, /User not found/);
  const small = await api("POST", "/api/owners/owner-o5/check-address");
  assert.equal(small.data.ok, false);
  assert.match(small.data.message, /only accepts/);
});

let batch;
test("drafting a month sends nothing", async () => {
  const r = await api("POST", "/api/payout-batches", { period: "2026-11" });
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 5);
  batch = r.data.batch.id;
  const again = await api("POST", "/api/payout-batches", { period: "2026-11" });
  assert.equal(again.data.added, 0);
  assert.equal(world.sent.length, 0);
  assert.equal(world.probes, 0);
});

test("weeks set the amount, capped at the monthly maximum", async () => {
  const lines = (await api("GET", `/api/payout-batches/${batch}`)).data.lines;
  const id = o => lines.find(l => l.owner_id === o).id;
  assert.equal((await api("PATCH", `/api/payouts/${id("owner-o1")}`, { weeks_earned: 4 })).data.amount_sats, 28000);
  assert.equal((await api("PATCH", `/api/payouts/${id("owner-o2")}`, { weeks_earned: 3 })).data.amount_sats, 21000);
  assert.equal((await api("PATCH", `/api/payouts/${id("owner-o3")}`, { weeks_earned: 4 })).status, 200);
  assert.equal((await api("PATCH", `/api/payouts/${id("owner-o4")}`, { weeks_earned: 4 })).status, 200);
  assert.equal((await api("PATCH", `/api/payouts/${id("owner-o1")}`, { weeks_earned: 5 })).status, 400);
});

test("approving needs the right password", async () => {
  const lines = (await api("GET", `/api/payout-batches/${batch}`)).data.lines;
  const r = await api("POST", "/api/payouts/approve", { ids: lines.map(l => l.id), password: "wrong" });
  assert.equal(r.status, 403);
  await waitIdle();
  assert.equal(world.sent.length, 0);
});

test("approve and send pays only good lines, once", async () => {
  const lines = (await api("GET", `/api/payout-batches/${batch}`)).data.lines;
  const r = await api("POST", "/api/payouts/approve", { ids: lines.map(l => l.id), password: "correct horse battery" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.approved, 2);                    // o1, o2. Skipped: o3 (address check failed), o4 (no address), o5 (0 weeks)
  assert.equal(r.data.skipped.length, 3);
  await waitIdle();
  const after = (await api("GET", `/api/payout-batches/${batch}`)).data.lines;
  const by = o => after.find(l => l.owner_id === o);
  assert.equal(by("owner-o1").status, "paid");
  assert.ok(by("owner-o1").blink_tx_id);
  assert.equal(by("owner-o1").fee_sats, 2);
  assert.equal(by("owner-o2").status, "paid");
  assert.equal(by("owner-o4").status, "pending");            // no address: skipped
  assert.deepEqual(world.sent.sort(), [21000, 28000]);
  // Approving the same lines again does nothing.
  const again = await api("POST", "/api/payouts/approve", { ids: [by("owner-o1").id], password: "correct horse battery" });
  assert.equal(again.data.approved, 0);
  await waitIdle();
  assert.equal(world.sent.length, 2);
});

test("an owner can't get a second learning payout for the same month", async () => {
  const r = await api("POST", "/api/payout-batches", { period: "2026-11" });
  assert.equal(r.data.added, 0);
  assert.throws(() => app.db.prepare("insert into payouts(id, owner_id, period, reason, amount_sats) values ('dup','owner-o1','2026-11','weekly_learning',7000)").run(), /UNIQUE/);
});

test("single payment: limit, approval, failure and retry", async () => {
  assert.equal((await api("POST", "/api/payouts", { owner_id: "owner-o2", amount_sats: 60000, reason: "bonus", note: "x" })).status, 400);
  const c = await api("POST", "/api/payouts", { owner_id: "owner-o2", amount_sats: 5000, reason: "bonus", note: "Painted again" });
  assert.equal(c.status, 201);
  world.behaviour.pay = "fail";
  await api("POST", "/api/payouts/approve", { ids: [c.data.id], password: "correct horse battery" });
  await waitIdle();
  let row = app.db.prepare("select * from payouts where id = ?").get(c.data.id);
  assert.equal(row.status, "failed");
  assert.match(row.failure_reason, /No route/);
  world.behaviour.pay = "ok";
  assert.equal((await api("POST", `/api/payouts/${c.data.id}/retry`)).data.status, "pending");   // back to waiting for approval, not sent
  await waitIdle();
  assert.equal(app.db.prepare("select status from payouts where id = ?").get(c.data.id).status, "pending");
  await api("POST", "/api/payouts/approve", { ids: [c.data.id], password: "correct horse battery" });
  await waitIdle();
  row = app.db.prepare("select * from payouts where id = ?").get(c.data.id);
  assert.equal(row.status, "paid");
  assert.equal(row.attempts, 2);
});

test("wrong-amount invoices and high fees are refused", async () => {
  app.db.prepare("insert into owners(id, full_name, lightning_address) values ('owner-o6','Bad Wallet','wrongamt@example.com')").run();
  const a = await api("POST", "/api/payouts", { owner_id: "owner-o6", amount_sats: 1000, reason: "other", note: "test" });
  await api("POST", "/api/payouts/approve", { ids: [a.data.id], password: "correct horse battery" });
  await waitIdle();
  assert.match(app.db.prepare("select failure_reason f from payouts where id = ?").get(a.data.id).f, /wrong amount/);
  world.behaviour.fee = 500;
  const b = await api("POST", "/api/payouts", { owner_id: "owner-o1", amount_sats: 1000, reason: "other", note: "fee test" });
  const before = world.sent.length;
  await api("POST", "/api/payouts/approve", { ids: [b.data.id], password: "correct horse battery" });
  await waitIdle();
  assert.match(app.db.prepare("select failure_reason f from payouts where id = ?").get(b.data.id).f, /fee/);
  assert.equal(world.sent.length, before);
  world.behaviour.fee = 2;
});

test("a lost answer from Blink is checked, never paid twice", async () => {
  const c = await api("POST", "/api/payouts", { owner_id: "owner-o1", amount_sats: 2000, reason: "other", note: "timeout test" });
  const before = world.sent.length;
  world.behaviour.pay = "timeout";
  process.env.BLINK_SEND_TIMEOUT_MS = "300";
  await api("POST", "/api/payouts/approve", { ids: [c.data.id], password: "correct horse battery" });
  await waitIdle();
  assert.equal(app.db.prepare("select status from payouts where id = ?").get(c.data.id).status, "sending");   // outcome unknown
  world.behaviour.pay = "ok"; delete process.env.BLINK_SEND_TIMEOUT_MS;
  await app.pay.reconcile();                     // the 10-minute checker asks Blink by payment hash
  const row = app.db.prepare("select * from payouts where id = ?").get(c.data.id);
  assert.equal(row.status, "paid");
  assert.equal(world.sent.length, before + 1);   // paid exactly once
});

test("checker fails a payment Blink never saw, so it can be retried safely", async () => {
  const c = await api("POST", "/api/payouts", { owner_id: "owner-o1", amount_sats: 1500, reason: "other", note: "lost" });
  app.db.prepare("update payouts set status = 'sending', payment_hash = ?, sending_since = ? where id = ?")
    .run(crypto.randomBytes(32).toString("hex"), new Date(Date.now() - 11 * 60e3).toISOString(), c.data.id);
  await app.pay.reconcile();
  const row = app.db.prepare("select * from payouts where id = ?").get(c.data.id);
  assert.equal(row.status, "failed");
  assert.match(row.failure_reason, /Safe to retry/);
});

test("read-only key can't approve", async () => {
  world.behaviour.readOnly = true;
  const c = await api("POST", "/api/payouts", { owner_id: "owner-o2", amount_sats: 100, reason: "other", note: "ro" });
  const r = await api("POST", "/api/payouts/approve", { ids: [c.data.id], password: "correct horse battery" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /only read/);
  world.behaviour.readOnly = false;
});

test("not enough in the wallet blocks approval", async () => {
  const keep = world.balance; world.balance = 50;
  const c = await api("POST", "/api/payouts", { owner_id: "owner-o2", amount_sats: 1000, reason: "other", note: "low" });
  const r = await api("POST", "/api/payouts/approve", { ids: [c.data.id], password: "correct horse battery" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Top up/);
  world.balance = keep;
});

test("funding summary keeps sponsor money and payouts apart; CSV downloads", async () => {
  const s = (await api("GET", "/api/payments/summary")).data;
  assert.equal(s.sponsor_in_sats, 3095490);
  const paidSum = app.db.prepare("select sum(amount_sats) n, sum(fee_sats) f from payouts where status = 'paid'").get();
  assert.equal(s.paid_out_sats, paidSum.n);
  assert.equal(s.balance_sats, 3095490 - paidSum.n - paidSum.f);
  const csv = await fetch(appUrl + `/api/reports/payouts.csv?batch=${batch}`, { headers: { Cookie: cookie } });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /Thandi/);
  assert.match(text, /Blink reference/);
  const f = await (await fetch(appUrl + "/api/reports/funding.csv", { headers: { Cookie: cookie } })).text();
  assert.match(f, /Sponsor money in/);
  assert.match(f, /Paid to owners/);
});

test("CSV cells can't run as spreadsheet formulas", async () => {
  app.db.prepare("update owners set full_name = '=HYPERLINK(\"x\")' where id = 'owner-o2'").run();
  const text = await (await fetch(appUrl + "/api/reports/payouts.csv", { headers: { Cookie: cookie } })).text();
  assert.ok(!/(^|,)=HYPERLINK/m.test(text));
});

test("pay day can be moved for one month (December 2026 is paid on 30 December)", async () => {
  const ov = async () => (await api("GET", "/api/payments/overview")).data;
  const pay = app.pay;
  assert.equal(pay.payDay("2026-12"), "2026-12-30");
  assert.equal(pay.draftDay("2026-12"), "2026-12-28");
  assert.equal(pay.payDay("2027-01"), "2027-01-29", "other months stay on the last Friday");
  assert.equal((await api("PUT", "/api/paydays/2027-01", { pay_date: "2027-02-01" })).status, 400, "must be in that month");
  assert.equal((await api("PUT", "/api/paydays/2027-01", { pay_date: "2027-01-27" })).status, 200);
  assert.equal(pay.payDay("2027-01"), "2027-01-27");
  assert.ok((await ov()).paydays.some(d => d.period === "2027-01"));
  assert.equal((await api("DELETE", "/api/paydays/2027-01")).status, 200);
  assert.equal(pay.payDay("2027-01"), "2027-01-29");
});
