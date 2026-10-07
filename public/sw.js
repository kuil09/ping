const CACHE = "ping-shell-v7";
const SHELL = ["/index.html", "/styles.css", "/history.css", "/app.js", "/tab-status.js", "/profile.js", "/history.js", "/history-view.js", "/icon.svg", "/icon-active.svg", "/manifest.webmanifest"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("ping-shell-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok && SHELL.includes(url.pathname)) await cache.put(event.request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") {
        const shell = await cache.match("/index.html"); if (shell) return shell;
      }
      return new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
    }
  })());
});
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* malformed notification */ }
  const roomId = /^[A-Za-z0-9_-]{3,64}$/.test(data.roomId ?? "") ? data.roomId : null;
  event.waitUntil(self.registration.showNotification("ping", {
    body: "●", tag: roomId ? `ping:${roomId}` : "ping", renotify: true,
    data: { url: roomId ? `/r/${roomId}` : "/", eventId: data.signal?.eventId },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL(event.notification.data?.url ?? "/", self.location.origin);
    if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => client.url === target.href);
    if (existing) return existing.focus();
    return self.clients.openWindow(target.href);
  })());
});
