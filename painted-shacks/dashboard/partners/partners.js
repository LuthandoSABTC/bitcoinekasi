// Partner view: sign in, then each family's lessons and cleaning inspections (shack numbers only). Data: /api/partner/progress.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n = v => Number(v || 0).toLocaleString("en-US");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d => { if (!d) return ""; const t = new Date(d + "T12:00:00Z"); return t.getUTCDate() + " " + MON[t.getUTCMonth()] + " " + t.getUTCFullYear(); };
  const RESULT = { yes: ["Clean", "p-good"], partly: ["Partly clean", "p-warn"], no: ["Not clean", "p-bad"], unknown: ["Checked before cleaning checks", ""] };
  const api = (method, url, body) => fetch(url, { method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json", "X-PS-Admin": "1" } : { "X-PS-Admin": "1" }, body: body ? JSON.stringify(body) : undefined });

  const root = document.documentElement;
  try { const t = localStorage.getItem("ps-acc-theme"); if (t === "light" || t === "dark") root.dataset.theme = t; } catch (e) { /* private mode */ }
  $("theme").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("ps-acc-theme", root.dataset.theme); } catch (e) { /* ignore */ }
  });

  let data = null, filter = "all";
  function showLogin(msg) { $("view").hidden = true; $("out").hidden = true; $("login").hidden = false; $("err").textContent = msg || ""; }

  function draw() {
    const rows = data.families.filter(f => filter === "all" || (filter === "mine" ? f.your_wall : f.latest_inspection === "partly" || f.latest_inspection === "no"));
    const total = data.total_weeks || 20;
    $("rows").innerHTML = rows.map(f => {
      const r = RESULT[f.latest_inspection];
      return '<tr class="' + (f.your_wall ? "mine" : "") + '"><td><b>' + String(f.shack_no).padStart(3, "0") + "</b></td><td>" + esc(f.section || "–") + "</td><td>" + esc(f.logo || "–") +
        (f.your_wall ? ' <span class="pill p-good">Your logo</span>' : "") + '</td><td><div class="meter"><span>' + f.lessons_done + " of " + total +
        '</span><div class="bg"><i style="width:' + Math.min(100, Math.round(f.lessons_done / total * 100)) + '%"></i></div></div><div class="muted" style="font-size:12px">' +
        (f.last_lesson_on ? "Last " + day(f.last_lesson_on) : "Not started") + '</div></td><td class="r">' + f.lessons_this_month + "</td><td>" +
        (r ? '<span class="pill ' + r[1] + '">' + r[0] + '</span> <span class="muted" style="font-size:12px">' + day(f.latest_inspection_on) + "</span>" : '<span class="muted">Not inspected yet</span>') +
        '</td><td class="r">' + f.inspections_passed + " of " + f.inspections + "</td></tr>";
    }).join("") || '<tr><td colspan="7" class="muted">No families match.</td></tr>';
  }

  async function load() {
    const r = await api("GET", "/api/partner/progress");
    if (r.status === 401) return showLogin();
    if (!r.ok) { const e = await r.json().catch(() => ({})); return showLogin(e.error || "Could not load. Try again."); }
    data = await r.json();
    $("login").hidden = true; $("view").hidden = false; $("out").hidden = false;
    $("hello").textContent = "Family progress for " + data.sponsor;
    $("intro").textContent = "Each family learns Bitcoin in the Painted Shacks app, " + data.total_weeks + " weekly lessons in isiXhosa, and keeps their home and wall clean. " +
      "Inspectors check each home every month that the shack and yard are clean, and families are paid only when both lessons and cleaning are done." + (data.start_date && data.start_date > data.today ? " Lessons start on " + day(data.start_date) + "." : "");
    const t = data.totals;
    $("t-fam").textContent = n(t.families); $("t-les").textContent = n(t.lessons);
    $("t-ins").textContent = n(t.passed) + " of " + n(t.inspections); $("t-now").textContent = n(t.latest_good) + " of " + n(t.families);
    draw();
    $("view").setAttribute("aria-busy", "false");
  }

  document.querySelectorAll("[data-f]").forEach(b => b.addEventListener("click", () => {
    filter = b.dataset.f;
    document.querySelectorAll("[data-f]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  }));
  $("login").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.target), btn = e.target.querySelector("button");
    btn.disabled = true; $("err").textContent = "";
    try {
      const r = await api("POST", "/api/partner/login", { email: f.get("email"), password: f.get("password") });
      if (!r.ok) { const j = await r.json().catch(() => ({})); $("err").textContent = j.error || "Could not sign in."; return; }
      e.target.reset(); await load();
    } catch (err) { $("err").textContent = "Could not reach the server."; } finally { btn.disabled = false; }
  });
  $("out").addEventListener("click", async () => { await api("POST", "/api/partner/logout", {}).catch(() => {}); data = null; showLogin(); });
  load().catch(() => showLogin("Could not reach the server."));
})();
