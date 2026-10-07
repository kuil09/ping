const { test, expect } = require("@playwright/test");
const crypto = require("node:crypto");
const A = "http://127.0.0.1:9101";

test("resource budget: five idle SSE subscribers share one watch and perform zero periodic reads in 12 seconds", async ({}, info) => {
  test.skip(Boolean(process.env.PING_TEST_ORIGIN), "Per-instance resource measurements run in CI, never on shared production.");
  const room = "cost_" + crypto.randomUUID().replaceAll("-", "");
  const connections = [];
  const health = async () => (await (await fetch(A + "/api/health")).json()).live;
  try {
    const baseline = await health();
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const query = new URLSearchParams({ clientId: crypto.randomUUID(), sessionId: crypto.randomUUID() });
      const response = await fetch(`${A}/api/rooms/${room}/events?${query}`, { signal: controller.signal });
      expect(response.ok).toBeTruthy();
      const task = (async () => {
        const reader = response.body.getReader();
        try { while (!(await reader.read()).done) { /* consume without creating a client heartbeat */ } }
        catch (error) { if (!controller.signal.aborted) throw error; }
      })();
      connections.push({ controller, task });
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    const start = await health();
    expect(start.watchers - baseline.watchers).toBe(1);
    expect(start.streams - baseline.streams).toBe(5);
    await new Promise(resolve => setTimeout(resolve, 12000));
    const end = await health();
    expect(end.reconcileReads - start.reconcileReads).toBe(0);
    expect(end.snapshots - start.snapshots).toBe(0);
    for (const connection of connections) connection.controller.abort();
    await Promise.all(connections.map(connection => connection.task));
    await expect.poll(async () => (await health()).streams).toBe(baseline.streams);
    await expect.poll(async () => (await health()).watchers).toBe(baseline.watchers);
    await info.attach("resource-measurement", { contentType: "application/json", body: JSON.stringify({ intervalSeconds: 12, subscribers: 5, watcherDelta: start.watchers - baseline.watchers, periodicReads: end.reconcileReads - start.reconcileReads, unchangedSnapshots: end.snapshots - start.snapshots, allDetached: true, measuredIn: "isolated CI app instance, not Deno billing" }, null, 2) });
  } finally {
    for (const connection of connections) connection.controller.abort();
    await Promise.allSettled(connections.map(connection => connection.task));
  }
});
