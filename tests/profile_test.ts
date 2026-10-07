import assert from "node:assert/strict";
import { KvRooms, snapshot, type Room } from "../state.ts";
import { normalizeNickname } from "../public/profile.js";

Deno.test("first presence, nickname and ping all default to unavailable until explicit opt-in", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 1_000_000;
  try {
    const store = new KvRooms(kv, () => now);
    await store.act("room", "alpha", "tab-one", "presence");
    await store.act("room", "bravo", "tab-two", "nickname", "", undefined, "니트로");
    await store.act("room", "charlie", "tab-three", "signal", "request-one");
    let state = store.snapshot(await store.read("room"));
    assert.equal(state.users.length, 3);
    assert.ok(state.users.every((u) => u.available === false));
    assert.equal(state.users.find((u) => u.clientId === "bravo")?.nickname, "니트로");
    await store.act("room", "alpha", "tab-one", "availability", "", true);
    now += 2000;
    await store.act("room", "alpha", "tab-one", "nickname", "", undefined, "알파");
    await store.act("room", "bravo", "tab-two", "signal", "request-two");
    await store.act("room", "alpha", "tab-new", "presence");
    state = store.snapshot(await store.read("room"));
    assert.equal(state.users.find((u) => u.clientId === "alpha")?.available, true);
    assert.equal(state.users.find((u) => u.clientId === "bravo")?.available, false);
  } finally { kv.close(); }
});

Deno.test("concurrent nickname and availability writes preserve both; rename never creates a ping", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const a = new KvRooms(kv);
    const b = new KvRooms(kv);
    await a.act("room", "alpha", "tab-one", "signal", "request-one");
    const before = a.snapshot(await a.read("room"));
    await Promise.all([
      a.act("room", "alpha", "tab-one", "nickname", "", undefined, "  니트로  개발  "),
      b.act("room", "alpha", "tab-two", "availability", "", true),
    ]);
    let state = b.snapshot(await b.read("room"));
    assert.equal(state.users[0].nickname, "니트로 개발");
    assert.equal(state.users[0].available, true);
    assert.equal(state.sequence, before.sequence);
    assert.deepEqual(state.channelPing, before.channelPing);
    await a.act("room", "alpha", "tab-one", "nickname", "", undefined, "니트로 개발");
    state = b.snapshot(await b.read("room"));
    assert.equal(state.users[0].nickname, "니트로 개발");
    assert.deepEqual(state.channelPing, before.channelPing);
    await a.act("room", "alpha", "tab-one", "nickname", "", undefined, " ");
    assert.equal(a.snapshot(await a.read("room")).users[0].nickname, "");
  } finally { kv.close(); }
});

Deno.test("nickname validation normalizes Korean, bounds Unicode length and rejects controls and non-strings", () => {
  assert.equal(normalizeNickname("  니트로   개발자  "), "니트로 개발자");
  assert.equal(normalizeNickname("한글"), "한글");
  assert.equal(normalizeNickname("가".repeat(20)), "가".repeat(20));
  assert.equal(normalizeNickname("😀".repeat(20)), "😀".repeat(20));
  assert.equal(normalizeNickname("<b>니트로</b>"), "<b>니트로</b>");
  assert.equal(normalizeNickname(""), "");
  assert.throws(() => normalizeNickname("가".repeat(21)), /nickname_too_long/);
  for (const value of [undefined, null, 123, false, {}, "bad\nname", "name\u202E", "\u200B"]) {
    assert.throws(() => normalizeNickname(value), /invalid_nickname/);
  }
});

Deno.test("invalid nickname fails before any state mutation", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new KvRooms(kv);
    await store.act("room", "alpha", "tab-one", "nickname", "", undefined, "정상");
    const before = await store.read("room");
    await assert.rejects(() => store.act("room", "alpha", "tab-one", "nickname", "", undefined, 42), /invalid_nickname/);
    await assert.rejects(() => store.act("room", "alpha", "tab-one", "nickname", "", undefined, "가".repeat(21)), /nickname_too_long/);
    assert.deepEqual(await store.read("room"), before);
  } finally { kv.close(); }
});

Deno.test("nickname is channel-scoped display text, not identity; reload keeps it but deployment reset clears it", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new KvRooms(kv, () => 1_000_000, "one");
    const sibling = new KvRooms(kv, () => 1_000_000, "one");
    const fresh = new KvRooms(kv, () => 1_000_000, "two");
    await store.act("room", "alpha", "tab-one", "nickname", "", undefined, "같은 이름");
    await store.act("room", "bravo", "tab-two", "nickname", "", undefined, "같은 이름");
    await store.act("room", "alpha", "tab-one", "availability", "", true);
    await sibling.act("room", "alpha", "tab-new", "presence");
    assert.equal(sibling.snapshot(await sibling.read("room")).users.length, 2);
    assert.equal(sibling.snapshot(await sibling.read("room")).users[0].nickname, "같은 이름");
    await store.act("other", "alpha", "tab-other", "presence");
    assert.equal(store.snapshot(await store.read("other")).users[0].nickname, "");
    assert.equal(store.snapshot(await store.read("other")).users[0].available, false);
    await fresh.act("room", "alpha", "tab-next", "presence");
    assert.equal(fresh.snapshot(await fresh.read("room")).users[0].nickname, "");
    assert.equal(fresh.snapshot(await fresh.read("room")).users[0].available, false);
  } finally { kv.close(); }
});

Deno.test("legacy missing availability is unavailable, while an explicit prior choice is preserved", () => {
  const room: Room = { epoch: "legacy", revision: 0, sequence: 0, events: [], members: [
    { clientId: "alpha", lastSeen: 100, lastSignalAt: 0, pingUntil: 0, sessions: [{ id: "one", until: 200 }] },
    { clientId: "bravo", lastSeen: 100, lastSignalAt: 0, pingUntil: 0, available: true, sessions: [{ id: "two", until: 200 }] },
  ] };
  const state = snapshot(room, 150);
  assert.equal(state.users[0].available, false);
  assert.equal(state.users[0].nickname, "");
  assert.equal(state.users[1].available, true);
});
