import { DurableObject } from "cloudflare:workers";
import { generation, type Env } from "./env.ts";
import { execute, freshRoom, identity, leaseDeadline, MAX_MEMBERS, PRESENCE_TTL_MS, PROTOCOL,
  roster, ROOM_TTL_MS, snapshot, type Command, type RoomState, type Signal } from "./model.ts";
import { sendPush, validSubscription, vapid, type Subscription } from "./push.ts";

type Attachment = { generation: string; clientId: string | null; lastSeen: number; visible: boolean;
  started: number; count: number; joined: number };
export class PingRoom extends DurableObject<Env> {
  private release: string;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.release = generation(env);
    // Auto-response is handled by Cloudflare without invoking webSocketMessage or waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("~ping", "~pong"));
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS subscriptions (client TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");
    const row = ctx.storage.sql.exec<{value: string}>("SELECT value FROM room WHERE id=1").toArray()[0];
    const state = row ? JSON.parse(row.value) as RoomState : null;
    if (!state || state.generation !== this.release) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec("DELETE FROM subscriptions");
        this.save(freshRoom(this.release, Date.now()));
      });
      for (const ws of ctx.getWebSockets()) ws.close(1012, "deployment_changed");
    }
  }
  private read(): RoomState {
    const row = this.ctx.storage.sql.exec<{value:string}>("SELECT value FROM room WHERE id=1").toArray()[0];
    return row ? JSON.parse(row.value) : freshRoom(this.release, Date.now());
  }
  private save(room: RoomState) {
    this.ctx.storage.sql.exec("INSERT INTO room(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(room));
  }
  private attachment(ws: WebSocket): Attachment | null { return ws.deserializeAttachment() as Attachment | null; }
  private deadline(ws: WebSocket, a: Attachment) {
    if (!a.clientId) return a.joined + 10_000;
    return leaseDeadline(a.lastSeen, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime());
  }
  private live(now = Date.now()) {
    return this.ctx.getWebSockets().filter(ws => {
      const a = this.attachment(ws);
      return ws.readyState === 1 && a?.generation === this.release && this.deadline(ws, a) > now;
    });
  }
  private sync(room: RoomState, now = Date.now()) {
    return roster(room, this.live(now).map(ws => this.attachment(ws)?.clientId).filter((id): id is string => Boolean(id)), now);
  }
  private send(ws: WebSocket, value: unknown) {
    try {
      // Outbound state is bounded by member/event caps; slow clients cannot retain arbitrary payloads.
      if (((ws as WebSocket & { bufferedAmount?: number }).bufferedAmount || 0) > 262144) { ws.close(4008, "slow_consumer"); return; }
      if (ws.readyState === 1) ws.send(JSON.stringify(value));
    } catch { try { ws.close(1011, "send_failed"); } catch { /* already closed */ } }
  }
  private broadcast(room: RoomState) {
    const message = { type: "state", state: snapshot(room, Date.now()) };
    for (const ws of this.live()) if (this.attachment(ws)?.clientId) this.send(ws, message);
  }
  private async schedule(room: RoomState) {
    const now = Date.now();
    const sockets = this.live(now);
    const deadline = sockets.length ? Math.min(...sockets.map(ws => this.deadline(ws, this.attachment(ws)!))) : room.touchedAt + ROOM_TTL_MS;
    const at = Math.max(now + 50, deadline);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at || current <= now) await this.ctx.storage.setAlarm(at);
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    if (this.ctx.getWebSockets().filter(w => w.readyState === 1).length >= 128) return new Response("Room full", { status: 429 });
    const pair = new WebSocketPair();
    const now = Date.now();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ generation: this.release, clientId: null, lastSeen: now, visible: true,
      started: now, count: 0, joined: now } satisfies Attachment);
    const room = this.read();
    room.roomId = new URL(request.url).pathname.split("/")[3];
    this.save(room);
    await this.schedule(room);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws: WebSocket, input: string | ArrayBuffer) {
    let id: unknown;
    try {
      if (typeof input !== "string" || new TextEncoder().encode(input).length > 8192) {
        ws.close(1009, "message_too_large"); return;
      }
      const message = JSON.parse(input);
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid_message");
      id = message.id;
      const a = this.attachment(ws), now = Date.now();
      if (!a || a.generation !== this.release) { ws.close(1012, "deployment_changed"); return; }
      if (this.deadline(ws, a) <= now) { ws.close(4000, "presence_expired"); return; }
      if (now - a.started >= 10000) { a.started = now; a.count = 0; }
      if (++a.count > 30) { ws.close(4008, "too_fast"); return; }
      a.lastSeen = now;
      ws.serializeAttachment(a);
      if (message.type === "hello") {
        if (a.clientId) throw new Error("already_connected");
        if (message.protocol !== PROTOCOL) { ws.close(4006, "reload_required"); return; }
        const clientId = await identity(message.credential);
        // Re-read after the asynchronous hash: never commit a snapshot captured before an await.
        if (ws.readyState !== 1) return;
        const room = this.read();
        this.sync(room);
        if (!room.online.includes(clientId) && room.online.length >= MAX_MEMBERS) throw new Error("room_full");
        a.clientId = clientId; a.visible = message.visible !== false; a.lastSeen = Date.now();
        ws.serializeAttachment(a);
        this.sync(room); this.save(room);
        this.send(ws, { type: "welcome", clientId, state: snapshot(room, Date.now()) });
        this.broadcast(room); await this.schedule(room); return;
      }
      if (!a.clientId) throw new Error("hello_required");
      if (message.type === "visibility") { a.visible = message.visible === true; ws.serializeAttachment(a); return; }
      const room = this.read();
      this.sync(room, now);
      if (message.type === "subscribe") {
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("invalid_request");
        if (!vapid(this.env)) throw new Error("push_not_configured");
        if (!validSubscription(message.subscription)) throw new Error("invalid_subscription");
        this.ctx.storage.sql.exec("INSERT INTO subscriptions(client,value,expires) VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET value=excluded.value,expires=excluded.expires",
          a.clientId, JSON.stringify(message.subscription), now + ROOM_TTL_MS);
        this.send(ws, { type: "ack", id, state: snapshot(room, now) }); return;
      }
      const result = execute(room, a.clientId, message as Command, now);
      this.save(room);
      this.send(ws, { type: "ack", id, state: snapshot(room, now), signal: result.signal });
      if (!result.duplicate) {
        this.broadcast(room);
        if (result.signal) {
          // The Worker-validated upgrade path is the only notification destination.
          if (room.roomId) this.ctx.waitUntil(this.push(room.roomId, result.signal));
        }
      }
      await this.schedule(room);
    } catch (error) {
      const known = ["invalid_request", "not_connected", "invalid_action", "request_conflict", "nickname_required", "invalid_nickname", "nickname_too_long", "invalid_availability", "too_fast", "room_full", "invalid_identity", "already_connected", "hello_required", "push_not_configured", "invalid_subscription", "invalid_message"];
      const code = error instanceof Error && known.includes(error.message) ? error.message : "request_failed";
      this.send(ws, { type: "error", id: typeof id === "string" ? id : undefined, error: code });
    }
  }
  private async push(roomId: string, signal: Signal) {
    const foreground = new Set(this.live().filter(ws => this.attachment(ws)?.visible).map(ws => this.attachment(ws)?.clientId));
    const subscriptions = this.ctx.storage.sql.exec<{client: string; value: string}>(
      "SELECT client,value FROM subscriptions WHERE expires>? LIMIT 64", Date.now()).toArray();
    // Eight concurrent requests at most; no unbounded job or queue accumulation.
    for (let i = 0; i < subscriptions.length; i += 8) await Promise.all(subscriptions.slice(i, i + 8).map(async item => {
      if (item.client === signal.clientId || foreground.has(item.client)) return;
      const subscription = JSON.parse(item.value) as Subscription;
      const status = await sendPush(this.env, subscription, { type: "signal", roomId, signal });
      if (status === 404 || status === 410) this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE client=? AND value=?", item.client, item.value);
    }));
  }
  async webSocketClose(ws: WebSocket) { await this.disconnected(ws); }
  async webSocketError(ws: WebSocket) { await this.disconnected(ws); }
  private async disconnected(ws: WebSocket) {
    const a = this.attachment(ws);
    if (a) { a.clientId = null; a.lastSeen = 0; a.joined = 0; ws.serializeAttachment(a); }
    try { ws.close(1000, "closed"); } catch { /* already closed */ }
    const room = this.read();
    if (this.sync(room)) { this.save(room); this.broadcast(room); }
    await this.schedule(room);
  }
  async alarm() {
    const now = Date.now(), room = this.read();
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws);
      if (!a || a.generation !== this.release || this.deadline(ws, a) <= now) {
        if (a) { a.clientId = null; a.joined = 0; a.lastSeen = 0; ws.serializeAttachment(a); }
        ws.close(4000, "presence_expired");
      }
    }
    if (this.sync(room, now)) { this.save(room); this.broadcast(room); }
    this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE expires<=?", now);
    if (!this.live(now).length && now >= room.touchedAt + ROOM_TTL_MS) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM room");
        this.ctx.storage.sql.exec("DELETE FROM subscriptions");
      });
      return;
    }
    await this.schedule(room);
  }
}
