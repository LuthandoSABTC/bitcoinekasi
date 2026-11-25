// Payments screens for the Painted Shacks admin app (Lightning payouts to shack owners).
// Loaded after the main script in index.html and uses its helpers (shell, call, esc, pages, ...).
// The Blink wallet key never reaches this page: the server holds it and does all sending.
"use strict";
(function () {
  const BOLT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>';
  NAV.splice(4, 0, ["payments", "Payments", BOLT]);

  const ST = {pending: ["Waiting for approval", "p-warn"], approved: ["Approved, in queue", "p-or"], sending: ["Sending", "p-or"],
              paid: ["Paid", "p-good"], failed: ["Failed", "p-bad"], cancelled: ["Cancelled", ""]};
  const REASON = {weekly_learning: "Weekly learning", bonus: "Bonus", correction: "Correction", other: "Other"};
  const pill = s => `<span class="pill ${ST[s][1]}">${ST[s][0]}</span>`;
  const when = t => t ? new Date(t).toLocaleString("en-ZA", {day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"}) : "";
  const preview = () => { shell("payments", `<div class="card"><h1>Payments</h1><p class="muted">Payments work on the live server only, not in this preview.</p></div>`); };
  let refreshTimer = null;
  const stopRefresh = () => { clearTimeout(refreshTimer); refreshTimer = null; };
  window.addEventListener("hashchange", stopRefresh);

  function walletCard(w) {
    if (!w.configured) return `<div class="note">The Blink wallet is not connected yet. On the server, run <span class="mono">bash /opt/painted-shacks/deploy/set-blink-key.sh</span> and paste the key there. Never paste it into this app.</div>`;
    if (!w.ok) return `<div class="note">Blink wallet problem: ${esc(w.error)}</div>`;
    return `<div class="stat ${w.can_send ? "" : ""}"><span class="lbl">Payout wallet (Blink)</span><span class="val">${fmtSats(w.balance_sats)}</span>
      <span class="muted" style="font-size:13px">sats ${w.can_send ? "· ready to send" : "· <b style='color:var(--warn)'>read-only key: sending is off</b>"}</span></div>`;
  }

  // Password + confirm, then approve. Returns true if something was approved.
  async function approveFlow(ids, total, count, pwInput) {
    const pw = pwInput.value;
    if (!pw) { toast("Type your password to approve.", true); pwInput.focus(); return false; }
    if (!confirm(`Send ${fmtSats(total)} sats to ${count} owner${count === 1 ? "" : "s"} now?\n\nLightning payments can't be taken back.`)) return false;
    try {
      const r = await call("POST", "/api/payouts/approve", {ids, password: pw});
      pwInput.value = "";
      const skipped = r.skipped?.length ? ` ${r.skipped.length} skipped: ${r.skipped.slice(0, 3).map(s => `${s.owner || "owner"} (${s.why})`).join("; ")}${r.skipped.length > 3 ? "…" : ""}` : "";
      toast(r.approved ? `Approved ${r.approved} payment${r.approved === 1 ? "" : "s"} (${fmtSats(r.total_sats)} sats). Sending now.${skipped}` : `Nothing approved.${skipped}`, !r.approved);
      return r.approved > 0;
    } catch (err) { toast(friendlyError(err), true); return false; }
  }

  function payoutRow(r, opts = {}) {
    const addr = r.lightning_address || r.owner_address;
    return `<div class="item">
      ${opts.select ? `<input type="checkbox" data-pick="${esc(r.id)}" data-sats="${r.amount_sats}" aria-label="Select ${esc(r.owner_name || "owner")}" style="width:20px;height:20px;accent-color:var(--orange)">` : ""}
      <div class="main"><b><a href="#/owner/${esc(r.owner_id)}" style="color:inherit">${esc(r.owner_name || "Name not added yet")}</a>${r.shacks ? ` <span class="muted" style="font-weight:400">· Shack ${esc(r.shacks)}</span>` : ""}</b>
        <small class="mono">${esc(addr || "No Lightning address")}</small>
        <small>${REASON[r.reason]}${r.period ? " · " + esc(r.period) : ""}${r.note ? " · " + esc(r.note) : ""}${r.paid_at ? " · paid " + when(r.paid_at) : ""}${r.blink_tx_id ? ` · ref <span class="mono">${esc(r.blink_tx_id)}</span>` : ""}</small>
        ${r.status === "failed" && r.failure_reason ? `<small style="color:var(--bad);white-space:normal">${esc(r.failure_reason)}</small>` : ""}</div>
      <div class="end"><span class="num">${fmtSats(r.amount_sats)}</span>${pill(r.status)}
        ${r.status === "failed" ? `<button class="btn ghost small" data-retry="${esc(r.id)}">Retry</button>` : ""}
        ${["pending", "failed"].includes(r.status) && opts.cancel ? `<button class="btn danger small" data-cancel="${esc(r.id)}">Cancel</button>` : ""}</div></div>`;
  }
  function bindRowActions(after) {
    document.querySelectorAll("[data-retry]").forEach(b => b.addEventListener("click", async () => {
      try { await call("POST", `/api/payouts/${b.dataset.retry}/retry`, {}); toast("Moved back to waiting for approval"); after(); } catch (err) { toast(friendlyError(err), true); }
    }));
    document.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Cancel this payment? It will not be sent.")) return;
      try { await call("POST", `/api/payouts/${b.dataset.cancel}/cancel`, {}); toast("Cancelled"); after(); } catch (err) { toast(friendlyError(err), true); }
    }));
  }

  /* ---------------------------------------------------------------- Payments home */
  let tab = "batches";
  pages.payments = async params => {
    if (DEMO) return preview();
    if (params.get("t")) tab = params.get("t");
    shell("payments", `<div class="head"><div><h1>Payments</h1><p class="sub">Loading…</p></div></div>`);
    let o;
    try { o = await call("GET", "/api/payments/overview"); } catch (err) { $("#main").innerHTML = `<div class="card"><p class="note">${esc(friendlyError(err))}</p></div>`; return; }
    const tm = o.this_month, cur = o.batches.find(b => b.period === tm.period), c = o.counts;
    const tabs = [["batches", "Monthly batches"], ["pending", `Waiting${c.pending ? ` (${c.pending})` : ""}`], ["paid", "Paid"], ["failed", `Failed${c.failed ? ` (${c.failed})` : ""}`], ["all", "All"]];
    $("#main").innerHTML = `
      <div class="head"><div><h1>Payments</h1><p class="sub">Owners earn ${fmtSats(o.settings.sats_per_week)} sats per finished week, up to ${fmtSats(o.settings.sats_per_week * o.settings.max_weeks)} a month. Paid on the last Friday, after an admin approves.</p></div>
        <div class="actions"><a class="btn ghost" href="#/paysettings">Settings</a><a class="btn" href="#/payout/new">Single payment</a></div></div>
      <div class="stats">
        ${walletCard(o.wallet)}
        <a class="stat hero" href="${cur ? "#/batch/" + cur.id : "#/payments"}"><span class="lbl">${esc(tm.title)} pay day</span><span class="val" style="font-size:22px">${fmtDate(tm.pay_date)}</span>
          <span style="font-size:13px">${cur ? `${fmtSats(cur.total_sats)} sats drafted` : `Drafts on ${fmtDate(tm.draft_on)}`}</span></a>
        <a class="stat" href="#/payments?t=pending"><span class="lbl">Waiting for approval</span><span class="val">${c.pending || 0}</span></a>
        <a class="stat" href="#/payments?t=failed"><span class="lbl">Failed</span><span class="val" style="${c.failed ? "color:var(--bad)" : ""}">${c.failed || 0}</span></a>
      </div>
      ${(c.approved || 0) && !o.sending ? `<div class="card"><h2>${c.approved} approved payment${c.approved === 1 ? " is" : "s are"} waiting to send</h2>
        <p class="muted" style="margin:0">The server restarted while sending. Type your password to carry on.</p>
        <div class="actions"><input type="password" id="contpw" placeholder="Your password" autocomplete="current-password" style="max-width:260px"><button class="btn" id="cont">Continue sending</button></div></div>` : ""}
      ${!cur ? `<div class="card"><h2>${esc(tm.title)}</h2><p class="muted" style="margin:0">The payout list for this month is made automatically on ${fmtDate(tm.draft_on)}, two days before pay day. Nothing is sent until you approve it.</p>
        <div class="actions"><button class="btn ghost" id="draft">Make the list now</button></div></div>` : ""}
      <div class="chips" style="margin-bottom:12px" role="group" aria-label="Show">${tabs.map(([k, l]) => `<a class="chip" href="#/payments?t=${k}" aria-pressed="${tab === k}" style="text-decoration:none">${l}</a>`).join("")}</div>
      <div id="tabbody"><div class="list"><div class="empty">Loading…</div></div></div>
      <div class="card" style="margin-top:16px"><h2>Reports</h2>
        <form class="fields" id="rep" style="align-items:end">
          <label class="fld">From<input type="date" name="from"></label><label class="fld">To<input type="date" name="to"></label>
          <label class="fld">Status<select name="status"><option value="">All</option>${Object.entries(ST).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select></label>
          <div class="actions"><button class="btn ghost" type="submit">Download payments (CSV)</button></div>
        </form>
        <div class="actions"><a class="btn ghost" href="/api/reports/funding.csv" download>Download funding statement (CSV)</a><button class="btn ghost" id="checkall">Check all Lightning addresses</button></div>
        <p class="hint" style="margin:0">CSV files open in Excel and Google Sheets.</p></div>`;
    $("#draft")?.addEventListener("click", async e => {
      e.target.disabled = true;
      try { const r = await call("POST", "/api/payout-batches", {period: tm.period}); toast(`List made for ${r.added} owners. Nothing has been sent.`); location.hash = "#/batch/" + r.batch.id; }
      catch (err) { toast(friendlyError(err), true); e.target.disabled = false; }
    });
    $("#cont")?.addEventListener("click", async () => {
      try { await call("POST", "/api/payouts/send-approved", {password: $("#contpw").value}); toast("Sending"); setTimeout(route, 1500); } catch (err) { toast(friendlyError(err), true); }
    });
    $("#rep").addEventListener("submit", e => {
      e.preventDefault(); const q = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v));
      location.href = "/api/reports/payouts.csv" + (q.toString() ? "?" + q : "");
    });
    $("#checkall").addEventListener("click", async e => {
      e.target.disabled = true; e.target.textContent = "Checking…";
      try { const r = await call("POST", "/api/payments/check-addresses", {}); const bad = r.filter(x => !x.ok);
        toast(bad.length ? `${bad.length} of ${r.length} addresses have a problem. See the owners' pages.` : `All ${r.length} addresses work.`, !!bad.length); }
      catch (err) { toast(friendlyError(err), true); } finally { e.target.disabled = false; e.target.textContent = "Check all Lightning addresses"; }
    });
    drawTab(o);
  };

  async function drawTab(o) {
    const body = $("#tabbody");
    if (tab === "batches") {
      body.innerHTML = `<div class="list">${o.batches.map(b => {
        const n = k => b.counts[k]?.n || 0;
        return `<a class="item" href="#/batch/${b.id}"><div class="main"><b>${esc(b.title)}</b><small>Pay day ${fmtDate(b.pay_date)} · ${fmtSats(b.total_sats)} sats</small></div>
          <div class="end">${n("paid") ? `<span class="pill p-good">${n("paid")} paid</span>` : ""}${n("pending") ? `<span class="pill p-warn">${n("pending")} waiting</span>` : ""}${n("approved") + n("sending") ? `<span class="pill p-or">${n("approved") + n("sending")} sending</span>` : ""}${n("failed") ? `<span class="pill p-bad">${n("failed")} failed</span>` : ""}</div></a>`;
      }).join("") || '<div class="empty">No monthly batches yet.</div>'}</div>`;
      return;
    }
    const rows = await call("GET", "/api/payouts" + (tab === "all" ? "" : "?status=" + tab));
    const select = tab === "pending";
    body.innerHTML = `<div class="list">${rows.map(r => payoutRow(r, {select, cancel: true})).join("") || '<div class="empty">Nothing here.</div>'}</div>
      ${select && rows.length ? `<div class="card" style="margin-top:12px"><h2>Approve and send</h2><p class="muted" style="margin:0" id="selinfo">Tick the payments to send.</p>
        <div class="actions"><input type="password" id="apw" placeholder="Your password" autocomplete="current-password" style="max-width:260px"><button class="btn" id="approve" disabled>Approve and send</button></div></div>` : ""}`;
    bindRowActions(() => route());
    if (select) {
      const picks = () => [...document.querySelectorAll("[data-pick]:checked")];
      const upd = () => { const p = picks(), t = p.reduce((a, x) => a + Number(x.dataset.sats), 0);
        $("#selinfo").textContent = p.length ? `${p.length} selected · ${fmtSats(t)} sats` : "Tick the payments to send."; $("#approve").disabled = !p.length; };
      document.querySelectorAll("[data-pick]").forEach(x => x.addEventListener("change", upd));
      $("#approve")?.addEventListener("click", async e => {
        const p = picks(); e.target.disabled = true;
        if (await approveFlow(p.map(x => x.dataset.pick), p.reduce((a, x) => a + Number(x.dataset.sats), 0), p.length, $("#apw"))) { tab = "all"; setTimeout(route, 1200); }
        else e.target.disabled = false;
      });
    }
  }

  /* ---------------------------------------------------------------- One monthly batch */
  pages.batch = async id => {
    if (DEMO) return preview();
    stopRefresh();
    let d;
    try { d = await call("GET", "/api/payout-batches/" + id); } catch (err) { return notFound(); }
    const {batch: b, lines, settings: s} = d;
    const ready = lines.filter(l => l.status === "pending" && l.amount_sats > 0 && l.owner_address && !(l.address_ok === 0 && l.checked_address === l.owner_address));
    const notReady = lines.filter(l => l.status === "pending" && l.amount_sats > 0 && !ready.includes(l));
    const waitingWeekly = lines.filter(l => l.status === "pending" && l.reason === "weekly_learning");
    const busy = lines.some(l => ["approved", "sending"].includes(l.status));
    const total = ready.reduce((a, l) => a + l.amount_sats, 0);
    const paid = lines.filter(l => l.status === "paid");
    const weekSel = l => `<select data-weeks="${esc(l.id)}" aria-label="Weeks for ${esc(l.owner_name || "owner")}" style="width:auto;padding:6px 8px">${Array.from({length: s.max_weeks + 1}, (_, i) => `<option value="${i}" ${l.weeks_earned === i ? "selected" : ""}>${i}</option>`).join("")}</select>`;
    shell("payments", `
      <a class="back" href="#/payments">${I.back}Payments</a>
      <div class="head"><div><h1>${esc(b.title)}</h1><p class="sub">Pay day ${fmtDate(b.pay_date)} · ${fmtSats(s.sats_per_week)} sats per week, up to ${s.max_weeks} weeks</p></div>
        <div class="actions"><a class="btn ghost" href="/api/reports/payouts.csv?batch=${esc(b.id)}" download>Download CSV</a></div></div>
      <div class="stats">
        <div class="stat hero"><span class="lbl">Ready to approve</span><span class="val">${fmtSats(total)}</span><span style="font-size:13px">sats to ${ready.length} owner${ready.length === 1 ? "" : "s"}</span></div>
        <div class="stat"><span class="lbl">Paid</span><span class="val">${fmtSats(paid.reduce((a, l) => a + l.amount_sats, 0))}</span><span class="muted" style="font-size:13px">${paid.length} owners · ${fmtSats(paid.reduce((a, l) => a + (l.fee_sats || 0), 0))} sats fees</span></div>
        <div class="stat"><span class="lbl">Need attention</span><span class="val">${notReady.length + lines.filter(l => l.status === "failed").length}</span><span class="muted" style="font-size:13px">no working address, or failed</span></div>
      </div>
      ${busy ? `<div class="note" style="margin-bottom:16px;color:var(--fg)">Sending… this page updates by itself.</div>` : ""}
      <div class="card"><h2>Owners</h2>
        <p class="muted" style="margin:0">Weeks come from the owner learning app (lesson read and quiz passed). Press <b>Update weeks from app</b> to bring in weeks finished since this batch was drafted. You can still change a line by hand; then the app leaves it alone. Owners with 0 weeks are not paid.</p>
        ${waitingWeekly.length ? `<div class="actions"><button class="btn ghost small" id="fromapp">Update weeks from app</button><a class="btn ghost small" href="#/learning">See learning progress</a></div>` : ""}
        <div class="scroll"><table class="t"><thead><tr><th>Owner</th><th>Lightning address</th><th class="r">Weeks</th><th class="r">Sats</th><th>Status</th><th></th></tr></thead><tbody>
        ${lines.map(l => {
          const addr = l.lightning_address || l.owner_address;
          const chk = l.owner_address && l.checked_address === l.owner_address ? (l.address_ok ? '<span class="pill p-good">Works</span>' : `<span class="pill p-bad" title="${esc(l.address_message)}">Problem</span>`) : "";
          const why = l.status !== "pending" ? "" : !l.owner_address ? "No Lightning address" : l.address_ok === 0 && l.checked_address === l.owner_address ? esc(l.address_message) : !l.amount_sats ? "0 weeks: not paid" : "";
          return `<tr><td><a href="#/owner/${esc(l.owner_id)}">${esc(l.owner_name || "Name not added yet")}</a>${l.shacks ? `<div class="muted" style="font-size:12px">Shack ${esc(l.shacks)}</div>` : ""}</td>
            <td><span class="mono">${esc(addr || "—")}</span> ${chk}${why ? `<div style="font-size:12px;color:var(--warn)">${why}</div>` : ""}</td>
            <td class="r">${l.status === "pending" && l.reason === "weekly_learning" ? weekSel(l) : esc(l.weeks_earned ?? "")}
              ${l.reason === "weekly_learning" ? `<div class="muted" style="font-size:12px;white-space:nowrap">${l.weeks_by_admin ? `set by hand · app: ${l.app_weeks}${l.status === "pending" ? ` <a href="#" data-useapp="${esc(l.id)}">use app</a>` : ""}` : "from app"}</div>` : ""}</td>
            <td class="r num">${fmtSats(l.amount_sats)}</td>
            <td>${pill(l.status)}${l.status === "failed" ? `<div style="font-size:12px;color:var(--bad);max-width:240px">${esc(l.failure_reason || "")}</div>` : ""}${l.blink_tx_id ? `<div class="mono" style="font-size:11px">${esc(l.blink_tx_id)}</div>` : ""}</td>
            <td class="r">${l.status === "failed" ? `<button class="btn ghost small" data-retry="${esc(l.id)}">Retry</button>` : ""}${["pending", "failed"].includes(l.status) ? ` <button class="btn danger small" data-cancel="${esc(l.id)}">Cancel</button>` : ""}</td></tr>`;
        }).join("") || '<tr><td colspan="6" class="muted">No owners in this batch.</td></tr>'}
        </tbody></table></div></div>
      ${ready.length ? `<div class="card"><h2>Approve and send</h2>
        <p style="margin:0">Pays <b>${fmtSats(total)} sats</b> to <b>${ready.length}</b> owner${ready.length === 1 ? "" : "s"} from the Blink wallet. Lines that need attention are skipped. Payments can't be taken back.</p>
        <div class="actions"><input type="password" id="apw" placeholder="Your password" autocomplete="current-password" style="max-width:260px"><button class="btn" id="approve">Approve and send ${fmtSats(total)} sats</button></div></div>` : ""}`);
    document.querySelectorAll("[data-weeks]").forEach(sel => sel.addEventListener("change", async () => {
      try { await call("PATCH", "/api/payouts/" + sel.dataset.weeks, {weeks_earned: Number(sel.value)}); route(); } catch (err) { toast(friendlyError(err), true); }
    }));
    $("#fromapp")?.addEventListener("click", async e => {
      e.target.disabled = true;
      try { const r = await call("POST", "/api/payout-batches", {period: b.period}); toast(r.updated || r.added ? `Updated ${r.updated} line${r.updated === 1 ? "" : "s"}, added ${r.added}. Nothing has been sent.` : "Already up to date."); }
      catch (err) { toast(friendlyError(err), true); }
      route();
    });
    document.querySelectorAll("[data-useapp]").forEach(a => a.addEventListener("click", async e => {
      e.preventDefault();
      try { await call("PATCH", "/api/payouts/" + a.dataset.useapp, {weeks_from_app: true}); route(); } catch (err) { toast(friendlyError(err), true); }
    }));
    bindRowActions(() => route());
    $("#approve")?.addEventListener("click", async e => {
      e.target.disabled = true;
      if (await approveFlow(ready.map(l => l.id), total, ready.length, $("#apw"))) setTimeout(route, 1200); else e.target.disabled = false;
    });
    if (busy) refreshTimer = setTimeout(() => { if (location.hash === "#/batch/" + id) route(); }, 3000);
  };

  /* ---------------------------------------------------------------- Single payment */
  pages.payout = async (id, params) => {
    if (DEMO) return preview();
    if (id !== "new") return notFound();
    let s; try { s = (await call("GET", "/api/payments/overview")).settings; } catch (err) { return toast(friendlyError(err), true); }
    const owners = cache.ps_owners.slice().sort((a, b) => ownerLabel(a).localeCompare(ownerLabel(b)));
    const pre = params.get("owner");
    shell("payments", `
      <a class="back" href="#/payments">${I.back}Payments</a>
      <div class="head"><div><h1>Single payment</h1><p class="sub">For a bonus or a correction. It waits for approval like every other payment.</p></div></div>
      <form class="card f" id="form"><div class="fields">
        <label class="fld wide">Owner<select name="owner_id" required><option value="">Choose owner</option>${owners.map(o => `<option value="${o.id}" ${pre === o.id ? "selected" : ""} ${o.lightning_address ? "" : "disabled"}>${esc(ownerLabel(o))} · ${esc(o.lightning_address || "no Lightning address")}</option>`).join("")}</select></label>
        <label class="fld">Amount in sats<input type="number" name="amount_sats" min="1" max="${s.single_limit_sats}" step="1" required><span class="hint">Up to ${fmtSats(s.single_limit_sats)} sats.</span></label>
        <label class="fld">Reason<select name="reason"><option value="bonus">Bonus</option><option value="correction">Correction</option><option value="other">Other</option></select></label>
        <label class="fld wide">What is it for?<input type="text" name="note" required maxlength="500" placeholder="e.g. Missed week in October paid late"></label>
      </div><div class="actions"><button class="btn" type="submit">Save, then approve</button></div></form>`);
    $("#form").addEventListener("submit", async e => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), btn = e.target.querySelector("button"); btn.disabled = true;
      try { await call("POST", "/api/payouts", {...f, amount_sats: Number(f.amount_sats)}); toast("Saved. Approve it below to send."); location.hash = "#/payments?t=pending"; }
      catch (err) { toast(friendlyError(err), true); btn.disabled = false; }
    });
  };

  /* ---------------------------------------------------------------- Payment settings */
  pages.paysettings = async () => {
    if (DEMO) return preview();
    let o; try { o = await call("GET", "/api/payments/overview"); } catch (err) { return toast(friendlyError(err), true); }
    const s = o.settings;
    const num = (n, l, h, min = 0) => `<label class="fld">${l}<input type="number" name="${n}" min="${min}" step="1" required value="${esc(s[n])}">${h ? `<span class="hint">${h}</span>` : ""}</label>`;
    shell("payments", `
      <a class="back" href="#/payments">${I.back}Payments</a>
      <div class="head"><div><h1>Payment settings</h1><p class="sub">Changes are saved in the activity log with your name.</p></div></div>
      <form class="card f" id="form"><h2>Amounts and schedule</h2><div class="fields">
        ${num("sats_per_week", "Sats per finished week", "Lesson and quiz done in the app.", 1)}
        ${num("max_weeks", "Most weeks paid per month", "", 1)}
        ${num("draft_days_before", "Make the list this many days before pay day", "Pay day is the last Friday of the month.")}
      </div><h2>Safety limits</h2><div class="fields">
        ${num("batch_limit_sats", "Most sats in one approval", "", 1)}
        ${num("single_limit_sats", "Most sats for one single payment", "", 1)}
        ${num("max_fee_sats", "Most network fee per payment (sats)", "Bitcoin Ekasi pays the fee, so owners get the full amount.")}
      </div>
      <label class="fld" style="max-width:320px">Your password<input type="password" name="password" required autocomplete="current-password"><span class="hint">Needed to change payment settings.</span></label>
      <div class="actions"><button class="btn" type="submit">Save settings</button></div></form>
      <div class="card"><h2>Blink wallet</h2>
        ${walletCard(o.wallet)}
        <p class="muted" style="margin:0">The wallet key is kept only on the server, in a file only the server can read. To connect or change it, sign in to the server and run <span class="mono">bash /opt/painted-shacks/deploy/set-blink-key.sh</span>. Owners can use any Lightning wallet; Blink is only where Bitcoin Ekasi pays from.</p></div>`);
    $("#form").addEventListener("submit", async e => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), btn = e.target.querySelector("button"); btn.disabled = true;
      const body = {password: f.password}; for (const k of Object.keys(s)) if (k in f && k !== "password") body[k] = Number(f[k]);
      try { await call("PATCH", "/api/payments/settings", body); toast("Settings saved"); location.hash = "#/payments"; }
      catch (err) { toast(friendlyError(err), true); btn.disabled = false; }
    });
  };

  /* ---------------------------------------------------------------- Owner page: address check + payment history */
  const baseOwner = pages.owner;
  pages.owner = (id, params) => {
    baseOwner(id, params);
    if (id === "new" || DEMO || !byId("ps_owners", id)) return;
    const card = document.createElement("div");
    card.className = "card"; card.id = "owner-pay";
    card.innerHTML = `<div class="head" style="margin:0"><h2>Payments</h2><div class="actions"><button class="btn ghost small" id="chk">Check Lightning address</button><a class="btn small" href="#/payout/new?owner=${esc(id)}">Single payment</a></div></div><div id="chkres"></div><div class="list" id="hist"><div class="empty">Loading…</div></div>`;
    $("#main").appendChild(card);
    const showCheck = c => { $("#chkres").innerHTML = c ? `<div class="${c.ok ? "" : "note"}" style="font-size:14px">${c.ok ? "✓ " : ""}${esc(c.message)}${c.ok && c.max_sats ? ` · accepts ${fmtSats(c.min_sats)} to ${fmtSats(c.max_sats)} sats` : ""}</div>` : ""; };
    call("GET", "/api/address-checks").then(all => { const c = all.find(x => x.owner_id === id && x.address === byId("ps_owners", id)?.lightning_address); if (c) showCheck({...c, ok: !!c.ok}); }).catch(() => {});
    $("#chk").addEventListener("click", async e => {
      e.target.disabled = true;
      try { showCheck(await call("POST", `/api/owners/${id}/check-address`, {})); } catch (err) { toast(friendlyError(err), true); } finally { e.target.disabled = false; }
    });
    call("GET", `/api/owners/${id}/payouts`).then(rows => {
      const paid = rows.filter(r => r.status === "paid").reduce((a, r) => a + r.amount_sats, 0);
      $("#hist").innerHTML = rows.length ? rows.map(r => payoutRow(r)).join("") + `<div class="item"><div class="main"><b>Total paid</b></div><span class="num">${fmtSats(paid)} sats</span></div>` : '<div class="empty">No payments yet.</div>';
      bindRowActions(() => route());
    }).catch(err => { $("#hist").innerHTML = `<div class="empty">${esc(friendlyError(err))}</div>`; });
  };

  /* ---------------------------------------------------------------- Funding page: money in vs paid to owners */
  const baseFunding = pages.funding;
  pages.funding = () => {
    baseFunding();
    if (DEMO) return;
    const hint = [...document.querySelectorAll("#main .hint")].find(h => /payout screen/.test(h.textContent));
    if (hint) hint.textContent = "Sponsor money is kept separate from payouts to owners. See Money in and out above.";
    call("GET", "/api/payments/summary").then(s => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<div class="head" style="margin:0"><h2>Money in and out</h2><a class="btn ghost small" href="/api/reports/funding.csv" download>Download statement (CSV)</a></div>
        <div class="stats" style="margin:0">
          <div class="stat"><span class="lbl">Sponsor sats in</span><span class="val">${fmtSats(s.sponsor_in_sats)}</span></div>
          <div class="stat"><span class="lbl">Paid to owners</span><span class="val">${fmtSats(s.paid_out_sats)}</span><span class="muted" style="font-size:13px">${s.paid_count} payments · ${fmtSats(s.fees_sats)} sats fees</span></div>
          <div class="stat hero"><span class="lbl">Fund balance</span><span class="val">${fmtSats(s.balance_sats)}</span>${s.in_flight_sats ? `<span style="font-size:13px">${fmtSats(s.in_flight_sats)} sats being sent</span>` : ""}</div>
        </div>
        ${s.months.length ? `<div class="scroll"><table class="t"><thead><tr><th>Month paid</th><th class="r">Payments</th><th class="r">Sats</th><th class="r">Fees</th></tr></thead><tbody>
          ${s.months.map(m => `<tr><td>${esc(m.month)}</td><td class="r num">${m.n}</td><td class="r num">${fmtSats(m.sats)}</td><td class="r num">${fmtSats(m.fees)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted" style="margin:0">No owner payouts yet.</p>'}
        <p class="hint" style="margin:0">The fund balance is what's left of sponsor money on paper. The Blink wallet balance (on the Payments page) is the money actually ready to send.</p>`;
      const stats = $("#main .stats");
      stats ? stats.after(card) : $("#main").appendChild(card);
    }).catch(() => {});
  };
})();
