// Painted Shacks accountability page for partners. Same live data as /dashboard (/api/public/dashboard), shown as a report.
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

  const root = document.documentElement;
  try { const t = localStorage.getItem("ps-acc-theme"); if (t === "light" || t === "dark") root.dataset.theme = t; } catch (e) { /* private mode */ }
  $("theme").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("ps-acc-theme", root.dataset.theme); } catch (e) { /* ignore */ }
  });

  function render(d) {
    const a = d.accountability, y = a.year;
    const walls = a.walls.reduce((s, w) => s + w.count, 0);
    const partners = a.partners.length, paidPartners = a.partners.filter(p => p.type === "paid").length;
    $("kicker").textContent = "Bitcoin Ekasi · " + (d.place || "JCC Camp, Mossel Bay");
    $("lead").textContent = plural(walls, "logo wall") + " are painted on family homes in " + (d.place || "JCC Camp").split(",")[0] + ". " +
      plural(partners, "partner") + " back the programme in " + y + (paidPartners ? ", " + paidPartners + " of them in sats." : ".");
    $("s-walls").textContent = n(walls);
    $("s-partners-k").textContent = "Partners in " + y; $("s-partners").textContent = n(partners);
    $("s-paid-k").textContent = "Paid to families in " + y;
    $("s-paid").innerHTML = esc(short(a.money.paid_to_families_sats)) + " <small>sats</small>";
    $("s-paid-s").textContent = a.money.paid_to_families_sats ? "All families together" : "First app payday: " + day(d.round.pay_date);

    // Walls
    const max = Math.max(1, ...a.walls.map(w => w.count));
    const group = (g, title) => '<div class="grp">' + title + "</div>" + a.walls.filter(w => w.group === g && w.count).map(w =>
      '<div class="row"><div class="h"><b>' + esc(w.label) + '</b><span class="n">' + n(w.count) + '</span></div><div class="bar' + (g === "not" ? " muted" : "") +
      '"><i style="width:' + Math.round(w.count / max * 100) + '%"></i></div><p>' + esc(w.desc) + "</p></div>").join("");
    $("wallcard").innerHTML = group("support", "Supporting the programme in " + y) + '<div style="height:12px"></div>' + group("not", "Not sponsored in " + y);

    // Terms
    const pr = d.programme;
    $("t-pay").textContent = n(pr.sats_per_week) + " sats for each finished week, up to " + n(pr.sats_per_week * pr.max_weeks) + " sats a month, paid over Lightning on the last Friday of the month.";

    // Learning
    const L = a.learning, cur = L.months[L.months.length - 1] || { households: 0 };
    $("l-k1").textContent = "Lessons finished in " + y; $("l-lessons").textContent = n(L.lessons);
    $("l-house").textContent = n(cur.households); $("l-house-s").textContent = "of " + plural(a.households, "household") + " in the programme";
    if (!pr.started && pr.start_date) $("l-desc").textContent = "Lessons start on " + day(pr.start_date) + ". They are done on the phone, so families who can't come to a class still learn. These numbers fill in as lessons are finished.";
    const shown = L.months.filter(m => !pr.start_date || m.period >= pr.start_date.slice(0, 7));
    const months = shown.length ? shown : L.months.slice(-1);
    const mx = Math.max(1, a.households, ...months.map(m => m.households));
    if (!pr.started) { $("l-cols").innerHTML = '<p class="empty" style="align-self:center;margin:auto">The chart starts in ' + esc(LONG[+pr.start_date.slice(5, 7) - 1]) + ", when the first lessons open.</p>"; $("l-cols").setAttribute("aria-label", "No lessons yet"); }
    else $("l-cols").innerHTML = months.map(m => '<div><b>' + (m.households || "") + '</b><i style="height:' + Math.max(1, Math.round(m.households / mx * 100)) + '%"></i><span>' + MON[+m.period.slice(5) - 1] + "</span></div>").join("");
    if (pr.started) $("l-cols").setAttribute("aria-label", months.map(m => LONG[+m.period.slice(5) - 1] + ": " + m.households + " households").join(", "));

    // Money
    const M = a.money;
    $("m-title").textContent = y + " so far, in sats";
    $("m-sum").innerHTML = '<div><span>Received from partners in ' + y + "</span><span>+" + n(M.received_sats) + "</span></div>" +
      "<div><span>Paid to families through the app</span><span>" + (M.paid_to_families_sats ? "−" : "") + n(M.paid_to_families_sats) + "</span></div>" +
      (M.fees_sats ? "<div><span>Lightning fees</span><span>−" + n(M.fees_sats) + "</span></div>" : "") +
      (M.received_zar ? '<div style="font-size:13px;color:var(--ink2)"><span>Partner money received, in rand when it arrived</span><span style="font:inherit">R' + M.received_zar.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "</span></div>" : "");
    $("m-rows").innerHTML = M.ledger.map(r => "<tr><td>" + esc(day(r.date)) + "</td><td>" + esc(r.what) + (r.from ? " · " + esc(r.from) : "") +
      '</td><td class="r in">' + (r.in_sats ? n(r.in_sats) : "") + '</td><td class="r">' + (r.out_sats ? n(r.out_sats) : "") + "</td></tr>").join("");
    $("m-empty").hidden = M.ledger.length > 0;

    // Partners
    $("p-list").innerHTML = a.partners.map(p => {
      const site = safeUrl(p.website);
      const posts = (p.posts || []).map(safeUrl).filter(Boolean);
      return '<div class="card"><h3>' + (site ? '<a href="' + esc(site) + '" target="_blank" rel="noopener">' + esc(p.name) + " ↗</a>" : esc(p.name)) + "</h3>" +
        "<p>" + (p.type === "paid" ? "Paid partner" : "In-kind partner") + "</p>" +
        "<p>" + plural(p.walls, "wall") + ": shack " + p.shacks.map(x => "#" + x).join(", ") + "</p>" +
        (p.last_paid_on ? "<p>Paid " + esc(day(p.last_paid_on)) + (p.renews_on ? " · renews " + esc(day(p.renews_on)) : "") + "</p>" : "") +
        (posts.length ? '<div class="links">' + posts.map((u, i) => '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + (posts.length > 1 ? "Wall " + (i + 1) + " on X" : "See the wall on X") + " ↗</a>").join("") + "</div>" : "") +
        "</div>";
    }).join("") || '<p class="empty">Partners show here once their payment or support is recorded.</p>';

    $("updated").textContent = "Numbers updated " + new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Johannesburg", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(d.generated_at)) + " (South Africa time).";
    $("app").setAttribute("aria-busy", "false");
  }

  let timer = null;
  async function load() {
    try {
      const r = await fetch("/api/public/dashboard", { headers: { Accept: "application/json" }, cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      render(await r.json());
    } catch (err) {
      if ($("app").getAttribute("aria-busy") === "true") $("lead").textContent = "Can't reach the live numbers right now. Trying again in a minute.";
    }
    clearTimeout(timer);
    timer = setTimeout(load, 60000);
  }
  load();
})();
