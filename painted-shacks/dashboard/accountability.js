// Painted Shacks Accountability: the main public dashboard (/dashboard/). Live data from /api/public/dashboard, laid out like the
// team's accountability draft (25 Nov 2026). Where the apps don't have the information yet, the draft's own text and made-up
// numbers stay, marked SAMPLE (made up) or DRAFT 25 NOV (copied from the draft), until the apps can fill them.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const n = v => Number(v || 0).toLocaleString("en-US");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => (typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const day = d => { const t = new Date(d + "T12:00:00Z"); return t.getUTCDate() + " " + MON[t.getUTCMonth()] + " " + t.getUTCFullYear(); };
  const short = v => (v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M" : v >= 1e4 ? Math.round(v / 1e3) + "k" : n(v));
  const plural = (k, one, many) => n(k) + " " + (k === 1 ? one : many || one + "s");
  const SAMPLE = '<span class="tag">SAMPLE</span>';
  const DRAFT = '<span class="tag grey">DRAFT 25 NOV</span>';

  /* ------------------------------------------------------------------ the draft's numbers (used only where the apps have nothing yet) */
  const D = {
    paidToFamilies: 2700000,
    walls: [{ group: "support", label: "Payment pending", count: 2, desc: "Said yes for 2026, invoice sent." },
            { group: "not", label: "Under review", count: 1, desc: "Being talked through with the logo's owner." }],
    classes: { count: 11, avg: 33, months: [29, 31, 30, 33, 32, 34, 31, 35, 36, 34, 37] },
    sum: [["Left over from 2025", "1,200,000"], ["Received in 2026", "+6,100,000"], ["Paid out in 2026", "−3,985,000"]], held: "3,315,000",
    spend: [["Families", 68, "2.7M", "Monthly payouts in sats to every family in the program."],
            ["Paint and upkeep", 17, "685k", "Paint, brushes and labour for new and repainted walls."],
            ["Running the program", 8, "330k", "The monthly class: venue and snacks."],
            ["Partnerships", 7, "270k", "Finding partners and making their posts."]],
    // Ledger lines of kinds the apps don't record (costs, donations, carry-over). Monthly payouts are used only if the app has none yet.
    costs: [["2026-11-14", "Monthly class: venue and snacks", 0, 30000], ["2026-10-14", "Monthly class: venue and snacks", 0, 30000],
            ["2026-09-30", "Repaint for a new partner wall", 0, 85000], ["2026-09-15", "Outreach and partner posts", 0, 150000],
            ["2026-09-14", "Monthly class: venue and snacks", 0, 30000], ["2026-08-14", "Monthly class: venue and snacks", 0, 30000],
            ["2026-08-12", "Annual repaint: paint, brushes, labour", 0, 460000], ["2026-07-14", "Monthly class: venue and snacks", 0, 30000],
            ["2026-06-14", "Monthly class: venue and snacks", 0, 30000], ["2026-05-19", "Donation", 250000, 0],
            ["2026-05-14", "Monthly class: venue and snacks", 0, 30000], ["2026-04-30", "Outreach and partner posts", 0, 120000],
            ["2026-04-14", "Monthly class: venue and snacks", 0, 30000], ["2026-03-14", "Monthly class: venue and snacks", 0, 30000],
            ["2026-02-20", "Touch-up paint", 0, 140000], ["2026-02-14", "Monthly class: venue and snacks", 0, 30000],
            ["2026-01-14", "Monthly class: venue and snacks", 0, 30000], ["2026-01-01", "Carried over from 2025", 1200000, 0]],
    payouts: ["2026-10-28", "2026-09-28", "2026-08-28", "2026-07-28", "2026-06-28", "2026-05-28", "2026-04-28", "2026-03-28", "2026-02-28", "2026-01-28"]
      .map(d => [d, "Monthly payout to families", 0, 270000]),
    // Partner posts and reach from the draft, by partner name.
    posts: [{ match: /aqua/i, video: "15 Jul 2026", x: "https://x.com/BitcoinEkasi/status/2077407843066536261", impressions: "11,820", views: "2,745" },
            { match: /^casa$/i, video: "18 Nov 2026", x: "https://x.com/BitcoinEkasi/status/2123060784230002917",
              nostr: "https://primal.net/e/nevent1qqsx9t62yzucr35uqtqmzdgvenmavvsmn0k6vmzmh4y3gaxnjj537tcmdh5ew", note: "Reach is added four weeks after posting." },
            { match: /^fedi$/i, soon: true }],
  };

  const root = document.documentElement;
  try { const t = localStorage.getItem("ps-acc-theme"); if (t === "light" || t === "dark") root.dataset.theme = t; } catch (e) { /* private mode */ }
  $("theme").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("ps-acc-theme", root.dataset.theme); } catch (e) { /* ignore */ }
  });

  function render(d) {
    const a = d.accountability, y = a.year, pr = d.programme, M = a.money, L = a.learning;
    const walls = a.walls.reduce((s, w) => s + w.count, 0);
    const partners = a.partners.length, paidPartners = a.partners.filter(p => p.type === "paid").length;
    const place = d.place || "JCC Camp, Mossel Bay";
    $("kicker").textContent = "Bitcoin Ekasi · " + place;
    $("lead").textContent = plural(walls, "logo wall") + " are painted on family homes in " + place.split(",")[0] + ". " +
      plural(partners, "partner") + " back the programme in " + y + (paidPartners ? ", " + paidPartners + " of them in sats." : ".");

    // Top numbers
    $("s-walls").textContent = n(walls);
    $("s-partners-k").textContent = "Partners in " + y; $("s-partners").textContent = n(partners);
    $("s-paid-k").innerHTML = "Paid to families in " + y + (M.paid_to_families_sats ? "" : " " + SAMPLE);
    $("s-paid").innerHTML = esc(M.paid_to_families_sats ? short(M.paid_to_families_sats) : short(D.paidToFamilies)) + " <small>sats</small>";

    // Walls: real groups from the app, plus the draft's two statuses the app doesn't have
    const rows = [...a.walls.filter(w => w.count), ...D.walls.map(w => ({ ...w, draft: true }))];
    const max = Math.max(1, ...rows.map(w => w.count));
    const group = (g, title) => '<div class="grp">' + title + "</div>" + rows.filter(w => w.group === g).map(w =>
      '<div class="row"><div class="h"><b>' + esc(w.label) + (w.draft ? " " + DRAFT : "") + '</b><span class="n">' + n(w.count) + '</span></div><div class="bar' +
      (g === "not" ? " muted" : "") + '"><i style="width:' + Math.round(w.count / max * 100) + '%"></i></div><p>' + esc(w.desc) + "</p></div>").join("");
    $("wallcard").innerHTML = group("support", "Supporting the program in " + y) + '<div style="height:12px"></div>' + group("not", "Not sponsored in " + y);

    // Terms
    $("t-pay").textContent = n(pr.sats_per_week) + " sats for each finished week, up to " + n(pr.sats_per_week * pr.max_weeks) + " sats a month, paid over Lightning on the last Friday of the month.";
    $("toc-agree").innerHTML = SAMPLE;

    // Learning: real once the first lessons are finished, the draft's class numbers until then
    const real = L.lessons > 0;
    $("l-tag").hidden = real; $("l-note").hidden = real; $("toc-learn").innerHTML = real ? "›" : SAMPLE;
    if (real) {
      const cur = L.months[L.months.length - 1] || { households: 0 };
      $("l-k1").textContent = "Lessons finished in " + y; $("l-lessons").textContent = n(L.lessons); $("l-s1").textContent = "Each one is a lesson read and a quiz passed";
      $("l-k2").textContent = "Households learning this month"; $("l-house").textContent = n(cur.households);
      $("l-house-s").textContent = "of " + plural(a.households, "household") + " in the programme";
      $("l-chart-t").textContent = "Households that finished a lesson, each month";
      const months = L.months.filter(m => !pr.start_date || m.period >= pr.start_date.slice(0, 7));
      cols(months.map(m => [MON[+m.period.slice(5) - 1], m.households]), Math.max(1, a.households));
    } else {
      $("l-desc").textContent = "Lessons are done on the phone, so families who can't come to a class still learn." + (pr.start_date && !pr.started ? " The first lessons open on " + day(pr.start_date) + "." : "");
      $("l-k1").textContent = "Bitcoin classes this year"; $("l-lessons").textContent = D.classes.count; $("l-s1").textContent = "";
      $("l-k2").textContent = "Households at each class, on average"; $("l-house").textContent = D.classes.avg; $("l-house-s").textContent = "";
      $("l-chart-t").innerHTML = "Households at each monthly class " + SAMPLE;
      cols(D.classes.months.map((v, i) => [MON[i], v]), Math.max(...D.classes.months));
    }

    // Money: the draft's totals (costs and money held aren't in the apps), real lines where the apps have them
    $("toc-money").innerHTML = SAMPLE;
    $("m-title").textContent = "This year so far, in sats";
    $("m-sum").innerHTML = D.sum.map(([k, v]) => "<div><span>" + k + "</span><span>" + v + "</span></div>").join("") +
      '<div class="big"><span>Held now</span><b>' + D.held + "</b></div>";
    $("m-real").innerHTML = "Real so far: <b>" + n(M.received_sats) + " sats</b> received from partners in " + y +
      (M.received_zar ? " (R" + M.received_zar.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ")" : "") +
      " and <b>" + n(M.paid_to_families_sats) + " sats</b> paid to families through the app.";
    $("m-spend").innerHTML = D.spend.map(([k, p, sats, desc]) => '<div class="row spend"><div class="h"><b>' + k + '</b><span><span class="pct">' + p + "%</span><small>" + sats + ' sats</small></span></div><div class="bar"><i style="width:' + p + '%"></i></div><p>' + desc + "</p></div>").join("");
    const ledger = M.ledger.map(r => ({ date: r.date, what: r.what + (r.from ? " · " + r.from : ""), in: r.in_sats, out: r.out_sats }));
    const hasPayouts = M.ledger.some(r => r.out_sats > 0);
    const sample = [...D.costs, ...(hasPayouts ? [] : D.payouts)].filter(r => r[0].startsWith(y)).map(([date, what, i, o]) => ({ date, what, in: i, out: o, sample: true }));
    const all = [...ledger, ...sample].sort((p, q) => q.date.localeCompare(p.date) || (p.sample ? 1 : -1));
    $("m-rows").innerHTML = all.map(r => "<tr><td>" + esc(day(r.date)) + "</td><td>" + esc(r.what) + (r.sample ? " " + SAMPLE : "") +
      '</td><td class="r in">' + (r.in ? n(r.in) : "") + '</td><td class="r">' + (r.out ? n(r.out) : "") + '</td><td class="proof">Link when live</td></tr>').join("");

    // Partners: real partners and walls; video posts and reach from the draft
    $("p-list").innerHTML = a.partners.map(p => {
      const site = safeUrl(p.website), extra = D.posts.find(x => x.match.test(p.name));
      const posts = (p.posts || []).map(safeUrl).filter(Boolean);
      let h = '<div class="card"><h3>' + (site ? '<a href="' + esc(site) + '" target="_blank" rel="noopener">' + esc(p.name) + " ↗</a>" : esc(p.name)) + "</h3>" +
        "<p>" + (p.type === "paid" ? "Paid partner" : "In-kind partner") + "</p>" +
        "<p>" + plural(p.walls, "wall") + ": shack " + p.shacks.map(x => "#" + x).join(", ") + "</p>" +
        (p.last_paid_on ? "<p>Paid " + esc(day(p.last_paid_on)) + (p.renews_on ? " · renews " + esc(day(p.renews_on)) : "") + "</p>" : "");
      const links = [];
      if (extra && !extra.soon) {
        h += "<p>Video posted " + esc(extra.video) + " " + DRAFT + "</p>";
        if (extra.x) links.push('<a href="' + esc(extra.x) + '" target="_blank" rel="noopener">Watch on X ↗</a>');
        if (extra.nostr) links.push('<a href="' + esc(extra.nostr) + '" target="_blank" rel="noopener">Watch on nostr ↗</a>');
      } else if (extra && extra.soon) h += "<p>Video coming soon</p>";
      posts.forEach((u, i) => links.push('<a href="' + esc(u) + '" target="_blank" rel="noopener">' + (posts.length > 1 ? "Wall " + (i + 1) + " photo on X" : "Wall photo on X") + " ↗</a>"));
      if (links.length) h += '<div class="links">' + links.join("") + "</div>";
      if (extra && extra.impressions) h += '<div class="reach"><div><b>' + extra.impressions + "</b><span>impressions on X</span></div><div><b>" + extra.views + "</b><span>video views</span></div></div>";
      if (extra && extra.note) h += "<p>" + esc(extra.note) + "</p>";
      return h + "</div>";
    }).join("") || '<p class="empty">Partners show here once their payment or support is recorded.</p>';

    $("updated").textContent = "Numbers updated " + new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Johannesburg", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(d.generated_at)) + " (South Africa time).";
    $("app").setAttribute("aria-busy", "false");
  }

  function cols(list, mx) {
    $("l-cols").innerHTML = list.map(([label, v]) => "<div><b>" + (v || "") + '</b><i style="height:' + Math.max(1, Math.round(v / mx * 100)) + '%"></i><span>' + label + "</span></div>").join("");
    $("l-cols").setAttribute("aria-label", list.map(([label, v]) => label + ": " + v).join(", "));
  }

  let timer = null;
  async function load() {
    try {
      const r = await fetch("/api/public/dashboard", { headers: { Accept: "application/json" }, cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      render(await r.json());
    } catch (err) {
      console.error(err);
      if ($("app").getAttribute("aria-busy") === "true") $("lead").textContent = "Can't reach the live numbers right now. Trying again in a minute.";
    }
    clearTimeout(timer);
    timer = setTimeout(load, 60000);
  }
  load();
})();
