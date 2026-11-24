// Keeps the inspector app working with no signal. Only the app's own files are cached here;
// shack lists and unsent inspections are kept by the page itself (localStorage + IndexedDB).
"use strict";
const VERSION = "inspector-v1";
const SHELL = ["./", "index.html", "logo.png", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // App files: try the network first so updates arrive, fall back to the saved copy when offline.
  // On weak signal, use the saved copy after 4 seconds instead of waiting.
  const saved = () => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"));
  const net = fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  });
  e.respondWith(new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => saved().then(finish), 4000);
    net.then(r => { clearTimeout(timer); finish(r); })
       .catch(() => { clearTimeout(timer); saved().then(r => r ? finish(r) : finish(Response.error())); });
  }));
});
