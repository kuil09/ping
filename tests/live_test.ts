import { LiveRooms } from "../live.ts";
import { KvRooms, type Room } from "../state.ts";
function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture() {
  const kv = await Deno.openKv(":memory:"), store = new KvRooms(kv), live = new LiveRooms(store);
  const room = crypto.randomUUID();
  const open = async (identity = crypto.randomUUID(), session = crypto.randomUUID()) => {
    const { room: seed } = await store.act(room, identity, session, "presence");
    const controller = new AbortController();
    const req = new Request(`http://localhost/api/rooms/${room}/events?clientId=${identity}&sessionId=${session}`, { signal: controller.signal });
    const response = live.events(req, room, seed, { "content-type": "text/event-stream" });
    return { identity, session, controller, response };
  };
  return { kv, store, live, room, open, async close() { live.close(); await wait(10); kv.close(); } };
}
Deno.test("one KV watch per room; last disconnect cancels the watch and every timer", async () => {
  const f = await fixture();
  try {
    const clients = [];
    for (let i = 0; i < 5; i++) clients.push(await f.open());
    assert(f.live.stats().watchers === 1, "five subscribers must share one watch");
    assert(f.live.stats().streams === 5, "all subscribers are retained");
    assert(f.live.stats().watchersOpened === 1, "no temporary duplicate watches");
    for (const client of clients) client.controller.abort();
    await wait(10);
    assert(f.live.stats().watchers === 0 && f.live.stats().streams === 0, "empty channels release everything");
    const reopened = await f.open();
    assert(reopened.response.ok && f.live.stats().watchers === 1, "reconnection creates one new hub");
    reopened.controller.abort();
  } finally { await f.close(); }
});
Deno.test("unchanged KV state does not broadcast duplicate snapshots", async () => {
  const f = await fixture();
  try {
    const client = await f.open();
    await wait(30);
    const before = f.live.stats().snapshots;
    const room = await f.store.read(f.room);
    await f.kv.set(f.store.key(f.room), room);
    await wait(50);
    assert(f.live.stats().snapshots === before, "identical revision must not serialize/broadcast again");
    assert(f.live.stats().reconcileReads === 0, "no periodic KV reads before the 60 second reconciliation");
    client.controller.abort();
  } finally { await f.close(); }
});
Deno.test("a lease deadline closes an abandoned stream without periodic KV polling", async () => {
  const f = await fixture();
  try {
    const client = await f.open();
    const room = await f.store.read(f.room);
    room.members[0].sessions[0].until = Date.now() + 100;
    room.revision++;
    await f.kv.set(f.store.key(f.room), room);
    await wait(250);
    assert(f.live.stats().streams === 0 && f.live.stats().watchers === 0, "orphan stream and watch must expire");
    assert(f.live.stats().reconcileReads === 0, "expiry uses a cached deadline, not a KV read");
    await client.response.body?.cancel();
  } finally { await f.close(); }
});
Deno.test("joining while the prior last subscriber expires cannot close the newcomer", async () => {
  const f = await fixture();
  try {
    const old = await f.open();
    const { room } = await f.store.act(f.room, "new-client-123", "new-session-123", "presence");
    const oldMember = room.members.find(member => member.clientId === old.identity)!;
    oldMember.sessions = [];
    room.revision += 100;
    const controller = new AbortController();
    const response = f.live.events(new Request(`http://localhost/events?clientId=new-client-123&sessionId=new-session-123`, { signal: controller.signal }), f.room, room, {});
    assert(response.ok && f.live.stats().streams === 1 && f.live.stats().watchers === 1, "new member survives old lease removal");
    controller.abort();
  } finally { await f.close(); }
});
Deno.test("slow clients are bounded and canceled instead of accumulating unlimited bytes", async () => {
  const f = await fixture();
  try {
    const first = await f.open();
    // Never consume this response. Large bounded snapshots exceed its 64 KiB queue budget.
    const room: Room = await f.store.read(f.room);
    for (let i = 0; i < 8; i++) {
      room.revision++;
      room.events = [{ eventId: `${room.epoch}:1`, sequence: 1, clientId: first.identity, requestId: "request-test", createdAt: Date.now(), pingUntil: Date.now() + 300000, nickname: "x".repeat(20000) }];
      await f.kv.set(f.store.key(f.room), room);
      await wait(20);
    }
    assert(f.live.stats().slowClosed === 1 && f.live.stats().streams === 0, "slow reader is detached");
    await first.response.body?.cancel();
  } finally { await f.close(); }
});
