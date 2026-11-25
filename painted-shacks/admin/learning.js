// Learning screens for the Painted Shacks admin app:
//  * Learning > Progress: every owner's weeks done, this pay month, current lesson and last activity, with a WhatsApp reminder.
//  * Learning > Lessons: the 20 weekly lessons. Write or check a lesson and its quiz, preview it as owners see it, publish.
//  * Owner page: that owner's week-by-week progress and their app sign-in (PIN).
// Loaded after the main script in index.html and uses its helpers (shell, call, esc, pages, ...).
"use strict";
(function () {
  const BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M8 7h7"/></svg>';
  NAV.splice(3, 0, ["learning", "Learning", BOOK]);

  const preview = () => shell("learning", `<div class="card"><h1>Learning</h1><p class="muted">Learning progress works on the live server only, not in this preview.</p></div>`);
  const ago = iso => {
    if (!iso) return "Never";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 14) return `${Math.round(s / 86400)} day${Math.round(s / 86400) === 1 ? "" : "s"} ago`;
    return fmtDate(iso.slice(0, 10));
  };
  const when = t => t ? new Date(t).toLocaleString("en-ZA", {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}) : "";
  const monthLabel = p => new Date(p + "-01T00:00:00").toLocaleDateString("en-ZA", {month: "long", year: "numeric"});
  const appUrl = () => `${location.origin}/learn/`;
  // WhatsApp link with a ready message (no cost, opens on the admin's phone or WhatsApp Web).
  function waLink(phone, text) {
    let d = String(phone || "").replace(/\D/g, "");
    if (d.startsWith("0")) d = "27" + d.slice(1);
    if (d.length < 10) return null;
    return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
  }
  const remindText = (name, week) => `Molo${name ? " " + name.split(" ")[0] : ""}! Isifundo sakho se-Bitcoin${week ? ` (Iveki ${week})` : ""} sikulindile kwi-app: ${appUrl()} Gqiba isifundo nemibuzo, ufumane i-7,000 sats kule veki. – Bitcoin Ekasi`;

  function currentText(c, published) {
    if (!c) return ["All weeks done", "p-good"];
    if (c.state === "soon") return [`Week ${c.week_no}: lesson not live yet`, ""];
    if (c.state === "wait") return [`Week ${c.week_no} opens ${fmtDate(c.opens_on)}`, "p-good"];
    if (c.attempts) return [`Week ${c.week_no}: quiz not passed (${c.attempts} tr${c.attempts === 1 ? "y" : "ies"}, best ${c.best_score})`, "p-bad"];
    if (c.read_done) return [`Week ${c.week_no}: read, quiz not done`, "p-warn"];
    return [`Week ${c.week_no}: not started`, "p-warn"];
  }
  const weekBar = (done, total) => `<span class="wbar" title="${done} of ${total} weeks" style="display:inline-grid;grid-template-columns:repeat(${total},1fr);gap:2px;width:min(160px,40vw);vertical-align:middle">${Array.from({length: total}, (_, i) => `<i style="height:8px;border-radius:2px;background:${i < done ? "var(--good)" : "var(--line)"}"></i>`).join("")}</span>`;

  /* ---------------------------------------------------------------- Learning page */
  let tab = "progress", filter = "all", query = "";
  pages.learning = async params => {
    if (DEMO) return preview();
    if (params.get("t")) tab = params.get("t");
    shell("learning", `<div class="head"><div><h1>Learning</h1><p class="sub">Loading…</p></div></div>`);
    const tabs = [["progress", "Owner progress"], ["lessons", "Lessons"], ["settings", "Quiz settings"]];
    const tabBar = `<div class="chips" style="margin-bottom:16px" role="tablist">${tabs.map(([k, l]) => `<a class="chip" href="#/learning?t=${k}" role="tab" aria-pressed="${tab === k}" style="text-decoration:none">${l}</a>`).join("")}</div>`;
    try {
      if (tab === "lessons") return await lessonsTab(tabBar);
      if (tab === "settings") return await settingsTab(tabBar);
      return await progressTab(tabBar);
    } catch (err) { $("#main").innerHTML = `<div class="card"><p class="note">${esc(friendlyError(err))}</p></div>`; }
  };

  async function progressTab(tabBar) {
    const d = await call("GET", "/api/learn-admin/progress");
    const owners = d.owners.filter(o => o.active);
    const P = d.period;
    const withLogin = owners.filter(o => o.has_login && !o.login_disabled).length;
    const doneThisPeriod = owners.filter(o => o.this_period.weeks > 0).length;
    const canDoNow = owners.filter(o => o.current?.state === "ready").length;
    const satsThisPeriod = owners.reduce((a, o) => a + o.this_period.sats, 0);
    const filters = [["all", "All"], ["now", `Can do a lesson now (${canDoNow})`], ["notstarted", "Not started"], ["nologin", "No app sign-in"]];
    const draw = () => {
      const q = query.toLowerCase();
      const rows = owners.filter(o => {
        if (filter === "now" && o.current?.state !== "ready") return false;
        if (filter === "notstarted" && o.weeks_done) return false;
        if (filter === "nologin" && o.has_login && !o.login_disabled) return false;
        return !q || [o.name, ...o.shacks].join(" ").toLowerCase().includes(q);
      }).sort((a, b) => (a.shacks[0] ?? 999) - (b.shacks[0] ?? 999));
      $("#rows").innerHTML = rows.length ? `<table class="t"><thead><tr><th>Owner</th><th>Weeks done</th><th class="r">${esc(P.title)}</th><th>Now</th><th>Last active</th><th></th></tr></thead><tbody>
        ${rows.map(o => {
          const [cur, cls] = currentText(o.current, d.published);
          const wa = o.current?.state === "ready" ? waLink(o.phone, remindText(o.name, o.current.week_no)) : null;
          return `<tr><td><a href="#/owner/${esc(o.owner_id)}">${esc(o.name || "Name not added yet")}</a><div class="muted" style="font-size:12px">${o.shacks.length ? "Shack " + o.shacks.join(", ") : "No shack"}</div></td>
            <td style="white-space:nowrap">${weekBar(o.weeks_done, d.total_weeks)} <span class="num" style="font-size:13px">${o.weeks_done}/${d.total_weeks}</span></td>
            <td class="r"><span class="num">${o.this_period.weeks}</span><span class="muted">/${d.max_weeks}</span><div class="muted" style="font-size:12px">${fmtSats(o.this_period.sats)} sats</div></td>
            <td><span class="pill ${cls}">${esc(cur)}</span>${!o.has_login ? '<div><span class="pill p-bad" style="margin-top:4px">No app sign-in</span></div>' : o.login_disabled ? '<div><span class="pill p-bad" style="margin-top:4px">Blocked</span></div>' : ""}</td>
            <td style="white-space:nowrap">${esc(ago(o.last_activity))}</td>
            <td class="r">${wa ? `<a class="btn ghost small" href="${esc(wa)}" target="_blank" rel="noopener">Remind</a>` : ""}</td></tr>`;
        }).join("")}</tbody></table>` : '<div class="empty">No owners match.</div>';
      $("#count").textContent = `${rows.length} of ${owners.length} active owners`;
    };
    $("#main").innerHTML = `
      <div class="head"><div><h1>Learning</h1><p class="sub">Owners earn ${fmtSats(d.sats_per_week)} sats for each week they read the lesson and pass the quiz in the app, up to ${d.max_weeks} weeks a month.</p></div>
        <div class="actions"><a class="btn ghost" href="/learn/" target="_blank" rel="noopener">Open owner app</a></div></div>
      ${tabBar}
      ${d.published < d.total_weeks ? `<div class="note" style="margin-bottom:16px">${d.published} of ${d.total_weeks} weekly lessons are live. Owners can't go past the last live lesson. <a href="#/learning?t=lessons">Check and publish lessons</a></div>` : ""}
      <div class="stats">
        <div class="stat hero"><span class="lbl">${esc(P.title)} payout so far</span><span class="val">${fmtSats(satsThisPeriod)}</span><span style="font-size:13px">sats · pay day ${fmtDate(P.pay_date)}</span></div>
        <div class="stat"><span class="lbl">Finished a week this month</span><span class="val">${doneThisPeriod}<span class="muted" style="font-size:15px"> / ${owners.length}</span></span><span class="muted" style="font-size:13px">counts until ${fmtDate(P.counts_until)}</span></div>
        <div class="stat"><span class="lbl">Can do a lesson now</span><span class="val">${canDoNow}</span></div>
        <div class="stat"><span class="lbl">Have app sign-in</span><span class="val">${withLogin}<span class="muted" style="font-size:15px"> / ${owners.length}</span></span></div>
      </div>
      <div class="toolbar"><input type="search" id="q" placeholder="Search name or shack" value="${esc(query)}" aria-label="Search owners"></div>
      <div class="chips" style="margin-bottom:12px" role="group" aria-label="Filter">${filters.map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join("")}</div>
      <p class="sub" id="count" style="margin:0 0 8px"></p>
      <div class="list scroll" id="rows"></div>
      <p class="hint" style="margin-top:12px">"Remind" opens WhatsApp with a ready message to owners who can do a lesson now. Weeks finished after ${fmtDate(P.counts_until)} count for next month's payout.</p>`;
    $("#q").addEventListener("input", e => { query = e.target.value; draw(); });
    document.querySelectorAll("[data-f]").forEach(b => b.addEventListener("click", () => {
      filter = b.dataset.f; document.querySelectorAll("[data-f]").forEach(x => x.setAttribute("aria-pressed", x === b)); draw();
    }));
    draw();
  }

  async function lessonsTab(tabBar) {
    const d = await call("GET", "/api/lessons");
    const byWeek = new Map(d.lessons.map(l => [l.week_no, l]));
    const total = Math.max(d.settings.total_weeks, ...d.lessons.map(l => l.week_no), 0);
    const live = d.lessons.filter(l => l.status === "published").length;
    $("#main").innerHTML = `
      <div class="head"><div><h1>Learning</h1><p class="sub">${live} of ${d.settings.total_weeks} lessons live. Owners only see live lessons. Check each draft, then press Publish.</p></div></div>
      ${tabBar}
      <div class="list">${Array.from({length: total}, (_, i) => i + 1).map(w => {
        const l = byWeek.get(w);
        if (!l) return `<a class="item" href="#/lesson/new?week=${w}"><span class="no">${w}</span><div class="main"><b class="muted">No lesson yet</b><small>Add week ${w}</small></div><div class="end"><span class="pill">Empty</span></div></a>`;
        const ready = l.questions >= d.settings.questions_shown && l.chars > 40;
        return `<a class="item" href="#/lesson/${esc(l.id)}"><span class="no">${w}</span><div class="main"><b>${esc(l.title)}</b>
          <small>${l.questions} question${l.questions === 1 ? "" : "s"} · ${l.pictures} picture${l.pictures === 1 ? "" : "s"}${l.done ? ` · finished by ${l.done}` : ""}${l.status === "published" && l.published_by_name ? ` · published by ${esc(l.published_by_name)}` : ""}</small></div>
          <div class="end">${l.status === "published" ? '<span class="pill p-good">Live</span>' : `<span class="pill p-warn">Draft</span>${ready ? "" : '<span class="pill">Not complete</span>'}`}</div></a>`;
      }).join("")}</div>
      <form class="card f" id="imp" style="margin-top:16px"><h2>Import lessons file</h2>
        <p class="muted" style="margin:0">Adds lessons from a lessons file (JSON). Weeks that already have a lesson are skipped. Imported lessons are drafts until you publish them.</p>
        <label class="fld">Lessons file<input type="file" name="file" accept=".json,application/json" required></label>
        <div class="actions"><button class="btn ghost" type="submit">Import</button></div></form>`;
    $("#imp").addEventListener("submit", async e => {
      e.preventDefault(); const btn = e.target.querySelector("button"); btn.disabled = true;
      try { const data = JSON.parse(await e.target.file.files[0].text()); const n = await call("POST", "/api/lessons/import", data); toast(`Added ${n.added} lesson${n.added === 1 ? "" : "s"} as drafts, skipped ${n.skipped}.`); route(); }
      catch (err) { toast(err instanceof SyntaxError ? "That file is not valid JSON." : friendlyError(err), true); btn.disabled = false; }
    });
  }

  async function settingsTab(tabBar) {
    const s = (await call("GET", "/api/lessons")).settings;
    $("#main").innerHTML = `
      <div class="head"><div><h1>Learning</h1></div></div>${tabBar}
      <form class="card f" id="ls"><h2>Quiz and lesson settings</h2>
        <div class="fields">
          <label class="fld">Questions shown per quiz<input type="number" name="questions_shown" min="1" max="20" value="${s.questions_shown}"><span class="hint">Picked at random from the lesson's questions each try.</span></label>
          <label class="fld">Right answers needed to pass<input type="number" name="pass_correct" min="1" max="20" value="${s.pass_correct}"></label>
          <label class="fld">Weeks in the course<input type="number" name="total_weeks" min="1" max="60" value="${s.total_weeks}"></label>
          <label class="check fld wide"><input type="checkbox" name="one_per_week" ${s.one_per_week ? "checked" : ""}> One new lesson a week (the next lesson opens on the Monday after finishing one)</label>
        </div>
        <div class="actions"><button class="btn" type="submit">Save</button></div></form>
      <div class="card"><h2>Owner app</h2><p class="muted" style="margin:0">Owners open <a href="/learn/" target="_blank" rel="noopener">${esc(appUrl())}</a> on their phone and sign in with their shack number (or phone number) and a PIN. Make a PIN on the owner's page.</p></div>`;
    $("#ls").addEventListener("submit", async e => {
      e.preventDefault(); const f = new FormData(e.target);
      try { await call("PATCH", "/api/learn-admin/settings", {questions_shown: Number(f.get("questions_shown")), pass_correct: Number(f.get("pass_correct")), total_weeks: Number(f.get("total_weeks")), one_per_week: !!f.get("one_per_week")}); toast("Saved"); }
      catch (err) { toast(friendlyError(err), true); }
    });
  }

  /* ---------------------------------------------------------------- Lesson editor */
  // Shrinks a picture on the admin's computer to a JPEG of at most 1280 px wide (about 100-250 KB), so owners' data lasts.
  async function toJpeg(file) {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file is not a picture.")); i.src = URL.createObjectURL(file); });
    const scale = Math.min(1, 1280 / img.naturalWidth), c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    return new Promise(res => c.toBlob(res, "image/jpeg", 0.8));
  }

  pages.lesson = async (id, params) => {
    if (DEMO) return preview();
    if (id === "new") {
      const week = params.get("week") || "";
      shell("learning", `<a class="back" href="#/learning?t=lessons">${I.back}Lessons</a><div class="head"><div><h1>New lesson</h1></div></div>
        <form class="card f" id="nl"><div class="fields">
          <label class="fld">Week<input type="number" name="week_no" min="1" max="60" value="${esc(week)}" required></label>
          <label class="fld">Title<input type="text" name="title" required placeholder="e.g. Kutheni sifuna imali?"></label></div>
          <div class="actions"><button class="btn" type="submit">Create draft</button></div></form>`);
      $("#nl").addEventListener("submit", async e => {
        e.preventDefault(); const f = new FormData(e.target);
        try { const l = await call("POST", "/api/lessons", {week_no: Number(f.get("week_no")), title: f.get("title")}); location.hash = "#/lesson/" + l.id; }
        catch (err) { toast(friendlyError(err), true); }
      });
      return;
    }
    let l, s;
    try { [l, s] = await Promise.all([call("GET", "/api/lessons/" + id), call("GET", "/api/lessons").then(r => r.settings)]); } catch (err) { return notFound(); }
    let questions = l.questions.map(q => ({...q, choices: [...q.choices]}));
    let pictures = [...l.pictures];
    const live = l.status === "published";
    shell("learning", `
      <a class="back" href="#/learning?t=lessons">${I.back}Lessons</a>
      <div class="head"><div><h1>Week ${l.week_no}: ${esc(l.title)}</h1>
        <p class="sub">${live ? `<span class="pill p-good">Live</span> published ${esc(when(l.published_at))}${l.published_by_name ? " by " + esc(l.published_by_name) : ""}` : '<span class="pill p-warn">Draft</span> owners can\'t see it yet'}
        · opened by ${l.usage.opened} · finished by ${l.usage.done}${l.source ? ` · from ${esc(l.source)}` : ""}</p></div>
        <div class="actions"><a class="btn ghost" href="#lesson-preview">Preview</a>${live ? '<button class="btn ghost" id="unpub">Move back to draft</button>' : '<button class="btn" id="pub">Publish</button>'}</div></div>
      ${live ? '<div class="note" style="margin-bottom:16px">This lesson is live. Changes you save show to owners straight away.</div>' : ""}
      <div class="card f">
        <div class="fields">
          <label class="fld" style="max-width:120px">Week<input type="number" id="week_no" min="1" max="60" value="${l.week_no}"></label>
          <label class="fld">Title<input type="text" id="title" value="${esc(l.title)}"></label>
        </div>
        <label class="fld wide">Lesson text
          <textarea id="body" style="min-height:360px;font-family:var(--mono);font-size:14px;line-height:1.5">${esc(l.body)}</textarea>
          <span class="hint">Keep pages short for phones. <b>---</b> on its own line = new page · <b># </b>heading · <b>- </b>bullet · <b>&gt; </b>"remember this" box · <b>**bold**</b> · blank line = new paragraph.</span></label>
        <div><h2 style="margin-bottom:8px">Pictures</h2>
          <div id="pics" style="display:flex;gap:10px;flex-wrap:wrap"></div>
          <label class="btn ghost small" style="margin-top:10px;cursor:pointer">Add picture<input type="file" id="addpic" accept="image/*" hidden></label>
          <span class="hint">The picture goes where the cursor is in the text.</span></div>
      </div>
      <div class="card"><div class="head" style="margin:0"><h2>Quiz questions</h2><span class="muted" style="font-size:13px">Owners get ${s.questions_shown} at random and need ${s.pass_correct} right. Write at least ${s.questions_shown}; 8 or more is better.</span></div>
        <div id="qs" class="grid"></div>
        <div class="actions"><button class="btn ghost small" id="addq" type="button">Add question</button></div></div>
      <div class="actions" style="position:sticky;bottom:calc(76px + env(safe-area-inset-bottom));background:var(--bg);padding:10px 0;z-index:5">
        <button class="btn" id="save">Save</button><span class="muted" id="dirty" style="font-size:13px"></span>
        ${!live && !l.usage.opened ? '<button class="btn danger" id="del" style="margin-left:auto">Delete</button>' : ""}</div>
      <div class="card" id="lesson-preview"><h2>Preview: what owners see</h2>
        <div id="pv" style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))"></div></div>`);

    const dirty = () => { $("#dirty").textContent = "Not saved yet"; };
    const drawPics = () => {
      $("#pics").innerHTML = pictures.map(p => `<div style="display:grid;gap:4px;width:120px"><img src="/api/learn/pictures/${esc(p)}" alt="" style="width:120px;height:90px;object-fit:cover;border-radius:8px;background:var(--raise)">
        <div class="actions" style="gap:4px"><button class="btn ghost small" type="button" data-ins="${esc(p)}">Insert</button><button class="btn danger small" type="button" data-delpic="${esc(p)}" aria-label="Delete picture">✕</button></div></div>`).join("") || '<span class="muted">No pictures yet.</span>';
      document.querySelectorAll("[data-ins]").forEach(b => b.addEventListener("click", () => insertAtCursor(`[[picture:${b.dataset.ins}]]`)));
      document.querySelectorAll("[data-delpic]").forEach(b => b.addEventListener("click", async () => {
        if ($("#body").value.includes(`[[picture:${b.dataset.delpic}]]`)) return toast("Take the picture out of the text first (and save).", true);
        if (!confirm("Delete this picture?")) return;
        try { await call("DELETE", "/api/lesson-pictures/" + b.dataset.delpic); pictures = pictures.filter(x => x !== b.dataset.delpic); drawPics(); } catch (err) { toast(friendlyError(err), true); }
      }));
    };
    const insertAtCursor = text => {
      const ta = $("#body"), a = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, a), after = ta.value.slice(a);
      ta.value = before.replace(/\s*$/, "") + `\n\n${text}\n\n` + after.replace(/^\s*/, "");
      ta.focus(); dirty(); drawPreview();
    };
    const drawQs = () => {
      $("#qs").innerHTML = questions.map((q, i) => `<fieldset style="border:1px solid var(--line);border-radius:12px;padding:12px;display:grid;gap:8px;margin:0">
        <legend class="muted" style="font-size:12px;padding:0 6px">Question ${i + 1}</legend>
        <textarea data-q="${i}" style="min-height:56px" placeholder="Question">${esc(q.question)}</textarea>
        ${[0, 1, 2, 3].map(j => `<label style="display:flex;gap:8px;align-items:center"><input type="radio" name="ans${i}" data-a="${i}" value="${j}" ${q.answer === j ? "checked" : ""} aria-label="Right answer" style="width:20px;height:20px;accent-color:var(--good)">
          <input type="text" data-c="${i}" data-j="${j}" value="${esc(q.choices[j] || "")}" placeholder="Answer ${j + 1}${j > 1 ? " (optional)" : ""}"></label>`).join("")}
        <div class="actions"><span class="hint">Tick the right answer.</span><button class="btn danger small" type="button" data-delq="${i}" style="margin-left:auto">Remove</button></div></fieldset>`).join("") || '<p class="muted" style="margin:0">No questions yet.</p>';
      document.querySelectorAll("[data-q]").forEach(t => t.addEventListener("input", () => { questions[t.dataset.q].question = t.value; dirty(); }));
      document.querySelectorAll("[data-c]").forEach(t => t.addEventListener("input", () => { questions[t.dataset.c].choices[t.dataset.j] = t.value; dirty(); }));
      document.querySelectorAll("[data-a]").forEach(t => t.addEventListener("change", () => { questions[t.dataset.a].answer = Number(t.value); dirty(); }));
      document.querySelectorAll("[data-delq]").forEach(b => b.addEventListener("click", () => { questions.splice(Number(b.dataset.delq), 1); drawQs(); dirty(); }));
    };
    const drawPreview = () => {
      const pages = window.lessonPages ? window.lessonPages($("#body").value) : [];
      $("#pv").innerHTML = pages.map((p, i) => `<div style="background:#fbf7f1;color:#1d1812;border-radius:16px;padding:16px;font:16px/1.55 system-ui,sans-serif;max-width:380px">
        <div style="font-size:12px;color:#6b6156;font-weight:600;margin-bottom:8px">Page ${i + 1} of ${pages.length}</div><div class="lesson-pv">${p}</div></div>`).join("") || '<p class="muted">Nothing to show yet.</p>';
    };
    drawPics(); drawQs(); drawPreview();
    $("#body").addEventListener("input", () => { dirty(); clearTimeout(drawPreview.t); drawPreview.t = setTimeout(drawPreview, 400); });
    ["#title", "#week_no"].forEach(s => $(s).addEventListener("input", dirty));
    $("#addq").addEventListener("click", () => { questions.push({question: "", choices: ["", "", "", ""], answer: 0}); drawQs(); dirty(); });
    $("#addpic").addEventListener("change", async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const blob = await toJpeg(file), pid = crypto.randomUUID();
        const res = await fetch(`/api/lessons/${id}/pictures/${pid}`, {method: "PUT", credentials: "same-origin", headers: {"Content-Type": "image/jpeg", "X-PS-Admin": "1"}, body: blob});
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Upload failed.");
        pictures.push(pid); drawPics(); insertAtCursor(`[[picture:${pid}]]`); toast("Picture added. Remember to save.");
      } catch (err) { toast(friendlyError(err), true); }
      e.target.value = "";
    });
    const save = async () => {
      const body = {week_no: Number($("#week_no").value), title: $("#title").value, body: $("#body").value,
        questions: questions.map(q => {
          const pairs = q.choices.map((c, j) => ({c: (c || "").trim(), j})).filter(x => x.c);
          return {id: q.id, question: q.question, choices: pairs.map(x => x.c), answer: pairs.findIndex(x => x.j === q.answer)};
        })};
      const r = await call("PATCH", "/api/lessons/" + id, body);
      questions = r.questions.map(q => ({...q, choices: [...q.choices]})); drawQs();
      $("#dirty").textContent = "Saved"; return r;
    };
    $("#save").addEventListener("click", async e => {
      e.target.disabled = true;
      try { await save(); toast("Saved"); } catch (err) { toast(friendlyError(err), true); } finally { e.target.disabled = false; }
    });
    $("#pub")?.addEventListener("click", async e => {
      if (!confirm(`Publish week ${l.week_no}? Owners will see this lesson and quiz.\n\nOnly publish after you checked the isiXhosa text and every answer.`)) return;
      e.target.disabled = true;
      try { await save(); await call("POST", `/api/lessons/${id}/publish`, {}); toast("Published. Owners can see it now."); route(); }
      catch (err) { toast(friendlyError(err), true); e.target.disabled = false; }
    });
    $("#unpub")?.addEventListener("click", async () => {
      if (!confirm("Move this lesson back to draft? Owners who haven't finished it can't open it until you publish it again.")) return;
      try { await call("POST", `/api/lessons/${id}/unpublish`, {}); toast("Moved back to draft"); route(); } catch (err) { toast(friendlyError(err), true); }
    });
    $("#del")?.addEventListener("click", async () => {
      if (!confirm("Delete this draft lesson and its questions?")) return;
      try { await call("DELETE", "/api/lessons/" + id); toast("Deleted"); location.hash = "#/learning?t=lessons"; } catch (err) { toast(friendlyError(err), true); }
    });
  };

  /* ---------------------------------------------------------------- Owner page: app sign-in + learning progress */
  const baseOwner = pages.owner;
  pages.owner = (id, params) => {
    baseOwner(id, params);
    if (id === "new" || DEMO || !byId("ps_owners", id)) return;
    const o = byId("ps_owners", id);
    const card = document.createElement("div");
    card.className = "card"; card.id = "owner-learn";
    card.innerHTML = `<div class="head" style="margin:0"><h2>Learning</h2><a class="btn ghost small" href="#/learning">All owners</a></div><div id="lp"><div class="empty">Loading…</div></div>`;
    const form = $("#form");
    form ? form.after(card) : $("#main").appendChild(card);
    const draw = async (newPin) => {
      let d;
      try { d = await call("GET", `/api/learn-admin/owners/${id}`); } catch (err) { $("#lp").innerHTML = `<div class="empty">${esc(friendlyError(err))}</div>`; return; }
      const sh = shacksOf(id).map(s => s.shack_no);
      const signIn = sh.length ? `shack number <b>${sh[0]}</b>` : "their phone number";
      const pinMsg = newPin ? `Molo${o.full_name ? " " + o.full_name.split(" ")[0] : ""}! Vula le app ufunde nge-Bitcoin: ${appUrl()} Ngena nge-${sh.length ? "nombolo yeshack " + sh[0] : "nombolo yefowuni yakho"} kunye ne-PIN: ${newPin}. Ungayitshintsha i-PIN kwi-app. – Bitcoin Ekasi` : "";
      const wa = newPin ? waLink(o.phone, pinMsg) : null;
      const L = d.login;
      const done = d.weeks.filter(w => w.state === "done");
      $("#lp").innerHTML = `
        ${newPin ? `<div class="note" style="color:var(--fg)"><b>New PIN: <span class="mono" style="font-size:18px">${esc(newPin)}</span></b><br>They sign in at <span class="mono">${esc(appUrl())}</span> with ${signIn} and this PIN. It is shown only once.
          ${wa ? `<div class="actions" style="margin-top:8px"><a class="btn small" href="${esc(wa)}" target="_blank" rel="noopener">Send on WhatsApp</a></div>` : ""}</div>` : ""}
        <div class="stats" style="margin:0">
          <div class="stat"><span class="lbl">Weeks done</span><span class="val">${d.weeks_done}<span class="muted" style="font-size:15px"> / ${d.total_weeks}</span></span>${weekBar(d.weeks_done, d.total_weeks)}</div>
          <div class="stat hero"><span class="lbl">${esc(d.this_period.title)} payout</span><span class="val">${fmtSats(d.this_period.sats)}</span><span style="font-size:13px">sats · ${d.this_period.weeks} week${d.this_period.weeks === 1 ? "" : "s"} · pay day ${fmtDate(d.this_period.pay_date)}</span></div>
          <div class="stat"><span class="lbl">Last active</span><span class="val" style="font-size:20px">${esc(ago(d.last_activity))}</span><span class="muted" style="font-size:13px">${L ? (L.disabled ? "Sign-in blocked" : L.locked ? "Locked for 15 min (wrong PINs)" : "Last sign-in " + (L.last_login_at ? ago(L.last_login_at) : "never")) : "No app sign-in yet"}</span></div>
        </div>
        <div class="actions">
          <button class="btn ${L ? "ghost" : ""} small" id="mkpin">${L ? "Make new PIN" : "Make app sign-in (PIN)"}</button>
          ${L ? `<button class="btn ${L.disabled ? "ghost" : "danger"} small" id="blk">${L.disabled ? "Allow sign-in" : "Block sign-in"}</button>` : ""}
          ${d.next_week && d.weeks[d.next_week - 1]?.state === "ready" && waLink(o.phone, "x") ? `<a class="btn ghost small" href="${esc(waLink(o.phone, remindText(o.full_name, d.next_week)))}" target="_blank" rel="noopener">Remind on WhatsApp</a>` : ""}
        </div>
        <div class="scroll"><table class="t"><thead><tr><th>Week</th><th>Lesson</th><th>Read</th><th class="r">Quiz tries</th><th>Finished</th><th>Paid in</th></tr></thead><tbody>
          ${d.weeks.filter(w => w.state !== "locked" || w.opened_at).map(w => `<tr>
            <td class="num">${w.week_no}</td>
            <td>${w.title ? esc(w.title) : '<span class="muted">No lesson yet</span>'}${w.lesson_status === "draft" ? ' <span class="pill p-warn">Draft</span>' : ""}
              ${w.state === "ready" ? ' <span class="pill p-or">Open now</span>' : w.state === "wait" ? ` <span class="pill">Opens ${fmtDate(w.opens_on)}</span>` : w.state === "soon" ? ' <span class="pill">Not live</span>' : ""}</td>
            <td>${w.read_done_at ? "✓ " + esc(when(w.read_done_at)) : w.opened_at ? '<span class="muted">Opened</span>' : '<span class="muted">—</span>'}</td>
            <td class="r num">${w.attempts || ""}${w.best_score != null && !w.completed_on ? ` <span class="muted">(best ${w.best_score})</span>` : ""}</td>
            <td>${w.completed_on ? `<span class="pill p-good">✓ ${fmtDate(w.completed_on)} · ${w.score}/${w.total}</span>` : ""}</td>
            <td>${w.pay_period ? esc(monthLabel(w.pay_period)) : ""}</td></tr>`).join("")}
        </tbody></table></div>
        ${done.length ? "" : '<p class="muted" style="margin:0">No weeks finished yet.</p>'}`;
      $("#mkpin").addEventListener("click", async () => {
        if (L && !confirm("Make a new PIN? The old PIN stops working and the owner is signed out.")) return;
        try { const r = await call("POST", `/api/owners/${id}/app-pin`, {}); draw(r.pin); } catch (err) { toast(friendlyError(err), true); }
      });
      $("#blk")?.addEventListener("click", async () => {
        if (!L.disabled && !confirm("Block this owner's app sign-in? They are signed out.")) return;
        try { await call("POST", `/api/owners/${id}/app-${L.disabled ? "unblock" : "block"}`, {}); draw(); } catch (err) { toast(friendlyError(err), true); }
      });
    };
    draw();
  };

  /* ---------------------------------------------------------------- Owners list: weeks done at a glance */
  const baseOwners = pages.owners;
  pages.owners = params => {
    baseOwners(params);
    if (DEMO) return;
    call("GET", "/api/learn-admin/progress").then(d => {
      const by = new Map(d.owners.map(o => [o.owner_id, o]));
      const paint = () => document.querySelectorAll('#rows a.item[href^="#/owner/"]').forEach(a => {
        const o = by.get(a.getAttribute("href").slice(8));
        if (!o || a.querySelector(".lw")) return;
        const end = a.querySelector(".end");
        end?.insertAdjacentHTML("afterbegin", `<span class="pill lw ${o.weeks_done ? "p-good" : ""}" title="Weeks finished in the learning app">${o.weeks_done}/${d.total_weeks} weeks</span>`);
      });
      paint();
      new MutationObserver(paint).observe($("#rows"), {childList: true});
    }).catch(() => {});
  };
})();
