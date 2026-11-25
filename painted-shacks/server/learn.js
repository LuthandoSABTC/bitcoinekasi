// Owner learning app (/learn) and the admin screens for lessons and owner progress.
//
// Rules this file keeps:
//  * Owners sign in with their shack number (or phone) and a 6-digit PIN that an admin gives them.
//    An owner only ever sees their own progress and payouts. No other owner's data, no admin data.
//  * Owners see published lessons only. Lessons start as drafts; an admin publishes after checking.
//  * A week counts (7,000 sats) when the owner has read the lesson AND passed its quiz in the app.
//    The server picks the quiz questions and marks the answers, so the phone never gets the answers first.
//  * One new lesson a week: the next lesson opens on the Monday after the last one was finished.
//  * A finished week belongs to a monthly payout (pay_period). Finishing on or after the day the
//    monthly payout is drafted counts for the next month, so nothing falls between two batches.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { lastFriday, addDays, monthName } = require("./payments");

const OWNER_COOKIE_DAYS = 120;
const MAX_PIC_BYTES = 1.5e6;
const ATTEMPT_MINUTES = 120;
const MAX_ATTEMPTS_PER_DAY = 8;

const now = () => new Date().toISOString();
const saNow = () => new Date(Date.now() + 2 * 3600e3);              // South Africa time (no daylight saving)
const saToday = () => saNow().toISOString().slice(0, 10);
const saDay = iso => new Date(Date.parse(iso) + 2 * 3600e3).toISOString().slice(0, 10);
// Monday of the week a date falls in.
const weekStart = d => { const t = new Date(d + "T00:00:00Z"); return addDays(d, -((t.getUTCDay() + 6) % 7)); };
const nextMonth = period => { const [y, m] = period.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };

function init(ctx) {
  const { db, audit, tx, Bad, readJson, send, hashPassword, checkPassword, sha256, readCookie, clientIp, cookieSecure, dataDir, pay } = ctx;
  const OWNER_COOKIE = cookieSecure ? "__Host-ps_owner" : "ps_owner";
  const PIC_DIR = process.env.LESSON_PIC_DIR || path.join(dataDir, "lesson-pictures");
  // The course drafts that ship with the app: content/lessons-xh-draft.json and its pictures in content/pictures/<id>.jpg.
  const BOOK_DIR = process.env.LESSON_BOOK_DIR || path.join(__dirname, "..", "content");
  const BOOK_FILE = path.join(BOOK_DIR, "lessons-xh-draft.json");
  const settings = () => db.prepare("select * from learn_settings where id = 1").get();

  /* ---------------------------------------------------------------- pay period of a finished week */
  function payPeriodFor(day) {
    const period = day.slice(0, 7);
    return day >= pay.draftDay(period) ? nextMonth(period) : period;
  }
  function periodInfo(period) {
    return { period, title: monthName(period), pay_date: pay.payDay(period), counts_until: addDays(pay.draftDay(period), -1) };
  }

  /* ---------------------------------------------------------------- owner sign-in */
  function ownerFromCookie(req) {
    const tok = readCookie(req, OWNER_COOKIE);
    if (!tok) return null;
    return db.prepare(`select o.* from owner_sessions x join owners o on o.id = x.owner_id join owner_logins l on l.owner_id = o.id
                       where x.token_hash = ? and x.expires_at > ? and l.disabled = 0 and o.active = 1`).get(sha256(tok), Date.now()) || null;
  }
  const setOwnerCookie = (res, token, maxAge) =>
    res.setHeader("Set-Cookie", `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSecure ? "; Secure" : ""}`);

  const normPhone = v => { let d = String(v || "").replace(/\D/g, ""); if (d.startsWith("27") && d.length === 11) d = "0" + d.slice(2); return d; };
  function findOwner(who) {
    const w = String(who || "").trim();
    if (/^\d{1,4}$/.test(w)) return db.prepare("select o.* from shacks s join owners o on o.id = s.owner_id where s.shack_no = ?").get(Number(w)) || null;
    const byName = db.prepare("select o.* from shacks s join owners o on o.id = s.owner_id where lower(trim(s.name)) = lower(?)").all(w);
    if (byName.length === 1) return byName[0];
    const ph = normPhone(w);
    if (ph.length < 9) return null;
    return db.prepare("select * from owners where phone is not null").all().find(o => normPhone(o.phone) === ph) || null;
  }

  const ipTries = new Map();
  function ipLimited(ip) {
    const t = Date.now(), list = (ipTries.get(ip) || []).filter(x => t - x < 15 * 60e3);
    ipTries.set(ip, list);
    return list;
  }
  // 4-digit PINs are easy for owners. Guessing is slowed: 5 wrong PINs lock the sign-in for 15 minutes, and after
  // 15 wrong PINs in a row it stays locked until an admin makes a new PIN.
  const newPin = () => { let p; do p = String(crypto.randomInt(0, 1e4)).padStart(4, "0"); while (weakPin(p)); return p; };
  const weakPin = p => /^(\d)\1+$/.test(p) || "0123456789".includes(p) || "9876543210".includes(p) || /^(19|20)\d\d$/.test(p);
  const LOCK_FOR_GOOD = 15;
  // How a shack shows in the sign-in list: its name, or "Shack 12 · Sponsor".
  const shackLabel = s => s.name?.trim() || `Shack ${s.shack_no}${s.sponsor ? " · " + s.sponsor : ""}`;

  /* ---------------------------------------------------------------- lesson state for one owner */
  function ownerState(ownerId) {
    const s = settings();
    const lessons = db.prepare("select id, week_no, title, status from lessons where week_no <= ? order by week_no").all(s.total_weeks);
    const byWeek = new Map(lessons.map(l => [l.week_no, l]));
    const done = new Map(db.prepare("select * from lesson_completions where owner_id = ? and passed = 1").all(ownerId).map(c => [c.week_no, c]));
    const reads = new Map(db.prepare("select * from lesson_reads where owner_id = ?").all(ownerId).map(r => [r.week_no, r]));
    const today = saToday();
    let nextWeek = null;
    for (let w = 1; w <= s.total_weeks; w++) if (!done.has(w)) { nextWeek = w; break; }
    const weeks = [];
    for (let w = 1; w <= s.total_weeks; w++) {
      const l = byWeek.get(w), c = done.get(w), r = reads.get(w);
      let state = "locked", opens_on = null;
      if (c) state = "done";
      else if (w === nextWeek) {
        if (!l || l.status !== "published") state = "soon";
        else {
          const prev = done.get(w - 1);
          if (s.start_date && today < s.start_date) { state = "wait"; opens_on = s.start_date; }
          else if (s.one_per_week && prev && weekStart(prev.completed_on) >= weekStart(today)) { state = "wait"; opens_on = addDays(weekStart(today), 7); }
          else state = "ready";
        }
      }
      weeks.push({ week_no: w, title: l && (l.status === "published" || c) ? l.title : null, state, opens_on,
                   read_done: !!r?.read_done_at, completed_on: c?.completed_on || null, score: c?.score ?? null, total: c?.total ?? null });
    }
    return { weeks, next_week: nextWeek, done_count: done.size };
  }

  function lessonFor(ownerId, week, need) {
    const st = ownerState(ownerId), w = st.weeks.find(x => x.week_no === week);
    if (!w) throw new Bad("Lesson not found", 404);
    if (need === "open" && !["ready", "done"].includes(w.state)) throw new Bad(w.state === "wait" ? `This lesson opens on ${w.opens_on}.` : "This lesson is not open yet.", 403);
    if (need === "quiz" && w.state !== "ready") throw new Bad(w.state === "done" ? "You already finished this week." : "This lesson is not open yet.", 403);
    const l = db.prepare("select * from lessons where week_no = ?").get(week);
    if (!l || (l.status !== "published" && w.state !== "done")) throw new Bad("This lesson is not open yet.", 403);
    return { lesson: l, week: w };
  }

  const picIds = lessonId => db.prepare("select id from lesson_pictures where lesson_id = ? order by created_at").all(lessonId).map(r => r.id);

  /* ---------------------------------------------------------------- quiz */
  function shuffled(list, inPlace) {
    const a = inPlace ? list : [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function startQuiz(owner, week) {
    const { lesson } = lessonFor(owner.id, week, "quiz");
    const read = db.prepare("select read_done_at from lesson_reads where owner_id = ? and week_no = ?").get(owner.id, week);
    if (!read?.read_done_at) throw new Bad("Read the lesson to the end first.", 403);
    const since = new Date(Date.now() - 864e5).toISOString();
    if (db.prepare("select count(*) n from quiz_attempts where owner_id = ? and week_no = ? and started_at > ?").get(owner.id, week, since).n >= MAX_ATTEMPTS_PER_DAY)
      throw new Bad("You have tried many times today. Read the lesson again and try tomorrow.", 429);
    const s = settings();
    const all = db.prepare("select * from quiz_questions where lesson_id = ? order by sort, created_at").all(lesson.id);
    if (!all.length) throw new Bad("This quiz has no questions yet.", 409);
    shuffled(all, true);
    const pick = all.slice(0, Math.min(s.questions_shown, all.length));
    // Shuffle each question's answers too, so the right answer is not always in the same place.
    const orders = pick.map(q => shuffled(JSON.parse(q.choices).map((_, i) => i)));
    const id = crypto.randomUUID();
    db.prepare("insert into quiz_attempts(id, owner_id, week_no, lesson_id, question_ids, orders, total) values (?,?,?,?,?,?,?)")
      .run(id, owner.id, week, lesson.id, JSON.stringify(pick.map(q => q.id)), JSON.stringify(orders), pick.length);
    return { attempt_id: id, week_no: week, pass_correct: Math.min(s.pass_correct, pick.length),
             questions: pick.map((q, i) => { const c = JSON.parse(q.choices); return { id: q.id, question: q.question, choices: orders[i].map(j => c[j]) }; }) };
  }

  /* ---------------------------------------------------------------- practice mode (no sign-in, nothing saved) */
  const demoAttempts = new Map(), demoIp = new Map();
  function demoLesson(week) {
    const s = settings();
    if (!s.demo_weeks) throw new Bad("Practice is switched off. / Ukuziqhelanisa kuvaliwe.", 404);
    if (!Number.isInteger(week) || week < 1 || week > s.demo_weeks) throw new Bad("Not found", 404);
    const l = db.prepare("select * from lessons where week_no = ?").get(week);
    if (!l || l.body.trim().length < 40) throw new Bad("This lesson is not ready yet. / Esi sifundo asikalungi.", 404);
    return l;
  }
  async function demoRoutes(req, res, p, method) {
    const s = settings();
    if (p === "/api/learn/demo" && method === "GET") {
      const weeks = s.demo_weeks ? db.prepare("select week_no, title from lessons where week_no <= ? and length(trim(body)) >= 40 order by week_no").all(s.demo_weeks) : [];
      return send(res, 200, { weeks });
    }
    let m = p.match(/^\/api\/learn\/demo\/lessons\/(\d{1,2})$/);
    if (m && method === "GET") {
      const l = demoLesson(Number(m[1])), qn = db.prepare("select count(*) n from quiz_questions where lesson_id = ?").get(l.id).n;
      return send(res, 200, { week_no: l.week_no, title: l.title, body: l.body, pictures: picIds(l.id), state: "ready", read_done: true, demo: true,
        questions: Math.min(s.questions_shown, qn), pass_correct: Math.min(s.pass_correct, qn) });
    }
    m = p.match(/^\/api\/learn\/demo\/lessons\/(\d{1,2})\/quiz$/);
    if (m && method === "POST") {
      const l = demoLesson(Number(m[1])), ip = clientIp(req), t = Date.now();
      const tries = (demoIp.get(ip) || []).filter(x => t - x < 3600e3); tries.push(t); demoIp.set(ip, tries);
      if (tries.length > 60) throw new Bad("Too many tries. Wait a while. / Zama emva kwexesha.", 429);
      const all = shuffled(db.prepare("select * from quiz_questions where lesson_id = ?").all(l.id));
      if (!all.length) throw new Bad("This quiz has no questions yet.", 409);
      const pick = all.slice(0, Math.min(s.questions_shown, all.length));
      const orders = pick.map(q => shuffled(JSON.parse(q.choices).map((_, i) => i)));
      for (const [k, v] of demoAttempts) if (t - v.at > ATTEMPT_MINUTES * 60e3 || demoAttempts.size > 2000) demoAttempts.delete(k);
      const id = crypto.randomUUID();
      demoAttempts.set(id, { at: t, ids: pick.map(q => q.id), orders, week: l.week_no });
      return send(res, 200, { attempt_id: id, week_no: l.week_no, demo: true, pass_correct: Math.min(s.pass_correct, pick.length),
        questions: pick.map((q, i) => { const c = JSON.parse(q.choices); return { id: q.id, question: q.question, choices: orders[i].map(j => c[j]) }; }) });
    }
    m = p.match(/^\/api\/learn\/demo\/quiz\/([\w-]{8,64})$/);
    if (m && method === "POST") {
      const a = demoAttempts.get(m[1]);
      if (!a) throw new Bad("Quiz not found. Start again. / Qala kwakhona.", 404);
      demoAttempts.delete(m[1]);
      const b = await readJson(req);
      const qs = a.ids.map(id => db.prepare("select * from quiz_questions where id = ?").get(id));
      if (qs.some(q => !q)) throw new Bad("The quiz was changed. Start again.", 409);
      if (!Array.isArray(b.answers) || b.answers.length !== qs.length) throw new Bad("Answer every question.");
      const picked = qs.map((q, i) => { const n = Number(b.answers[i]); return Number.isInteger(n) && n >= 0 && n < a.orders[i].length ? a.orders[i][n] : -1; });
      const results = qs.map((q, i) => ({ id: q.id, correct: picked[i] === q.answer }));
      const score = results.filter(r => r.correct).length, need = Math.min(s.pass_correct, qs.length), passed = score >= need;
      return send(res, 200, { score, total: qs.length, need, passed, demo: true, newly_done: false, added_sats: 0,
        results: results.map((r, i) => ({ ...r, ...(passed ? { answer: a.orders[i].indexOf(qs[i].answer) } : {}) })) });
    }
    throw new Bad("Not found", 404);
  }

  function submitQuiz(owner, attemptId, answers) {
    return tx(() => {
      const a = db.prepare("select * from quiz_attempts where id = ? and owner_id = ?").get(attemptId, owner.id);
      if (!a) throw new Bad("Quiz not found. Start again.", 404);
      if (a.submitted_at) throw new Bad("You already sent these answers.", 409);
      if (Date.parse(a.started_at) < Date.now() - ATTEMPT_MINUTES * 60e3) throw new Bad("This quiz took too long. Start again.", 410);
      const ids = JSON.parse(a.question_ids);
      const qs = ids.map(id => db.prepare("select * from quiz_questions where id = ?").get(id));
      if (qs.some(q => !q)) throw new Bad("The quiz was changed. Start again.", 409);
      if (!Array.isArray(answers) || answers.length !== qs.length) throw new Bad("Answer every question.");
      // answers[i] is the place on the phone; orders[i][place] is the answer's place in the lesson's list.
      const orders = a.orders ? JSON.parse(a.orders) : qs.map(q => JSON.parse(q.choices).map((_, j) => j));
      const picked = qs.map((q, i) => { const n = Number(answers[i]); return Number.isInteger(n) && n >= 0 && n < orders[i].length ? orders[i][n] : -1; });
      const results = qs.map((q, i) => ({ id: q.id, correct: picked[i] === q.answer }));
      const score = results.filter(r => r.correct).length;
      const need = Math.min(settings().pass_correct, qs.length);
      const passed = score >= need ? 1 : 0;
      db.prepare("update quiz_attempts set submitted_at = ?, score = ?, passed = ?, answers = ? where id = ?")
        .run(now(), score, passed, JSON.stringify(picked), a.id);
      let newly = false, period = null;
      if (passed && !db.prepare("select 1 from lesson_completions where owner_id = ? and week_no = ?").get(owner.id, a.week_no)) {
        const day = saToday();
        period = payPeriodFor(day);
        db.prepare(`insert into lesson_completions(owner_id, week_no, lesson_id, completed_on, completed_at, pay_period, score, total)
                    values (?,?,?,?,?,?,?,?)`).run(owner.id, a.week_no, a.lesson_id, day, now(), period, score, qs.length);
        audit(null, "lesson_completions", owner.id, "WEEK_DONE", null, { week_no: a.week_no, pay_period: period, score, total: qs.length });
        pay.syncWeeks(owner.id, period);
        newly = true;
      }
      // Sats this week adds to that month's payout (0 if the owner already has the monthly maximum of weeks).
      const ps = pay.settings();
      const added = newly && pay.weeksEarned(owner.id, period) <= ps.max_weeks ? ps.sats_per_week : 0;
      // Right answers are shown only after passing, so failing and retrying still means reading again.
      return { score, total: qs.length, need, passed: !!passed, newly_done: newly, added_sats: added, pay_period: period ? periodInfo(period) : null,
               results: results.map((r, i) => ({ ...r, ...(passed ? { answer: orders[i].indexOf(qs[i].answer) } : {}) })) };
    });
  }

  function myPeriod(ownerId) {
    const s = pay.settings(), period = payPeriodFor(saToday());
    const weeks = pay.weeksEarned(ownerId, period);
    return { ...periodInfo(period), weeks, paid_weeks: Math.min(weeks, s.max_weeks), max_weeks: s.max_weeks, sats_per_week: s.sats_per_week,
             sats: Math.min(weeks, s.max_weeks) * s.sats_per_week };
  }

  /* ---------------------------------------------------------------- owner routes: /api/learn/* */
  async function ownerRoutes(req, res, p, method) {
    // Practice mode: anyone can open the first weeks' lessons and try the quiz. Nothing is saved and no sats are earned.
    if (p.startsWith("/api/learn/demo")) return demoRoutes(req, res, p, method);
    if (p === "/api/learn/shacks" && method === "GET") {
      const rows = db.prepare(`select s.shack_no, s.name, sp.name sponsor from shacks s join owners o on o.id = s.owner_id
          join owner_logins l on l.owner_id = o.id left join sponsors sp on sp.id = s.sponsor_id
          where o.active = 1 and l.disabled = 0 and s.status <> 'removed' order by s.shack_no`).all();
      return send(res, 200, { shacks: rows.map(s => ({ no: s.shack_no, label: shackLabel(s) })) }, { "Cache-Control": "no-store" });
    }
    if (p === "/api/learn/login" && method === "POST") {
      const ip = clientIp(req), tries = ipLimited(ip);
      if (tries.length >= 20) throw new Bad("Too many tries. Wait 15 minutes. / Zama emva kwemizuzu eli-15.", 429);
      const b = await readJson(req);
      const o = findOwner(b.who), login = o && db.prepare("select * from owner_logins where owner_id = ?").get(o.id);
      const pin = String(b.pin || "");
      if (login && login.failed >= LOCK_FOR_GOOD) throw new Bad("Too many wrong PINs. Ask the admin for a new PIN. / Cela i-PIN entsha kumphathi.", 429);
      if (login && login.locked_until > Date.now()) throw new Bad("Too many wrong PINs. Wait 15 minutes. / Zama emva kwemizuzu eli-15.", 429);
      const ok = checkPassword(pin, login?.pin_hash) && o.active && !login.disabled;
      if (!ok) {
        tries.push(Date.now());
        if (login) {
          const failed = login.failed + 1;   // counts wrong PINs in a row; a right PIN or a new PIN resets it
          db.prepare("update owner_logins set failed = ?, locked_until = ? where owner_id = ?").run(failed, failed % 5 === 0 ? Date.now() + 15 * 60e3 : 0, o.id);
        }
        throw new Bad("Wrong shack or PIN. / Ishack okanye i-PIN ayichanekanga.", 401);
      }
      db.prepare("update owner_logins set failed = 0, locked_until = 0, last_login_at = ? where owner_id = ?").run(now(), o.id);
      const token = crypto.randomBytes(32).toString("base64url");
      db.prepare("insert into owner_sessions(token_hash, owner_id, expires_at) values (?,?,?)").run(sha256(token), o.id, Date.now() + OWNER_COOKIE_DAYS * 864e5);
      db.prepare("delete from owner_sessions where expires_at < ?").run(Date.now());
      setOwnerCookie(res, token, OWNER_COOKIE_DAYS * 86400);
      return send(res, 200, { ok: true });
    }

    // Lesson pictures: the owner app and the admin preview both use this.
    const pic = p.match(/^\/api\/learn\/pictures\/([\w-]{8,64})$/);
    if (pic && method === "GET") {
      const row = db.prepare("select lp.file, l.status from lesson_pictures lp join lessons l on l.id = lp.lesson_id where lp.id = ?").get(pic[1]);
      if (!row) throw new Bad("Not found", 404);
      const staff = ctx.currentUser(req);
      const inDemo = db.prepare("select 1 from lesson_pictures lp join lessons l on l.id = lp.lesson_id where lp.id = ? and l.week_no <= ?").get(pic[1], settings().demo_weeks);
      if (!(staff?.role === "admin") && !inDemo && !(ownerFromCookie(req) && row.status === "published")) throw new Bad("Please sign in.", 401);
      let buf; try { buf = fs.readFileSync(picPath(row.file)); } catch { throw new Bad("Picture file missing", 404); }
      return send(res, 200, buf, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=2592000, immutable" });
    }

    const owner = ownerFromCookie(req);
    if (!owner) throw new Bad("Please sign in. / Ngena kwakhona.", 401);

    if (p === "/api/learn/logout" && method === "POST") {
      db.prepare("delete from owner_sessions where token_hash = ?").run(sha256(readCookie(req, OWNER_COOKIE) || ""));
      setOwnerCookie(res, "", 0);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/learn/me" && method === "GET") {
      const shacks = db.prepare("select shack_no from shacks where owner_id = ? order by shack_no").all(owner.id).map(r => r.shack_no);
      const st = ownerState(owner.id);
      return send(res, 200, { name: owner.full_name, shacks, lightning_address: owner.lightning_address, language: owner.preferred_language,
        total_weeks: settings().total_weeks, ...st, this_month: myPeriod(owner.id), today: saToday() });
    }
    if (p === "/api/learn/pin" && method === "POST") {
      const b = await readJson(req);
      const login = db.prepare("select * from owner_logins where owner_id = ?").get(owner.id);
      if (!checkPassword(String(b.current || ""), login.pin_hash)) throw new Bad("Your PIN is wrong. / I-PIN yakho ayichanekanga.", 403);
      if (!/^\d{4}$/.test(String(b.next || "")) || weakPin(String(b.next))) throw new Bad("Choose 4 numbers that are not easy to guess. / Khetha amanani ama-4 angaqikelelekiyo.");
      db.prepare("update owner_logins set pin_hash = ? where owner_id = ?").run(hashPassword(String(b.next)), owner.id);
      db.prepare("delete from owner_sessions where owner_id = ? and token_hash <> ?").run(owner.id, sha256(readCookie(req, OWNER_COOKIE)));
      audit(null, "owner_logins", owner.id, "PIN_CHANGED_BY_OWNER", null, null);
      return send(res, 200, { ok: true });
    }
    let m = p.match(/^\/api\/learn\/lessons\/(\d{1,2})$/);
    if (m && method === "GET") {
      const week = Number(m[1]);
      const { lesson, week: w } = lessonFor(owner.id, week, "open");
      const t = now();
      db.prepare(`insert into lesson_reads(owner_id, week_no, lesson_id, first_opened_at, last_opened_at) values (?,?,?,?,?)
                  on conflict(owner_id, week_no) do update set last_opened_at = excluded.last_opened_at, lesson_id = excluded.lesson_id`)
        .run(owner.id, week, lesson.id, t, t);
      const qn = db.prepare("select count(*) n from quiz_questions where lesson_id = ?").get(lesson.id).n;
      return send(res, 200, { week_no: week, title: lesson.title, body: lesson.body, pictures: picIds(lesson.id), state: w.state,
        read_done: w.read_done, questions: Math.min(settings().questions_shown, qn), pass_correct: Math.min(settings().pass_correct, qn) });
    }
    m = p.match(/^\/api\/learn\/lessons\/(\d{1,2})\/read$/);
    if (m && method === "POST") {
      const week = Number(m[1]);
      lessonFor(owner.id, week, "open");
      db.prepare("update lesson_reads set read_done_at = coalesce(read_done_at, ?), last_opened_at = ? where owner_id = ? and week_no = ?").run(now(), now(), owner.id, week);
      return send(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/learn\/lessons\/(\d{1,2})\/quiz$/);
    if (m && method === "POST") return send(res, 200, startQuiz(owner, Number(m[1])));
    m = p.match(/^\/api\/learn\/quiz\/([\w-]{8,64})$/);
    if (m && method === "POST") { const b = await readJson(req); return send(res, 200, submitQuiz(owner, m[1], b.answers)); }
    if (p === "/api/learn/payouts" && method === "GET") {
      return send(res, 200, db.prepare(`select period, reason, weeks_earned, amount_sats, status, paid_at from payouts
        where owner_id = ? and status <> 'cancelled' and amount_sats > 0 order by coalesce(paid_at, created_at) desc limit 60`).all(owner.id));
    }
    throw new Bad("Not found", 404);
  }

  /* ---------------------------------------------------------------- lesson pictures on disk */
  function picPath(file) {
    const full = path.resolve(PIC_DIR, file);
    if (!full.startsWith(path.resolve(PIC_DIR) + path.sep)) throw new Bad("Not found", 404);
    return full;
  }
  function sweepPictures() {
    try {
      const keep = new Set(db.prepare("select file from lesson_pictures").all().map(r => r.file));
      for (const f of fs.existsSync(PIC_DIR) ? fs.readdirSync(PIC_DIR) : []) if (f.endsWith(".jpg") && !keep.has(f)) fs.unlinkSync(path.join(PIC_DIR, f));
    } catch (e) { console.error("picture sweep", e); }
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", c => { size += c.length; if (size > limit) { reject(new Bad("That picture is too big.", 413)); req.destroy(); } else chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  /* ---------------------------------------------------------------- progress for admins */
  function lastActivity(ownerId) {
    return db.prepare(`select max(t) t from (
        select max(last_opened_at) t from lesson_reads where owner_id = ?1
        union all select max(coalesce(submitted_at, started_at)) from quiz_attempts where owner_id = ?1
        union all select last_login_at from owner_logins where owner_id = ?1)`).get(ownerId).t;
  }

  function progressAll() {
    const s = settings(), ps = pay.settings();
    const period = payPeriodFor(saToday());
    const published = db.prepare("select count(*) n from lessons where status = 'published' and week_no <= ?").get(s.total_weeks).n;
    const owners = db.prepare("select o.*, l.owner_id as has_login, l.disabled as login_disabled, l.last_login_at from owners o left join owner_logins l on l.owner_id = o.id order by o.full_name").all();
    const rows = owners.map(o => {
      const st = ownerState(o.id);
      const cur = st.next_week ? st.weeks[st.next_week - 1] : null;
      const tries = cur ? db.prepare("select count(*) n, max(score) best from quiz_attempts where owner_id = ? and week_no = ? and submitted_at is not null").get(o.id, cur.week_no) : null;
      const weeks = pay.weeksEarned(o.id, period);
      const paidSats = db.prepare("select coalesce(sum(amount_sats),0) n from payouts where owner_id = ? and reason = 'weekly_learning' and status = 'paid'").get(o.id).n;
      return {
        owner_id: o.id, name: o.full_name, phone: o.phone, active: !!o.active, lightning_address: o.lightning_address,
        shacks: db.prepare("select shack_no from shacks where owner_id = ? order by shack_no").all(o.id).map(r => r.shack_no),
        has_login: !!o.has_login, login_disabled: !!o.login_disabled, last_login_at: o.last_login_at, last_activity: lastActivity(o.id),
        weeks_done: st.done_count, done_weeks: st.weeks.filter(w => w.state === "done").map(w => w.week_no),
        current: cur ? { week_no: cur.week_no, state: cur.state, opens_on: cur.opens_on, read_done: cur.read_done, attempts: tries.n, best_score: tries.best } : null,
        this_period: { weeks, sats: Math.min(weeks, ps.max_weeks) * ps.sats_per_week },
        learning_paid_sats: paidSats,
      };
    });
    return { period: periodInfo(period), total_weeks: s.total_weeks, published, settings: s, sats_per_week: ps.sats_per_week, max_weeks: ps.max_weeks,
             today: saToday(), this_week: weekStart(saToday()), owners: rows };
  }

  function progressOne(ownerId) {
    const o = db.prepare("select * from owners where id = ?").get(ownerId);
    if (!o) throw new Bad("Not found", 404);
    const st = ownerState(o.id);
    const lessons = new Map(db.prepare("select week_no, title, status from lessons").all().map(l => [l.week_no, l]));
    const reads = new Map(db.prepare("select * from lesson_reads where owner_id = ?").all(o.id).map(r => [r.week_no, r]));
    const comps = new Map(db.prepare("select * from lesson_completions where owner_id = ?").all(o.id).map(c => [c.week_no, c]));
    const att = db.prepare("select week_no, count(*) n, max(score) best, max(submitted_at) last from quiz_attempts where owner_id = ? and submitted_at is not null group by week_no").all(o.id);
    const attempts = new Map(att.map(a => [a.week_no, a]));
    const login = db.prepare("select failed, locked_until, disabled, last_login_at, created_at from owner_logins where owner_id = ?").get(o.id);
    const ps = pay.settings();
    const periods = db.prepare("select pay_period, count(*) n from lesson_completions where owner_id = ? group by pay_period order by pay_period desc").all(o.id)
      .map(r => ({ ...periodInfo(r.pay_period), weeks: r.n, sats: Math.min(r.n, ps.max_weeks) * ps.sats_per_week }));
    return {
      owner_id: o.id, name: o.full_name, active: !!o.active, phone: o.phone,
      login: login ? { last_login_at: login.last_login_at, created_at: login.created_at, disabled: !!login.disabled, locked: login.locked_until > Date.now() || login.failed >= LOCK_FOR_GOOD, locked_for_good: login.failed >= LOCK_FOR_GOOD } : null,
      last_activity: lastActivity(o.id), weeks_done: st.done_count, next_week: st.next_week, total_weeks: settings().total_weeks,
      this_period: myPeriod(o.id), periods,
      weeks: st.weeks.map(w => {
        const r = reads.get(w.week_no), c = comps.get(w.week_no), a = attempts.get(w.week_no), l = lessons.get(w.week_no);
        return { week_no: w.week_no, title: l?.title || null, lesson_status: l?.status || null, state: w.state, opens_on: w.opens_on,
                 opened_at: r?.first_opened_at || null, read_done_at: r?.read_done_at || null, attempts: a?.n || 0, best_score: a?.best ?? null,
                 completed_on: c?.completed_on || null, score: c?.score ?? null, total: c?.total ?? null, pay_period: c?.pay_period || null };
      }),
    };
  }

  /* ---------------------------------------------------------------- lesson editing (admins) */
  function cleanQuestions(list) {
    if (!Array.isArray(list) || list.length > 40) throw new Bad("Questions are not valid.");
    return list.map((q, i) => {
      const question = String(q.question || "").trim();
      const choices = (Array.isArray(q.choices) ? q.choices : []).map(c => String(c || "").trim()).filter(Boolean);
      const answer = Number(q.answer);
      if (!question) throw new Bad(`Question ${i + 1} has no text.`);
      if (question.length > 1000 || choices.some(c => c.length > 400)) throw new Bad(`Question ${i + 1} is too long.`);
      if (choices.length < 2 || choices.length > 6) throw new Bad(`Question ${i + 1} needs 2 to 6 answers.`);
      if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) throw new Bad(`Question ${i + 1}: choose the right answer.`);
      return { id: /^[\w-]{8,64}$/.test(q.id || "") ? q.id : null, question, choices, answer };
    });
  }
  function saveQuestions(lessonId, list) {
    const keep = new Set();
    list.forEach((q, i) => {
      const exists = q.id && db.prepare("select 1 from quiz_questions where id = ? and lesson_id = ?").get(q.id, lessonId);
      if (exists) db.prepare("update quiz_questions set sort = ?, question = ?, choices = ?, answer = ?, updated_at = ? where id = ?").run(i, q.question, JSON.stringify(q.choices), q.answer, now(), q.id);
      else { q.id = crypto.randomUUID(); db.prepare("insert into quiz_questions(id, lesson_id, sort, question, choices, answer) values (?,?,?,?,?,?)").run(q.id, lessonId, i, q.question, JSON.stringify(q.choices), q.answer); }
      keep.add(q.id);
    });
    for (const r of db.prepare("select id from quiz_questions where lesson_id = ?").all(lessonId)) if (!keep.has(r.id)) db.prepare("delete from quiz_questions where id = ?").run(r.id);
  }
  function makePin(ownerId, user) {
    const pin = newPin();
    db.prepare(`insert into owner_logins(owner_id, pin_hash) values (?,?)
                on conflict(owner_id) do update set pin_hash = excluded.pin_hash, failed = 0, locked_until = 0, disabled = 0`).run(ownerId, hashPassword(pin));
    db.prepare("delete from owner_sessions where owner_id = ?").run(ownerId);
    audit(user, "owner_logins", ownerId, "NEW_PIN", null, null);
    return pin;
  }
  // The shack an owner picks when signing in (their lowest-numbered shack).
  function signInLabel(ownerId) {
    const s = db.prepare("select s.shack_no, s.name, sp.name sponsor from shacks s left join sponsors sp on sp.id = s.sponsor_id where s.owner_id = ? order by s.shack_no limit 1").get(ownerId);
    return s ? shackLabel(s) : null;
  }
  function readBook() {
    let book; try { book = JSON.parse(fs.readFileSync(BOOK_FILE, "utf8")); } catch { throw new Bad("The book lessons file is missing on the server.", 404); }
    if (!Array.isArray(book.lessons)) throw new Bad("The book lessons file is not valid.", 500);
    return book;
  }
  // A picture that ships with the lessons file (content/pictures/<id>.jpg), or null.
  function bookPicture(id) {
    if (!/^[\w-]{8,64}$/.test(id)) return null;
    try { const buf = fs.readFileSync(path.join(BOOK_DIR, "pictures", id + ".jpg")); return buf[0] === 0xff && buf[1] === 0xd8 ? buf : null; } catch { return null; }
  }
  // Adds lessons as drafts. A week that already has a lesson is skipped, unless replaceDrafts is set and that lesson is
  // still a draft no owner has opened: then its text, questions and pictures are replaced. Live lessons are never touched.
  function importLessons(list, replaceDrafts, user) {
    if (!Array.isArray(list)) throw new Bad("This is not a lessons file.");
    const n = { added: 0, replaced: 0, skipped: 0, pictures: 0, missing_pictures: 0 };
    tx(() => {
      for (const l of list) {
        const week = Number(l.week_no);
        if (!Number.isInteger(week) || week < 1 || week > 60 || !String(l.title || "").trim()) throw new Bad("A lesson in the file has no week or title.");
        const qs = cleanQuestions(l.questions || []);
        const title = String(l.title).trim().slice(0, 200), body = String(l.body || "").slice(0, 100000), source = l.source ? String(l.source).slice(0, 300) : null;
        const cur = db.prepare("select id, status from lessons where week_no = ?").get(week);
        let id;
        if (cur) {
          if (!replaceDrafts || cur.status === "published" || lessonFull(cur.id).usage.opened) { n.skipped++; continue; }
          id = cur.id;
          db.prepare("update lessons set title = ?, body = ?, source = ?, updated_by_name = ?, updated_at = ? where id = ?").run(title, body, source, user.full_name, now(), id);
          db.prepare("delete from lesson_pictures where lesson_id = ?").run(id);
          n.replaced++;
        } else {
          id = crypto.randomUUID();
          db.prepare("insert into lessons(id, week_no, title, body, source, updated_by_name) values (?,?,?,?,?,?)").run(id, week, title, body, source, user.full_name);
          n.added++;
        }
        saveQuestions(id, qs.map(q => ({ ...q, id: null })));
        for (const pid of Array.isArray(l.pictures) ? l.pictures : []) {
          const buf = bookPicture(String(pid));
          if (!buf || db.prepare("select 1 from lesson_pictures where id = ?").get(pid)) { n.missing_pictures++; continue; }
          const file = `${pid}.jpg`, full = picPath(file);
          fs.mkdirSync(PIC_DIR, { recursive: true });
          fs.writeFileSync(full + ".part", buf); fs.renameSync(full + ".part", full);
          db.prepare("insert into lesson_pictures(id, lesson_id, file, bytes) values (?,?,?,?)").run(pid, id, file, buf.length);
          n.pictures++;
        }
      }
      audit(user, "lessons", null, "IMPORT", null, n);
    });
    if (n.replaced) sweepPictures();
    return n;
  }
  function lessonFull(id) {
    const l = db.prepare("select * from lessons where id = ?").get(id);
    if (!l) throw new Bad("Not found", 404);
    const questions = db.prepare("select id, question, choices, answer from quiz_questions where lesson_id = ? order by sort, created_at").all(id).map(q => ({ ...q, choices: JSON.parse(q.choices) }));
    const usage = db.prepare("select (select count(*) from lesson_completions where week_no = ?1) done, (select count(distinct owner_id) from lesson_reads where week_no = ?1) opened").get(l.week_no);
    return { ...l, questions, pictures: picIds(id), usage };
  }
  function publishProblems(l) {
    const s = settings(), out = [];
    if (!l.title.trim()) out.push("The lesson has no title.");
    if (l.body.trim().length < 40) out.push("The lesson text is empty or very short.");
    if (l.questions.length < s.questions_shown) out.push(`The quiz needs at least ${s.questions_shown} questions (it shows ${s.questions_shown} at random). It has ${l.questions.length}.`);
    for (const m of l.body.matchAll(/\[\[picture:([\w-]+)\]\]/g)) if (!l.pictures.includes(m[1])) out.push("The text points to a picture that was deleted.");
    return out;
  }

  async function adminRoutes(req, res, p, method, user, url) {
    if (p === "/api/learn-admin/progress" && method === "GET") return send(res, 200, progressAll());
    let m = p.match(/^\/api\/learn-admin\/owners\/([\w-]{8,64})$/);
    if (m && method === "GET") return send(res, 200, progressOne(m[1]));

    // Sign-in PIN for an owner: made by the server, shown to the admin once.
    m = p.match(/^\/api\/owners\/([\w-]{8,64})\/app-(pin|block|unblock)$/);
    if (m && method === "POST") {
      const [, id, act] = m;
      const o = db.prepare("select * from owners where id = ?").get(id);
      if (!o) throw new Bad("Not found", 404);
      if (act === "pin") {
        if (!db.prepare("select 1 from shacks where owner_id = ?").get(id) && normPhone(o.phone).length < 9)
          throw new Bad("Link this owner to a shack or add their phone number first, so they have something to sign in with.");
        const pin = makePin(id, user);
        return send(res, 200, { pin, shacks: db.prepare("select shack_no from shacks where owner_id = ? order by shack_no").all(id).map(r => r.shack_no),
                                shack_label: signInLabel(id) });
      }
      if (!db.prepare("select 1 from owner_logins where owner_id = ?").get(id)) throw new Bad("This owner has no app sign-in yet.");
      db.prepare("update owner_logins set disabled = ?, failed = 0, locked_until = 0 where owner_id = ?").run(act === "block" ? 1 : 0, id);
      if (act === "block") db.prepare("delete from owner_sessions where owner_id = ?").run(id);
      audit(user, "owner_logins", id, act.toUpperCase(), null, null);
      return send(res, 200, { ok: true });
    }

    // PINs for every active owner with a shack who has no app sign-in yet. Each PIN is shown once.
    if (p === "/api/learn-admin/pins" && method === "POST") {
      const list = db.prepare(`select o.id, o.full_name, o.phone from owners o where o.active = 1
          and exists (select 1 from shacks s where s.owner_id = o.id) and not exists (select 1 from owner_logins l where l.owner_id = o.id)`).all();
      const out = tx(() => list.map(o => ({ owner_id: o.id, name: o.full_name, phone: o.phone, shack: signInLabel(o.id),
        shack_no: db.prepare("select min(shack_no) n from shacks where owner_id = ?").get(o.id).n, pin: makePin(o.id, user) })));
      return send(res, 200, { made: out.sort((a, b) => a.shack_no - b.shack_no) });
    }

    if (p === "/api/learn-admin/settings" && method === "PATCH") {
      const b = await readJson(req), before = settings(), upd = {};
      for (const k of ["questions_shown", "pass_correct", "total_weeks", "one_per_week", "demo_weeks"]) {
        if (b[k] === undefined) continue;
        const v = k === "one_per_week" ? (b[k] ? 1 : 0) : Number(b[k]);
        if (!Number.isInteger(v) || v < 0) throw new Bad(`${k} must be a whole number`);
        upd[k] = v;
      }
      if (b.start_date !== undefined) {
        const d = b.start_date ? String(b.start_date) : null;
        if (d && !(/^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T00:00:00Z")))) throw new Bad("Start date must be a date like 2026-12-01.");
        upd.start_date = d;
      }
      const next = { ...before, ...upd };
      if (next.demo_weeks > 5) throw new Bad("Practice can show at most 5 weeks.");
      if (next.pass_correct > next.questions_shown) throw new Bad("The pass mark can't be more than the number of questions shown.");
      if (Object.keys(upd).length)
        db.prepare(`update learn_settings set ${Object.keys(upd).map(k => k + " = ?").join(", ")}, updated_at = ? where id = 1`).run(...Object.values(upd), now());
      audit(user, "learn_settings", "1", "UPDATE", before, settings());
      return send(res, 200, settings());
    }

    if (p === "/api/lessons" && method === "GET") {
      return send(res, 200, { settings: settings(), lessons: db.prepare(`select l.id, l.week_no, l.title, l.status, l.source, l.updated_at, l.published_at, l.published_by_name,
          (select count(*) from quiz_questions where lesson_id = l.id) questions, (select count(*) from lesson_pictures where lesson_id = l.id) pictures,
          length(l.body) chars, (select count(*) from lesson_completions where week_no = l.week_no) done
        from lessons l order by l.week_no`).all() });
    }
    if (p === "/api/lessons" && method === "POST") {
      const b = await readJson(req);
      const week = Number(b.week_no), title = String(b.title || "").trim();
      if (!Number.isInteger(week) || week < 1 || week > 60) throw new Bad("Week must be 1 to 60.");
      if (!title) throw new Bad("Give the lesson a title.");
      if (db.prepare("select 1 from lessons where week_no = ?").get(week)) throw new Bad(`Week ${week} already has a lesson.`, 409);
      const id = crypto.randomUUID();
      db.prepare("insert into lessons(id, week_no, title, updated_by_name) values (?,?,?,?)").run(id, week, title.slice(0, 200), user.full_name);
      audit(user, "lessons", id, "INSERT", null, { week_no: week, title });
      return send(res, 201, lessonFull(id));
    }
    if (p === "/api/lessons/import" && method === "POST") {
      const b = await readJson(req);
      return send(res, 200, importLessons(b.lessons, !!b.replace_drafts, user));
    }
    // The lessons that ship with the app (drafted from the isiXhosa Bitcoin Diploma book), with their pictures.
    if (p === "/api/lessons/book" && method === "GET") {
      const book = readBook();
      return send(res, 200, { about: book.about || "", weeks: book.lessons.map(l => {
        const cur = db.prepare("select id, status from lessons where week_no = ?").get(Number(l.week_no));
        return { week_no: l.week_no, title: l.title, pictures: (l.pictures || []).length, questions: (l.questions || []).length,
                 now: !cur ? "empty" : cur.status === "published" ? "published" : lessonFull(cur.id).usage.opened ? "opened" : "draft" };
      }) });
    }
    if (p === "/api/lessons/import-book" && method === "POST") {
      const b = await readJson(req);
      return send(res, 200, importLessons(readBook().lessons, !!b.replace_drafts, user));
    }
    m = p.match(/^\/api\/lessons\/([\w-]{8,64})$/);
    if (m && method === "GET") return send(res, 200, lessonFull(m[1]));
    if (m && method === "PATCH") {
      const b = await readJson(req);
      const out = tx(() => {
        const before = lessonFull(m[1]), upd = {};
        if (b.title !== undefined) { upd.title = String(b.title || "").trim().slice(0, 200); if (!upd.title) throw new Bad("Give the lesson a title."); }
        if (b.body !== undefined) upd.body = String(b.body || "").slice(0, 100000);
        if (b.week_no !== undefined && Number(b.week_no) !== before.week_no) {
          const w = Number(b.week_no);
          if (!Number.isInteger(w) || w < 1 || w > 60) throw new Bad("Week must be 1 to 60.");
          if (before.usage.done || before.usage.opened) throw new Bad("Owners have already opened this lesson, so its week can't change.");
          if (db.prepare("select 1 from lessons where week_no = ?").get(w)) throw new Bad(`Week ${w} already has a lesson.`, 409);
          upd.week_no = w;
        }
        upd.updated_by_name = user.full_name;
        db.prepare(`update lessons set ${Object.keys(upd).map(k => k + " = ?").join(", ")}, updated_at = ? where id = ?`).run(...Object.values(upd), now(), m[1]);
        if (b.questions !== undefined) saveQuestions(m[1], cleanQuestions(b.questions));
        const after = lessonFull(m[1]);
        if (after.status === "published") {
          const probs = publishProblems(after);
          if (probs.length) throw new Bad("This lesson is live, so it must stay complete: " + probs.join(" "));
        }
        audit(user, "lessons", m[1], "UPDATE", { title: before.title, body: before.body, questions: before.questions }, { title: after.title, body: after.body, questions: after.questions });
        return after;
      });
      return send(res, 200, out);
    }
    if (m && method === "DELETE") {
      tx(() => {
        const l = lessonFull(m[1]);
        if (l.usage.done || l.usage.opened) throw new Bad("Owners have already opened this lesson. Move it back to draft instead of deleting it.");
        db.prepare("delete from lessons where id = ?").run(m[1]);
        audit(user, "lessons", m[1], "DELETE", { week_no: l.week_no, title: l.title }, null);
      });
      sweepPictures();
      return send(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/lessons\/([\w-]{8,64})\/(publish|unpublish)$/);
    if (m && method === "POST") {
      const out = tx(() => {
        const l = lessonFull(m[1]);
        if (m[2] === "publish") {
          const probs = publishProblems(l);
          if (probs.length) throw new Bad(probs.join(" "));
          db.prepare("update lessons set status = 'published', published_at = ?, published_by_name = ?, updated_at = ? where id = ?").run(now(), user.full_name, now(), l.id);
        } else db.prepare("update lessons set status = 'draft', updated_at = ? where id = ?").run(now(), l.id);
        audit(user, "lessons", l.id, m[2].toUpperCase(), { status: l.status }, { status: m[2] === "publish" ? "published" : "draft" });
        return lessonFull(l.id);
      });
      return send(res, 200, out);
    }
    m = p.match(/^\/api\/lessons\/([\w-]{8,64})\/pictures\/([\w-]{8,64})$/);
    if (m && method === "PUT") {
      const [, lid, pid] = m;
      if (!db.prepare("select 1 from lessons where id = ?").get(lid)) throw new Bad("Not found", 404);
      if (db.prepare("select 1 from lesson_pictures where id = ?").get(pid)) return send(res, 200, { ok: true, id: pid });
      if ((req.headers["content-type"] || "") !== "image/jpeg") throw new Bad("Pictures must be JPEG.", 415);
      const buf = await readBody(req, MAX_PIC_BYTES);
      if (buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw new Bad("That file is not a JPEG picture.", 415);
      const file = `${pid}.jpg`, full = picPath(file);
      fs.mkdirSync(PIC_DIR, { recursive: true });
      fs.writeFileSync(full + ".part", buf); fs.renameSync(full + ".part", full);
      db.prepare("insert into lesson_pictures(id, lesson_id, file, bytes) values (?,?,?,?)").run(pid, lid, file, buf.length);
      audit(user, "lesson_pictures", pid, "INSERT", null, { lesson_id: lid, bytes: buf.length });
      return send(res, 201, { ok: true, id: pid });
    }
    m = p.match(/^\/api\/lesson-pictures\/([\w-]{8,64})$/);
    if (m && method === "DELETE") {
      const row = db.prepare("select lp.*, l.body, l.status from lesson_pictures lp join lessons l on l.id = lp.lesson_id where lp.id = ?").get(m[1]);
      if (!row) throw new Bad("Not found", 404);
      if (row.status === "published" && row.body.includes(`[[picture:${m[1]}]]`)) throw new Bad("This live lesson still shows the picture. Take it out of the text first.");
      db.prepare("delete from lesson_pictures where id = ?").run(m[1]);
      audit(user, "lesson_pictures", m[1], "DELETE", { lesson_id: row.lesson_id }, null);
      sweepPictures();
      return send(res, 200, { ok: true });
    }
    return undefined;
  }

  return { ownerRoutes, adminRoutes, ownerState, payPeriodFor, progressAll, progressOne, PIC_DIR };
}

module.exports = { init, weekStart };
