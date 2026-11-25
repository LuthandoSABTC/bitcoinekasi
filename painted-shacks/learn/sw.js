// Lets owners open the learning app and re-read lessons on weak or no signal.
// App files and lessons they already opened are kept on the phone. Quizzes always need a connection,
// because the server marks them.
"use strict";
const VERSION = "learn-v1";
const SHELL = ["./", "index.html", "lesson-render.js", "logo.png", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
const KEEP = /^\/api\/learn\/(me|lessons\/\d+|pictures\/[\w-]+)$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("learn-") && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const isApi = url.pathname.startsWith("/api/");
  if (isApi && !KEEP.test(url.pathname)) return;
  // Network first so new lessons and progress show; the saved copy after 5 seconds or when offline.
  const saved = () => caches.match(e.request, { ignoreSearch: true }).then(r => r || (isApi ? null : caches.match("index.html")));
  const net = fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  });
  e.respondWith(new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => saved().then(finish), 5000);
    net.then(r => { clearTimeout(timer); finish(r); })
       .catch(() => { clearTimeout(timer); saved().then(r => finish(r || Response.error())); });
  }));
});
