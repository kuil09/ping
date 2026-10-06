import { serveDir, serveFile } from "@std/http/file-server";
import webpush from "web-push";

type PushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

type Room = {
  clients: Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>;
  pingUntil: Map<string, number>;
  subscriptions: Map<string, PushSubscription>;
};

type UserState = {
  clientId: string;
  pingUntil: number;
};

type PresenceSnapshot = {
  instanceId: string;
  roomId: string;
  users: UserState[];
  ts: number;
};

type ClusterMessage =
  | {
    type: "signal";
    roomId: string;
    clientId: string;
    pingUntil: number;
    eventId: string;
  }
  | {
    type: "subscribe";
    roomId: string;
    clientId: string;
    subscription: PushSubscription;
  }
  | { type: "presence"; snapshot: PresenceSnapshot };

const rooms = new Map<string, Room>();
const encoder = new TextEncoder();
const SIGNAL_TTL_MS = 5 * 60_000;
const PRESENCE_TTL_MS = 15_000;
const PRESENCE_HEARTBEAT_MS = 5_000;
const instanceId = crypto.randomUUID();
const cluster = new BroadcastChannel("ping:v3");
const remotePresence = new Map<string, Map<string, PresenceSnapshot>>();

const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const rawVapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ping@example.invalid";
const vapidSubject = rawVapidSubject.includes("@") &&
    !rawVapidSubject.startsWith("mailto:")
  ? `mailto:${rawVapidSubject}`
  : rawVapidSubject;
const pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);

if (pushEnabled) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

function roomFor(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = {
      clients: new Map(),
      pingUntil: new Map(),
      subscriptions: new Map(),
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

  for (const [clientId, controllers] of room.clients) {
    for (const controller of controllers) {
      try {
        controller.enqueue(payload);
      } catch {
        controllers.delete(controller);
      }
    }

    if (controllers.size === 0) room.clients.delete(clientId);
  }
}

function localUsers(roomId: string): UserState[] {
  const room = roomFor(roomId);
  return [...room.clients.keys()].map((clientId) => ({
    clientId,
    pingUntil: room.pingUntil.get(clientId) ?? 0,
  }));
}

function mergedUsers(roomId: string): UserState[] {
  const byClient = new Map<string, number>();
  const now = Date.now();

  for (const user of localUsers(roomId)) {
    byClient.set(user.clientId, user.pingUntil);
  }

  const byInstance = remotePresence.get(roomId);
  if (byInstance) {
    for (const [remoteId, snapshot] of byInstance) {
      if (now - snapshot.ts > PRESENCE_TTL_MS) {
        byInstance.delete(remoteId);
        continue;
      }

      for (const user of snapshot.users) {
        byClient.set(
          user.clientId,
          Math.max(byClient.get(user.clientId) ?? 0, user.pingUntil),
        );
      }
    }
  }

  return [...byClient.entries()]
    .map(([clientId, pingUntil]) => ({ clientId, pingUntil }))
    .sort((a, b) => a.clientId.localeCompare(b.clientId));
}

function broadcastUsers(roomId: string) {
  broadcast(roomFor(roomId), "users", { users: mergedUsers(roomId) });
}

function publishPresence(roomId: string) {
  const snapshot: PresenceSnapshot = {
    instanceId,
    roomId,
    users: localUsers(roomId),
    ts: Date.now(),
  };

  cluster.postMessage({ type: "presence", snapshot } satisfies ClusterMessage);
  broadcastUsers(roomId);
}

function applySignal(
  roomId: string,
  clientId: string,
  pingUntil: number,
  eventId: string,
) {
  const room = roomFor(roomId);
  room.pingUntil.set(clientId, pingUntil);

  broadcast(room, "signal", {
    eventId,
    clientId,
    pingUntil,
  });
  broadcastUsers(roomId);
}

cluster.onmessage = (event: MessageEvent<ClusterMessage>) => {
  const message = event.data;

  if (message.type === "signal") {
    applySignal(
      message.roomId,
      message.clientId,
      message.pingUntil,
      message.eventId,
    );
    return;
  }

  if (message.type === "subscribe") {
    roomFor(message.roomId).subscriptions.set(
      message.clientId,
      message.subscription,
    );
    return;
  }

  if (message.type === "presence") {
    const { snapshot } = message;
    if (snapshot.instanceId === instanceId) return;

    let byInstance = remotePresence.get(snapshot.roomId);
    if (!byInstance) {
      byInstance = new Map();
      remotePresence.set(snapshot.roomId, byInstance);
    }

    byInstance.set(snapshot.instanceId, snapshot);

    const room = roomFor(snapshot.roomId);
    for (const user of snapshot.users) {
      if (user.pingUntil > (room.pingUntil.get(user.clientId) ?? 0)) {
        room.pingUntil.set(user.clientId, user.pingUntil);
      }
    }

    broadcastUsers(snapshot.roomId);
  }
};

setInterval(() => {
  for (const roomId of rooms.keys()) publishPresence(roomId);
}, PRESENCE_HEARTBEAT_MS);

async function sendPushes(
  roomId: string,
  room: Room,
  senderClientId: string,
  eventId: string,
) {
  if (!pushEnabled) return;

  const payload = JSON.stringify({
    type: "signal",
    eventId,
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
    return json({ users: mergedUsers(roomId) });
  }

  if (action === "events" && req.method === "GET") {
    const clientId = url.searchParams.get("clientId") ?? crypto.randomUUID();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;

        let controllers = room.clients.get(clientId);
        if (!controllers) {
          controllers = new Set();
          room.clients.set(clientId, controllers);
        }

        controllers.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
        controller.enqueue(ssePayload("users", { users: mergedUsers(roomId) }));

        publishPresence(roomId);
      },
      cancel() {
        if (!controllerRef) return;

        const controllers = room.clients.get(clientId);
        controllers?.delete(controllerRef);

        if (controllers?.size === 0) {
          room.clients.delete(clientId);
        }

        publishPresence(roomId);
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

    const clientId = body.clientId ?? crypto.randomUUID();
    const pingUntil = Date.now() + SIGNAL_TTL_MS;
    const eventId = crypto.randomUUID();

    applySignal(roomId, clientId, pingUntil, eventId);

    cluster.postMessage({
      type: "signal",
      roomId,
      clientId,
      pingUntil,
      eventId,
    } satisfies ClusterMessage);

    publishPresence(roomId);
    void sendPushes(roomId, room, clientId, eventId);

    return json({ eventId, clientId, pingUntil });
  }

  if (action === "subscribe" && req.method === "POST") {
    if (!pushEnabled) {
      return json({ error: "push disabled" }, { status: 503 });
    }

    const body = await req.json().catch(() => null) as
      | { clientId?: string; subscription?: PushSubscription }
      | null;

    if (
      !body?.clientId || !body.subscription?.endpoint ||
      !body.subscription.keys
    ) {
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
