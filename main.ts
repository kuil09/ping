import { serveDir, serveFile } from "@std/http/file-server";
import webpush from "web-push";
import { ApiError, deploymentGeneration, KvRooms, PRESENCE_TTL_MS, ROOM_TTL_MS, SIGNAL_TTL_MS } from "./state.ts";
import { NICKNAME_MAX_LENGTH, PROFILE_UI_VERSION } from "./public/profile.js";
import { LiveRooms } from "./live.ts";

const VERSION = "shared-kv-v2";
const RESOURCE_VERSION = "pooled-live-v1";
const instanceId = crypto.randomUUID();
const generation = deploymentGeneration(Object.fromEntries(
  ["DENO_DEPLOY", "DENO_DEPLOYMENT_ID", "DENO_DEPLOY_BUILD_ID", "DENO_TIMELINE", "PING_STATE_GENERATION"].map(name => [name, Deno.env.get(name)]),
));
const publicKey = (Deno.env.get("VAPID_PUBLIC_KEY") ?? "").trim();
const privateKey = (Deno.env.get("VAPID_PRIVATE_KEY") ?? "").trim();
const rawSubject = (Deno.env.get("VAPID_SUBJECT") ?? "").trim();
const subject = /^[^\s:@]+@[^\s@]+$/.test(rawSubject) ? `mailto:${rawSubject}` : rawSubject;
let pushEnabled = false;
try {
  if (publicKey && privateKey && subject) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    pushEnabled = true;
  }
} catch { console.error("Invalid VAPID configuration; Web Push disabled. Core signaling remains available."); }

let storePromise: Promise<KvRooms> | undefined;
let live: LiveRooms | undefined;
function getStore(): Promise<KvRooms> {
  storePromise ??= Deno.openKv(Deno.env.get("PING_KV_URL") || undefined)
    .then(kv => { const store = new KvRooms(kv, () => Date.now(), generation); live = new LiveRooms(store); return store; })
    .catch(() => { storePromise = undefined; throw new ApiError(503, "shared_storage_unavailable"); });
  return storePromise;
}
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: {
    "cache-control": "no-store", "x-ping-version": VERSION, "x-ping-instance": instanceId,
    "x-ping-generation": generation,
    ...(status === 429 || status === 503 ? { "retry-after": "30" } : {}),
  } });
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new ApiError(415, "json_required");
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "body_required");
  let size = 0, text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); throw new ApiError(413, "body_too_large"); }
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json");
  } finally { reader.releaseLock(); }
}

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
function validSubscription(value: unknown): value is Subscription {
  if (!value || typeof value !== "object") return false;
  const subscription = value as Subscription;
  try {
    const url = new URL(subscription.endpoint), host = url.hostname;
    const trusted = host === "fcm.googleapis.com" || host === "web.push.apple.com" ||
      host === "updates.push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com") || host.endsWith(".notify.windows.com");
    return trusted && url.protocol === "https:" && (!url.port || url.port === "443") &&
      !url.username && !url.password && subscription.endpoint.length < 2048 &&
      typeof subscription.keys?.p256dh === "string" && /^[A-Za-z0-9_-]{87}=?$/.test(subscription.keys.p256dh) &&
      typeof subscription.keys?.auth === "string" && /^[A-Za-z0-9_-]{22}={0,2}$/.test(subscription.keys.auth);
  } catch { return false; }
}
async function sendPushes(store: KvRooms, roomId: string, sender: string, signal: unknown) {
  if (!pushEnabled) return;
  const jobs: Promise<unknown>[] = [];
  for await (const entry of store.kv.list<Subscription>({ prefix: store.subscriptionPrefix(roomId) }, { limit: 64 })) {
    if (entry.key.at(-1) === sender) continue;
    jobs.push(webpush.sendNotification(entry.value, JSON.stringify({ type: "signal", generation, roomId, signal, url: `/r/${roomId}` }), {
      TTL: 300, urgency: "high", timeout: 5000,
    }).catch(async (error: { statusCode?: number }) => {
      if (error.statusCode === 404 || error.statusCode === 410) await store.kv.atomic().check(entry).delete(entry.key).commit();
      else console.warn("push_delivery_failed", error.statusCode ?? "network");
    }));
  }
  await Promise.allSettled(jobs);
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (req.method === "POST") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin) throw new ApiError(403, "origin_not_allowed");
      const expected = req.headers.get("x-ping-generation");
      if (expected && expected !== generation) throw new ApiError(409, "deployment_changed");
    }
    if (url.pathname === "/api/config") return json({
      version: VERSION, resourceVersion: RESOURCE_VERSION, generation, storage: "deno-kv", pushEnabled,
      profileUi: PROFILE_UI_VERSION, defaultAvailable: false, nicknameMaxLength: NICKNAME_MAX_LENGTH,
      vapidPublicKey: pushEnabled ? publicKey : null, signalTtlMs: SIGNAL_TTL_MS,
      presenceTtlMs: PRESENCE_TTL_MS, publicOrigin: Deno.env.get("PUBLIC_ORIGIN") || null,
    });
    if (url.pathname === "/api/health") {
      const store = await getStore(); await store.kv.get(["ping", "health"]);
      // Aggregate, per-instance counts only; no channel IDs, names or subscriptions.
      return json({ ok: true, version: VERSION, resourceVersion: RESOURCE_VERSION, generation, storage: "deno-kv", instanceId, live: live?.stats() });
    }
    const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{3,64})\/(state|events|presence|availability|nickname|signal|subscribe)$/);
    if (match) {
      const [, roomId, action] = match;
      const store = await getStore();
      if (req.method === "GET" && action === "state") return json(store.snapshot(await store.read(roomId)));
      if (req.method === "GET" && action === "events") {
        const clientId = url.searchParams.get("clientId"), sessionId = url.searchParams.get("sessionId");
        if (!validId(clientId) || !validId(sessionId)) throw new ApiError(400, "reload_required");
        // Check capacity before the join writes to KV, not after.
        const stats = live!.stats();
        if (stats.streams >= 256) throw new ApiError(429, "live_capacity");
        const { room } = await store.act(roomId, clientId, sessionId, "presence");
        return live!.events(req, roomId, room, {
          "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no", "x-ping-instance": instanceId, "x-ping-version": VERSION, "x-ping-generation": generation,
        });
      }
      if (req.method !== "POST") throw new ApiError(405, "method_not_allowed");
      const body = await readBody(req);
      if (!validId(body.clientId) || !validId(body.sessionId)) throw new ApiError(400, "invalid_client");
      if (action === "presence") {
        const result = await store.act(roomId, body.clientId, body.sessionId, body.online === false ? "leave" : "presence");
        return json(store.snapshot(result.room));
      }
      if (action === "availability") {
        if (typeof body.available !== "boolean") throw new ApiError(400, "invalid_availability");
        const result = await store.act(roomId, body.clientId, body.sessionId, "availability", "", body.available);
        return json(store.snapshot(result.room));
      }
      if (action === "nickname") {
        const result = await store.act(roomId, body.clientId, body.sessionId, "nickname", "", undefined, body.nickname);
        return json(store.snapshot(result.room));
      }
      if (action === "signal") {
        if (!validId(body.requestId)) throw new ApiError(400, "request_id_required");
        const result = await store.act(roomId, body.clientId, body.sessionId, "signal", body.requestId);
        if (!result.duplicate) {
          try { await sendPushes(store, roomId, body.clientId, result.signal); }
          catch { console.warn("push_dispatch_failed"); }
        }
        return json({ ...store.snapshot(result.room), signal: result.signal });
      }
      if (action === "subscribe") {
        if (!pushEnabled) throw new ApiError(503, "push_not_configured");
        if (!validSubscription(body.subscription)) throw new ApiError(400, "invalid_subscription");
        await store.kv.set([...store.subscriptionPrefix(roomId), body.clientId], body.subscription, { expireIn: ROOM_TTL_MS });
        return json({ ok: true, generation });
      }
      throw new ApiError(405, "method_not_allowed");
    }
    if (url.pathname.startsWith("/api/")) throw new ApiError(404, "not_found");
    if (req.method !== "GET" && req.method !== "HEAD") throw new ApiError(405, "method_not_allowed");
    if (url.pathname === "/") return Response.redirect(new URL(`/r/${crypto.randomUUID().replaceAll("-", "")}`, url), 302);
    const response = /^\/r\/[A-Za-z0-9_-]{3,64}$/.test(url.pathname)
      ? await serveFile(req, "./public/index.html")
      : await serveDir(req, { fsRoot: "public", showDirListing: false, quiet: true });
    response.headers.set("cache-control", "no-cache");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-ping-version", VERSION);
    return response;
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.code, generation }, error.status);
    console.error("request_failed", url.pathname.startsWith("/api/") ? "api" : "static");
    return json({ error: "service_unavailable" }, 503);
  }
}
if (import.meta.main) {
  Deno.addSignalListener("SIGINT", () => live?.close());
  Deno.serve({ port: Number(Deno.env.get("PORT") || 8000) }, handler);
}
export { handler };
