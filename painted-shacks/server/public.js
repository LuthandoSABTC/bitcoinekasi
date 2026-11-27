// Public dashboard data: GET /api/public/dashboard. Anyone can read it, no sign-in.
//
// Rules this file keeps:
//  * Only counts, dates and shack numbers. Never owner names, phone numbers, PINs, notes, sponsor contacts,
//    inspection notes or photos, payment hashes or errors.
//  * Lightning addresses and phone numbers are never shown here (admin app only; Luthando, 27 Nov 2026).
//  * Sponsor payments are only shown when an admin left "show publicly" on (sponsor_payments.show_publicly).
//  * The numbers are worked out at most once a minute and kept in memory, so many visitors cost the small
//    server almost nothing.
"use strict";
const { addDays, monthName } = require("./payments");

const CACHE_MS = Number(process.env.PUBLIC_CACHE_SECONDS || 60) * 1000;
const SA = 2 * 3600e3;                                                    // South Africa time (no daylight saving)
const saDay = iso => new Date(Date.parse(iso) + SA).toISOString().slice(0, 10);
const saHour = iso => new Date(Date.parse(iso) + SA).getUTCHours();
const weekStart = d => addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const webLink = u => (typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

function init({ db, pay, learn, send, Bad }) {
  let cache = null, cacheAt = 0;

  function build() {
    const nowIso = new Date().toISOString();
    const today = saDay(nowIso);
    const month = today.slice(0, 7);
    const monthStart = month + "-01";
    const ls = db.prepare("select * from learn_settings where id = 1").get();
    const ps = pay.settings();
    const period = learn.payPeriodFor(today);           // the next monthly payout that new lessons count towards
    const payDate = pay.payDay(period);

    /* -------------------------------------------------------------- shacks, owners, sponsors */
    const shacks = db.prepare(`select s.id, s.shack_no, s.status, s.area, s.owner_id, s.first_painted_on,
        sp.id as sponsor_id, sp.name as sponsor, sp.website, sp.kind as sponsor_kind, sp.payment_status as sponsor_status, s.x_post_url,
        o.active as owner_active
      from shacks s left join sponsors sp on sp.id = s.sponsor_id left join owners o on o.id = s.owner_id
      where s.status <> 'removed' order by s.shack_no`).all();
    const shackById = new Map(shacks.map(s => [s.id, s]));
    // An owner can have more than one wall: they show as their lowest shack number.
    const ownerShack = new Map();
    for (const s of shacks) if (s.owner_id && !ownerShack.has(s.owner_id)) ownerShack.set(s.owner_id, s);
    const activeOwners = [...ownerShack.values()].filter(s => s.owner_active).length;
    const painted = shacks.filter(s => s.status === "painted" || s.status === "needs_repaint").length;
    const shackRef = s => (s ? { shack_no: s.shack_no, logo: s.sponsor || null } : null);

    /* -------------------------------------------------------------- inspections */
    const latest = db.prepare(`select i.shack_id, i.result, i.inspected_on from inspections i
      where i.rowid = (select i2.rowid from inspections i2 where i2.shack_id = i.shack_id order by i2.inspected_on desc, i2.created_at desc limit 1)`).all()
      .filter(r => shackById.has(r.shack_id));
    const good = latest.filter(r => r.result === "good").length;
    const inspectedThisMonth = db.prepare("select count(distinct shack_id) n from inspections where inspected_on >= ?").get(monthStart).n;

    /* -------------------------------------------------------------- lessons */
    const comps = db.prepare("select owner_id, week_no, completed_on, completed_at, pay_period from lesson_completions where passed = 1").all();
    const round = comps.filter(c => c.pay_period === period);
    const perOwner = new Map();
    for (const c of round) perOwner.set(c.owner_id, (perOwner.get(c.owner_id) || 0) + 1);
    const roundSats = [...perOwner.values()].reduce((a, n) => a + Math.min(n, ps.max_weeks) * ps.sats_per_week, 0);
    const thisWeekStart = weekStart(today);
    const ownersThisWeek = new Set(comps.filter(c => c.completed_on >= thisWeekStart).map(c => c.owner_id)).size;
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(thisWeekStart, i);
      days.push({ day: d, lessons: comps.filter(c => c.completed_on === d).length, future: d > today, today: d === today });
    }
    // Owners who passed a week's quiz on their first try.
    const firsts = db.prepare(`select a.passed from quiz_attempts a where a.submitted_at is not null and a.rowid =
        (select b.rowid from quiz_attempts b where b.owner_id = a.owner_id and b.week_no = a.week_no and b.submitted_at is not null
         order by b.submitted_at limit 1)`).all();
    const byDay = new Map();
    for (const c of comps) byDay.set(c.completed_on, (byDay.get(c.completed_on) || 0) + 1);
    let bestDay = null;
    for (const [d, n] of byDay) if (!bestDay || n > bestDay.lessons) bestDay = { day: d, lessons: n };
    let busiest = null;
    if (comps.length >= 5) {
      const slots = new Array(12).fill(0);
      for (const c of comps) slots[Math.floor(saHour(c.completed_at) / 2)]++;
      const top = slots.indexOf(Math.max(...slots));
      busiest = { from: top * 2, to: top * 2 + 2 };
    }
    const since = ms => new Date(Date.now() - ms).toISOString();
    const lessonsSince = ms => comps.filter(c => c.completed_at >= since(ms)).length;
    const started = !ls.start_date || today >= ls.start_date;
    const published = db.prepare("select count(*) n from lessons where status = 'published' and week_no <= ?").get(ls.total_weeks).n;

    /* -------------------------------------------------------------- payouts */
    const paidLearning = db.prepare(`select p.period, p.paid_at, coalesce(b.pay_date, '') as pay_date from payouts p
      left join payout_batches b on b.id = p.batch_id where p.status = 'paid' and p.reason = 'weekly_learning'`).all();
    const onTime = paidLearning.filter(p => saDay(p.paid_at) <= (p.pay_date || (p.period ? pay.payDay(p.period) : "9999"))).length;
    const months = db.prepare(`select coalesce(period, substr(paid_at,1,7)) as period, sum(amount_sats) sats, count(distinct owner_id) owners,
        max(paid_at) last_paid from payouts where status = 'paid' group by 1 order by 1`).all()
      .map(m => ({ period: m.period, title: monthName(m.period), sats: m.sats, owners: m.owners, paid_on: saDay(m.last_paid), upcoming: false }));
    if (!months.some(m => m.period === period)) {
      const queued = db.prepare(`select coalesce(sum(amount_sats),0) n from payouts where period = ? and reason = 'weekly_learning'
                                 and status in ('pending','approved','sending')`).get(period).n;
      months.push({ period, title: monthName(period), sats: Math.max(queued, roundSats), owners: perOwner.size, paid_on: payDate, upcoming: true });
    }
    const paidTotal = db.prepare("select coalesce(sum(amount_sats),0) n from payouts where status = 'paid'").get().n;

    /* -------------------------------------------------------------- feed (newest first) */
    const feed = [];
    for (const c of db.prepare(`select owner_id, week_no, completed_at from lesson_completions where passed = 1 order by completed_at desc limit 10`).all())
      feed.push({ at: c.completed_at, kind: "lesson", week_no: c.week_no, sats: ps.sats_per_week, shack: shackRef(ownerShack.get(c.owner_id)) });
    for (const i of db.prepare("select shack_id, result, created_at from inspections order by created_at desc limit 10").all())
      if (shackById.has(i.shack_id)) feed.push({ at: i.created_at, kind: "inspection", result: i.result, shack: shackRef(shackById.get(i.shack_id)) });
    for (const b of db.prepare("select id, period, title, created_at from payout_batches where period is not null order by created_at desc limit 4").all()) {
      const t = db.prepare("select coalesce(sum(amount_sats),0) sats, count(*) n from payouts where batch_id = ? and status <> 'cancelled'").get(b.id);
      feed.push({ at: b.created_at, kind: "payout_drafted", title: monthName(b.period), sats: t.sats, owners: t.n });
      const p = db.prepare("select coalesce(sum(amount_sats),0) sats, count(*) n, max(paid_at) at from payouts where batch_id = ? and status = 'paid'").get(b.id);
      if (p.n) feed.push({ at: p.at, kind: "payout_sent", title: monthName(b.period), sats: p.sats, owners: p.n });
    }
    for (const s of db.prepare(`select sp.name, sp.website, p.received_on, p.amount_sats from sponsor_payments p join sponsors sp on sp.id = p.sponsor_id
                                where p.show_publicly = 1 order by p.received_on desc limit 3`).all())
      feed.push({ at: s.received_on + "T10:00:00.000Z", day_only: true, kind: "sponsor", sponsor: s.name, website: webLink(s.website), sats: s.amount_sats });
    for (const s of shacks.filter(s => s.first_painted_on).sort((a, b) => b.first_painted_on.localeCompare(a.first_painted_on)).slice(0, 3))
      feed.push({ at: s.first_painted_on + "T10:00:00.000Z", day_only: true, kind: "painted", shack: shackRef(s) });
    feed.sort((a, b) => b.at.localeCompare(a.at));

    /* -------------------------------------------------------------- sections of JCC Camp (shacks.area) + the map */
    const map = mapSettings();
    const keyOf = a => (a || "").trim().toLowerCase() || null;
    const groups = new Map();
    for (const m of map.sections) groups.set(keyOf(m.name), { name: m.name, shacks: 0, painted: 0, lessons: 0, lat: m.lat, lng: m.lng, radius_m: m.radius_m });
    for (const s of shacks) {
      const k = keyOf(s.area);
      if (!groups.has(k)) groups.set(k, { name: k ? s.area.trim() : null, shacks: 0, painted: 0, lessons: 0, lat: null, lng: null, radius_m: null });
      const g = groups.get(k); g.shacks++;
      if (s.status === "painted" || s.status === "needs_repaint") g.painted++;
    }
    for (const c of comps) { const s = ownerShack.get(c.owner_id); if (s) groups.get(keyOf(s.area)).lessons++; }
    const sections = [...groups.values()].filter(g => g.shacks > 0 || g.lat != null)
      .sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || b.shacks - a.shacks || b.lessons - a.lessons);

    /* -------------------------------------------------------------- funding, tips, sponsors */
    const funding = db.prepare(`select p.received_on, p.purpose, p.amount_sats, p.amount_zar, p.renews_on, sp.name as sponsor, sp.website, p.proof_url
      from sponsor_payments p join sponsors sp on sp.id = p.sponsor_id where p.show_publicly = 1 order by p.received_on desc`).all()
      .map(({ proof_url, ...r }) => ({ ...r, website: webLink(r.website), proof: webLink(proof_url) }));
    const sponsorWalls = new Map();
    for (const s of shacks) if (s.sponsor && s.status !== "free_wall") {
      const e = sponsorWalls.get(s.sponsor) || { name: s.sponsor, website: webLink(s.website), walls: 0 };
      e.walls++; sponsorWalls.set(s.sponsor, e);
    }

    /* -------------------------------------------------------------- accountability page (/dashboard/accountability/) */
    const year = today.slice(0, 4);
    // What each wall is, from the sponsor's status in the admin app.
    const WALL_KINDS = [
      { key: "paid", group: "support", label: "Paid partner", desc: "The partner pays in sats for its logo on the wall." },
      { key: "in_kind", group: "support", label: "In-kind partner", desc: "The partner gives services or products instead of sats." },
      { key: "ekasi", group: "support", label: "Bitcoin Ekasi wall", desc: "Bitcoin Ekasi's own logo." },
      { key: "renewal", group: "not", label: "Up for renewal", desc: "A partner in an earlier year, not renewed yet." },
      { key: "thanks", group: "not", label: "Thank-you wall", desc: "Painted by the team to thank a project. No charge." },
      { key: "open", group: "not", label: "Open for a new partner", desc: "Will be repainted for the next partner." },
    ];
    const wallKind = s => {
      if (s.status === "free_wall" || s.status === "to_replace" || !s.sponsor_id) return "open";
      if (s.sponsor_kind === "bitcoin_ekasi") return "ekasi";
      return { paying: "paid", ongoing_in_kind: "in_kind", lapsed: "renewal" }[s.sponsor_status] || "thanks";
    };
    const wallCount = new Map();
    for (const s of shacks) wallCount.set(wallKind(s), (wallCount.get(wallKind(s)) || 0) + 1);
    const partnerMap = new Map();
    for (const s of shacks) {
      const k = wallKind(s);
      if (k !== "paid" && k !== "in_kind") continue;
      const e = partnerMap.get(s.sponsor_id) || { name: s.sponsor, website: webLink(s.website), type: k, walls: 0, shacks: [], posts: [] };
      e.walls++; e.shacks.push(s.shack_no);
      const post = webLink(s.x_post_url);
      if (post && /^https:\/\/(x|twitter)\.com\//i.test(post) && !e.posts.includes(post)) e.posts.push(post);
      partnerMap.set(s.sponsor_id, e);
    }
    const lastPay = db.prepare(`select sponsor_id, max(received_on) last_paid_on, max(renews_on) renews_on from sponsor_payments
                                where show_publicly = 1 group by sponsor_id`).all();
    for (const r of lastPay) { const e = partnerMap.get(r.sponsor_id); if (e) Object.assign(e, { last_paid_on: r.last_paid_on, renews_on: r.renews_on }); }
    const partners = [...partnerMap.values()].sort((a, b) => (a.type === b.type ? 0 : a.type === "paid" ? -1 : 1) || b.walls - a.walls || a.name.localeCompare(b.name));
    // Money in and out this year: public sponsor payments in, and each month's payout to families (one line per month, never per family).
    const inYear = funding.filter(r => r.received_on.startsWith(year));
    const outMonths = db.prepare(`select substr(paid_at,1,7) month, sum(amount_sats) sats, sum(coalesce(fee_sats,0)) fees, count(distinct owner_id) households, max(paid_at) at
                                  from payouts where status = 'paid' and paid_at >= ? group by 1 order by 1`).all(year + "-01-01");
    // Payouts made before the app (typed in admin), skipping any month the app itself paid.
    const appMonths = new Set(outMonths.map(m => m.month));
    const past = db.prepare("select period, paid_on, households, amount_sats, proof_url from past_payouts where period like ? order by period").all(year + "-%")
      .filter(p => !appMonths.has(p.period));
    const ledger = [
      ...past.map(p => ({ date: p.paid_on, what: `${monthName(p.period).split(" ")[0]} payout to ${p.households} ${p.households === 1 ? "family" : "families"}`,
                          in_sats: 0, out_sats: p.amount_sats, proof: webLink(p.proof_url) })),
      ...inYear.map(r => ({ date: r.received_on, what: "Partner sponsorship", from: r.sponsor, in_sats: r.amount_sats, out_sats: 0, proof: r.proof || null })),
      ...outMonths.map(m => ({ date: saDay(m.at), what: `${monthName(m.month).split(" ")[0]} payout to ${m.households} ${m.households === 1 ? "family" : "families"}`, in_sats: 0, out_sats: m.sats })),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const yearLessons = comps.filter(c => c.completed_on.startsWith(year));
    const learnMonths = [];
    for (let m = 1; m <= Number(today.slice(5, 7)); m++) {
      const per = `${year}-${String(m).padStart(2, "0")}`;
      const rows = comps.filter(c => c.completed_on.startsWith(per));
      learnMonths.push({ period: per, households: new Set(rows.map(c => c.owner_id)).size, lessons: rows.length });
    }
    /* -------------------------------------------------------------- typed in the admin app's Public report page */
    const rs = reportSettings();
    const entries = db.prepare("select entry_date, direction, category, what, amount_sats, proof_url from report_entries where entry_date like ? order by entry_date desc")
      .all(year + "-%");
    const videos = new Map(db.prepare("select * from partner_posts").all().map(v => [v.sponsor_id, v]));
    for (const [sid, e] of partnerMap) {
      const v = videos.get(sid);
      if (v) e.video = { on: v.video_on || null, x: webLink(v.video_x_url), nostr: webLink(v.video_nostr_url), impressions: v.impressions,
                         views: v.views, coming_soon: !!v.coming_soon, note: v.note || null };
    }
    // Cleaning inspections this year: totals only (each family's results are for paid partners, see partner.js).
    // Passed = the inspector found the shack and yard clean (inspections.clean). Older inspections without that question are left out.
    const hasClean = !!db.prepare("select 1 from pragma_table_info('inspections') where name = 'clean'").get();
    const yearInsp = db.prepare(`select shack_id, ${hasClean ? "clean" : "null as clean"} from inspections where inspected_on like ?`).all(year + "-%")
      .filter(i => shackById.has(i.shack_id) && i.clean);
    const inspections = { total: yearInsp.length, passed: yearInsp.filter(i => i.clean === "yes").length,
      not_passed: yearInsp.filter(i => i.clean !== "yes").length, shacks: new Set(yearInsp.map(i => i.shack_id)).size,
      latest_good: good, latest_of: latest.length };
    const accountability = {
      year,
      walls: WALL_KINDS.map(k => ({ ...k, count: wallCount.get(k.key) || 0 })),
      partners,
      money: { received_sats: inYear.reduce((a, r) => a + r.amount_sats, 0), received_zar: inYear.reduce((a, r) => a + (r.amount_zar || 0), 0),
               paid_to_families_sats: outMonths.reduce((a, m) => a + m.sats, 0) + past.reduce((a, p) => a + p.amount_sats, 0), fees_sats: outMonths.reduce((a, m) => a + m.fees, 0), ledger },
      learning: { months: learnMonths, lessons: yearLessons.length, households: new Set(yearLessons.map(c => c.owner_id)).size },
      households: activeOwners,
      inspections,
      // Report settings and lines typed in the admin app. null = not typed yet, so the page keeps the draft's text.
      report: {
        agreements_signed: rs.agreements_signed, agreement_url: webLink(rs.agreement_url), carried_over_sats: rs.carried_over_sats,
        pending_walls: rs.pending_walls, pending_note: rs.pending_note, review_walls: rs.review_walls, review_note: rs.review_note,
        questions: rs.questions, show_draft_note: rs.show_draft_note,
        entries: entries.map(r => ({ date: r.entry_date, direction: r.direction, category: r.category, what: r.what, sats: r.amount_sats, proof: webLink(r.proof_url) })),
        has_entries: db.prepare("select count(*) n from report_entries").get().n > 0,
      },
    };

    return {
      generated_at: nowIso, today, refresh_seconds: Math.round(CACHE_MS / 1000), place: map.place_name,
      month: { period: month, title: monthName(month) },
      round: { period, title: monthName(period), pay_date: payDate, lessons: round.length, owners: perOwner.size, sats: roundSats },
      programme: { start_date: ls.start_date || null, started, total_weeks: ls.total_weeks, published_lessons: published,
                   sats_per_week: ps.sats_per_week, max_weeks: ps.max_weeks },
      tiles: {
        shacks_painted: { value: painted, of: shacks.length },
        lesson_this_week: { value: ownersThisWeek, of: activeOwners },
        good_condition: { value: good, of: latest.length },
        paid_on_time: { value: onTime, of: paidLearning.length, pct: pct(onTime, paidLearning.length) },
      },
      sections, feed: feed.slice(0, 8), days,
      highlights: {
        lessons: round.length, owners_learning: perOwner.size, sats: roundSats, shacks_inspected: inspectedThisMonth,
        first_try_pct: pct(firsts.filter(f => f.passed).length, firsts.length), first_try_n: firsts.length,
        lessons_all_time: comps.length, best_day: bestDay, busiest,
        newest_shack: (() => { const s = shacks.filter(s => s.first_painted_on).sort((a, b) => b.first_painted_on.localeCompare(a.first_painted_on))[0];
                               return s ? { shack_no: s.shack_no, painted_on: s.first_painted_on } : null; })(),
        last48: { lessons: lessonsSince(48 * 3600e3),
                  inspections: db.prepare("select count(*) n from inspections where created_at >= ?").get(since(48 * 3600e3)).n,
                  failed_payments: db.prepare("select count(*) n from payouts where status = 'failed' and updated_at >= ?").get(since(48 * 3600e3)).n },
        last7_lessons: lessonsSince(7 * 864e5),
      },
      months, paid_total_sats: paidTotal,
      funding: { rows: funding, total_sats: funding.reduce((a, r) => a + r.amount_sats, 0),
                 total_zar: funding.reduce((a, r) => a + (r.amount_zar || 0), 0), sponsors: new Set(funding.map(r => r.sponsor)).size },
      sponsors: [...sponsorWalls.values()].sort((a, b) => b.walls - a.walls || a.name.localeCompare(b.name)),
      accountability,
    };
  }

  /* -------------------------------------------------------------- map settings (changed in the admin app) */
  function mapSettings() {
    const r = db.prepare("select place_name, sections, updated_by, updated_at from dash_map where id = 1").get()
      || { place_name: "JCC Camp, Mossel Bay", sections: "[]" };
    let list = [];
    try { list = JSON.parse(r.sections); } catch { list = []; }
    return { place_name: r.place_name, sections: Array.isArray(list) ? list : [], updated_by: r.updated_by || null, updated_at: r.updated_at || null };
  }
  function saveMap(body, user) {
    const place = String(body?.place_name ?? "").trim();
    if (!place || place.length > 80) throw new Bad("Type the place name (at most 80 letters).");
    const list = Array.isArray(body?.sections) ? body.sections : [];
    if (list.length > 8) throw new Bad("At most 8 sections.");
    const seen = new Set();
    const sections = list.map(x => {
      const name = String(x?.name ?? "").trim();
      if (!name || name.length > 40) throw new Bad("Each section needs a name (at most 40 letters).");
      if (seen.has(name.toLowerCase())) throw new Bad(`"${name}" is in the list twice.`);
      seen.add(name.toLowerCase());
      const num = v => (v === null || v === undefined || v === "" ? null : Number(v));
      const lat = num(x.lat), lng = num(x.lng), radius = num(x.radius_m) ?? 100;
      if ((lat === null) !== (lng === null)) throw new Bad(`${name}: give both numbers of the place, or neither.`);
      if (lat !== null && !(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new Bad(`${name}: that place is not on the map.`);
      if (!(radius >= 20 && radius <= 3000)) throw new Bad(`${name}: the circle size must be between 20 and 3000 metres.`);
      const r6 = v => (v === null ? null : Math.round(v * 1e6) / 1e6);
      return { name, lat: r6(lat), lng: r6(lng), radius_m: Math.round(radius) };
    });
    db.prepare("update dash_map set place_name = ?, sections = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = 1")
      .run(place, JSON.stringify(sections), user?.full_name || null);
    cache = null;
    return mapSettings();
  }

  /* -------------------------------------------------------------- public report settings (changed in the admin app) */
  function reportSettings() {
    const r = db.prepare("select * from report_settings where id = 1").get() || {};
    return {
      agreements_signed: r.agreements_signed ?? null, agreement_url: r.agreement_url || null, carried_over_sats: r.carried_over_sats ?? null,
      pending_walls: r.pending_walls ?? null, pending_note: r.pending_note || null, review_walls: r.review_walls ?? null, review_note: r.review_note || null,
      questions: String(r.questions || "").split("\n").map(q => q.trim()).filter(Boolean), show_draft_note: r.show_draft_note !== 0,
      updated_by: r.updated_by || null, updated_at: r.updated_at || null,
    };
  }
  function saveReport(body, user) {
    const count = (k, label) => {
      const v = body?.[k];
      if (v === null || v === undefined || v === "") return null;
      const x = Number(v);
      if (!Number.isInteger(x) || x < 0 || x > 1e12) throw new Bad(`${label} must be a whole number, 0 or more.`);
      return x;
    };
    const text = (k, max) => {
      const v = String(body?.[k] ?? "").trim();
      if (v.length > max) throw new Bad("One of the notes is too long.");
      return v || null;
    };
    const url = text("agreement_url", 2000);
    if (url && !webLink(url)) throw new Bad("The agreement link must start with https://");
    const qs = (Array.isArray(body?.questions) ? body.questions : String(body?.questions ?? "").split("\n")).map(q => String(q).trim()).filter(Boolean);
    if (qs.length > 20 || qs.some(q => q.length > 300)) throw new Bad("At most 20 questions, each at most 300 letters.");
    db.prepare(`update report_settings set agreements_signed = ?, agreement_url = ?, carried_over_sats = ?, pending_walls = ?, pending_note = ?,
                review_walls = ?, review_note = ?, questions = ?, show_draft_note = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = 1`)
      .run(count("agreements_signed", "Signed agreements"), url, count("carried_over_sats", "Left over from last year"),
           count("pending_walls", "Payment pending"), text("pending_note", 200), count("review_walls", "Under review"), text("review_note", 200),
           qs.join("\n"), body?.show_draft_note === false ? 0 : 1, user?.full_name || null);
    cache = null;
    return reportSettings();
  }

  function get() {
    if (!cache || Date.now() - cacheAt > CACHE_MS) { cache = JSON.stringify(build()); cacheAt = Date.now(); }
    return cache;
  }

  function routes(req, res, p, method) {
    if (p !== "/api/public/dashboard") return false;
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (method === "OPTIONS") return send(res, 204, "", { ...cors, "Access-Control-Allow-Methods": "GET" });
    if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "Read only" }, cors);
    return send(res, 200, get(), { ...cors, "Cache-Control": `public, max-age=${Math.min(30, Math.round(CACHE_MS / 1000))}` });
  }

  return { routes, build, mapSettings, saveMap, reportSettings, saveReport, clear: () => { cache = null; } };
}

module.exports = { init };
