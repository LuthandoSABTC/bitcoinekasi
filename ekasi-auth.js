/* ekasi-auth.js — shared login + data access for the Attendance Tracker pages.
   Pages sign in with a password (checked by the server), receive a short-lived token,
   and send it with every request. Nothing secret is stored in the page. */
(function () {
  var BACKEND = "https://tracker.learn-bitcoinekasi.it.com";
  var TK = "ek_session";
  var token = "";
  try { token = sessionStorage.getItem(TK) || ""; } catch (e) {}

  function setToken(t) {
    token = t || "";
    try { if (token) sessionStorage.setItem(TK, token); else sessionStorage.removeItem(TK); } catch (e) {}
  }

  // Add the token to every request that goes to our own server.
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    var u = typeof url === "string" ? url : (url && url.url) || "";
    if (token && u.indexOf(BACKEND) === 0 && u.indexOf(BACKEND + "/auth/login") !== 0) {
      opts = Object.assign({}, opts || {});
      opts.headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + token });
    }
    return realFetch(url, opts).then(function (res) {
      if (res.status === 401 && token && u.indexOf(BACKEND) === 0 && u.indexOf("/auth/") < 0) {
        setToken("");
        alert("Your session has ended. Please sign in again.");
        location.reload();
      }
      return res;
    });
  };

  async function login(role, teacherId, password) {
    var res = await realFetch(BACKEND + "/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: role, teacherId: teacherId || undefined, password: password })
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.ok && data.token) { setToken(data.token); return { ok: true }; }
    return { ok: false, error: data.error || "Could not sign in" };
  }

  // Same behaviour as the old sb(): returns rows, throws Error(message) on failure.
  async function sb(method, table, body, params) {
    var res = await fetch(BACKEND + "/db/" + table + (params || ""), {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : null
    });
    var text = await res.text();
    if (!text) return [];
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { return []; }
    if (!res.ok) {
      var msg = (parsed && (parsed.message || parsed.error || parsed.hint)) || text.slice(0, 200);
      throw new Error(msg);
    }
    return parsed;
  }

  async function changePassword(target, teacherId, newPassword) {
    var res = await fetch(BACKEND + "/auth/change-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: target, teacherId: teacherId || undefined, newPassword: newPassword })
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || "Could not change password");
    return true;
  }

  window.EkAuth = { login: login, sb: sb, changePassword: changePassword, logout: function () { setToken(""); } };
})();
