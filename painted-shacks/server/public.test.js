// Tests for the public dashboard data: nothing private gets out, and the numbers add up.
// Run:  node --test --disable-warning=ExperimentalWarning public.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

let app, server, appUrl;
const q = sql => app.db.prepare(sql);
const saToday = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-public-"));
  Object.assign(process.env, { DB_PATH: path.join(dir, "t.db"), COOKIE_SECURE: "0", PUBLIC_CACHE_SECONDS: "0" });
  app = require("./server");
  server = http.createServer(async (req, res) => {
    try { await app.handle(req, res); }
    catch (e) { res.writeHead(e.status || 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("empty database: the dashboard still answers, with zeros", async () => {
  const r = await fetch(appUrl + "/api/public/dashboard");
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.tiles.shacks_painted.of, 0);
  assert.equal(d.feed.length, 0);
  assert.equal(d.months.length, 1, "only the coming payday");
  assert.equal(d.months[0].upcoming, true);
  assert.equal(d.days.length, 7);
});

test("no names, phones, notes, private addresses or hidden payments; public numbers add up", async () => {
  const today = saToday();
  q("insert into sponsors(id, name, website) values ('spn1','Fedi','https://www.fedi.xyz/'), ('spn2','Secret Sponsor','javascript:alert(1)')").run();
  q("insert into owners(id, full_name, phone, lightning_address, show_address_publicly, notes) values ('o1','Thandi Private','0721112222','thandi@blink.sv',1,'owner note xyz')").run();
  q("insert into owners(id, full_name, phone, lightning_address, show_address_publicly) values ('o2','Sipho Hidden','0823334444','sipho@private.example',0)").run();
  q("insert into owners(id, full_name, active, lightning_address, show_address_publicly) values ('o3','Gone Owner',0,'gone@blink.sv',1)").run();
  q("insert into shacks(id, shack_no, owner_id, sponsor_id, area, notes, first_painted_on) values ('s1',7,'o1','spn1','Section A','shack note abc','2026-01-10')").run();
  q("insert into shacks(id, shack_no, owner_id, sponsor_id, area) values ('s2',8,'o2','spn2','Section B')").run();
  q("insert into shacks(id, shack_no, owner_id, sponsor_id, area) values ('s3',9,'o1','spn1','Section A')").run();
  q("insert into shacks(id, shack_no, owner_id, status) values ('s4',10,'o3','removed')").run();
  q("insert into shacks(id, shack_no, owner_id) values ('s5',11,'o3')").run();
  q("insert into inspections(id, shack_id, inspected_on, paint, logo, result, notes) values ('i1','s1',?, 'good','yes','good','inspection note qqq')").run(today);
  q("insert into inspections(id, shack_id, inspected_on, paint, logo, result) values ('i2','s2',?, 'fading','partly','touch_up')").run(today);
  q("insert into sponsor_payments(id, sponsor_id, received_on, amount_sats, amount_zar, renews_on) values ('p1','spn1','2026-11-17',3095490,34145.1,'2027-11-17')").run();
  q("insert into sponsor_payments(id, sponsor_id, received_on, amount_sats, show_publicly) values ('p2','spn2','2026-11-01',999999,0)").run();
  const period = app.learn.payPeriodFor(today);
  const at = new Date().toISOString();
  q("insert into lesson_completions(owner_id, week_no, completed_on, completed_at, pay_period) values ('o1',1,?,?,?), ('o1',2,?,?,?), ('o2',1,?,?,?)")
    .run(today, at, period, today, at, period, today, at, period);
  q("insert into quiz_attempts(id, owner_id, week_no, question_ids, total, submitted_at, passed, score) values ('a1','o1',1,'[]',4,?,1,4), ('a2','o2',1,'[]',4,?,0,1), ('a3','o2',1,'[]',4,?,1,3)")
    .run("2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z");
  q("insert into payout_batches(id, period, title, pay_date) values ('b1','2026-10','October 2026','2026-10-30')").run();
  q("insert into payouts(id, batch_id, owner_id, period, amount_sats, status, paid_at, payment_hash, failure_reason) values ('x1','b1','o1','2026-10',28000,'paid','2026-10-30T08:00:00Z','hash-secret-1',null)").run();
  q("insert into payouts(id, batch_id, owner_id, period, amount_sats, status, paid_at) values ('x2','b1','o2','2026-10',21000,'paid','2026-11-02T08:00:00Z')").run();

  const r = await fetch(appUrl + "/api/public/dashboard");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const text = await r.text(), d = JSON.parse(text);
  for (const secret of ["Thandi", "Sipho", "Gone Owner", "0721112222", "0823334444", "sipho@private.example", "gone@blink.sv", "owner note", "shack note",
                        "inspection note", "999999", "hash-secret", "javascript:", "pin", "o1", "o2", "s1\""])
    assert.ok(!text.includes(secret), `public data must not contain ${secret}`);
  assert.deepEqual(d.tips.list, [{ shack_no: 7, address: "thandi@blink.sv", logo: "Fedi" }]);
  assert.equal(d.tips.owners, 2, "owners with a shack that are active");
  assert.equal(d.tiles.shacks_painted.of, 4, "removed shacks are left out");
  assert.deepEqual(d.tiles.good_condition, { value: 1, of: 2 });
  assert.deepEqual(d.tiles.paid_on_time, { value: 1, of: 2, pct: 50 });
  assert.equal(d.round.lessons, 3); assert.equal(d.round.owners, 2); assert.equal(d.round.sats, 21000);
  assert.equal(d.highlights.first_try_pct, 50);
  assert.equal(d.funding.rows.length, 1); assert.equal(d.funding.total_sats, 3095490);
  assert.equal(d.paid_total_sats, 49000);
  assert.ok(d.months.some(m => m.period === "2026-10" && m.sats === 49000 && !m.upcoming));
  const a = d.sections.find(s => s.name === "Section A");
  assert.equal(a.shacks, 2); assert.equal(a.lessons, 2);
  const lesson = d.feed.find(e => e.kind === "lesson" && e.shack.shack_no === 8);
  assert.equal(lesson.shack.address, null); assert.equal(lesson.shack.address_state, "private");
  assert.ok(d.sponsors.find(s => s.name === "Fedi").walls === 2);
  assert.equal(d.sponsors.find(s => s.name === "Secret Sponsor").website, null, "only web links");
});

test("read only", async () => {
  const r = await fetch(appUrl + "/api/public/dashboard", { method: "POST", headers: { "X-PS-Admin": "1" } });
  assert.equal(r.status, 405);
  assert.equal((await fetch(appUrl + "/api/public/other")).status, 401, "other public paths are not open");
});

test("map settings: admins set sections and places; shacks are grouped by section, ignoring capitals", async () => {
  q("insert into staff(id, email, full_name, role, pw_hash) values ('adm1','a@x.co','Luthando','admin',?)").run(app.hashPassword("admin-password-1"));
  const login = await fetch(appUrl + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-PS-Admin": "1" }, body: JSON.stringify({ email: "a@x.co", password: "admin-password-1" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = (method, p, body) => fetch(appUrl + p, { method, headers: { "Content-Type": "application/json", "X-PS-Admin": "1", Cookie: cookie }, body: body && JSON.stringify(body) });
  const def = await (await call("GET", "/api/dashboard-map")).json();
  assert.equal(def.place_name, "JCC Camp, Mossel Bay");
  assert.deepEqual(def.sections.map(s => s.name), ["Zinyoka", "Asazani"]);
  assert.equal((await call("PUT", "/api/dashboard-map", { place_name: "JCC Camp", sections: [{ name: "Zinyoka", lat: -34.17 }] })).status, 400, "both numbers or none");
  assert.equal((await call("PUT", "/api/dashboard-map", { place_name: "JCC Camp", sections: [{ name: "A" }, { name: "a" }] })).status, 400, "no doubles");
  const saved = await call("PUT", "/api/dashboard-map", { place_name: "JCC Camp, Mossel Bay",
    sections: [{ name: "Zinyoka", lat: -34.1712345678, lng: 22.1034, radius_m: 120 }, { name: "Asazani", lat: null, lng: null, radius_m: 90 }] });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).sections[0].lat, -34.171235);
  const r = await call("POST", "/api/shacks/areas", { areas: { s1: "zinyoka", s2: " Zinyoka ", s3: "Asazani", s5: "" } });
  assert.deepEqual(await r.json(), { changed: 3 }, "s5 had no section already");
  assert.equal((await fetch(appUrl + "/api/shacks/areas", { method: "POST", headers: { "Content-Type": "application/json", "X-PS-Admin": "1" }, body: "{}" })).status, 401);
  app.publicData.clear();
  const d = await (await fetch(appUrl + "/api/public/dashboard")).json();
  assert.equal(d.place, "JCC Camp, Mossel Bay");
  const z = d.sections.find(s => s.name === "Zinyoka");
  assert.equal(z.shacks, 2); assert.equal(z.lat, -34.171235); assert.equal(z.radius_m, 120);
  assert.equal(d.sections.find(s => s.name === "Asazani").shacks, 1);
  assert.equal(d.sections.at(-1).name, null, "shacks without a section come last");
});

test("accountability: walls by sponsor status, partners, money in and out, no private text", async () => {
  q("update sponsors set payment_status = 'paying', kind = 'for_profit', support_in_kind = 'Akhona private note' where id = 'spn1'").run();
  q("update sponsors set payment_status = 'lapsed' where id = 'spn2'").run();
  q("update shacks set x_post_url = 'https://x.com/BitcoinEkasi/status/1' where id = 's1'").run();
  app.publicData.clear();
  const text = await (await fetch(appUrl + "/api/public/dashboard")).text();
  assert.ok(!text.includes("Akhona"), "in-kind notes stay private");
  const a = JSON.parse(text).accountability;
  const w = Object.fromEntries(a.walls.map(x => [x.key, x.count]));
  assert.deepEqual(w, { paid: 2, in_kind: 0, ekasi: 0, renewal: 1, thanks: 0, open: 1 });
  assert.equal(a.partners.length, 1);
  assert.deepEqual(a.partners[0].shacks, [7, 9]);
  assert.deepEqual(a.partners[0].posts, ["https://x.com/BitcoinEkasi/status/1"]);
  assert.equal(a.money.received_sats, 3095490, "only public payments this year");
  const year = new Date().toISOString().slice(0, 4);
  assert.equal(a.money.paid_to_families_sats, year === "2026" ? 49000 : 0);
  assert.ok(a.money.ledger.every(r => !/Thandi|Sipho/.test(r.what)), "payouts are one line per month");
});

test("public report: admins type costs, agreements, wall statuses and video posts; empty means draft", async () => {
  const login = await fetch(appUrl + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-PS-Admin": "1" }, body: JSON.stringify({ email: "a@x.co", password: "admin-password-1" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = (method, p, body) => fetch(appUrl + p, { method, headers: { "Content-Type": "application/json", "X-PS-Admin": "1", Cookie: cookie }, body: body && JSON.stringify(body) });
  const pub = async () => (await (await fetch(appUrl + "/api/public/dashboard")).json()).accountability.report;

  let R = await pub();
  assert.equal(R.agreements_signed, null, "nothing typed yet: the page keeps the draft");
  assert.equal(R.carried_over_sats, null);
  assert.equal(R.has_entries, false);
  assert.equal(R.questions.length, 7, "the draft's questions to start with");
  assert.equal(R.show_draft_note, true);

  assert.equal((await call("PUT", "/api/report-settings", { agreements_signed: -1 })).status, 400);
  assert.equal((await call("PUT", "/api/report-settings", { agreement_url: "javascript:alert(1)" })).status, 400);
  assert.equal((await fetch(appUrl + "/api/report-settings", { method: "PUT", headers: { "Content-Type": "application/json", "X-PS-Admin": "1" }, body: "{}" })).status, 401);
  const ok = await call("PUT", "/api/report-settings", { agreements_signed: "38", agreement_url: "https://example.org/agreement.pdf", carried_over_sats: 1200000,
    pending_walls: 0, review_walls: 1, review_note: "Talking to the owner", questions: ["One", " ", "Two"], show_draft_note: false });
  assert.equal(ok.status, 200);
  const year = saToday().slice(0, 4);
  assert.equal((await call("POST", "/api/report_entries", { entry_date: year + "-11-14", direction: "out", category: "running", what: "Class venue", amount_sats: 30000, proof_url: "https://x.example/tx" })).status, 201);
  assert.equal((await call("POST", "/api/report_entries", { entry_date: year + "-05-19", direction: "in", category: "donation", what: "Donation", amount_sats: 250000 })).status, 201);
  assert.equal((await call("POST", "/api/report_entries", { entry_date: year + "-05-19", direction: "sideways", what: "x", amount_sats: 1 })).status, 400);
  assert.equal((await call("POST", "/api/report_entries", { entry_date: year + "-05-19", direction: "out", what: "x", amount_sats: 1, proof_url: "ftp://x" })).status, 400);
  assert.equal((await call("POST", "/api/partner_posts", { sponsor_id: "spn1", video_on: year + "-07-15", video_x_url: "https://x.com/BitcoinEkasi/status/2", impressions: 11820, views: 2745 })).status, 201);
  assert.equal((await call("POST", "/api/partner_posts", { sponsor_id: "spn1" })).status, 400, "one video post per sponsor");

  R = await pub();
  assert.equal(R.agreements_signed, 38);
  assert.equal(R.agreement_url, "https://example.org/agreement.pdf");
  assert.equal(R.carried_over_sats, 1200000);
  assert.equal(R.pending_walls, 0); assert.equal(R.review_walls, 1); assert.equal(R.review_note, "Talking to the owner");
  assert.deepEqual(R.questions, ["One", "Two"]);
  assert.equal(R.show_draft_note, false);
  assert.equal(R.entries.length, 2);
  assert.deepEqual(R.entries[0], { date: year + "-11-14", direction: "out", category: "running", what: "Class venue", sats: 30000, proof: "https://x.example/tx" });
  const d = await (await fetch(appUrl + "/api/public/dashboard")).json();
  const p = d.accountability.partners.find(x => x.shacks.includes(7));
  assert.equal(p.video.impressions, 11820);
  assert.equal(p.video.x, "https://x.com/BitcoinEkasi/status/2");
  assert.ok(!JSON.stringify(d).includes("Luthando"), "who changed the settings stays private");
});
