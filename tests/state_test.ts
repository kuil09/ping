import assert from "node:assert/strict";
import { deploymentGeneration, KvRooms, PRESENCE_TTL_MS, replay, ROOM_TTL_MS, SIGNAL_TTL_MS, snapshot } from "../state.ts";

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
    assert.ok(state.users.every((u) => u.available === false));
    assert.equal(state.sequence, 2);
    assert.equal(state.channelPing?.sequence, 2);
    assert.deepEqual(state.events.map((e) => e.sequence), [1, 2]);
  } finally { kv.close(); }
});

Deno.test("tabs count once; leaving removes membership, not the shared ping", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 1_000_000;
  try {
    const store = new KvRooms(kv, () => now);
    await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    await store.act("room", "client-alpha", "session-two", "presence");
    await store.act("room", "client-alpha", "session-one", "leave");
    assert.equal(snapshot(await store.read("room"), now).users.length, 1);
    await store.act("room", "client-alpha", "session-two", "leave");
    let state = snapshot(await store.read("room"), now);
    assert.equal(state.users.length, 0);
    assert.equal(state.channelPing?.pingUntil, now + SIGNAL_TTL_MS);
    now += SIGNAL_TTL_MS + 1;
    state = snapshot(await store.read("room"), now);
    assert.equal(state.users.length, 0);
    assert.ok(state.channelPing!.pingUntil < now);
  } finally { kv.close(); }
});

Deno.test("silently disconnected users disappear at exactly the lease deadline without a leave call", async () => {
  const kv = await Deno.openKv(":memory:");
  const start = 1_000_000;
  try {
    const store = new KvRooms(kv, () => start);
    await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    const room = await store.read("room");
    assert.equal(snapshot(room, start + PRESENCE_TTL_MS - 1).users.length, 1);
    assert.equal(snapshot(room, start + PRESENCE_TTL_MS).users.length, 0);
    assert.equal(snapshot(room, start + 46_000).channelPing?.pingUntil, start + SIGNAL_TTL_MS);
    assert.equal(snapshot(room, start + ROOM_TTL_MS + 1).users.length, 0);
  } finally { kv.close(); }
});

Deno.test("another live tab prevents timeout; reconnect restores the user's explicit availability", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 1_000_000;
  try {
    const store = new KvRooms(kv, () => now);
    await store.act("room", "client-alpha", "session-one", "availability", "", true);
    now += 30_000;
    await store.act("room", "client-alpha", "session-two", "presence");
    now += 20_000;
    assert.equal(snapshot(await store.read("room"), now).users.length, 1);
    assert.equal(snapshot(await store.read("room"), now).users[0].available, true);
    now += 26_000;
    assert.equal(snapshot(await store.read("room"), now).users.length, 0);
    await store.act("room", "client-alpha", "session-three", "presence");
    assert.equal(snapshot(await store.read("room"), now).users[0].available, true);
  } finally { kv.close(); }
});

Deno.test("each channel has its own membership, availability and events", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new KvRooms(kv);
    await store.act("one", "client-alpha", "session-one", "availability", "", true);
    await store.act("one", "client-alpha", "session-one", "signal", "request-one");
    await store.act("two", "client-alpha", "session-two", "presence");
    const state = snapshot(await store.read("two"));
    assert.equal(state.users[0].available, false);
    assert.equal(state.sequence, 0);
    assert.equal(state.channelPing, null);
  } finally { kv.close(); }
});

Deno.test("idempotent retries do not refresh time, but a new ping while active always does", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 1_000_000;
  try {
    const store = new KvRooms(kv, () => now);
    const first = await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    now += 2000;
    const retried = await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    assert.equal(retried.duplicate, true);
    assert.equal(retried.signal?.eventId, first.signal?.eventId);
    assert.equal(retried.room.lastPing?.createdAt, 1_000_000);
    const next = await store.act("room", "client-alpha", "session-one", "signal", "request-two");
    assert.equal(next.room.sequence, 2);
    assert.notEqual(next.signal?.eventId, first.signal?.eventId);
    assert.equal(next.room.lastPing?.createdAt, now);
    assert.equal(next.room.lastPing?.pingUntil, now + SIGNAL_TTL_MS);
  } finally { kv.close(); }
});

Deno.test("another sender refreshes the channel clock without changing anyone's availability", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 1_000_000;
  try {
    const a = new KvRooms(kv, () => now);
    const b = new KvRooms(kv, () => now);
    await a.act("room", "client-alpha", "session-one", "availability", "", false);
    await a.act("room", "client-alpha", "session-one", "signal", "request-one");
    now += 10_000;
    await b.act("room", "client-bravo", "session-two", "signal", "request-two");
    const state = snapshot(await a.read("room"), now);
    assert.equal(state.channelPing?.clientId, "client-bravo");
    assert.equal(state.channelPing?.createdAt, now);
    assert.equal(state.channelPing?.pingUntil, now + SIGNAL_TTL_MS);
    assert.equal(state.users.find((u) => u.clientId === "client-alpha")?.available, false);
    const sequence = state.sequence;
    await a.act("room", "client-alpha", "session-one", "availability", "", true);
    const toggled = snapshot(await b.read("room"), now);
    assert.equal(toggled.sequence, sequence);
    assert.deepEqual(toggled.channelPing, state.channelPing);
  } finally { kv.close(); }
});

Deno.test("availability writes absolute values and rejects non-boolean input", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new KvRooms(kv);
    await store.act("room", "client-alpha", "session-one", "availability", "", false);
    await store.act("room", "client-alpha", "session-one", "availability", "", false);
    const state = snapshot(await store.read("room"));
    assert.equal(state.users[0].available, false);
    assert.equal(state.channelPing, null);
    assert.equal(state.sequence, 0);
    await assert.rejects(() => store.act("room", "client-alpha", "session-one", "availability"), /invalid_availability/);
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

Deno.test("latest ping timestamp survives expired event cleanup without renewing its lifetime", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 1_000_000;
  try {
    const store = new KvRooms(kv, () => now);
    await store.act("room", "client-alpha", "session-one", "signal", "request-one");
    now += SIGNAL_TTL_MS + 1;
    await store.act("room", "client-bravo", "session-two", "presence");
    const state = snapshot(await store.read("room"), now);
    assert.equal(state.events.length, 0);
    assert.equal(state.channelPing?.createdAt, 1_000_000);
    assert.equal(state.channelPing?.pingUntil, 1_000_000 + SIGNAL_TTL_MS);
  } finally { kv.close(); }
});

Deno.test("a new deployment resets rooms and subscriptions; sibling instances do not clear each other", async () => {
  const kv = await Deno.openKv(":memory:");
  const now = 1_000_000;
  try {
    const old = new KvRooms(kv, () => now, "deployment-a");
    const sibling = new KvRooms(kv, () => now, "deployment-a");
    const fresh = new KvRooms(kv, () => now, "deployment-b");
    await old.act("room", "client-alpha", "session-one", "availability", "", true);
    await old.act("room", "client-alpha", "session-one", "signal", "request-one");
    await kv.set([...old.subscriptionPrefix("room"), "client-alpha"], { test: true }, { expireIn: ROOM_TTL_MS });
    assert.equal(snapshot(await sibling.read("room"), now).users.length, 1);
    let state = snapshot(await fresh.read("room"), now);
    assert.equal(state.users.length, 0);
    assert.equal(state.channelPing, null);
    assert.equal(state.events.length, 0);
    assert.equal((await kv.get([...fresh.subscriptionPrefix("room"), "client-alpha"])).value, null);
    await fresh.act("room", "client-alpha", "session-new", "presence");
    state = snapshot(await fresh.read("room"), now);
    assert.equal(state.users[0].available, false);
    assert.equal(state.users[0].pingUntil, 0);
    await sibling.act("room", "client-bravo", "old-session", "signal", "old-request");
    assert.equal(snapshot(await fresh.read("room"), now).sequence, 0);
  } finally { kv.close(); }
});

Deno.test("deployment identity is shared, platform-defined and never generated per process", () => {
  const env = { DENO_DEPLOY: "true", DENO_DEPLOYMENT_ID: "config-123", DENO_DEPLOY_BUILD_ID: "build-1", DENO_TIMELINE: "production" };
  assert.equal(deploymentGeneration(env), "production:config-123");
  assert.equal(deploymentGeneration({ ...env }), deploymentGeneration(env));
  assert.notEqual(deploymentGeneration({ ...env, DENO_DEPLOYMENT_ID: "config-456" }), deploymentGeneration(env));
  assert.equal(deploymentGeneration({ DENO_DEPLOY_BUILD_ID: "build-2" }), "deploy:build-2");
  assert.throws(() => deploymentGeneration({ DENO_DEPLOY: "true" }), /deployment_identity_missing/);
});
