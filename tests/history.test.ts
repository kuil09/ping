import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_LIMIT, HistoryTracker, LocalHistory } from "../public/history.js";
class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
const event = (id: string, at: number) => ({ id, kind: "ping", name: "니트로", at, observed: false });
test("history persists per channel and duplicate replay never duplicates or renames old pings", () => {
  const storage = new MemoryStorage(), now = () => 1_000_000;
  const a = new LocalHistory("one", { storage: () => storage, now });
  a.add(event("id-one", 999_000)); a.add({ ...event("id-one", 999_000), name: "새 이름" });
  const reload = new LocalHistory("one", { storage: () => storage, now });
  assert.equal(reload.entries().length, 1); assert.equal(reload.entries()[0].name, "니트로");
  assert.equal(new LocalHistory("two", { storage: () => storage, now }).entries().length, 0);
});
test("per-entry keys keep different tabs' writes and synchronize clear without touching other app data", () => {
  const storage = new MemoryStorage(); let now = 1_000_000;
  storage.setItem("ping:clientId", "keep-me"); storage.setItem("other-app", "keep-too");
  const a = new LocalHistory("room", { storage: () => storage, now: () => now });
  const b = new LocalHistory("room", { storage: () => storage, now: () => now });
  a.add(event("one", now - 100)); b.add(event("two", now - 50)); a.refresh(); b.refresh();
  assert.equal(a.entries().length, 2); assert.equal(b.entries().length, 2);
  a.clear(); b.refresh(); assert.equal(b.entries().length, 0);
  assert.equal(b.add(event("one", now - 100)), false);
  now += 1000; b.add(event("three", now)); a.refresh(); assert.equal(a.entries().length, 1);
  assert.equal(storage.getItem("ping:clientId"), "keep-me"); assert.equal(storage.getItem("other-app"), "keep-too");
});
test("history caps entries, rejects stale/future values and prunes persisted keys", () => {
  const storage = new MemoryStorage(), now = 100_000_000_000;
  const store = new LocalHistory("room", { storage: () => storage, now: () => now });
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) store.add(event(`id-${i}`, now - 1000 + i));
  assert.equal(store.entries().length, HISTORY_LIMIT);
  assert.equal([...storage.values.keys()].filter(k => k.includes(":event:")).length, HISTORY_LIMIT);
  assert.equal(store.add(event("very-old", now - 31 * 86_400_000)), false);
  assert.equal(store.add(event("future", now + 100_000)), false);
  store.add(event("out-of-order", now - 10_000));
  assert.equal([...storage.values.keys()].filter(k => k.includes(":event:")).length, HISTORY_LIMIT);
});
test("blocked storage, exhausted quota and damaged JSON never disable the in-memory history", () => {
  const denied = new LocalHistory("one", { storage: () => { throw new Error("denied"); }, now: () => 1_000_000 });
  denied.add(event("one", 999_000)); assert.equal(denied.entries().length, 1); assert.equal(denied.persistent, false);
  class QuotaStorage extends MemoryStorage { override setItem() { throw new Error("quota"); } }
  const quota = new LocalHistory("one", { storage: () => new QuotaStorage(), now: () => 1_000_000 });
  quota.add(event("one", 999_000)); assert.equal(quota.entries().length, 1); assert.equal(quota.persistent, false);
  const storage = new MemoryStorage(); storage.setItem("ping:history:v2:one:event:bad", "{not-json");
  storage.setItem("ping:history:v2:one:event:bad-two", JSON.stringify({ kind: "ping", at: "invalid", name: {} }));
  const safe = new LocalHistory("one", { storage: () => storage, now: () => 1_000_000 });
  assert.equal(safe.entries().length, 0); safe.add(event("good", 999_000)); assert.equal(safe.entries().length, 1);
});
test("tracker uses initial membership only as baseline and timestamps confirmed user actions", () => {
  let now = 1_000_000;
  const store = new LocalHistory("room", { storage: () => new MemoryStorage(), now: () => now });
  const tracker = new HistoryTracker(store);
  const alpha = { clientId: "alpha", nickname: "니트로", available: false, lastSeen: now, joinedAt: now, joinRevision: 1 };
  const baseline = { generation: "deploy-one", epoch: "epoch", revision: 1, users: [alpha], events: [], serverTime: now };
  tracker.observe(baseline); tracker.observe(baseline); assert.equal(store.entries().length, 0);
  now += 1000;
  const opted = { ...alpha, available: true, availableAt: now, availableRevision: 2 };
  tracker.observe({ ...baseline, revision: 2, users: [opted], serverTime: now });
  now += 1000;
  const renamed = { ...opted, nickname: "구름", nicknameAt: now, nicknameRevision: 3 };
  tracker.observe({ ...baseline, revision: 3, users: [renamed], serverTime: now });
  now += 1000;
  const bravo = { ...alpha, clientId: "bravo", nickname: "바람", joinRevision: 4, joinedAt: now };
  tracker.observe({ ...baseline, revision: 4, users: [renamed, bravo], serverTime: now });
  now += 1000;
  tracker.observe({ ...baseline, revision: 5, users: [renamed], serverTime: now });
  const entries = store.entries();
  assert.deepEqual(entries.map(e => e.kind), ["leave", "join", "nickname", "availability"]);
  assert.equal(entries[0].observed, true); assert.equal(entries[2].from, "니트로"); assert.equal(entries[3].available, true);
  tracker.observe({ ...baseline, revision: 6, users: [renamed], serverTime: now }); assert.equal(store.entries().length, 4);
});
test("confirmed ping replay retains original names across rename, reload, reset and clear", () => {
  const storage = new MemoryStorage(); let now = 1_000_000;
  const store = new LocalHistory("room", { storage: () => storage, now: () => now });
  const tracker = new HistoryTracker(store);
  const signal = { eventId: "epoch:1", createdAt: now, nickname: "원래 이름", clientId: "a" };
  tracker.signal(signal, "deploy-one", [{ clientId: "a", nickname: "새 이름" }]);
  tracker.observe({ generation: "deploy-one", epoch: "epoch", revision: 1, users: [], events: [signal], serverTime: now });
  assert.equal(store.entries().length, 1); assert.equal(store.entries()[0].name, "원래 이름");
  now += 1000;
  tracker.observe({ generation: "deploy-two", epoch: "new", revision: 0, users: [], events: [], serverTime: now });
  assert.equal(store.entries().length, 2); assert.equal(store.entries()[0].kind, "reset");
  store.clear();
  const reload = new LocalHistory("room", { storage: () => storage, now: () => now });
  new HistoryTracker(reload).signal(signal, "deploy-one", []); assert.equal(reload.entries().length, 0);
});
