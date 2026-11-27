// Lightning payouts to shack owners.
//
// Rules this file keeps:
//  * Nothing is ever sent without an admin approving it with their password. Timers only DRAFT the monthly
//    batch and CHECK the outcome of payments that were already sent.
//  * Owners can use a Lightning address from any wallet. We fetch an invoice from their wallet (LNURL-pay)
//    and pay it from Bitcoin Ekasi's Blink wallet. The Blink key lives only in the server's environment.
//  * An owner can be paid for learning once per month (database rule), and the payment hash is saved
//    before paying, so a crash never leads to paying twice.
"use strict";
const crypto = require("node:crypto");
const ln = require("./lightning");
const blink = require("./blink");

const now = () => new Date().toISOString();
const saToday = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);   // South Africa time
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = period => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

// Last Friday of a month ('2026-11' -> '2026-11-27').
function lastFriday(period) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));                 // last day of the month
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7));  // back to Friday (day 5)
  return d.toISOString().slice(0, 10);
}
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

function init(ctx) {
  const { db, audit, tx, Bad, readJson, send, checkPassword } = ctx;
  const settings = () => db.prepare("select * from pay_settings where id = 1").get();
  // Pay day of a month: the last Friday, unless an admin moved it for that month.
  const payDay = period => db.prepare("select pay_date from paydays where period = ?").get(period)?.pay_date || lastFriday(period);
  const draftDay = period => addDays(payDay(period), -settings().draft_days_before);

  /* ---------------------------------------------------------------- weeks earned
     The owner app records each finished week (lesson read + quiz passed) in lesson_completions, with the
     monthly payout it belongs to (pay_period). An admin can still change the weeks on a line by hand. */
  function weeksEarned(ownerId, period) {
    return db.prepare("select count(*) n from lesson_completions where owner_id = ? and pay_period = ? and passed = 1").get(ownerId, period).n;
  }

  // Bring the weeks on an owner's waiting learning payout up to date with the app (unless an admin set them by hand).
  function syncWeeks(ownerId, period) {
    const s = settings();
    const row = db.prepare(`select * from payouts where owner_id = ? and period = ? and reason = 'weekly_learning'
                            and status = 'pending' and weeks_by_admin = 0`).get(ownerId, period);
    if (!row) return false;
    const weeks = Math.min(weeksEarned(ownerId, period), s.max_weeks);
    if (weeks === row.weeks_earned && row.amount_sats === weeks * s.sats_per_week) return false;
    db.prepare("update payouts set weeks_earned = ?, amount_sats = ?, updated_at = ? where id = ?").run(weeks, weeks * s.sats_per_week, now(), row.id);
    audit(null, "payouts", row.id, "WEEKS_FROM_APP", { weeks_earned: row.weeks_earned }, { weeks_earned: weeks });
    return true;
  }

  /* ---------------------------------------------------------------- reading */
  const LIST_SQL = `select p.*, o.full_name as owner_name, o.active as owner_active, o.lightning_address as owner_address,
      (select group_concat(shack_no, ', ') from (select shack_no from shacks where owner_id = p.owner_id order by shack_no)) as shacks,
      (select count(*) from lesson_completions lc where lc.owner_id = p.owner_id and lc.pay_period = p.period and lc.passed = 1) as app_weeks,
      b.title as batch_title, ac.ok as address_ok, ac.message as address_message, ac.address as checked_address
    from payouts p join owners o on o.id = p.owner_id left join payout_batches b on b.id = p.batch_id
    left join address_checks ac on ac.owner_id = p.owner_id`;
  const pub = r => { if (!r) return r; const { payment_request, ...rest } = r; return rest; };

  function batchInfo(b) {
    const rows = db.prepare("select status, count(*) n, sum(amount_sats) sats, sum(coalesce(fee_sats,0)) fees from payouts where batch_id = ? group by status").all(b.id);
    const by = Object.fromEntries(rows.map(r => [r.status, { n: r.n, sats: r.sats || 0, fees: r.fees || 0 }]));
    return { ...b, counts: by, total_sats: rows.filter(r => r.status !== "cancelled").reduce((a, r) => a + (r.sats || 0), 0) };
  }

  function walletStatus() {
    if (!blink.configured()) return Promise.resolve({ configured: false, ok: false, error: "The Blink key is not set on the server yet." });
    return blink.wallet().then(w => ({ configured: true, ok: true, balance_sats: w.balance_sats, can_send: w.scopes.includes("WRITE"), scopes: w.scopes }))
      .catch(e => ({ configured: true, ok: false, error: e.message }));
  }

  /* ---------------------------------------------------------------- drafting the monthly batch */
  function draftBatch(period, user) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Bad("Month must look like 2026-12.");
    const s = settings();
    return tx(() => {
      let b = db.prepare("select * from payout_batches where period = ?").get(period);
      if (!b) {
        const id = crypto.randomUUID();
        db.prepare("insert into payout_batches(id, period, title, pay_date, created_by) values (?,?,?,?,?)")
          .run(id, period, `${monthName(period)} payout`, payDay(period), user?.id || null);
        b = db.prepare("select * from payout_batches where id = ?").get(id);
        audit(user, "payout_batches", id, "INSERT", null, b);
      }
      let added = 0, updated = 0;
      const owners = db.prepare("select id from owners where active = 1").all();
      for (const o of owners) {
        if (db.prepare("select 1 from payouts where owner_id = ? and period = ? and reason = 'weekly_learning' and status <> 'cancelled'").get(o.id, period)) {
          if (syncWeeks(o.id, period)) updated++;
          continue;
        }
        const weeks = Math.min(weeksEarned(o.id, period), s.max_weeks);
        db.prepare(`insert into payouts(id, batch_id, owner_id, period, reason, weeks_earned, amount_sats, created_by)
                    values (?,?,?,?, 'weekly_learning', ?, ?, ?)`)
          .run(crypto.randomUUID(), b.id, o.id, period, weeks, weeks * s.sats_per_week, user?.id || null);
        added++;
      }
      if (added) audit(user, "payouts", b.id, "DRAFT", null, { period, added });
      return { batch: batchInfo(b), added, updated };
    });
  }

  // Runs every hour: drafts this month's batch a few days before pay day. It never sends anything.
  function autoDraft() {
    try {
      const period = saToday().slice(0, 7);
      if (db.prepare("select 1 from payout_batches where period = ?").get(period)) return;
      if (saToday() < draftDay(period)) return;
      if (!db.prepare("select 1 from owners where active = 1").get()) return;
      draftBatch(period, null);
      console.log(new Date().toISOString(), "drafted payout batch", period);
    } catch (e) { console.error("auto draft", e); }
  }

  /* ---------------------------------------------------------------- approving */
  const pwTries = new Map();
  function confirmPassword(user, password) {
    const t = Date.now(), list = (pwTries.get(user.id) || []).filter(x => t - x < 15 * 60e3);
    pwTries.set(user.id, list);
    if (list.length >= 5) throw new Bad("Too many wrong passwords. Wait 15 minutes.", 429);
    const row = db.prepare("select pw_hash from staff where id = ? and disabled = 0").get(user.id);
    if (!checkPassword(String(password || ""), row?.pw_hash)) { list.push(t); throw new Bad("Your password is wrong. Nothing was approved.", 403); }
  }

  async function approve(ids, user) {
    const s = settings();
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new Bad("Choose the payments to approve.");
    const rows = ids.map(id => db.prepare(LIST_SQL + " where p.id = ?").get(String(id))).filter(Boolean);
    const ok = [], skipped = [];
    for (const r of rows) {
      const why = r.status !== "pending" ? "not waiting for approval"
        : !(r.amount_sats > 0) ? "amount is 0"
        : !r.owner_address ? "owner has no Lightning address"
        : r.address_ok === 0 && r.checked_address === r.owner_address ? `address check failed: ${r.address_message}`
        : r.reason === "weekly_learning" && r.amount_sats > s.sats_per_week * s.max_weeks ? "more than the monthly maximum"
        : r.reason !== "weekly_learning" && r.amount_sats > s.single_limit_sats ? `more than the single payment limit (${s.single_limit_sats} sats)`
        : null;
      if (why) skipped.push({ id: r.id, owner: r.owner_name, why }); else ok.push(r);
    }
    if (!ok.length) return { approved: 0, total_sats: 0, skipped };
    const total = ok.reduce((a, r) => a + r.amount_sats, 0);
    const queued = db.prepare("select coalesce(sum(amount_sats),0) n from payouts where status in ('approved','sending')").get().n;
    if (total + queued > s.batch_limit_sats)
      throw new Bad(`That is ${total.toLocaleString("en-ZA")} sats, over the limit of ${s.batch_limit_sats.toLocaleString("en-ZA")} sats per approval. Approve fewer, or raise the limit in payment settings.`);
    const w = await walletStatus();
    if (!w.ok) throw new Bad(w.error);
    if (!w.can_send) throw new Bad("The Blink key on the server can only read. Put a key with Write (send) rights on the server.");
    const need = total + queued + ok.length * s.max_fee_sats;
    if (w.balance_sats < need) throw new Bad(`The Blink wallet has ${w.balance_sats.toLocaleString("en-ZA")} sats, but this needs up to ${need.toLocaleString("en-ZA")} sats with fees. Top up the wallet first.`);
    tx(() => {
      for (const r of ok) {
        db.prepare(`update payouts set status = 'approved', approved_by = ?, approved_by_name = ?, approved_at = ?, lightning_address = ?,
                    failure_reason = null, updated_at = ? where id = ? and status = 'pending'`)
          .run(user.id, user.full_name, now(), r.owner_address, now(), r.id);
        audit(user, "payouts", r.id, "APPROVE", { status: "pending" }, { status: "approved", amount_sats: r.amount_sats, lightning_address: r.owner_address });
      }
    });
    setImmediate(runSender);
    return { approved: ok.length, total_sats: total, skipped };
  }

  /* ---------------------------------------------------------------- sending (only rows an admin approved) */
  let sending = false;
  const attempt = (id, hash, result, message) =>
    db.prepare("insert into payout_attempts(payout_id, payment_hash, result, message) values (?,?,?,?)").run(id, hash || null, result, message || null);
  const fail = (id, reason) => {
    db.prepare("update payouts set status = 'failed', failure_reason = ?, updated_at = ? where id = ?").run(String(reason).slice(0, 400), now(), id);
    audit(null, "payouts", id, "FAILED", null, { reason });
  };
  const paid = (id, r) => {
    db.prepare("update payouts set status = 'paid', blink_tx_id = ?, fee_sats = ?, paid_at = ?, failure_reason = null, updated_at = ? where id = ?")
      .run(r.tx_id || null, r.fee_sats ?? null, now(), now(), id);
    audit(null, "payouts", id, "PAID", null, { blink_tx_id: r.tx_id, fee_sats: r.fee_sats });
  };

  async function sendOne(p) {
    const s = settings();
    const claim = db.prepare(`update payouts set status = 'sending', attempts = attempts + 1, sending_since = ?, payment_request = null,
                              payment_hash = null, updated_at = ? where id = ? and status = 'approved'`).run(now(), now(), p.id);
    if (!claim.changes) return;
    let inv;
    try {
      inv = await ln.invoiceFor(p.lightning_address, p.amount_sats, `Bitcoin Ekasi Painted Shacks${p.period ? " " + monthName(p.period) : ""}`);
    } catch (e) { attempt(p.id, null, "no_invoice", e.message); return fail(p.id, `Owner's wallet: ${e.message}`); }
    try {
      db.prepare("update payouts set payment_request = ?, payment_hash = ? where id = ?").run(inv.payment_request, inv.payment_hash, p.id);
    } catch (e) { attempt(p.id, inv.payment_hash, "error", "invoice reused"); return fail(p.id, "The owner's wallet sent an invoice that was already used. Retry."); }
    try {
      const fee = await blink.feeProbe(inv.payment_request);
      if (fee > s.max_fee_sats) { attempt(p.id, inv.payment_hash, "fee_too_high", `${fee} sats`); return fail(p.id, `Network fee would be ${fee} sats, more than the ${s.max_fee_sats} sats limit.`); }
    } catch (e) {
      attempt(p.id, inv.payment_hash, "probe_failed", e.message);
      return fail(p.id, e.unknown ? `${e.message} Nothing was sent. Retry later.` : `No route to the owner's wallet (${e.message}). Nothing was sent.`);
    }
    let r;
    try { r = await blink.payInvoice(inv.payment_request, `Painted Shacks${p.period ? " " + monthName(p.period) : ""}`); }
    catch (e) {
      attempt(p.id, inv.payment_hash, e.unknown ? "unknown" : "error", e.message);
      if (e.unknown) return;            // stays "sending"; the checker asks Blink about this payment hash
      return fail(p.id, e.message);
    }
    attempt(p.id, inv.payment_hash, r.status, r.message);
    if (r.status === "SUCCESS" || r.status === "ALREADY_PAID") return paid(p.id, r);
    if (r.status === "PENDING") return;   // checker follows up
    return fail(p.id, r.message ? `Blink: ${r.message}` : "Blink could not pay this invoice.");
  }

  async function runSender() {
    if (sending) return;
    sending = true;
    try {
      for (;;) {
        const p = db.prepare("select * from payouts where status = 'approved' order by approved_at, created_at limit 1").get();
        if (!p) break;
        try { await sendOne(p); } catch (e) { console.error("payout", p.id, e); fail(p.id, "Server error while sending. Check Blink before retrying."); }
        await new Promise(r => setTimeout(r, Number(process.env.PAYOUT_GAP_MS ?? 700)));
      }
    } finally { sending = false; }
  }

  // Checks payments whose outcome we don't know yet. Never starts a new payment.
  async function reconcile() {
    const rows = db.prepare("select * from payouts where status = 'sending'").all();
    for (const p of rows) {
      if (sending) break;
      if (!p.payment_hash) { attempt(p.id, null, "not_sent", "stopped before an invoice was saved"); fail(p.id, "Sending stopped before anything was paid. Safe to retry."); continue; }
      try {
        const t = await blink.lookup(p.payment_hash);
        if (t?.status === "SUCCESS") { attempt(p.id, p.payment_hash, "SUCCESS", "confirmed by check"); paid(p.id, t); }
        else if (t?.status === "FAILURE") { attempt(p.id, p.payment_hash, "FAILURE", "confirmed by check"); fail(p.id, "Blink could not complete this payment. Nothing was paid."); }
        else if (!t && Date.parse(p.sending_since) < Date.now() - 10 * 60e3) {
          attempt(p.id, p.payment_hash, "not_found", "Blink has no record"); fail(p.id, "Blink has no record of this payment, so nothing was paid. Safe to retry.");
        }
      } catch (e) { console.error("payout check", p.id, e.message); }
    }
  }

  /* ---------------------------------------------------------------- address checks */
  async function checkOwnerAddress(owner) {
    const s = settings();
    let ok = 0, message = null, min = null, max = null;
    if (!owner.lightning_address) message = "No Lightning address";
    else {
      try { const i = await ln.checkAddress(owner.lightning_address, s.sats_per_week); ok = 1; min = i.min_sats; max = i.max_sats; message = `OK (${i.domain})`; }
      catch (e) { message = e.message; }
    }
    if (owner.lightning_address)
      db.prepare(`insert into address_checks(owner_id, address, ok, message, min_sats, max_sats, checked_at) values (?,?,?,?,?,?,?)
                  on conflict(owner_id) do update set address = excluded.address, ok = excluded.ok, message = excluded.message,
                  min_sats = excluded.min_sats, max_sats = excluded.max_sats, checked_at = excluded.checked_at`)
        .run(owner.id, owner.lightning_address, ok, message, min, max, now());
    return { owner_id: owner.id, address: owner.lightning_address, ok: !!ok, message, min_sats: min, max_sats: max };
  }

  /* ---------------------------------------------------------------- funding (sponsor money in vs payouts out) */
  function summary() {
    const inn = db.prepare("select coalesce(sum(amount_sats),0) n from sponsor_payments").get().n;
    const out = db.prepare("select coalesce(sum(amount_sats),0) sats, coalesce(sum(fee_sats),0) fees, count(*) n from payouts where status = 'paid'").get();
    const queued = db.prepare("select coalesce(sum(amount_sats),0) n from payouts where status in ('approved','sending')").get().n;
    const months = db.prepare(`select substr(paid_at,1,7) month, count(*) n, sum(amount_sats) sats, sum(coalesce(fee_sats,0)) fees
                               from payouts where status = 'paid' group by month order by month desc`).all();
    const sponsors = db.prepare(`select sp.name, sum(p.amount_sats) sats, count(*) n from sponsor_payments p join sponsors sp on sp.id = p.sponsor_id
                                 group by sp.id order by sats desc`).all();
    return { sponsor_in_sats: inn, paid_out_sats: out.sats, fees_sats: out.fees, paid_count: out.n, in_flight_sats: queued,
             balance_sats: inn - out.sats - out.fees, months, sponsors };
  }

  /* ---------------------------------------------------------------- CSV reports */
  const cell = v => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;      // stop spreadsheets running it as a formula
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = (head, rows) => "﻿" + [head, ...rows].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  const REASON = { weekly_learning: "Weekly learning", bonus: "Bonus", correction: "Correction", other: "Other" };

  function payoutRows(q) {
    const where = [], args = [];
    if (q.get("batch")) { where.push("p.batch_id = ?"); args.push(q.get("batch")); }
    if (q.get("owner")) { where.push("p.owner_id = ?"); args.push(q.get("owner")); }
    if (q.get("status")) { where.push("p.status = ?"); args.push(q.get("status")); }
    if (q.get("from")) { where.push("coalesce(substr(p.paid_at,1,10), substr(p.created_at,1,10)) >= ?"); args.push(q.get("from")); }
    if (q.get("to")) { where.push("coalesce(substr(p.paid_at,1,10), substr(p.created_at,1,10)) <= ?"); args.push(q.get("to")); }
    return db.prepare(`${LIST_SQL} ${where.length ? "where " + where.join(" and ") : ""} order by coalesce(p.paid_at, p.created_at) desc limit 5000`).all(...args);
  }

  function payoutsCsv(q) {
    const rows = payoutRows(q);
    return csv(["Date paid", "Month", "Owner", "Shack", "Lightning address", "Reason", "Weeks", "Amount (sats)", "Fee (sats)", "Status",
                "Blink reference", "Payment hash", "Approved by", "Approved at", "Note", "Failure reason"],
      rows.map(r => [r.paid_at ? r.paid_at.slice(0, 16).replace("T", " ") : "", r.period || "", r.owner_name || "", r.shacks || "",
        r.lightning_address || r.owner_address || "", REASON[r.reason], r.weeks_earned ?? "", r.amount_sats, r.fee_sats ?? "", r.status,
        r.blink_tx_id || "", r.payment_hash || "", r.approved_by_name || "", r.approved_at ? r.approved_at.slice(0, 16).replace("T", " ") : "",
        r.note || "", r.failure_reason || ""]));
  }

  function fundingCsv() {
    const ins = db.prepare(`select p.received_on d, sp.name who, p.purpose what, p.amount_sats sats, p.amount_zar zar from sponsor_payments p
                            join sponsors sp on sp.id = p.sponsor_id`).all().map(r => ({ d: r.d, kind: "Sponsor money in", who: r.who, what: r.what || "", in: r.sats, out: 0, fee: 0, zar: r.zar }));
    const outs = db.prepare(`select substr(paid_at,1,10) d, count(*) n, sum(amount_sats) sats, sum(coalesce(fee_sats,0)) fees, period from payouts
                             where status = 'paid' group by d, period`).all()
      .map(r => ({ d: r.d, kind: "Paid to owners", who: `${r.n} owner${r.n === 1 ? "" : "s"}`, what: r.period ? monthName(r.period) : "Single payments", in: 0, out: r.sats, fee: r.fees, zar: null }));
    let bal = 0;
    const all = [...ins, ...outs].sort((a, b) => a.d.localeCompare(b.d) || (b.in - a.in));
    return csv(["Date", "Type", "From / to", "For", "In (sats)", "Out (sats)", "Fees (sats)", "Balance (sats)", "Rand (sponsor)"],
      all.map(r => { bal += r.in - r.out - r.fee; return [r.d, r.kind, r.who, r.what, r.in || "", r.out || "", r.fee || "", bal, r.zar ?? ""]; }));
  }

  /* ---------------------------------------------------------------- routes (admins only; server.js checks the role first) */
  async function routes(req, res, p, method, user, url) {
    const csvOut = (name, body) => send(res, 200, body, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` });
    const day = saToday();

    if (p === "/api/payments/overview" && method === "GET") {
      const batches = db.prepare("select * from payout_batches order by coalesce(period, created_at) desc limit 24").all().map(batchInfo);
      const counts = Object.fromEntries(db.prepare("select status, count(*) n from payouts group by status").all().map(r => [r.status, r.n]));
      const period = day.slice(0, 7);
      return send(res, 200, { settings: settings(), wallet: await walletStatus(), batches, counts, sending,
        this_month: { period, title: monthName(period), pay_date: payDay(period), draft_on: draftDay(period) },
        paydays: db.prepare("select * from paydays where period >= ? order by period").all(period),
        today: day });
    }
    if (p === "/api/payments/summary" && method === "GET") return send(res, 200, summary());

    if (p === "/api/payments/settings" && method === "PATCH") {
      const b = await readJson(req);
      confirmPassword(user, b.password);
      const before = settings(), upd = {};
      for (const k of ["sats_per_week", "max_weeks", "draft_days_before", "batch_limit_sats", "single_limit_sats", "max_fee_sats"]) {
        if (b[k] === undefined) continue;
        const v = Number(b[k]);
        if (!Number.isInteger(v) || v < 0) throw new Bad(`${k} must be a whole number`);
        upd[k] = v;
      }
      if (Object.keys(upd).length)
        db.prepare(`update pay_settings set ${Object.keys(upd).map(k => k + " = ?").join(", ")}, updated_at = ? where id = 1`).run(...Object.values(upd), now());
      audit(user, "pay_settings", "1", "UPDATE", before, settings());
      return send(res, 200, settings());
    }

    let pd = p.match(/^\/api\/paydays\/(\d{4}-(?:0[1-9]|1[0-2]))$/);
    if (pd && (method === "PUT" || method === "DELETE")) {
      const period = pd[1], before = db.prepare("select * from paydays where period = ?").get(period) || null;
      const b = method === "PUT" ? await readJson(req) : {};
      const date = method === "PUT" ? String(b.pay_date || "") : null;
      if (method === "PUT" && !(/^\d{4}-\d{2}-\d{2}$/.test(date) && date.slice(0, 7) === period && !isNaN(Date.parse(date + "T00:00:00Z"))))
        throw new Bad(`Pay day must be a date in ${monthName(period)}.`);
      const batch = db.prepare("select * from payout_batches where period = ?").get(period);
      if (batch && db.prepare("select 1 from payouts where batch_id = ? and status not in ('pending','cancelled')").get(batch.id))
        throw new Bad("Payments for this month are already approved or sent, so its pay day can't change.");
      tx(() => {
        if (method === "PUT") db.prepare(`insert into paydays(period, pay_date, set_by_name, updated_at) values (?,?,?,?)
                                         on conflict(period) do update set pay_date = excluded.pay_date, set_by_name = excluded.set_by_name, updated_at = excluded.updated_at`)
          .run(period, date, user?.full_name || null, now());
        else db.prepare("delete from paydays where period = ?").run(period);
        if (batch) db.prepare("update payout_batches set pay_date = ? where id = ?").run(payDay(period), batch.id);
        audit(user, "paydays", period, method === "PUT" ? "UPDATE" : "DELETE", before, db.prepare("select * from paydays where period = ?").get(period) || null);
      });
      return send(res, 200, { period, pay_date: payDay(period), draft_on: draftDay(period) });
    }

    if (p === "/api/payout-batches" && method === "POST") {
      const b = await readJson(req);
      return send(res, 200, draftBatch(String(b.period || day.slice(0, 7)), user));
    }
    let m = p.match(/^\/api\/payout-batches\/([\w-]{8,64})$/);
    if (m && method === "GET") {
      const b = db.prepare("select * from payout_batches where id = ?").get(m[1]);
      if (!b) throw new Bad("Not found", 404);
      const lines = db.prepare(LIST_SQL + " where p.batch_id = ? order by cast(coalesce(shacks,'999') as integer), o.full_name").all(b.id).map(pub);
      return send(res, 200, { batch: batchInfo(b), lines, settings: settings() });
    }

    if (p === "/api/payouts" && method === "GET") {
      const rows = payoutRows(url.searchParams).slice(0, 1000).map(pub);
      return send(res, 200, rows);
    }
    if (p === "/api/payouts" && method === "POST") {
      const b = await readJson(req), s = settings();
      const owner = db.prepare("select * from owners where id = ?").get(String(b.owner_id || ""));
      if (!owner) throw new Bad("Choose an owner.");
      const reason = ["bonus", "correction", "other"].includes(b.reason) ? b.reason : null;
      if (!reason) throw new Bad("Choose a reason.");
      const amount = Number(b.amount_sats);
      if (!Number.isInteger(amount) || amount < 1) throw new Bad("Amount must be a whole number of sats.");
      if (amount > s.single_limit_sats) throw new Bad(`Single payments are limited to ${s.single_limit_sats.toLocaleString("en-ZA")} sats. Change the limit in payment settings.`);
      const note = String(b.note || "").trim().slice(0, 500);
      if (!note) throw new Bad("Please say what this payment is for.");
      const id = crypto.randomUUID();
      db.prepare("insert into payouts(id, owner_id, period, reason, amount_sats, note, created_by) values (?,?,?,?,?,?,?)")
        .run(id, owner.id, day.slice(0, 7), reason, amount, note, user.id);
      const row = db.prepare("select * from payouts where id = ?").get(id);
      audit(user, "payouts", id, "INSERT", null, row);
      return send(res, 201, pub(row));
    }
    if (p === "/api/payouts/approve" && method === "POST") {
      const b = await readJson(req);
      confirmPassword(user, b.password);
      return send(res, 200, await approve(b.ids, user));
    }
    if (p === "/api/payouts/send-approved" && method === "POST") {   // continue after a server restart
      const b = await readJson(req);
      confirmPassword(user, b.password);
      setImmediate(runSender);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/payouts/recheck" && method === "POST") { await reconcile(); return send(res, 200, { ok: true }); }

    m = p.match(/^\/api\/payouts\/([\w-]{8,64})$/);
    if (m && method === "PATCH") {
      const b = await readJson(req), s = settings();
      const out = tx(() => {
        const before = db.prepare("select * from payouts where id = ?").get(m[1]);
        if (!before) throw new Bad("Not found", 404);
        if (before.status !== "pending") throw new Bad("Only payments waiting for approval can be changed.");
        const upd = {};
        if ((b.weeks_earned !== undefined || b.weeks_from_app) && before.reason === "weekly_learning") {
          const w = b.weeks_from_app ? 0 : Number(b.weeks_earned);
          if (!Number.isInteger(w) || w < 0 || w > s.max_weeks) throw new Bad(`Weeks must be 0 to ${s.max_weeks}.`);
          upd.weeks_earned = w; upd.amount_sats = w * s.sats_per_week;
          if (b.weeks_from_app) { upd.weeks_earned = Math.min(weeksEarned(before.owner_id, before.period), s.max_weeks); upd.amount_sats = upd.weeks_earned * s.sats_per_week; upd.weeks_by_admin = 0; }
          else upd.weeks_by_admin = 1;
        }
        if (b.amount_sats !== undefined && before.reason !== "weekly_learning") {
          const a = Number(b.amount_sats);
          if (!Number.isInteger(a) || a < 1 || a > s.single_limit_sats) throw new Bad("Amount is not allowed.");
          upd.amount_sats = a;
        }
        if (b.note !== undefined) upd.note = String(b.note || "").trim().slice(0, 500) || null;
        if (Object.keys(upd).length)
          db.prepare(`update payouts set ${Object.keys(upd).map(k => k + " = ?").join(", ")}, updated_at = ? where id = ?`).run(...Object.values(upd), now(), m[1]);
        const after = db.prepare("select * from payouts where id = ?").get(m[1]);
        audit(user, "payouts", m[1], "UPDATE", before, after);
        return after;
      });
      return send(res, 200, pub(out));
    }
    m = p.match(/^\/api\/payouts\/([\w-]{8,64})\/(cancel|retry)$/);
    if (m && method === "POST") {
      const [, id, act] = m;
      const out = tx(() => {
        const before = db.prepare("select * from payouts where id = ?").get(id);
        if (!before) throw new Bad("Not found", 404);
        if (act === "cancel" && !["pending", "failed"].includes(before.status)) throw new Bad("Only payments waiting for approval or failed ones can be cancelled.");
        if (act === "retry" && before.status !== "failed") throw new Bad("Only failed payments can be retried.");
        db.prepare(`update payouts set status = ?, approved_by = null, approved_by_name = null, approved_at = null, updated_at = ? where id = ?`)
          .run(act === "cancel" ? "cancelled" : "pending", now(), id);
        audit(user, "payouts", id, act.toUpperCase(), { status: before.status }, { status: act === "cancel" ? "cancelled" : "pending" });
        return db.prepare("select * from payouts where id = ?").get(id);
      });
      return send(res, 200, pub(out));
    }

    m = p.match(/^\/api\/owners\/([\w-]{8,64})\/check-address$/);
    if (m && method === "POST") {
      const o = db.prepare("select * from owners where id = ?").get(m[1]);
      if (!o) throw new Bad("Not found", 404);
      return send(res, 200, await checkOwnerAddress(o));
    }
    if (p === "/api/payments/check-addresses" && method === "POST") {
      const owners = db.prepare("select * from owners where active = 1 and lightning_address is not null").all();
      const out = [];
      for (let i = 0; i < owners.length; i += 4) out.push(...await Promise.all(owners.slice(i, i + 4).map(checkOwnerAddress)));
      return send(res, 200, out);
    }
    if (p === "/api/address-checks" && method === "GET") return send(res, 200, db.prepare("select * from address_checks").all());
    m = p.match(/^\/api\/owners\/([\w-]{8,64})\/payouts$/);
    if (m && method === "GET") return send(res, 200, db.prepare(LIST_SQL + " where p.owner_id = ? order by p.created_at desc").all(m[1]).map(pub));

    if (p === "/api/reports/payouts.csv" && method === "GET") {
      audit(user, "reports", null, "DOWNLOAD", null, { report: "payouts", query: url.search });
      return csvOut(`painted-shacks-payouts-${day}.csv`, payoutsCsv(url.searchParams));
    }
    if (p === "/api/reports/funding.csv" && method === "GET") {
      audit(user, "reports", null, "DOWNLOAD", null, { report: "funding" });
      return csvOut(`painted-shacks-funding-${day}.csv`, fundingCsv());
    }
    return undefined;
  }

  function startTimers() {
    setTimeout(() => { reconcile().catch(() => {}); autoDraft(); }, 5000);
    setInterval(autoDraft, 60 * 60e3).unref();
    setInterval(() => reconcile().catch(e => console.error("payout check", e)), 10 * 60e3).unref();
  }

  return { routes, startTimers, draftBatch, syncWeeks, weeksEarned, settings, payDay, draftDay, approve, runSender, reconcile, autoDraft, summary, isSending: () => sending };
}

module.exports = { init, lastFriday, addDays, monthName };
