// Painted Shacks public dashboard. Reads /api/public/dashboard (non-private totals only) and refreshes every minute.
(function () {
  "use strict";
  const API = "/api/public/dashboard";
  const $ = id => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const TZ = "Africa/Johannesburg";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const n = v => Number(v || 0).toLocaleString("en-US");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => (typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);
  const pad3 = v => "#" + String(v).padStart(3, "0");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dObj = d => new Date(d + "T12:00:00Z");
  const short = d => { const t = dObj(d); return t.getUTCDate() + " " + MONTHS[t.getUTCMonth()]; };
  const long = d => { const t = dObj(d); return WD[t.getUTCDay()] + " " + t.getUTCDate() + " " + LONG[t.getUTCMonth()]; };
  const monthYear = d => { const t = dObj(d); return LONG[t.getUTCMonth()] + " " + t.getUTCFullYear(); };
  const dayDiff = (a, b) => Math.round((dObj(b) - dObj(a)) / 864e5);
  const saParts = iso => {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const p = Object.fromEntries(f.formatToParts(iso ? new Date(iso) : new Date()).map(x => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, hms: `${p.hour}:${p.minute}:${p.second}` };
  };
  const setBar = (id, part, of) => { $(id).style.width = (of > 0 ? Math.max(0, Math.min(100, Math.round(part / of * 100))) : 0) + "%"; };
  const plural = (k, one, many) => n(k) + " " + (k === 1 ? one : many || one + "s");

  // Theme toggle
  const root = document.documentElement;
  $("theme").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("ps-theme", root.dataset.theme); } catch (e) { /* private mode */ }
  });
  try { const t = localStorage.getItem("ps-theme"); if (t === "light" || t === "dark") root.dataset.theme = t; } catch (e) { /* ignore */ }

  // Clock (South Africa time)
  const tick = () => { $("clock").textContent = "live · " + saParts().hms; };
  tick(); setInterval(tick, 1000);

  let data = null, seenFeed = null;

  /* ------------------------------------------------------------------ hero */
  function hero(d) {
    const r = d.round, pr = d.programme, today = d.today;
    $("h-title").textContent = d.month.title.split(" ")[0] + " stats";
    if (!pr.started && pr.start_date) {
      const left = dayDiff(today, pr.start_date);
      $("h-lead").innerHTML = "Lessons start on <b>" + esc(long(pr.start_date)) + "</b>. Owners learn on their phones and earn <b>" +
        n(pr.sats_per_week) + " sats</b> for every lesson they finish.";
      $("h-cap").textContent = (left === 1 ? "1 day to go" : left + " days to go") + " · " + pr.total_weeks + " weekly lessons · first payday " + short(r.pay_date);
      const span = 30; setBar("h-fill", Math.max(0, span - left), span);
      $("h-bracket").setAttribute("aria-label", left + " days until lessons start");
    } else {
      $("h-lead").innerHTML = r.lessons
        ? "<b>" + plural(r.owners, "owner") + "</b> finished <b>" + plural(r.lessons, "lesson") + "</b> and will earn <b>" + n(r.sats) + " sats</b> on " + esc(WD[dObj(r.pay_date).getUTCDay()]) + "."
        : "New lessons are open. Every lesson an owner finishes adds <b>" + n(pr.sats_per_week) + " sats</b> to payday on " + esc(WD[dObj(r.pay_date).getUTCDay()]) + ".";
      const left = dayDiff(today, r.pay_date);
      $("h-cap").textContent = "Payday " + long(r.pay_date) + (left > 0 ? " · in " + plural(left, "day") : left === 0 ? " · today" : "") +
        " · " + pr.published_lessons + " of " + pr.total_weeks + " lessons open";
      const m = Number(today.slice(8, 10)), len = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).getUTCDate();
      setBar("h-fill", m, len);
      $("h-bracket").setAttribute("aria-label", m + " of " + len + " days of " + d.month.title + " gone");
    }
    const t = d.tiles;
    const txt = (id, v, isText) => { $(id).textContent = v; $(id).classList.toggle("txt", !!isText); };
    $("t-painted").textContent = t.shacks_painted.value + "/" + t.shacks_painted.of; setBar("t-painted-bar", t.shacks_painted.value, t.shacks_painted.of);
    txt("t-week", pr.started ? t.lesson_this_week.value + "/" + t.lesson_this_week.of : "starts " + short(pr.start_date), !pr.started);
    setBar("t-week-bar", t.lesson_this_week.value, t.lesson_this_week.of);
    txt("t-good", t.good_condition.of ? t.good_condition.value + "/" + t.good_condition.of : "no checks yet", !t.good_condition.of);
    setBar("t-good-bar", t.good_condition.value, t.good_condition.of);
    txt("t-ontime", t.paid_on_time.of ? t.paid_on_time.pct + "%" : "first payday " + short(r.pay_date), !t.paid_on_time.of);
    setBar("t-ontime-bar", t.paid_on_time.value, t.paid_on_time.of);
  }

  /* ------------------------------------------------------------------ map + sections */
  const AREAS = [{ x: 140, y: 86 }, { x: 375, y: 92 }, { x: 140, y: 224 }, { x: 362, y: 220 }];
  const LETTERS = ["A", "B", "C", "D"];
  let mapTimer = null, paused = false, mapKey = "";
  function sections(d) {
    const secs = d.sections.filter(s => s.shacks > 0);
    const key = JSON.stringify(secs);
    if (key === mapKey) return;            // nothing changed: keep the map as it is
    mapKey = key;
    const dots = $("dots"), pins = $("pins"), rank = $("rank");
    dots.textContent = ""; pins.textContent = "";
    const named = secs.filter(s => s.name);
    const single = named.length === 0;     // no areas typed in yet: one group for all of KwaNonqaba
    const onMap = single ? [] : secs.slice(0, 4);
    let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const dot = (x, y, id) => { const r = document.createElementNS(NS, "rect"); r.setAttribute("x", x.toFixed(1)); r.setAttribute("y", y.toFixed(1)); r.setAttribute("width", 6); r.setAttribute("height", 6); r.setAttribute("fill", "var(--orange)"); r.setAttribute("stroke", "var(--ink)"); r.setAttribute("stroke-width", ".8"); r.dataset.s = id; dots.appendChild(r); };
    if (single) {
      const total = secs.reduce((a, s) => a + s.shacks, 0);
      for (let i = 0; i < total; i++) { const a = AREAS[i % 4]; dot(a.x - 70 + rnd() * 140, a.y - 40 + rnd() * 80, "all"); }
      const g = document.createElementNS(NS, "g");
      g.innerHTML = '<circle cx="256" cy="158" r="26" fill="var(--orange)" fill-opacity=".35" stroke="var(--ink)" class="ring"/><rect x="252" y="154" width="8" height="8" fill="var(--ink)"/><text x="286" y="163" style="paint-order:stroke" stroke="var(--bg)" stroke-width="4">' + total + ' shacks</text>';
      pins.appendChild(g);
      rank.innerHTML = '<button class="on" data-s="all"><span class="n">1</span><span><b>KwaNonqaba</b></span><span class="m">' + plural(total, "shack") + " · " + plural(secs.reduce((a, x) => a + x.lessons, 0), "lesson") + "</span></button>";
      $("rank-note").hidden = false;
      $("rank-note").textContent = "Sections show here once each shack has its part of KwaNonqaba filled in.";
      $("mapbtn").hidden = true;
      if (mapTimer) clearInterval(mapTimer), mapTimer = null;
      $("mapsvg").setAttribute("aria-label", "Sketch map of KwaNonqaba with " + total + " painted shacks");
      return;
    }
    onMap.forEach((s, i) => {
      const a = AREAS[i];
      for (let k = 0; k < s.shacks; k++) dot(a.x - 70 + rnd() * 140, a.y - 40 + rnd() * 80, String(i));
      const g = document.createElementNS(NS, "g"); g.dataset.s = String(i);
      g.innerHTML = '<circle cx="' + a.x + '" cy="' + a.y + '" r="18" fill="var(--bg)" fill-opacity=".85" stroke="var(--ink)" class="ring"/><rect x="' + (a.x - 4) + '" y="' + (a.y - 4) + '" width="8" height="8" fill="var(--ink)"/><text x="' + (a.x + 24) + '" y="' + (a.y + 5) + '" style="paint-order:stroke" stroke="var(--bg)" stroke-width="4">' + LETTERS[i] + " " + s.shacks + "</text>";
      pins.appendChild(g);
    });
    rank.innerHTML = secs.map((s, i) => '<button data-s="' + (i < 4 ? i : "x" + i) + '"><span class="n">' + (i < 4 ? LETTERS[i] : i + 1) + "</span><span><b>" +
      esc(s.name || "Area not set yet") + "</b></span><span class=\"m\">" + plural(s.shacks, "shack") + " · " + plural(s.lessons, "lesson") + "</span></button>").join("");
    const extra = secs.length - onMap.length;
    $("rank-note").hidden = !extra;
    if (extra) $("rank-note").textContent = "The sketch shows the four biggest sections.";
    $("mapsvg").setAttribute("aria-label", "Sketch map of KwaNonqaba with sections of painted shacks: " + onMap.map((s, i) => LETTERS[i] + " " + (s.name || "no area") + " " + s.shacks).join(", "));
    let cur = 0;
    const focus = id => {
      rank.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.s === id));
      pins.querySelectorAll("g").forEach(g => { const on = g.dataset.s === id, r = g.querySelector(".ring"); r.setAttribute("r", on ? 26 : 18); r.setAttribute("fill", on ? "var(--orange)" : "var(--bg)"); r.setAttribute("fill-opacity", on ? ".35" : ".85"); });
      dots.querySelectorAll("rect").forEach(r => r.setAttribute("opacity", r.dataset.s === id ? 1 : 0.45));
    };
    rank.onclick = e => { const b = e.target.closest("button"); if (!b) return; paused = true; $("mapbtn").textContent = "[ PLAY ]"; focus(b.dataset.s); };
    focus("0");
    $("mapbtn").hidden = onMap.length < 2 || reduce;
    if (mapTimer) clearInterval(mapTimer), mapTimer = null;
    if (!reduce && onMap.length > 1) mapTimer = setInterval(() => { if (paused) return; cur = (cur + 1) % onMap.length; focus(String(cur)); }, 3000);
  }
  $("mapbtn").addEventListener("click", () => { paused = !paused; $("mapbtn").textContent = paused ? "[ PLAY ]" : "[ PAUSE ]"; });

  /* ------------------------------------------------------------------ feed */
  const RESULT = { good: "good condition", touch_up: "logo needs a touch-up", repaint: "needs a repaint" };
  function feedText(e) {
    switch (e.kind) {
      case "lesson": return ["✓", "Shack " + pad3(e.shack?.shack_no ?? "?") + " finished lesson " + e.week_no + " · +" + n(e.sats) + " sats"];
      case "inspection": return ["◉", "Shack " + pad3(e.shack.shack_no) + " inspected · " + (RESULT[e.result] || e.result)];
      case "payout_drafted": return ["₿", e.title.split(" ")[0] + " payout drafted · " + n(e.sats) + " sats for " + plural(e.owners, "owner")];
      case "payout_sent": return ["⚡", e.title.split(" ")[0] + " payout sent · " + n(e.sats) + " sats to " + plural(e.owners, "owner")];
      case "sponsor": return ["★", e.sponsor + " paid " + n(e.sats) + " sats for a logo"];
      case "painted": return ["▣", "Shack " + pad3(e.shack.shack_no) + " painted"];
    }
    return ["·", e.kind];
  }
  function feedTime(e, today) {
    if (e.day_only) { const d = e.at.slice(0, 10); return d === today ? "today" : short(d); }
    const p = saParts(e.at);
    if (p.day === today) return p.hm;
    const diff = dayDiff(p.day, today);
    return diff < 7 ? WD[dObj(p.day).getUTCDay()].slice(0, 3) : short(p.day);
  }
  function feed(d) {
    const ul = $("feedlist");
    const keyOf = e => e.kind + e.at + (e.shack?.shack_no ?? "") + (e.week_no ?? "");
    ul.textContent = "";
    for (const e of d.feed) {
      const [ic, txt] = feedText(e);
      const li = document.createElement("li");
      if (seenFeed && !seenFeed.has(keyOf(e)) && !reduce) li.className = "new";
      li.innerHTML = '<time></time><span class="ic"></span><span><span class="ft"></span><span class="meta" hidden></span></span>';
      li.children[0].textContent = feedTime(e, d.today);
      li.children[1].textContent = ic;
      li.querySelector(".ft").textContent = txt;
      if (e.shack) {
        const meta = li.querySelector(".meta"); meta.hidden = false;
        const addr = e.shack.address_state === "public" ? "⚡ " + e.shack.address : e.shack.address_state === "private" ? "⚡ address kept private" : "";
        meta.innerHTML = (e.shack.logo ? '<span class="logo-tag"></span>' : "") + (addr ? '<span class="ln"></span>' : "");
        if (e.shack.logo) meta.querySelector(".logo-tag").textContent = "Logo: " + e.shack.logo;
        if (addr) { const ln = meta.querySelector(".ln"); ln.textContent = addr; if (e.shack.address_state !== "public") ln.classList.add("priv"); }
        if (!meta.children.length) meta.hidden = true;
      }
      ul.appendChild(li);
    }
    seenFeed = new Set(d.feed.map(keyOf));
    $("feed-empty").hidden = d.feed.length > 0;
  }

  /* ------------------------------------------------------------------ lessons per day */
  function days(d) {
    const max = Math.max(5, ...d.days.map(x => x.lessons));
    $("days").innerHTML = d.days.map(x => '<div class="day' + (x.today ? " today" : "") + (x.future ? " future" : "") + '"><div class="col"><i style="height:' +
      Math.round(x.lessons / max * 100) + '%"></i></div><span>' + WD[dObj(x.day).getUTCDay()].slice(0, 3) + "</span></div>").join("");
    const t = d.days.find(x => x.today);
    $("today-cap").textContent = "Today: " + plural(t ? t.lessons : 0, "lesson") + " finished";
    $("days-from").textContent = short(d.days[0].day); $("days-to").textContent = short(d.days[6].day);
    $("days-desc").textContent = d.programme.started
      ? "Owners finish lessons on their phones in their own time. A new lesson opens for each owner every Monday."
      : "Lessons start on " + long(d.programme.start_date) + ". Each finished lesson shows up here the same minute.";
  }

  /* ------------------------------------------------------------------ highlights */
  function highlights(d) {
    const h = d.highlights;
    $("hl-desc").textContent = "This payout round: lessons that count towards " + d.round.title.split(" ")[0] + " payday on " + long(d.round.pay_date) + ".";
    $("hl-lessons").textContent = n(h.lessons); $("hl-owners").textContent = n(h.owners_learning); $("hl-sats").textContent = n(h.sats);
    $("hl-insp").textContent = n(h.shacks_inspected); $("hl-first").textContent = h.first_try_pct == null ? "–" : h.first_try_pct + "%";
    const facts = [];
    if (h.best_day) facts.push("Most lessons in a day: <b>" + n(h.best_day.lessons) + "</b>, on " + esc(short(h.best_day.day)) + ".");
    if (h.busiest) facts.push("Busiest time: <b>" + String(h.busiest.from).padStart(2, "0") + ":00 to " + String(h.busiest.to % 24).padStart(2, "0") + ":00</b>.");
    if (h.newest_shack) facts.push("Newest shack: <b>" + pad3(h.newest_shack.shack_no) + "</b>, painted " + esc(short(h.newest_shack.painted_on)) + ".");
    facts.push("Lessons finished since the start: <b>" + n(h.lessons_all_time) + "</b>.");
    $("hl-facts").innerHTML = facts.join(" &nbsp; ");
    $("hl-recent").innerHTML = "Last 48 hours: <b>" + plural(h.last48.lessons, "lesson") + "</b>, " + plural(h.last48.inspections, "inspection") + ", " +
      plural(h.last48.failed_payments, "missed payment") + ". Last 7 days: <b>" + plural(h.last7_lessons, "lesson") + "</b>.";
  }

  /* ------------------------------------------------------------------ months */
  function months(d) {
    const rows = d.months, max = Math.max(1, ...rows.map(m => m.sats));
    const first = rows.find(m => !m.upcoming);
    $("months-desc").innerHTML = first
      ? "<b>" + n(d.paid_total_sats) + " sats</b> paid to shack owners through the app since " + esc(LONG[+first.period.slice(5, 7) - 1] + " " + first.period.slice(0, 4)) + ", in sats per month."
      : "Payments made through the app show here month by month. The first payday is <b>" + esc(long(d.round.pay_date)) + "</b>.";
    $("months").innerHTML = rows.map(m => '<div class="mrow' + (m.upcoming ? " now" : "") + '"><div><b>' + esc(m.title.split(" ")[0]) + "</b><small" + (m.upcoming ? ' class="up"' : "") + ">" +
      (m.upcoming ? "pays " : "paid ") + esc(short(m.paid_on)) + '</small></div><div class="mbar"><i style="width:calc((100% - 90px) * ' + (m.sats / max).toFixed(3) + ')"></i><span>' +
      n(m.sats) + (m.upcoming ? " so far" : "") + "</span></div></div>").join("");
  }

  /* ------------------------------------------------------------------ funding */
  function funding(d) {
    const f = d.funding;
    $("f-sats").textContent = n(f.total_sats);
    $("f-zar").textContent = "R" + f.total_zar.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    $("f-n").textContent = n(f.sponsors);
    const link = (name, url) => { const u = safeUrl(url); return u ? '<a class="spl" href="' + esc(u) + '" target="_blank" rel="noopener"><b>' + esc(name) + "</b> ↗</a>" : "<b>" + esc(name) + "</b>"; };
    const dmy = d => d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
    $("f-rows").innerHTML = f.rows.map(r => "<tr><td>" + dmy(r.received_on) + "</td><td>" + esc(r.purpose === "Painted Shacks" ? "Logo on a shack" : r.purpose) + "</td><td>" + link(r.sponsor, r.website) +
      '</td><td class="r">' + (r.amount_zar != null ? "R" + Number(r.amount_zar).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "–") +
      '</td><td class="r">' + n(r.amount_sats) + "</td><td>" + (r.renews_on ? "Yearly · due " + esc(MONTHS[+r.renews_on.slice(5, 7) - 1] + " " + r.renews_on.slice(0, 4)) : "–") + "</td></tr>").join("");
    $("f-tzar").textContent = $("f-zar").textContent; $("f-tsats").textContent = n(f.total_sats);
    $("f-wrap").hidden = !f.rows.length; $("f-empty").hidden = !!f.rows.length;
    const up = f.rows.filter(r => r.renews_on && r.renews_on >= d.today).sort((a, b) => a.renews_on.localeCompare(b.renews_on)).slice(0, 2);
    $("renew").innerHTML = up.map((r, i) => {
      const total = Math.max(1, dayDiff(r.received_on, r.renews_on)), gone = Math.max(0, dayDiff(r.received_on, d.today));
      const left = dayDiff(d.today, r.renews_on), mths = Math.round(left / 30.4);
      return '<div><span class="cap">' + (i ? "Then" : "Next renewal") + "</span><b>" + link(r.sponsor, r.website) + "</b><span>" + esc(monthYear(r.renews_on)) + " · " +
        (mths >= 1 ? "in about " + plural(mths, "month") : "in " + plural(left, "day")) + '</span><div class="pbar o"><i style="width:' + Math.min(100, Math.round(gone / total * 100)) + '%"></i></div></div>';
    }).join("");
  }

  /* ------------------------------------------------------------------ tips + sponsors */
  function tips(d) {
    const t = d.tips;
    $("tiplist").innerHTML = t.list.length
      ? t.list.map(x => "<div><b>" + pad3(x.shack_no) + "</b><code>" + esc(x.address) + "</code><button type=\"button\">COPY</button></div>").join("")
      : '<p class="empty">No owner has chosen to show their address yet.</p>';
    $("tip-count").textContent = t.list.length + " of " + plural(t.owners, "owner") + " show their address";
    $("sponsors").innerHTML = d.sponsors.map(s => { const u = safeUrl(s.website), label = esc(s.name) + (s.walls > 1 ? " <small>×" + s.walls + "</small>" : "");
      return u ? '<a class="spl chip-l" href="' + esc(u) + '" target="_blank" rel="noopener">' + label + " ↗</a>" : "<span>" + label + "</span>"; }).join("") ||
      '<p class="desc">Sponsors show here once their logo is on a wall.</p>';
  }
  $("tiplist").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const code = b.previousElementSibling, t = code.textContent;
    const done = () => { b.textContent = "COPIED"; setTimeout(() => (b.textContent = "COPY"), 1500); };
    const select = () => { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
    try { navigator.clipboard.writeText(t).then(done, select); } catch (err) { select(); }
  });

  /* ------------------------------------------------------------------ load + refresh */
  function render(d) {
    const parts = [hero, sections, feed, days, highlights, months, funding, tips];
    for (const fn of parts) { try { fn(d); } catch (err) { console.error(fn.name, err); } }
    $("app").setAttribute("aria-busy", "false");
    $("updated").textContent = "Numbers updated " + saParts(d.generated_at).hm + " (South Africa time).";
  }
  let timer = null, fails = 0;
  async function load() {
    try {
      const r = await fetch(API, { headers: { Accept: "application/json" }, cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json(); fails = 0;
      render(data);
      $("status").textContent = "● Live"; $("status").className = "status live";
    } catch (err) {
      fails++;
      $("status").textContent = data ? "Can't reach the live data. Showing the last numbers." : "Can't reach the live data right now. Trying again…";
      $("status").className = "status off";
    }
    clearTimeout(timer);
    const every = Math.max(30, (data && data.refresh_seconds) || 60) * 1000 * Math.min(4, 1 + fails);
    timer = setTimeout(() => { if (document.hidden) waitVisible(); else load(); }, every);
  }
  function waitVisible() { document.addEventListener("visibilitychange", function on() { if (!document.hidden) { document.removeEventListener("visibilitychange", on); load(); } }); }
  load();
})();
