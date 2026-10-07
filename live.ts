import { type KvRooms, replay, type Room } from "./state.ts";

export const KEEPALIVE_MS = 25_000;
export const RECONCILE_MS = 60_000;
const encoder = new TextEncoder();
type Counts = { watchersOpened: number; reconcileReads: number; snapshots: number; frames: number; slowClosed: number };
type Subscriber = { clientId: string; sessionId: string; cursor: string | null; send: (data: Uint8Array) => void; close: () => void };

/** Local handles only: shared KV remains authoritative across instances. */
export class LiveRooms {
  private channels = new Map<string, Channel>();
  private counters: Counts = { watchersOpened: 0, reconcileReads: 0, snapshots: 0, frames: 0, slowClosed: 0 };
  constructor(private store: KvRooms, private now = () => Date.now()) {}
  stats() {
    return { channels: this.channels.size, watchers: this.channels.size,
      streams: [...this.channels.values()].reduce((n, room) => n + room.size, 0), ...this.counters };
  }
  close() { for (const room of [...this.channels.values()]) room.close(); }
  events(req: Request, roomId: string, seed: Room, headers: HeadersInit): Response {
    if (this.stats().streams >= 256 || (!this.channels.has(roomId) && this.channels.size >= 128)) {
      return new Response("Too many live connections", { status: 429, headers: { "retry-after": "30", "cache-control": "no-store" } });
    }
    let channel = this.channels.get(roomId);
    if (!channel) {
      channel = new Channel(this.store, roomId, seed, this.now, this.counters, () => {
        if (this.channels.get(roomId) === channel) this.channels.delete(roomId);
      });
      this.channels.set(roomId, channel);
    }
    const selected = channel, url = new URL(req.url);
    let stopped = false, unsubscribe = () => {}, stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        const rotation = setTimeout(() => stop(), 600_000);
        stop = () => {
          if (stopped) return;
          stopped = true; clearTimeout(rotation);
          req.signal.removeEventListener("abort", stop); unsubscribe();
          try { controller.close(); } catch { /* downstream already canceled */ }
        };
        const send = (data: Uint8Array) => {
          if (stopped) return;
          if ((controller.desiredSize ?? 0) < 0) { this.counters.slowClosed++; stop(); return; }
          try { controller.enqueue(data); this.counters.frames++; } catch { stop(); }
        };
        req.signal.addEventListener("abort", stop, { once: true });
        send(encoder.encode("retry: 3000\n: connected\n\n"));
        unsubscribe = selected.add({ clientId: url.searchParams.get("clientId") || "", sessionId: url.searchParams.get("sessionId") || "",
          cursor: req.headers.get("last-event-id") || url.searchParams.get("since"), send, close: stop }, seed);
        if (stopped) unsubscribe();
        if (req.signal.aborted) stop();
      },
      cancel: () => stop(),
    }, new ByteLengthQueuingStrategy({ highWaterMark: 65_536 }));
    return new Response(stream, { headers });
  }
}

class Channel {
  private subscribers = new Set<Subscriber>();
  private reader: ReadableStreamDefaultReader<Deno.KvEntryMaybe<unknown>[]>;
  private room: Room;
  private closed = false;
  private reading = false;
  private boundary: ReturnType<typeof setTimeout> | undefined;
  private keepalive: ReturnType<typeof setInterval>;
  private reconcile: ReturnType<typeof setInterval>;
  get size() { return this.subscribers.size; }
  constructor(private store: KvRooms, roomId: string, seed: Room, private now: () => number,
    private counters: Counts, private onClose: () => void) {
    this.room = seed;
    this.reader = store.kv.watch([store.key(roomId)]).getReader(); counters.watchersOpened++;
    this.keepalive = setInterval(() => {
      // Keep-alive has no KV read and never extends any client lease.
      const frame = encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ serverTime: now(), generation: store.generation })}\n\n`);
      for (const subscriber of this.subscribers) subscriber.send(frame);
    }, KEEPALIVE_MS);
    this.reconcile = setInterval(() => {
      if (this.closed || this.reading) return;
      this.reading = true; counters.reconcileReads++;
      void store.read(roomId).then(room => this.accept(room)).catch(() => this.close()).finally(() => { this.reading = false; });
    }, RECONCILE_MS);
    void this.watch();
  }
  add(subscriber: Subscriber, seed: Room): () => void {
    if (this.closed) { subscriber.close(); return () => {}; }
    // Add before emitting: expiration of the old last subscriber must not close the newcomer.
    this.subscribers.add(subscriber);
    if (seed.epoch !== this.room.epoch || seed.revision > this.room.revision) this.accept(seed);
    else this.emit([subscriber]);
    this.scheduleBoundary();
    return () => { this.subscribers.delete(subscriber); if (!this.subscribers.size) this.close(); };
  }
  private async watch() {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read(); if (done) break;
        const room = value[0]?.value as Room | null; if (room) this.accept(room);
      }
    } catch { /* Subscribers reconnect with independent replay cursors. */ }
    finally { this.close(); }
  }
  private accept(room: Room) {
    if (this.closed || (room.epoch === this.room.epoch && room.revision <= this.room.revision)) return;
    this.room = room; this.emit([...this.subscribers]); this.scheduleBoundary();
  }
  private emit(subscribers: Subscriber[]) {
    if (this.closed || !subscribers.length) return;
    const time = this.now(), state = this.store.snapshot(this.room);
    const snapshotFrame = encoder.encode(`id: ${state.cursor}\nevent: users\ndata: ${JSON.stringify(state)}\n\n`);
    this.counters.snapshots++;
    const signalFrames = new Map<string, Uint8Array>();
    for (const subscriber of subscribers) {
      for (const signal of replay(this.room, subscriber.cursor, time)) {
        let frame = signalFrames.get(signal.eventId);
        if (!frame) {
          frame = encoder.encode(`id: ${signal.eventId}\nevent: signal\ndata: ${JSON.stringify({ ...signal, generation: this.store.generation })}\n\n`);
          signalFrames.set(signal.eventId, frame);
        }
        subscriber.send(frame);
      }
      subscriber.cursor = state.cursor; subscriber.send(snapshotFrame);
      const member = this.room.members.find(user => user.clientId === subscriber.clientId);
      // A half-open socket without client heartbeats cannot retain server resources indefinitely.
      if (!member?.sessions.some(session => session.id === subscriber.sessionId && session.until > time)) subscriber.close();
    }
  }
  private scheduleBoundary() {
    clearTimeout(this.boundary); if (this.closed) return;
    const time = this.now();
    const deadlines = this.room.members.flatMap(member => [...member.sessions.map(session => session.until), member.pingUntil]);
    if (this.room.lastPing) deadlines.push(this.room.lastPing.pingUntil);
    const next = Math.min(...deadlines.filter(deadline => deadline > time));
    if (Number.isFinite(next)) this.boundary = setTimeout(() => {
      this.emit([...this.subscribers]); this.scheduleBoundary();
    }, Math.max(1, next - time + 1));
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.keepalive); clearInterval(this.reconcile); clearTimeout(this.boundary);
    void this.reader.cancel().catch(() => {});
    for (const subscriber of [...this.subscribers]) subscriber.close();
    this.subscribers.clear(); this.onClose();
  }
}
