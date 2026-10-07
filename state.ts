export const SIGNAL_TTL_MS = 300_000;
export const PRESENCE_TTL_MS = 45_000;
export const ROOM_TTL_MS = 86_400_000;

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/** Stable across instances, different for a new deployment/configuration. Never a process UUID. */
export function deploymentGeneration(env: Record<string, string | undefined>): string {
  const id = env.DENO_DEPLOYMENT_ID || env.DENO_DEPLOY_BUILD_ID;
  if (id) return `${env.DENO_TIMELINE || "deploy"}:${id}`;
  if (env.DENO_DEPLOY === "true") throw new ApiError(503, "deployment_identity_missing");
  return env.PING_STATE_GENERATION || "local";
}

type Member = {
  clientId: string;
  lastSeen: number;
  pingUntil: number;
  lastSignalAt: number;
  available?: boolean;
  sessions: { id: string; until: number }[];
};

export type Signal = {
  eventId: string;
  sequence: number;
  clientId: string;
  requestId: string;
  createdAt: number;
  pingUntil: number;
};
export type ChannelPing = Pick<Signal, "eventId" | "sequence" | "clientId" | "createdAt" | "pingUntil">;
export type Room = {
  epoch: string;
  revision: number;
  sequence: number;
  members: Member[];
  events: Signal[];
  lastPing?: ChannelPing;
};

export function roomKey(roomId: string, generation = "local"): Deno.KvKey {
  return ["ping", "v5", generation, "room", roomId];
}
function emptyRoom(): Room {
  return { epoch: crypto.randomUUID(), revision: 0, sequence: 0, members: [], events: [] };
}
function onlineUntil(member: Member) {
  return Math.max(0, ...member.sessions.map((session) => session.until));
}

export function snapshot(room: Room, now = Date.now()) {
  const latest = room.lastPing ?? room.events.at(-1);
  return {
    epoch: room.epoch,
    revision: room.revision,
    sequence: room.sequence,
    cursor: `${room.epoch}:${room.sequence}`,
    serverTime: now,
    channelPing: latest ? {
      eventId: latest.eventId, sequence: latest.sequence, clientId: latest.clientId,
      createdAt: latest.createdAt, pingUntil: latest.pingUntil,
    } : null,
    // Leases, not explicit leave events or open server-side sockets, define membership.
    users: room.members.filter((m) => onlineUntil(m) > now).map((m) => ({
      clientId: m.clientId,
      online: true,
      onlineUntil: onlineUntil(m),
      available: m.available !== false,
      pingAt: m.lastSignalAt || 0,
      pingUntil: m.pingUntil > now ? m.pingUntil : 0,
      lastSeen: m.lastSeen,
    })).sort((a, b) => a.clientId.localeCompare(b.clientId)),
    events: room.events.filter((event) => event.pingUntil > now),
  };
}

/** Each deployment gets an empty namespace; old namespaces expire without a dangerous global flush. */
export class KvRooms {
  constructor(public kv: Deno.Kv, private now = () => Date.now(), public generation = "local") {}

  key(roomId: string): Deno.KvKey { return roomKey(roomId, this.generation); }
  subscriptionPrefix(roomId: string): Deno.KvKey {
    return ["ping", "v5", this.generation, "subscription", roomId];
  }
  snapshot(room: Room) { return { ...snapshot(room, this.now()), generation: this.generation }; }

  async read(roomId: string): Promise<Room> {
    const entry = await this.kv.get<Room>(this.key(roomId), { consistency: "strong" });
    return entry.value ?? emptyRoom();
  }

  async act(
    roomId: string,
    clientId: string,
    sessionId: string,
    kind: "presence" | "leave" | "signal" | "availability",
    requestId = "",
    available?: boolean,
  ): Promise<{ room: Room; signal: Signal | null; duplicate: boolean }> {
    if (kind === "availability" && typeof available !== "boolean") throw new ApiError(400, "invalid_availability");
    for (let attempt = 0; attempt < 32; attempt++) {
      const entry = await this.kv.get<Room>(this.key(roomId), { consistency: "strong" });
      const room = entry.value ?? emptyRoom();
      const now = this.now();
      room.lastPing ??= room.events.at(-1);
      room.members = room.members.filter((m) => now - m.lastSeen < ROOM_TTL_MS);
      room.events = room.events.filter((e) => e.pingUntil > now).slice(-128);
      for (const m of room.members) m.sessions = m.sessions.filter((s) => s.until > now);

      if (kind === "signal") {
        const previous = room.events.find((e) => e.clientId === clientId && e.requestId === requestId);
        if (previous) return { room, signal: previous, duplicate: true };
      }
      let member = room.members.find((m) => m.clientId === clientId);
      if (!member && kind === "leave") return { room, signal: null, duplicate: false };
      if (!member) {
        if (room.members.length >= 64) {
          const departed = room.members.filter((m) => onlineUntil(m) <= now).sort((a, b) => a.lastSeen - b.lastSeen)[0];
          if (!departed) throw new ApiError(429, "channel_full");
          room.members = room.members.filter((m) => m !== departed);
        }
        member = { clientId, lastSeen: now, pingUntil: 0, lastSignalAt: 0, available: true, sessions: [] };
        room.members.push(member);
      }
      member.sessions = member.sessions.filter((s) => s.id !== sessionId);
      if (kind !== "leave") {
        if (member.sessions.length >= 8) throw new ApiError(429, "too_many_tabs");
        member.sessions.push({ id: sessionId, until: now + PRESENCE_TTL_MS });
        member.lastSeen = now;
      }
      // Absolute value, not a flip: request retries cannot toggle it back accidentally.
      if (kind === "availability") member.available = available;

      let signal: Signal | null = null;
      if (kind === "signal") {
        if (now - member.lastSignalAt < 1000) throw new ApiError(429, "too_fast");
        member.pingUntil = now + SIGNAL_TTL_MS;
        member.lastSignalAt = now;
        room.sequence++;
        signal = {
          eventId: `${room.epoch}:${room.sequence}`, sequence: room.sequence,
          clientId, requestId, createdAt: now, pingUntil: member.pingUntil,
        };
        // Every NEW sender event refreshes the channel, regardless of availability or prior activity.
        room.lastPing = {
          eventId: signal.eventId, sequence: signal.sequence, clientId,
          createdAt: now, pingUntil: signal.pingUntil,
        };
        room.events.push(signal);
        room.events = room.events.slice(-128);
      }
      room.revision++;
      if (new TextEncoder().encode(JSON.stringify(room)).byteLength > 60_000) throw new ApiError(429, "channel_capacity");
      const result = await this.kv.atomic().check(entry)
        .set(this.key(roomId), room, { expireIn: ROOM_TTL_MS }).commit();
      if (result.ok) return { room, signal, duplicate: false };
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
    throw new ApiError(503, "channel_busy_retry");
  }
}

/** KV watch may coalesce changes: replay from the bounded event log, not the watch count. */
export function replay(room: Room, cursor: string | null, now = Date.now()) {
  if (!cursor) return [];
  const split = cursor.lastIndexOf(":");
  if (cursor.slice(0, split) !== room.epoch) return [];
  const sequence = Number(cursor.slice(split + 1));
  if (!Number.isSafeInteger(sequence) || sequence < 0) return [];
  return room.events.filter((e) => e.sequence > sequence && e.pingUntil > now);
}
