// Partner view (/dashboard/partners/): paid sponsors sign in to follow each family's progress.
//
// Rules this file keeps:
//  * Only sponsors whose payment status is "Paying" can sign in or see anything. This is checked on every request,
//    so a sponsor that lapses loses access straight away.
//  * Families are shown by shack number, section and logo only. Never names, phone numbers, PINs, Lightning addresses,
//    notes, inspection notes or photos.
//  * Accounts are made by an admin (sponsor page in the admin app). The password is shown once.
"use strict";
const crypto = require("node:crypto");

const SESSION_DAYS = 30;

function init({ db, send, Bad, readJson, hashPassword, checkPassword, sha256, readCookie, clientIp, audit, cookieSecure }) {
  const COOKIE = cookieSecure ? "__Host-ps_partner" : "ps_partner";
  const attempts = new Map();
  const tooMany = ip => {
    const now = Date.now(), list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
    attempts.set(ip, list);
    return list.length >= 10;
  };
  const setCookie = (res, token, maxAge) =>
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSecure ? "; Secure" : ""}`);

  function current(req) {
    const tok = readCookie(req, COOKIE);
    if (!tok) return null;
    return db.prepare(`select l.id, l.email, l.sponsor_id, sp.name as sponsor, sp.payment_status from partner_sessions x
        join partner_logins l on l.id = x.login_id join sponsors sp on sp.id = l.sponsor_id
        where x.token_hash = ? and x.expires_at > ? and l.disabled = 0`).get(sha256(tok), Date.now()) || null;
  }
  const isPaid = u => u && u.payment_status === "paying";

  /* -------------------------------------------------------------- what a paid partner sees */
  function progress(u) {
    const ls = db.prepare("select total_weeks, start_date from learn_settings where id = 1").get() || {};
    const shacks = db.prepare(`select s.id, s.shack_no, s.area, s.owner_id, s.sponsor_id, sp.name as logo from shacks s
        left join sponsors sp on sp.id = s.sponsor_id left join owners o on o.id = s.owner_id
        where s.status <> 'removed' and s.owner_id is not null and o.active = 1 order by s.shack_no`).all();
    const today = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10), month = today.slice(0, 7);
    const lessons = new Map();
    for (const c of db.prepare("select owner_id, week_no, completed_on from lesson_completions where passed = 1").all()) {
      const e = lessons.get(c.owner_id) || { weeks: new Set(), last: null, month: 0 };
      e.weeks.add(c.week_no);
      if (!e.last || c.completed_on > e.last) e.last = c.completed_on;
      if (c.completed_on.startsWith(month)) e.month++;
      lessons.set(c.owner_id, e);
    }
    const insp = new Map();
    for (const i of db.prepare("select shack_id, result, inspected_on, created_at from inspections order by inspected_on, created_at").all()) {
      const e = insp.get(i.shack_id) || { total: 0, passed: 0, latest: null, latest_on: null };
      e.total++; if (i.result === "good") e.passed++;
      e.latest = i.result; e.latest_on = i.inspected_on;
      insp.set(i.shack_id, e);
    }
    const seen = new Set();   // an owner with two walls shows once, under their lowest shack number
    const rows = [];
    for (const s of shacks) {
      if (seen.has(s.owner_id)) continue;
      seen.add(s.owner_id);
      const l = lessons.get(s.owner_id) || { weeks: new Set(), last: null, month: 0 };
      const i = insp.get(s.id) || { total: 0, passed: 0, latest: null, latest_on: null };
      rows.push({ shack_no: s.shack_no, section: (s.area || "").trim() || null, logo: s.logo || null, your_wall: s.sponsor_id === u.sponsor_id,
                  lessons_done: l.weeks.size, lessons_this_month: l.month, last_lesson_on: l.last,
                  inspections: i.total, inspections_passed: i.passed, latest_inspection: i.latest, latest_inspection_on: i.latest_on });
    }
    return {
      sponsor: u.sponsor, email: u.email, today, total_weeks: ls.total_weeks || 20, start_date: ls.start_date || null, families: rows,
      totals: { families: rows.length, lessons: rows.reduce((t, r) => t + r.lessons_done, 0), inspections: rows.reduce((t, r) => t + r.inspections, 0),
                passed: rows.reduce((t, r) => t + r.inspections_passed, 0), latest_good: rows.filter(r => r.latest_inspection === "good").length },
    };
  }

  /* -------------------------------------------------------------- /api/partner/* (no staff account needed) */
  async function routes(req, res, p, method) {
    if (p === "/api/partner/login" && method === "POST") {
      const ip = clientIp(req);
      if (tooMany(ip)) throw new Bad("Too many tries. Wait 15 minutes and try again.", 429);
      const { email, password } = await readJson(req);
      const l = db.prepare("select * from partner_logins where email = ? and disabled = 0").get(String(email || "").trim().toLowerCase());
      if (!checkPassword(String(password || ""), l?.pw_hash)) { attempts.get(ip).push(Date.now()); throw new Bad("Wrong email or password.", 401); }
      const sp = db.prepare("select payment_status from sponsors where id = ?").get(l.sponsor_id);
      if (sp?.payment_status !== "paying") throw new Bad("This view is for paid partners. Please contact Bitcoin Ekasi.", 403);
      const token = crypto.randomBytes(32).toString("base64url");
      db.prepare("insert into partner_sessions(token_hash, login_id, expires_at) values (?,?,?)").run(sha256(token), l.id, Date.now() + SESSION_DAYS * 864e5);
      db.prepare("delete from partner_sessions where expires_at < ?").run(Date.now());
      db.prepare("update partner_logins set last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ?").run(l.id);
      setCookie(res, token, SESSION_DAYS * 86400);
      audit({ id: null, email: l.email }, "partner_logins", l.id, "LOGIN", null, null);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/partner/logout" && method === "POST") {
      const tok = readCookie(req, COOKIE);
      if (tok) db.prepare("delete from partner_sessions where token_hash = ?").run(sha256(tok));
      setCookie(res, "", 0);
      return send(res, 200, { ok: true });
    }
    const u = current(req);
    if (!u) throw new Bad("Please sign in.", 401);
    if (!isPaid(u)) throw new Bad("This view is for paid partners. Please contact Bitcoin Ekasi.", 403);
    if (p === "/api/partner/progress" && method === "GET") return send(res, 200, progress(u));
    throw new Bad("Not found", 404);
  }

  /* -------------------------------------------------------------- admin: accounts for a sponsor */
  const newPassword = () => crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x");   // 12 letters and digits
  async function adminRoutes(req, res, p, method, user) {
    if (p === "/api/partner-logins" && method === "GET")
      return send(res, 200, db.prepare("select id, sponsor_id, email, disabled, last_login_at, created_at from partner_logins order by created_at").all()
        .map(r => ({ ...r, disabled: !!r.disabled })));
    if (p === "/api/partner-logins" && method === "POST") {
      const { sponsor_id, email } = await readJson(req);
      const mail = String(email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Bad("That email address doesn't look right.");
      if (!db.prepare("select 1 from sponsors where id = ?").get(sponsor_id)) throw new Bad("Sponsor not found.", 404);
      if (db.prepare("select 1 from partner_logins where email = ?").get(mail)) throw new Bad("That email already has a partner account.");
      const id = crypto.randomUUID(), password = newPassword();
      db.prepare("insert into partner_logins(id, sponsor_id, email, pw_hash) values (?,?,?,?)").run(id, sponsor_id, mail, hashPassword(password));
      audit(user, "partner_logins", id, "INSERT", null, { sponsor_id, email: mail });
      return send(res, 201, { id, sponsor_id, email: mail, disabled: false, password });
    }
    const m = p.match(/^\/api\/partner-logins\/([\w-]{8,64})(\/reset)?$/);
    if (!m) return false;
    const l = db.prepare("select * from partner_logins where id = ?").get(m[1]);
    if (!l) throw new Bad("Not found", 404);
    if (m[2] && method === "POST") {
      const password = newPassword();
      db.prepare("update partner_logins set pw_hash = ? where id = ?").run(hashPassword(password), l.id);
      db.prepare("delete from partner_sessions where login_id = ?").run(l.id);
      audit(user, "partner_logins", l.id, "PASSWORD", null, null);
      return send(res, 200, { password });
    }
    if (!m[2] && method === "DELETE") {
      db.prepare("delete from partner_logins where id = ?").run(l.id);
      audit(user, "partner_logins", l.id, "DELETE", { sponsor_id: l.sponsor_id, email: l.email }, null);
      return send(res, 200, { ok: true });
    }
    return false;
  }

  return { routes, adminRoutes, progress };
}

module.exports = { init };
