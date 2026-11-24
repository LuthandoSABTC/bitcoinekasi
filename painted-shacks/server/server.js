// Painted Shacks admin API. No npm packages: Node's own http, crypto and sqlite.
// Caddy serves the app files and HTTPS, and passes /api/* to this process on 127.0.0.1.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const { open } = require("./db");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || "/var/lib/painted-shacks/painted-shacks.db";
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "0";
const SESSION_DAYS = 14;
const COOKIE = COOKIE_SECURE ? "__Host-ps_session" : "ps_session";

const db = open(DB_PATH);

/* ------------------------------------------------------------------ passwords */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
function checkPassword(pw, stored) {
  const [alg, s, k] = String(stored || "").split("$");
  if (alg !== "scrypt" || !s || !k) { crypto.scryptSync(pw, "x", 64); return false; }
  const key = crypto.scryptSync(pw, Buffer.from(s, "base64"), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(k, "base64");
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const sha256 = t => crypto.createHash("sha256").update(t).digest("hex");

/* ------------------------------------------------------------------ tables the app may edit
   Only these columns can be written. Everything else is ignored. */
const T = {
  sponsors: {
    cols: { name: "text!", website: "url", kind: "text", logo_url: "url", support_in_kind: "text", payment_status: "text",
            should_request_sats: "bool", last_contact: "text", notes: "text" } },
  sponsor_contacts: {
    cols: { sponsor_id: "id!", name: "text!", email: "email", chat: "text", notes: "text" } },
  sponsor_payments: {
    cols: { sponsor_id: "id!", received_on: "date!", amount_sats: "int!", amount_zar: "num", purpose: "text", renews_on: "date",
            show_publicly: "bool", notes: "text" } },
  owners: {
    cols: { full_name: "text", phone: "text", age: "int", occupation: "text", lightning_address: "lnaddr", show_address_publicly: "bool",
            preferred_language: "text", active: "bool", joined_on: "date", notes: "text" } },
  shacks: {
    cols: { shack_no: "int!", owner_id: "id", sponsor_id: "id", status: "text", needs_maintenance: "bool", first_painted_on: "date",
            photo_url: "url", x_post_url: "url", area: "text", latitude: "num", longitude: "num", notes: "text" } },
};
const BOOL_COLS = new Set(Object.values(T).flatMap(t => Object.entries(t.cols).filter(([, v]) => v === "bool").map(([k]) => k)));

class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function clean(table, body, isNew) {
  const spec = T[table].cols, out = {};
  for (const [col, type] of Object.entries(spec)) {
    const required = type.endsWith("!"), kind = type.replace("!", "");
    if (!(col in body)) { if (required && isNew) throw new Bad(`${col} is required`); continue; }
    let v = body[col];
    if (typeof v === "string") v = v.trim();
    if (v === "" || v === undefined) v = null;
    if (v === null) { if (required) throw new Bad(`${col} is required`); out[col] = null; continue; }
    switch (kind) {
      case "text": case "id": if (typeof v !== "string" || v.length > 4000) throw new Bad(`${col} is not valid`); break;
      case "url": if (typeof v !== "string" || !/^https?:\/\/\S+$/i.test(v) || v.length > 2000) throw new Bad(`${col} must be a web link starting with https://`); break;
      case "email": if (typeof v !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Bad("That email address doesn't look right."); break;
      case "lnaddr": v = String(v).toLowerCase(); if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) throw new Bad("That Lightning address doesn't look right. It should look like name@blink.sv"); break;
      case "date": if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Bad(`${col} must be a date`); break;
      case "int": v = Number(v); if (!Number.isInteger(v)) throw new Bad(`${col} must be a whole number`); break;
      case "num": v = Number(v); if (!Number.isFinite(v)) throw new Bad(`${col} must be a number`); break;
      case "bool": v = v === true || v === 1 || v === "1" || v === "true" ? 1 : 0; break;
    }
    out[col] = v;
  }
  return out;
}
const toJson = row => { if (!row) return row; const r = { ...row }; for (const k of Object.keys(r)) if (BOOL_COLS.has(k)) r[k] = !!r[k]; return r; };

function audit(user, table, id, action, before, after) {
  db.prepare("insert into audit_log(staff_id, staff_email, table_name, row_id, action, before, after) values (?,?,?,?,?,?,?)")
    .run(user?.id ?? null, user?.email ?? null, table, id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
function tx(fn) { db.exec("begin immediate"); try { const r = fn(); db.exec("commit"); return r; } catch (e) { db.exec("rollback"); throw e; } }

function friendly(e) {
  const m = String(e.message || e);
  if (/UNIQUE.*shacks\.shack_no/.test(m)) return "That shack number is already used.";
  if (/UNIQUE.*sponsors\.name/.test(m)) return "A sponsor with that name already exists.";
  if (/owners_lnaddr_uq|UNIQUE.*lightning_address/i.test(m)) return "Another owner already has that Lightning address.";
  if (/FOREIGN KEY/.test(m)) return "This is still linked to other records (for example payments). Remove those first.";
  if (/CHECK constraint/.test(m)) return "One of the values is not allowed.";
  return null;
}

/* ------------------------------------------------------------------ sessions + login limits */
function readCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function currentUser(req) {
  const tok = readCookie(req, COOKIE);
  if (!tok) return null;
  const row = db.prepare(`select s.id, s.email, s.full_name, s.role from sessions x join staff s on s.id = x.staff_id
                          where x.token_hash = ? and x.expires_at > ? and s.disabled = 0`).get(sha256(tok), Date.now());
  return row || null;
}
function setSessionCookie(res, token, maxAge) {
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${COOKIE_SECURE ? "; Secure" : ""}`);
}
const attempts = new Map(); // ip -> [timestamps]
function tooMany(ip) {
  const now = Date.now(), list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(ip, list);
  return list.length >= 10;
}
function clientIp(req) {
  const peer = req.socket.remoteAddress || "";
  if ((peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1") && req.headers["x-forwarded-for"])
    return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return peer;
}

/* ------------------------------------------------------------------ http helpers */
function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/.test(req.headers["content-type"] || "")) return reject(new Bad("Expected JSON", 415));
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 2e6) { reject(new Bad("Too large", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Bad("Bad JSON")); } });
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------ routes */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  // Cross-site request protection: every change must carry our header (browsers can't add it cross-site without CORS).
  if (method !== "GET" && req.headers["x-ps-admin"] !== "1") throw new Bad("Missing app header", 403);

  if (p === "/api/health") return send(res, 200, { ok: true });

  if (p === "/api/login" && method === "POST") {
    const ip = clientIp(req);
    if (tooMany(ip)) throw new Bad("Too many tries. Wait 15 minutes and try again.", 429);
    const { email, password } = await readJson(req);
    const u = db.prepare("select * from staff where email = ? and disabled = 0").get(String(email || "").trim());
    if (!checkPassword(String(password || ""), u?.pw_hash)) { attempts.get(ip).push(Date.now()); throw new Bad("Wrong email or password.", 401); }
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("insert into sessions(token_hash, staff_id, expires_at) values (?,?,?)").run(sha256(token), u.id, Date.now() + SESSION_DAYS * 864e5);
    db.prepare("delete from sessions where expires_at < ?").run(Date.now());
    setSessionCookie(res, token, SESSION_DAYS * 86400);
    audit(u, "staff", u.id, "LOGIN", null, null);
    return send(res, 200, { name: u.full_name, email: u.email, role: u.role });
  }

  const user = currentUser(req);
  if (!user) throw new Bad("Please sign in.", 401);

  if (p === "/api/logout" && method === "POST") {
    db.prepare("delete from sessions where token_hash = ?").run(sha256(readCookie(req, COOKIE) || ""));
    setSessionCookie(res, "", 0);
    return send(res, 200, { ok: true });
  }
  if (p === "/api/me" && method === "GET") return send(res, 200, { name: user.full_name, email: user.email, role: user.role });

  if (p === "/api/password" && method === "POST") {
    const { current, next } = await readJson(req);
    const row = db.prepare("select pw_hash from staff where id = ?").get(user.id);
    if (!checkPassword(String(current || ""), row.pw_hash)) throw new Bad("Your current password is wrong.");
    if (typeof next !== "string" || next.length < 12) throw new Bad("New password must be at least 12 characters.");
    db.prepare("update staff set pw_hash = ? where id = ?").run(hashPassword(next), user.id);
    db.prepare("delete from sessions where staff_id = ? and token_hash <> ?").run(user.id, sha256(readCookie(req, COOKIE)));
    audit(user, "staff", user.id, "PASSWORD", null, null);
    return send(res, 200, { ok: true });
  }

  if (user.role !== "admin") throw new Bad("Admins only.", 403);

  if (p === "/api/data" && method === "GET") {
    const out = {};
    for (const t of Object.keys(T)) out[t] = db.prepare(`select * from ${t}`).all().map(toJson);
    return send(res, 200, out);
  }

  if (p === "/api/backup" && method === "GET") {
    const file = `${require("node:os").tmpdir()}/ps-backup-${crypto.randomUUID()}.db`;
    db.exec(`vacuum into '${file}'`);
    const buf = require("node:fs").readFileSync(file); require("node:fs").unlinkSync(file);
    audit(user, "backup", null, "DOWNLOAD", null, null);
    const day = new Date().toISOString().slice(0, 10);
    return send(res, 200, buf, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="painted-shacks-${day}.db"` });
  }

  if (p === "/api/import" && method === "POST") return send(res, 200, importSeed(await readJson(req), user));

  const m = p.match(/^\/api\/(sponsors|sponsor_contacts|sponsor_payments|owners|shacks)(?:\/([\w-]{1,64}))?$/);
  if (m) {
    const [, table, id] = m;
    if (method === "POST" && !id) {
      const row = clean(table, await readJson(req), true);
      row.id = crypto.randomUUID();
      const cols = Object.keys(row);
      const saved = tx(() => {
        db.prepare(`insert into ${table}(${cols.join(",")}) values (${cols.map(() => "?").join(",")})`).run(...cols.map(c => row[c]));
        const r = db.prepare(`select * from ${table} where id = ?`).get(row.id);
        audit(user, table, row.id, "INSERT", null, r);
        return r;
      });
      return send(res, 201, toJson(saved));
    }
    if (method === "PATCH" && id) {
      const row = clean(table, await readJson(req), false);
      const cols = Object.keys(row);
      const saved = tx(() => {
        const before = db.prepare(`select * from ${table} where id = ?`).get(id);
        if (!before) throw new Bad("Not found", 404);
        if (cols.length) db.prepare(`update ${table} set ${cols.map(c => c + " = ?").join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ?`).run(...cols.map(c => row[c]), id);
        const after = db.prepare(`select * from ${table} where id = ?`).get(id);
        audit(user, table, id, "UPDATE", before, after);
        return after;
      });
      return send(res, 200, toJson(saved));
    }
    if (method === "DELETE" && id) {
      tx(() => {
        const before = db.prepare(`select * from ${table} where id = ?`).get(id);
        if (!before) throw new Bad("Not found", 404);
        db.prepare(`delete from ${table} where id = ?`).run(id);
        audit(user, table, id, "DELETE", before, null);
      });
      return send(res, 200, { ok: true });
    }
  }
  throw new Bad("Not found", 404);
}

/* ------------------------------------------------------------------ one-time import of the sheet data
   Accepts the seed.json made from the Google Sheet. Skips anything that already exists. */
function importSeed(d, user) {
  if (!d || !Array.isArray(d.shacks) || !Array.isArray(d.sponsors)) throw new Bad("This is not a Painted Shacks data file.");
  const n = { sponsors: 0, owners: 0, shacks: 0, contacts: 0, payments: 0 };
  tx(() => {
    const spId = name => db.prepare("select id from sponsors where name = ?").get(name)?.id;
    for (const s of d.sponsors) {
      if (spId(s.name)) continue;
      const r = clean("sponsors", s, true), id = crypto.randomUUID(), cols = Object.keys(r);
      db.prepare(`insert into sponsors(id,${cols}) values (?,${cols.map(() => "?")})`).run(id, ...cols.map(c => r[c])); n.sponsors++;
    }
    for (const c of d.contacts || []) {
      const sid = spId(c.sponsor); if (!sid) continue;
      if (db.prepare("select 1 from sponsor_contacts where sponsor_id = ? and name = ?").get(sid, c.name)) continue;
      const r = clean("sponsor_contacts", { ...c, sponsor_id: sid }, true), cols = Object.keys(r);
      db.prepare(`insert into sponsor_contacts(id,${cols}) values (?,${cols.map(() => "?")})`).run(crypto.randomUUID(), ...cols.map(k => r[k])); n.contacts++;
    }
    for (const p of d.payments || []) {
      const sid = spId(p.sponsor); if (!sid) continue;
      if (db.prepare("select 1 from sponsor_payments where sponsor_id = ? and received_on = ?").get(sid, p.received_on)) continue;
      const r = clean("sponsor_payments", { ...p, sponsor_id: sid }, true), cols = Object.keys(r);
      db.prepare(`insert into sponsor_payments(id,${cols}) values (?,${cols.map(() => "?")})`).run(crypto.randomUUID(), ...cols.map(k => r[k])); n.payments++;
    }
    const ownerIds = {};
    for (const o of d.owners || []) {
      let id = o.lightning_address
        ? db.prepare("select id from owners where lower(lightning_address) = lower(?)").get(o.lightning_address)?.id
        : /^__shack\d+$/.test(o.key || "") && db.prepare("select owner_id from shacks where shack_no = ?").get(Number(o.key.slice(7)))?.owner_id;
      if (!id) {
        const r = clean("owners", o, true), cols = Object.keys(r); id = crypto.randomUUID();
        db.prepare(`insert into owners(id,${cols}) values (?,${cols.map(() => "?")})`).run(id, ...cols.map(k => r[k])); n.owners++;
      }
      ownerIds[o.key] = id;
    }
    for (const s of d.shacks) {
      if (db.prepare("select 1 from shacks where shack_no = ?").get(s.shack_no)) continue;
      const r = clean("shacks", { ...s, owner_id: ownerIds[s.owner_key] || null, sponsor_id: spId(s.sponsor) || null }, true), cols = Object.keys(r);
      db.prepare(`insert into shacks(id,${cols}) values (?,${cols.map(() => "?")})`).run(crypto.randomUUID(), ...cols.map(k => r[k])); n.shacks++;
    }
    audit(user, "import", null, "IMPORT", null, n);
  });
  return n;
}

/* ------------------------------------------------------------------ start */
if (require.main === module) {
  http.createServer(async (req, res) => {
    try { await handle(req, res); }
    catch (e) {
      const f = friendly(e);
      if (!(e instanceof Bad) && !f) console.error(new Date().toISOString(), req.method, req.url, e);
      send(res, e.status || (f ? 409 : 500), { error: f || (e instanceof Bad ? e.message : "Something went wrong on the server.") });
    }
  }).listen(PORT, HOST, () => console.log(`Painted Shacks API on http://${HOST}:${PORT}, database ${DB_PATH}`));
}

module.exports = { db, hashPassword, checkPassword };
