import { normalizeNickname } from "../public/profile.js";

export const PROTOCOL = "ping-ws-v1";
export const SIGNAL_TTL_MS = 300_000;
export const PRESENCE_TTL_MS = 45_000;
export const ROOM_TTL_MS = 86_400_000;
export const MAX_MEMBERS = 64;
export const MAX_EVENTS = 128;
export const MAX_RECEIPTS = 512;
export type Member = {
  clientId: string; nickname: string; available: boolean; pingUntil: number;
  joinedAt: number; joinRevision: number; nicknameAt: number; nicknameRevision: number;
  availableAt: number; availableRevision: number; touchedAt: number;
};
export type Signal = {
  eventId: string; generation: string; sequence: number; clientId: string;
  nickname: string; createdAt: number; pingUntil: number;
};
export type Receipt = { fingerprint: string; at: number; signal?: Signal };
export type RoomState = {
  roomId?: string; generation: string; epoch: string; revision: number; sequence: number;
  profiles: Record<string, Member>; online: string[]; events: Signal[];
  channelPing: Signal | null; receipts: Record<string, Receipt>; touchedAt: number;
};
export type Command = {
  type: "nickname" | "availability" | "signal"; id: string;
  nickname?: unknown; available?: unknown;
};
export const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
export function freshRoom(generation: string, now: number): RoomState {
  return { generation, epoch: crypto.randomUUID(), revision: 0, sequence: 0,
    profiles: {}, online: [], events: [], channelPing: null, receipts: {}, touchedAt: now };
}
/** Membership is derived from live WebSockets, not heartbeat writes to a database. */
export function roster(room: RoomState, ids: string[], now: number): boolean {
  const online = [...new Set(ids)].sort();
  const changed = online.join(",") !== room.online.join(",");
  if (!changed) return false;
  if (online.length > MAX_MEMBERS) throw new Error("room_full");
  room.revision++;
  for (const id of online) {
    if (!room.profiles[id]) room.profiles[id] = {
      clientId: id, nickname: "", available: false, pingUntil: 0,
      joinedAt: now, joinRevision: room.revision, nicknameAt: 0, nicknameRevision: 0,
      availableAt: 0, availableRevision: 0, touchedAt: now,
    };
    if (!room.online.includes(id)) {
      room.profiles[id].joinedAt = now;
      room.profiles[id].joinRevision = room.revision;
      room.profiles[id].touchedAt = now;
    }
  }
  room.online = online;
  room.touchedAt = now;
  // Bound departed profiles; a still-connected participant is never removed.
  const departed = Object.values(room.profiles).filter(p => !online.includes(p.clientId))
    .sort((a, b) => b.touchedAt - a.touchedAt);
  for (const p of departed.slice(MAX_MEMBERS)) delete room.profiles[p.clientId];
  return true;
}
export function prune(room: RoomState, now: number) {
  room.events = room.events.filter(e => now - e.createdAt < ROOM_TTL_MS).slice(-MAX_EVENTS);
  const receipts = Object.entries(room.receipts).filter(([, r]) => now - r.at < ROOM_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at).slice(0, MAX_RECEIPTS);
  room.receipts = Object.fromEntries(receipts);
}
export function execute(room: RoomState, clientId: string, command: Command, now: number) {
  if (!validId(command.id)) throw new Error("invalid_request");
  const member = room.profiles[clientId];
  if (!member || !room.online.includes(clientId)) throw new Error("not_connected");
  if (!["nickname", "availability", "signal"].includes(command.type)) throw new Error("invalid_action");
  const fingerprint = JSON.stringify([command.type, command.nickname ?? null, command.available ?? null]);
  const receiptKey = `${clientId}:${command.id}`;
  const prior = room.receipts[receiptKey];
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error("request_conflict");
    return { duplicate: true, signal: prior.signal };
  }
  let nickname: string | undefined;
  if (command.type === "nickname") {
    nickname = normalizeNickname(command.nickname);
    if (!nickname) throw new Error("nickname_required");
  } else if (!member.nickname) throw new Error("nickname_required");
  if (command.type === "availability" && typeof command.available !== "boolean") throw new Error("invalid_availability");
  if (command.type === "signal" && room.events.some(e => e.clientId === clientId && now - e.createdAt < 1000)) throw new Error("too_fast");
  room.revision++;
  member.touchedAt = now;
  room.touchedAt = now;
  let signal: Signal | undefined;
  if (nickname !== undefined && nickname !== member.nickname) {
    member.nickname = nickname; member.nicknameAt = now; member.nicknameRevision = room.revision;
  }
  if (command.type === "availability" && command.available !== member.available) {
    member.available = command.available as boolean; member.availableAt = now; member.availableRevision = room.revision;
  }
  if (command.type === "signal") {
    signal = { eventId: `${room.epoch}:${++room.sequence}`, generation: room.generation,
      sequence: room.sequence, clientId, nickname: member.nickname, createdAt: now, pingUntil: now + SIGNAL_TTL_MS };
    member.pingUntil = signal.pingUntil;
    room.channelPing = signal;
    room.events.push(signal);
  }
  room.receipts[receiptKey] = { fingerprint, at: now, ...(signal ? { signal } : {}) };
  prune(room, now);
  return { duplicate: false, signal };
}
export function snapshot(room: RoomState, now: number) {
  return { protocol: PROTOCOL, generation: room.generation, epoch: room.epoch,
    revision: room.revision, sequence: room.sequence, serverTime: now,
    users: room.online.map(id => ({ ...room.profiles[id], online: true })),
    channelPing: room.channelPing, events: room.events };
}
export function leaseDeadline(lastSeen: number, autoResponseAt: number | undefined) {
  return Math.max(lastSeen, autoResponseAt || 0) + PRESENCE_TTL_MS;
}
export async function identity(credential: unknown): Promise<string> {
  if (typeof credential !== "string" || !/^[a-f0-9]{64}$/.test(credential)) throw new Error("invalid_identity");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
