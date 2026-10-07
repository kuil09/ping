export const SIGNAL_TTL_MS = 300_000;
export const PRESENCE_TTL_MS = 45_000;
export const ROOM_TTL_MS = 86_400_000;

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

type Member = {
  clientId: string;
  lastSeen: number;
  pingUntil: number;
  lastSignalAt: number;
  // Optional for compatibility with existing v4 KV records. Default: available.
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
  // Keep the latest timestamp when the replay log is pruned; not a history UI.
  lastPing?: ChannelPing;
};

export function roomKey(roomId: string): Deno.KvKey {
  return ["ping", "v4", "room", roomId];
}

function emptyRoom(): Room {
  return {
    epoch: crypto.randomUUID(),
    revision: 0,
    sequence: 0,
    members: [],
    events: [],
  };
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
    users: room.members.filter((m) => now - m.lastSeen < ROOM_TTL_MS).map((m) => ({
      clientId: m.clientId,
      online: m.sessions.some((s) => s.until > now),
      available: m.available !== false,
      pingAt: m.lastSignalAt || 0,
      pingUntil: m.pingUntil > now ? m.pingUntil : 0,
      lastSeen: m.lastSeen,
    })).sort((a, b) => a.clientId.localeCompare(b.clientId)),
    events: room.events.filter((event) => event.pingUntil > now),
  };
}

/** No process-local channel state. Every request reads the same remote KV. */
export class KvRooms {
  constructor(public kv: Deno.Kv, private now = () => Date.now()) {}

  async read(roomId: string): Promise<Room> {
    const entry = await this.kv.get<Room>(roomKey(roomId), { consistency: "strong" });
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
    if (kind === "availability" && typeof available !== "boolean") {
      throw new ApiError(400, "invalid_availability");
    }
    for (let attempt = 0; attempt < 32; attempt++) {
      const entry = await this.kv.get<Room>(roomKey(roomId), { consistency: "strong" });
      const room = entry.value ?? emptyRoom();
      const now = this.now();
      // Migrate old rooms lazily without dropping their latest ping or membership.
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
        if (room.members.length >= 64) throw new ApiError(429, "channel_full");
        member = { clientId, lastSeen: now, pingUntil: 0, lastSignalAt: 0, available: true, sessions: [] };
        room.members.push(member);
      }
      member.sessions = member.sessions.filter((s) => s.id !== sessionId);
      if (kind !== "leave") {
        if (member.sessions.length >= 8) throw new ApiError(429, "too_many_tabs");
        member.sessions.push({ id: sessionId, until: now + PRESENCE_TTL_MS });
        member.lastSeen = now;
      }
      // Explicit value (not server-side flip): retrying false must stay false.
      if (kind === "availability") member.available = available;

      let signal: Signal | null = null;
      if (kind === "signal") {
        if (now - member.lastSignalAt < 1000) throw new ApiError(429, "too_fast");
        member.pingUntil = now + SIGNAL_TTL_MS;
        member.lastSignalAt = now;
        room.sequence++;
        signal = {
          eventId: `${room.epoch}:${room.sequence}`,
          sequence: room.sequence,
          clientId,
          requestId,
          createdAt: now,
          pingUntil: member.pingUntil,
        };
        // Every NEW ping refreshes the channel clock, whoever sent it.
        // Availability is intentionally unchanged by this action.
        room.lastPing = {
          eventId: signal.eventId, sequence: signal.sequence, clientId,
          createdAt: now, pingUntil: signal.pingUntil,
        };
        room.events.push(signal);
        room.events = room.events.slice(-128);
      }
      room.revision++;
      if (new TextEncoder().encode(JSON.stringify(room)).byteLength > 60_000) {
        throw new ApiError(429, "channel_capacity");
      }
      const result = await this.kv.atomic().check(entry)
        .set(roomKey(roomId), room, { expireIn: ROOM_TTL_MS }).commit();
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
