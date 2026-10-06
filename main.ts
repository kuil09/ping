import { serveDir, serveFile } from "@std/http/file-server";
import webpush from "web-push";

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

type ClusterMessage =
  | { type: "signal"; roomId: string; activeUntil: number }
  | { type: "subscribe"; roomId: string; clientId: string; subscription: PushSubscription }
  | { type: "state-request"; roomId: string; requestId: string }
  | { type: "state-response"; roomId: string; requestId: string; activeUntil: number };

const rooms = new Map<string, Room>();
const encoder = new TextEncoder();
const SIGNAL_TTL_MS = 5 * 60_000;
const PUSH_COOLDOWN_MS = 60_000;
const cluster = new BroadcastChannel("ping:v1");
const stateWaiters = new Map<string, { roomId: string; activeUntil: number }>();

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

function applySignal(roomId: string, activeUntil: number) {
  const room = roomFor(roomId);
  room.activeUntil = Math.max(room.activeUntil, activeUntil);
  broadcast(room, "signal", { active: room.activeUntil > Date.now(), activeUntil: room.activeUntil });
}

cluster.onmessage = (event: MessageEvent<ClusterMessage>) => {
  const message = event.data;

  if (message.type === "signal") {
    applySignal(message.roomId, message.activeUntil);
    return;
  }

  if (message.type === "subscribe") {
    roomFor(message.roomId).subscriptions.set(message.clientId, message.subscription);
    return;
  }

  if (message.type === "state-request") {
    const room = rooms.get(message.roomId);
    const activeUntil = room?.activeUntil ?? 0;
    if (activeUntil > Date.now()) {
      cluster.postMessage({
        type: "state-response",
        roomId: message.roomId,
        requestId: message.requestId,
        activeUntil,
      } satisfies ClusterMessage);
    }
    return;
  }

  if (message.type === "state-response") {
    const waiter = stateWaiters.get(message.requestId);
    if (waiter && waiter.roomId === message.roomId) {
      waiter.activeUntil = Math.max(waiter.activeUntil, message.activeUntil);
    }
  }
};

async function syncedActiveUntil(roomId: string): Promise<number> {
  const room = roomFor(roomId);
  const requestId = crypto.randomUUID();
  const waiter = { roomId, activeUntil: room.activeUntil };
  stateWaiters.set(requestId, waiter);

  cluster.postMessage({ type: "state-request", roomId, requestId } satisfies ClusterMessage);
  await new Promise((resolve) => setTimeout(resolve, 120));
  stateWaiters.delete(requestId);

  room.activeUntil = Math.max(room.activeUntil, waiter.activeUntil);
  return room.activeUntil > Date.now() ? room.activeUntil : 0;
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

  const match = url.pathname.match(
    /^\/api\/rooms\/([^/]+)\/(state|events|signal|subscribe)$/,
  );
  if (!match) return null;

  const roomId = decodeURIComponent(match[1]);
  const action = match[2];
  if (!validRoomId(roomId)) {
    return json({ error: "invalid room" }, { status: 400 });
  }

  const room = roomFor(roomId);

  if (action === "state" && req.method === "GET") {
    const activeUntil = await syncedActiveUntil(roomId);
    return json({ active: activeUntil > Date.now(), activeUntil });
  }

  if (action === "events" && req.method === "GET") {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        room.clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));

        void syncedActiveUntil(roomId).then((activeUntil) => {
          try {
            controller.enqueue(
              ssePayload("state", {
                active: activeUntil > Date.now(),
                activeUntil,
              }),
            );
          } catch {
            room.clients.delete(controller);
          }
        });
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

    const activeUntil = Date.now() + SIGNAL_TTL_MS;
    applySignal(roomId, activeUntil);
    cluster.postMessage({ type: "signal", roomId, activeUntil } satisfies ClusterMessage);

    void sendPushes(roomId, room, body.clientId ?? "");
    return json({ active: true, activeUntil });
  }

  if (action === "subscribe" && req.method === "POST") {
    if (!pushEnabled) {
      return json({ error: "push disabled" }, { status: 503 });
    }

    const body = await req.json().catch(() => null) as
      | { clientId?: string; subscription?: PushSubscription }
      | null;

    if (!body?.clientId || !body.subscription?.endpoint || !body.subscription.keys) {
      return json({ error: "invalid subscription" }, { status: 400 });
    }

    room.subscriptions.set(body.clientId, body.subscription);
    cluster.postMessage({
      type: "subscribe",
      roomId,
      clientId: body.clientId,
      subscription: body.subscription,
    } satisfies ClusterMessage);

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
