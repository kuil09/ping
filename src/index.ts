import { generation, type Env } from "./env.ts";
import { PRESENCE_TTL_MS, PROTOCOL, SIGNAL_TTL_MS } from "./model.ts";
import { vapid } from "./push.ts";
export { PingRoom } from "./room.ts";
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
    if (url.pathname === "/api/health") return json({ ok: true, protocol: PROTOCOL, generation: generation(env), storage: "durable-object-sqlite" });
    if (url.pathname === "/api/config") {
      const keys = vapid(env);
      return json({ protocol: PROTOCOL, generation: generation(env), pushEnabled: Boolean(keys),
        vapidPublicKey: keys?.publicKey || null, signalTtlMs: SIGNAL_TTL_MS, presenceTtlMs: PRESENCE_TTL_MS });
    }
    const manifest = url.pathname.match(/^\/api\/manifest\/([a-f0-9]{32})$/);
    if (manifest) return json({ id: `/r/${manifest[1]}`, name: "ping", short_name: "ping",
      start_url: `/r/${manifest[1]}`, scope: "/", display: "standalone", background_color: "#f4f1ea", theme_color: "#f4f1ea",
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }] });
    const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{32})\/ws$/);
    if (match) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket_required" }, 426);
      // Prevent cross-site WebSocket hijacking. No wildcard CORS or credentials in URLs/logs.
      if (request.headers.get("Origin") !== url.origin) return json({ error: "origin_not_allowed" }, 403);
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    if (url.pathname === "/") return Response.redirect(new URL(`/r/${crypto.randomUUID().replaceAll("-", "")}`, url).href, 302);
    if (/^\/r\/[a-f0-9]{32}$/.test(url.pathname)) {
      const response = await env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-cache"); headers.set("referrer-policy", "no-referrer");
      return new Response(response.body, { status: response.status, headers });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
