export const HISTORY_VERSION = "local-history-v2";
export const HISTORY_LIMIT = 300;
export const HISTORY_DAYS = 30;
const AGE = HISTORY_DAYS * 86_400_000;
const ROOT = "ping:history:v2:";
const KINDS = new Set(["ping", "availability", "nickname", "join", "leave", "reset"]);
function validEntry(value) {
  return value && typeof value.id === "string" && value.id.length <= 512 &&
    KINDS.has(value.kind) && Number.isFinite(value.at) && value.at >= 0 &&
    typeof value.name === "string" && value.name.length <= 160 &&
    (value.from === undefined || (typeof value.from === "string" && value.from.length <= 160)) &&
    (value.available === undefined || typeof value.available === "boolean");
}
/** One key per event: independent tabs cannot overwrite each other's distinct writes. */
export class LocalHistory {
  constructor(roomId, { storage = () => globalThis.localStorage, now = () => Date.now() } = {}) {
    this.prefix = `${ROOT}${roomId}:`; this.now = now; this.items = new Map();
    this.cutoff = 0; this.persistent = true; this.onchange = () => {};
    try { this.storage = storage(); if (!this.storage) throw new Error(); }
    catch { this.storage = null; this.persistent = false; }
    this.refresh();
  }
  notify() { try { this.onchange(); } catch { /* optional UI */ } }
  readCutoff() {
    if (!this.storage) return;
    try {
      const value = Number(this.storage.getItem(`${this.prefix}cleared`));
      if (Number.isFinite(value) && value <= this.now() + 60_000) this.cutoff = Math.max(this.cutoff, value);
    } catch { this.persistent = false; }
  }
  refresh() {
    this.readCutoff();
    if (this.storage) {
      try {
        const loaded = new Map();
        for (let i = 0; i < this.storage.length; i++) {
          const key = this.storage.key(i);
          if (!key?.startsWith(`${this.prefix}event:`)) continue;
          const raw = this.storage.getItem(key);
          if (!raw || raw.length > 4096) continue;
          try {
            const entry = JSON.parse(raw);
            if (validEntry(entry) && key === `${this.prefix}event:${entry.id}`) loaded.set(entry.id, entry);
          } catch { /* damaged data is not executable */ }
        }
        if (this.persistent) this.items = loaded;
        else for (const [id, entry] of loaded) if (!this.items.has(id)) this.items.set(id, entry);
      } catch { this.persistent = false; }
    }
    this.prune(); this.notify();
  }
  entries() {
    const min = Math.max(this.cutoff, this.now() - AGE);
    return [...this.items.values()].filter(entry => entry.at > min && entry.at <= this.now() + 60_000)
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, HISTORY_LIMIT);
  }
  prune() {
    const keep = new Set(this.entries().map(entry => entry.id));
    for (const [id] of this.items) if (!keep.has(id)) {
      this.items.delete(id);
      try { this.storage?.removeItem(`${this.prefix}event:${id}`); } catch { this.persistent = false; }
    }
  }
  add(entry) {
    if (!validEntry(entry)) return false;
    this.readCutoff();
    if (entry.at <= Math.max(this.cutoff, this.now() - AGE) || entry.at > this.now() + 60_000 || this.items.has(entry.id)) return false;
    const key = `${this.prefix}event:${entry.id}`;
    if (this.storage) {
      try {
        const raw = this.storage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (validEntry(parsed) && parsed.id === entry.id) { this.items.set(entry.id, parsed); this.prune(); this.notify(); return false; }
        }
      } catch { /* damaged entry may be replaced */ }
    }
    this.items.set(entry.id, entry);
    this.prune();
    if (!this.items.has(entry.id)) return false;
    try { this.storage?.setItem(key, JSON.stringify(entry)); } catch { this.persistent = false; }
    this.notify(); return true;
  }
  clear() {
    // Suppress pre-clear replay; remove only this app's current-channel history keys.
    this.cutoff = Math.max(this.cutoff, this.now());
    try {
      this.storage?.setItem(`${this.prefix}cleared`, String(this.cutoff));
      const keys = [];
      for (let i = 0; i < (this.storage?.length || 0); i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(`${this.prefix}event:`)) keys.push(key);
      }
      for (const key of keys) this.storage.removeItem(key);
    } catch { this.persistent = false; }
    this.items.clear(); this.notify();
  }
}
/** Initial membership is a baseline, not fabricated joins or earlier profile actions. */
export class HistoryTracker {
  constructor(store) { this.store = store; this.scope = null; this.previous = new Map(); }
  signal(signal, generation, users = []) {
    if (!signal?.eventId || !Number.isFinite(signal.createdAt)) return;
    const member = users.find(user => user.clientId === signal.clientId);
    this.store.add({ id: `${signal.generation || generation || "unknown"}:ping:${signal.eventId}`,
      kind: "ping", at: signal.createdAt, name: signal.nickname ?? member?.nickname ?? "", observed: false });
  }
  observe(state) {
    if (!Array.isArray(state.users) || !state.epoch || !Number.isFinite(state.serverTime)) return;
    const scope = `${state.generation || "unknown"}:${state.epoch}`;
    const current = new Map(state.users.map(user => [user.clientId, { ...user }]));
    for (const signal of state.events || []) this.signal(signal, state.generation, state.users);
    if (this.scope && this.scope !== scope) {
      this.store.add({ id: `${scope}:reset`, kind: "reset", at: state.serverTime, name: "", observed: true });
    } else if (this.scope === scope) {
      for (const [id, user] of current) {
        const before = this.previous.get(id);
        if (!before) {
          this.store.add({ id: `${scope}:join:${id}:${user.joinRevision || user.lastSeen}`, kind: "join",
            at: user.joinedAt || state.serverTime, name: user.nickname || "", observed: true });
          continue;
        }
        if ((before.nickname || "") !== (user.nickname || "")) {
          this.store.add({ id: `${scope}:nickname:${id}:${user.nicknameRevision || state.revision}`, kind: "nickname",
            at: user.nicknameAt || state.serverTime, name: user.nickname || "", from: before.nickname || "", observed: !user.nicknameAt });
        }
        if ((before.available === true) !== (user.available === true)) {
          this.store.add({ id: `${scope}:availability:${id}:${user.availableRevision || state.revision}`, kind: "availability",
            at: user.availableAt || state.serverTime, name: user.nickname || "", available: user.available === true, observed: !user.availableAt });
        }
      }
      for (const [id, before] of this.previous) if (!current.has(id)) {
        this.store.add({ id: `${scope}:leave:${id}:${before.joinRevision || before.lastSeen}`, kind: "leave",
          at: state.serverTime, name: before.nickname || "", observed: true });
      }
    }
    this.scope = scope; this.previous = current;
  }
}
