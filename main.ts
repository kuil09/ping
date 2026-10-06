import { serveDir, serveFile } from "@std/http/file-server";
import webpush from "npm:web-push@3.6.7";

type PushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

type Room = {
  activeUntil: number;
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  subscriptions: Map<string, PushSubscription>;
  pushCooldownUntil: number;
};

const rooms = new Map<string, Room>();
const encoder = new TextEncoder();
const SIGNAL_TTL_MS = 5 * 60_000;
const PUSH_COOLDOWN_MS = 60_000;

const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ping@example.invalid";
const pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);

if (pushEnabled) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

function roomFor(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = {
      activeUntil: 0,
      clients: new Set(),
      subscriptions: new Map(),
      pushCooldownUntil: 0,
    };
    rooms.set(id, room);
  }
  return room;
}

function validRoomId(id: string): boolean {
  return /^[A-Za-z0-9_-]{3,64}$/.test(id);
}

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function ssePayload(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room: Room, event: string, data: unknown) {
  const payload = ssePayload(event, data);
  for (const controller of room.clients) {
    try {
      controller.enqueue(payload);
    } catch {
      room.clients.delete(controller);
    }
  }
}

async function sendPushes(roomId: string, room: Room, senderClientId: string) {
  if (!pushEnabled || Date.now() < room.pushCooldownUntil) return;
  room.pushCooldownUntil = Date.now() + PUSH_COOLDOWN_MS;

  const payload = JSON.stringify({
    type: "signal",
    roomId,
    url: `/r/${roomId}`,
  });

  await Promise.allSettled(
    [...room.subscriptions.entries()].map(async ([clientId, subscription]) => {
      if (clientId === senderClientId) return;
      try {
        await webpush.sendNotification(subscription, payload, {
          TTL: Math.ceil(SIGNAL_TTL_MS / 1000),
          urgency: "high",
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          room.subscriptions.delete(clientId);
        } else {
          console.error("push failed", statusCode ?? error);
        }
      }
    }),
  );
}

async function handleApi(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/config" && req.method === "GET") {
    return json({
      pushEnabled,
      vapidPublicKey: pushEnabled ? vapidPublicKey : null,
      signalTtlMs: SIGNAL_TTL_MS,
    });
  }

  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(state|events|signal|subscribe)$/);
  if (!match) return null;

  const roomId = decodeURIComponent(match[1]);
  const action = match[2];
  if (!validRoomId(roomId)) return json({ error: "invalid room" }, { status: 400 });

  const room = roomFor(roomId);

  if (action === "state" && req.method === "GET") {
    const active = room.activeUntil > Date.now();
    return json({ active, activeUntil: active ? room.activeUntil : 0 });
  }

  if (action === "events" && req.method === "GET") {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        room.clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
        const active = room.activeUntil > Date.now();
        controller.enqueue(
          ssePayload("state", { active, activeUntil: active ? room.activeUntil : 0 }),
        );
      },
      cancel() {
        if (controllerRef) room.clients.delete(controllerRef);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  if (action === "signal" && req.method === "POST") {
    let body: { clientId?: string } = {};
    try {
      body = await req.json();
    } catch {
      // clientId is optional
    }

    const now = Date.now();
    room.activeUntil = now + SIGNAL_TTL_MS;
    const state = { active: true, activeUntil: room.activeUntil };
    broadcast(room, "signal", state);

    void sendPushes(roomId, room, body.clientId ?? "");
    return json(state);
  }

  if (action === "subscribe" && req.method === "POST") {
    if (!pushEnabled) return json({ error: "push disabled" }, { status: 503 });

    const body = await req.json().catch(() => null) as
      | { clientId?: string; subscription?: PushSubscription }
      | null;

    if (!body?.clientId || !body.subscription?.endpoint || !body.subscription.keys) {
      return json({ error: "invalid subscription" }, { status: 400 });
    }

    room.subscriptions.set(body.clientId, body.subscription);
    return json({ ok: true });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  const api = await handleApi(req, url);
  if (api) return api;

  if (url.pathname === "/") {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    return Response.redirect(new URL(`/r/${id}`, url), 302);
  }

  if (/^\/r\/[A-Za-z0-9_-]{3,64}$/.test(url.pathname)) {
    return serveFile(req, "./public/index.html");
  }

  return serveDir(req, {
    fsRoot: "public",
    urlRoot: "",
    showDirListing: false,
    quiet: true,
  });
});
