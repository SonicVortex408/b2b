// XIE Spaces service worker: offline shell + Web Push ("Room free now" hand-offs, approvals, bumps).
const CACHE = "xie-spaces-v2";
const SHELL = ["/", "/map", "/swipe", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET" || new URL(request.url).pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    // network-first for pages so the live map is never stale
    e.respondWith(fetch(request).then((r) => (caches.open(CACHE).then((c) => c.put(request, r.clone())), r)).catch(() => caches.match(request).then((r) => r || caches.match("/map"))));
    return;
  }
  e.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((r) => (r.ok && new URL(request.url).origin === location.origin && caches.open(CACHE).then((c) => c.put(request, r.clone())), r))));
});

self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : { title: "XIE Spaces", body: "Something changed on your booking." };
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: "/icon-192.png", data: { url: data.url || "/map" } }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data.url));
});
