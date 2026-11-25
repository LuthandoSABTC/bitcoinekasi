// Tests for the owner learning app, lesson review and how finished weeks reach payouts.
// Run:  node --test --disable-warning=ExperimentalWarning learn.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

let app, server, appUrl;
const jars = { admin: "", insp: "", owner: "", owner2: "" };
async function api(who, method, p, body, headers = {}) {
  const isJson = body !== undefined && !Buffer.isBuffer(body);
  const res = await fetch(appUrl + p, { method, headers: { ...(isJson ? { "Content-Type": "application/json" } : {}), "X-PS-Admin": "1", Cookie: jars[who] || "", ...headers },
    body: isJson ? JSON.stringify(body) : body });
  const sc = res.headers.get("set-cookie"); if (sc && who) jars[who] = sc.split(";")[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const q = sql => app.db.prepare(sql);
let owner1, owner2, lesson1, lesson2;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-learn-"));
  Object.assign(process.env, { DB_PATH: path.join(dir, "t.db"), COOKIE_SECURE: "0" });
  app = require("./server");
  server = http.createServer(async (req, res) => {
    try { await app.handle(req, res); }
    catch (e) { res.writeHead(e.status || 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${server.address().port}`;
  q("insert into staff(id, email, full_name, role, pw_hash) values ('adm00001','a@x.co','Admin','admin',?)").run(app.hashPassword("admin-password-1"));
  q("insert into staff(id, email, full_name, role, pw_hash) values ('ins00001','i@x.co','Insp','inspector',?)").run(app.hashPassword("insp-password-1"));
  q("insert into owners(id, full_name, phone, lightning_address) values ('own00001','Thandi','072 111 2222','thandi@blink.sv')").run();
  q("insert into owners(id, full_name, phone, lightning_address) values ('own00002','Sipho','+27 82 333 4444','sipho@blink.sv')").run();
  q("insert into owners(id, full_name) values ('own00003','No shack no phone')").run();
  q("insert into shacks(id, shack_no, owner_id) values ('shk00001', 7, 'own00001')").run();
  owner1 = "own00001"; owner2 = "own00002";
  q("update learn_settings set start_date = null").run();   // tests run on any date; the start date has its own test
  assert.equal((await api("admin", "POST", "/api/login", { email: "a@x.co", password: "admin-password-1" })).status, 200);
  assert.equal((await api("insp", "POST", "/api/login", { email: "i@x.co", password: "insp-password-1" })).status, 200);
});
test.after(() => server.close());

const QS = n => Array.from({ length: n }, (_, i) => ({ question: `Umbuzo ${i + 1}?`, choices: ["Ewe", "Hayi", "Andazi"], answer: i % 3 }));
const BODY = "# Intshayelelo\n\nLe yindlela yokufunda nge-Bitcoin. Imali yinto esiyisebenzisayo yonke imihla.\n\n---\n\nIphepha lesibini.";

test("owners need a PIN from an admin, and wrong PINs lock the sign-in", async () => {
  assert.equal((await api("owner", "POST", "/api/learn/login", { who: "7", pin: "000000" })).status, 401);
  assert.equal((await api("admin", "POST", "/api/owners/own00003/app-pin", {})).status, 400, "no shack and no phone: nothing to sign in with");
  const r = await api("admin", "POST", `/api/owners/${owner1}/app-pin`, {});
  assert.equal(r.status, 200); assert.match(r.data.pin, /^\d{6}$/); assert.deepEqual(r.data.shacks, [7]);
  assert.ok(!JSON.stringify(q("select * from owner_logins").all()).includes(r.data.pin), "PIN is stored hashed");
  const wrong = r.data.pin === "111111" ? "222222" : "111111";
  for (let i = 0; i < 5; i++) assert.equal((await api("owner", "POST", "/api/learn/login", { who: "7", pin: wrong })).status, 401);
  assert.equal((await api("owner", "POST", "/api/learn/login", { who: "7", pin: r.data.pin })).status, 429, "locked after 5 wrong PINs");
  const r2 = await api("admin", "POST", `/api/owners/${owner1}/app-pin`, {});     // admin gives a new PIN, which also unlocks
  assert.equal((await api("owner", "POST", "/api/learn/login", { who: "7", pin: r2.data.pin })).status, 200);
  assert.equal((await api("owner", "GET", "/api/learn/me")).data.name, "Thandi");
  // Owner 2 has no shack: signs in with the phone number in any format.
  const r3 = await api("admin", "POST", `/api/owners/${owner2}/app-pin`, {});
  assert.equal((await api("owner2", "POST", "/api/learn/login", { who: "082 333 4444", pin: r3.data.pin })).status, 200);
});

test("an owner session can't reach staff or admin routes", async () => {
  assert.equal((await api("owner", "GET", "/api/data")).status, 401);
  assert.equal((await api("owner", "GET", "/api/learn-admin/progress")).status, 401);
  assert.equal((await api("owner", "GET", "/api/payments/overview")).status, 401);
  assert.equal((await api("insp", "GET", "/api/learn-admin/progress")).status, 403, "inspectors can't see owner progress");
  assert.equal((await api("insp", "GET", "/api/learn/me")).status, 401, "a staff session is not an owner session");
  assert.equal((await api("owner", "POST", "/api/learn/logout", {}, { "X-PS-Admin": "" })).status, 403, "changes need the app header");
});

test("lessons are drafts until an admin publishes a complete one", async () => {
  let r = await api("admin", "POST", "/api/lessons", { week_no: 1, title: "Kutheni sifuna imali?" });
  assert.equal(r.status, 201); lesson1 = r.data.id;
  assert.equal((await api("admin", "POST", "/api/lessons", { week_no: 1, title: "dup" })).status, 409);
  let me = (await api("owner", "GET", "/api/learn/me")).data;
  assert.equal(me.weeks[0].state, "soon"); assert.equal(me.weeks[0].title, null, "draft titles are hidden from owners");
  assert.equal((await api("owner", "GET", "/api/learn/lessons/1")).status, 403);
  r = await api("admin", "POST", `/api/lessons/${lesson1}/publish`, {});
  assert.equal(r.status, 400); assert.match(r.data.error, /at least 4 questions/);
  r = await api("admin", "PATCH", `/api/lessons/${lesson1}`, { body: BODY, questions: QS(6) });
  assert.equal(r.status, 200); assert.equal(r.data.questions.length, 6);
  assert.equal((await api("admin", "PATCH", `/api/lessons/${lesson1}`, { questions: [{ question: "x", choices: ["a"], answer: 0 }] })).status, 400);
  r = await api("admin", "POST", `/api/lessons/${lesson1}/publish`, {});
  assert.equal(r.status, 200); assert.equal(r.data.status, "published"); assert.equal(r.data.published_by_name, "Admin");
  assert.equal((await api("admin", "PATCH", `/api/lessons/${lesson1}`, { questions: QS(2) })).status, 400, "a live lesson can't lose its quiz");
  me = (await api("owner", "GET", "/api/learn/me")).data;
  assert.equal(me.weeks[0].state, "ready"); assert.equal(me.weeks[1].state, "locked");
});

test("lesson pictures: JPEG only, admins upload, owners see only published ones", async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
  assert.equal((await api("admin", "PUT", `/api/lessons/${lesson1}/pictures/pic000001`, Buffer.from("not a picture at all".repeat(50)), { "Content-Type": "image/jpeg" })).status, 415);
  assert.equal((await api("admin", "PUT", `/api/lessons/${lesson1}/pictures/pic000001`, jpeg, { "Content-Type": "image/jpeg" })).status, 201);
  assert.equal((await api("owner", "GET", "/api/learn/pictures/pic000001")).status, 200);
  assert.equal((await api("", "GET", "/api/learn/pictures/pic000001")).status, 401, "not signed in");
  await api("admin", "PATCH", `/api/lessons/${lesson1}`, { body: BODY + "\n\n[[picture:pic000001]]" });
  assert.equal((await api("admin", "DELETE", "/api/lesson-pictures/pic000001")).status, 400, "still used by a live lesson");
});

test("quiz: must read first, the server marks it, a pass records the week once", async () => {
  assert.equal((await api("owner", "POST", "/api/learn/lessons/1/quiz", {})).status, 403, "read first");
  const l = await api("owner", "GET", "/api/learn/lessons/1");
  assert.equal(l.status, 200); assert.equal(l.data.questions, 4); assert.equal(l.data.pass_correct, 3);
  assert.ok(!JSON.stringify(l.data).includes('"answer"'));
  assert.equal((await api("owner", "POST", "/api/learn/lessons/1/read", {})).status, 200);

  // Wrong answers: not passed, no right answers given away, nothing recorded.
  let s = await api("owner", "POST", "/api/learn/lessons/1/quiz", {});
  assert.equal(s.status, 200); assert.equal(s.data.questions.length, 4);
  assert.ok(s.data.questions.every(x => !("answer" in x)), "the phone never gets the answers");
  // Where the right answer is on the phone (answers are shuffled per try).
  const keyOf = x => { const r = q("select answer, choices from quiz_questions where id = ?").get(x.id); return x.choices.indexOf(JSON.parse(r.choices)[r.answer]); };
  let r = await api("owner", "POST", `/api/learn/quiz/${s.data.attempt_id}`, { answers: s.data.questions.map(x => (keyOf(x) + 1) % 3) });
  assert.equal(r.data.passed, false); assert.equal(r.data.score, 0); assert.ok(r.data.results.every(x => !("answer" in x)));
  assert.equal((await api("owner", "POST", `/api/learn/quiz/${s.data.attempt_id}`, { answers: [0, 0, 0, 0] })).status, 409, "can't resend an attempt");
  assert.equal(q("select count(*) n from lesson_completions").get().n, 0);

  // Owner 2 can't send answers for owner 1's quiz.
  s = await api("owner", "POST", "/api/learn/lessons/1/quiz", {});
  assert.equal((await api("owner2", "POST", `/api/learn/quiz/${s.data.attempt_id}`, { answers: [0, 0, 0, 0] })).status, 404);

  // 3 of 4 right is a pass.
  const ans = s.data.questions.map(keyOf); ans[0] = (ans[0] + 1) % 3;
  r = await api("owner", "POST", `/api/learn/quiz/${s.data.attempt_id}`, { answers: ans });
  assert.equal(r.data.passed, true); assert.equal(r.data.score, 3); assert.equal(r.data.newly_done, true);
  assert.ok(r.data.results.every(x => "answer" in x), "right answers shown after passing");
  assert.deepEqual(r.data.results.map(x => x.answer), s.data.questions.map(keyOf), "right answers given in the order the phone showed");
  const c = q("select * from lesson_completions where owner_id = ?").get(owner1);
  assert.equal(c.week_no, 1); assert.equal(c.pay_period, app.learn.payPeriodFor(c.completed_on));
  assert.equal((await api("owner", "POST", "/api/learn/lessons/1/quiz", {})).status, 403, "week already done");
  const me = (await api("owner", "GET", "/api/learn/me")).data;
  assert.equal(me.done_count, 1); assert.equal(me.weeks[0].state, "done");
  assert.equal(me.this_month.weeks, c.pay_period === me.this_month.period ? 1 : 0);
});

test("one new lesson a week", async () => {
  lesson2 = (await api("admin", "POST", "/api/lessons", { week_no: 2, title: "Yintoni imali?" })).data.id;
  await api("admin", "PATCH", `/api/lessons/${lesson2}`, { body: BODY, questions: QS(4) });
  await api("admin", "POST", `/api/lessons/${lesson2}/publish`, {});
  let w2 = (await api("owner", "GET", "/api/learn/me")).data.weeks[1];
  assert.equal(w2.state, "wait"); assert.ok(w2.opens_on > q("select completed_on d from lesson_completions").get().d);
  assert.equal((await api("owner", "GET", "/api/learn/lessons/2")).status, 403);
  // Pretend week 1 was finished last week: week 2 opens.
  const lastWeek = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  q("update lesson_completions set completed_on = ? where owner_id = ?").run(lastWeek, owner1);
  w2 = (await api("owner", "GET", "/api/learn/me")).data.weeks[1];
  assert.equal(w2.state, "ready");
  assert.equal((await api("owner", "GET", "/api/learn/lessons/2")).status, 200);
});

test("finishing on or after the payout draft day counts for next month", () => {
  const { lastFriday, addDays } = require("./payments");
  const draftDay = addDays(lastFriday("2026-11"), -2);           // 25 Nov 2026
  assert.equal(app.learn.payPeriodFor(addDays(draftDay, -1)), "2026-11");
  assert.equal(app.learn.payPeriodFor(draftDay), "2026-12");
  assert.equal(app.learn.payPeriodFor("2026-12-31"), "2027-01");
  assert.equal(require("./learn").weekStart("2026-11-25"), "2026-11-23");   // a Wednesday -> Monday
});

test("payout batch takes weeks from the app; an admin change sticks until reset", async () => {
  const period = "2027-03";
  q("delete from lesson_completions").run();
  const add = (o, w) => q("insert into lesson_completions(owner_id, week_no, completed_on, completed_at, pay_period, score, total) values (?,?,?,?,?,3,4)")
    .run(o, w, "2027-03-0" + w, "2027-03-0" + w + "T10:00:00Z", period);
  add(owner1, 1); add(owner1, 2); add(owner1, 3); add(owner2, 1);
  let r = await api("admin", "POST", "/api/payout-batches", { period });
  assert.equal(r.status, 200);
  const line = o => q("select * from payouts where owner_id = ? and period = ?").get(o, period);
  assert.equal(line(owner1).weeks_earned, 3); assert.equal(line(owner1).amount_sats, 21000);
  assert.equal(line(owner2).weeks_earned, 1); assert.equal(line(owner2).amount_sats, 7000);
  assert.equal(line("own00003").weeks_earned, 0);
  // More weeks finished before approval: redraft brings them in.
  add(owner1, 4); add(owner1, 5);
  r = await api("admin", "POST", "/api/payout-batches", { period });
  assert.equal(r.data.updated, 1);
  assert.equal(line(owner1).weeks_earned, 4, "capped at 4 weeks a month"); assert.equal(line(owner1).amount_sats, 28000);
  // Admin sets weeks by hand: the app no longer changes that line...
  await api("admin", "PATCH", `/api/payouts/${line(owner2).id}`, { weeks_earned: 2 });
  add(owner2, 2); add(owner2, 3);
  await api("admin", "POST", "/api/payout-batches", { period });
  assert.equal(line(owner2).weeks_earned, 2);
  // ...until they press "use the app's count" again.
  await api("admin", "PATCH", `/api/payouts/${line(owner2).id}`, { weeks_from_app: true });
  assert.equal(line(owner2).weeks_earned, 3); assert.equal(line(owner2).weeks_by_admin, 0);
  const b = await api("admin", "GET", `/api/payout-batches/${line(owner2).batch_id}`);
  assert.equal(b.data.lines.find(l => l.owner_id === owner1).app_weeks, 5);
});

test("admin progress view shows each owner's weeks, current lesson and last activity", async () => {
  const r = await api("admin", "GET", "/api/learn-admin/progress");
  assert.equal(r.status, 200);
  assert.equal(r.data.published, 2); assert.equal(r.data.total_weeks, 20);
  const t = r.data.owners.find(o => o.owner_id === owner1);
  assert.equal(t.has_login, true); assert.ok(t.last_activity); assert.deepEqual(t.shacks, [7]);
  const n = r.data.owners.find(o => o.owner_id === "own00003");
  assert.equal(n.has_login, false); assert.equal(n.weeks_done, 0); assert.equal(n.current.week_no, 1);
  const one = await api("admin", "GET", `/api/learn-admin/owners/${owner1}`);
  assert.equal(one.status, 200); assert.equal(one.data.weeks.length, 20);
  assert.equal(one.data.weeks[0].attempts, 2); assert.ok(one.data.weeks[0].read_done_at);
  assert.ok(one.data.periods.find(p => p.period === "2027-03").weeks === 5);
});

test("blocking an owner signs them out; PIN change by the owner", async () => {
  const p = await api("admin", "POST", `/api/owners/${owner2}/app-pin`, {});
  await api("owner2", "POST", "/api/learn/login", { who: "0823334444", pin: p.data.pin });
  assert.equal((await api("owner2", "POST", "/api/learn/pin", { current: p.data.pin, next: "123456" })).status, 400, "too easy");
  assert.equal((await api("owner2", "POST", "/api/learn/pin", { current: p.data.pin, next: "804317" })).status, 200);
  assert.equal((await api("owner2", "GET", "/api/learn/me")).status, 200);
  await api("admin", "POST", `/api/owners/${owner2}/app-block`, {});
  assert.equal((await api("owner2", "GET", "/api/learn/me")).status, 401);
  assert.equal((await api("owner2", "POST", "/api/learn/login", { who: "0823334444", pin: "804317" })).status, 401);
  await api("admin", "POST", `/api/owners/${owner2}/app-unblock`, {});
  assert.equal((await api("owner2", "POST", "/api/learn/login", { who: "0823334444", pin: "804317" })).status, 200);
});

test("lessons that owners opened can't be deleted; import adds drafts only", async () => {
  assert.equal((await api("admin", "DELETE", `/api/lessons/${lesson1}`)).status, 400);
  const r = await api("admin", "POST", "/api/lessons/import", { lessons: [
    { week_no: 1, title: "already there" }, { week_no: 3, title: "Imbali yemali", body: BODY, questions: QS(5), source: "Bitcoin Diploma, isahluko 3" }] });
  assert.deepEqual(r.data, { added: 1, skipped: 1 });
  const l = (await api("admin", "GET", "/api/lessons")).data.lessons.find(x => x.week_no === 3);
  assert.equal(l.status, "draft"); assert.equal(l.questions, 5);
});

test("nothing opens before the course start date", async () => {
  const st = () => app.learn.ownerState("own00003").weeks[0];
  assert.equal(st().state, "ready");
  assert.equal((await api("admin", "PATCH", "/api/learn-admin/settings", { start_date: "1 Dec" })).status, 400);
  assert.equal((await api("admin", "PATCH", "/api/learn-admin/settings", { start_date: "2999-12-01" })).status, 200);
  assert.deepEqual([st().state, st().opens_on], ["wait", "2999-12-01"]);
  assert.equal((await api("admin", "PATCH", "/api/learn-admin/settings", { start_date: "2020-01-01" })).status, 200);
  assert.equal(st().state, "ready");
  assert.equal((await api("admin", "PATCH", "/api/learn-admin/settings", { start_date: null })).status, 200);
  assert.equal(q("select start_date from learn_settings").get().start_date, null);
});
