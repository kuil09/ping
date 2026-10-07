import assert from "node:assert/strict";
import { KvRooms, replay, ROOM_TTL_MS, SIGNAL_TTL_MS, snapshot } from "../state.ts";

Deno.test("concurrent users do not overwrite each other's signals", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const first = new KvRooms(kv);
    const second = new KvRooms(kv);
    await Promise.all([
      first.act("room", "client-alpha", "session-alpha", "signal", "request-alpha"),
      second.act("room", "client-bravo", "session-bravo", "signal", "request-bravo"),
    ]);
    const state = snapshot(await second.read("room"));
    assert.equal(state.users.length, 2);
    assert.equal(state.users.filter((u) => u.pingUntil > Date.now()).length, 2);
    assert.equal(state.sequence, 2);
    assert.deepEqual(state.events.map((e) => e.sequence), [1, 2]);
  } finally { kv.close(); }
});

Deno.test("same browser tabs count once; presence and ping ON/OFF are independent", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 1_000_000;
  try {
    const store = new KvRooms(kv, () => now);
    await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    await store.act("room", "client-alpha", "session-two", "presence");
    await store.act("room", "client-alpha", "session-one", "leave");
    let state = snapshot(await store.read("room"), now);
    assert.equal(state.users.length, 1);
    assert.equal(state.users[0].online, true);
    await store.act("room", "client-alpha", "session-two", "leave");
    state = snapshot(await store.read("room"), now);
    assert.equal(state.users[0].online, false);
    assert.equal(state.users[0].pingUntil, now + SIGNAL_TTL_MS);
    now += SIGNAL_TTL_MS + 1;
    state = snapshot(await store.read("room"), now);
    assert.equal(state.users.length, 1);
    assert.equal(state.users[0].pingUntil, 0);
  } finally { kv.close(); }
});

Deno.test("mobile suspension expires presence without clearing an active ping", async () => {
  const kv = await Deno.openKv(":memory:");
  const start = 1_000_000;
  try {
    const store = new KvRooms(kv, () => start);
    await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    const room = await store.read("room");
    assert.equal(snapshot(room, start + 46_000).users[0].online, false);
    assert.equal(snapshot(room, start + 46_000).users[0].pingUntil, start + SIGNAL_TTL_MS);
    assert.equal(snapshot(room, start + ROOM_TTL_MS + 1).users.length, 0);
  } finally { kv.close(); }
});

Deno.test("each channel has its own membership and events", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new KvRooms(kv);
    await store.act("one", "client-alpha", "session-one", "signal", "request-one");
    await store.act("two", "client-bravo", "session-two", "presence");
    const state = snapshot(await store.read("two"));
    assert.deepEqual(state.users.map((u) => u.clientId), ["client-bravo"]);
    assert.equal(state.sequence, 0);
    assert.equal(state.events.length, 0);
  } finally { kv.close(); }
});

Deno.test("retrying the same request is idempotent; a later ping is a new event", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 1_000_000;
  try {
    const store = new KvRooms(kv, () => now);
    const first = await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    const retried = await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    assert.equal(retried.duplicate, true);
    assert.equal(retried.signal?.eventId, first.signal?.eventId);
    now += 2000;
    const next = await store.act("room", "client-alpha", "session-one", "signal", "request-two");
    assert.equal(next.room.sequence, 2);
    assert.notEqual(next.signal?.eventId, first.signal?.eventId);
    assert.equal(next.signal?.pingUntil, now + SIGNAL_TTL_MS);
  } finally { kv.close(); }
});

Deno.test("reconnection and coalesced KV watches replay every retained event", async () => {
  const kv = await Deno.openKv(":memory:");
  const now = 1_000_000;
  try {
    const store = new KvRooms(kv, () => now);
    const joined = await store.act("room", "client-alpha", "session-one", "presence");
    const cursor = snapshot(joined.room, now).cursor;
    await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    await store.act("room", "client-bravo", "session-two", "signal", "request-two");
    const room = await store.read("room");
    assert.equal(replay(room, cursor, now).length, 2);
    assert.equal(replay(room, snapshot(room, now).cursor, now).length, 0);
    assert.equal(replay(room, "different-epoch:0", now).length, 0);
    assert.equal(replay(room, cursor, now + SIGNAL_TTL_MS + 1).length, 0);
  } finally { kv.close(); }
});
