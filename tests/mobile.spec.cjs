const { test, expect, chromium, webkit, devices } = require("@playwright/test");
const crypto = require("node:crypto");
const A = "http://127.0.0.1:9101";
const B = "http://127.0.0.1:9102";
test.setTimeout(60000);

async function post(base, room, action, body) {
  const response = await fetch(`${base}/api/rooms/${room}/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect(response.ok).toBeTruthy();
  return response.json();
}

async function listen(base, room, identity, cursor) {
  const abort = new AbortController();
  const query = new URLSearchParams(identity);
  const response = await fetch(`${base}/api/rooms/${room}/events?${query}`, {
    signal: abort.signal, headers: cursor ? { "Last-Event-ID": cursor } : {},
  });
  expect(response.ok).toBeTruthy();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const task = (async () => {
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = chunk.split("\n").find((line) => line.startsWith("data: "));
          const type = chunk.split("\n").find((line) => line.startsWith("event: "));
          if (data && type) events.push({ type: type.slice(7), data: JSON.parse(data.slice(6)) });
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  return {
    events,
    async until(predicate) {
      await expect.poll(() => events.some(predicate), { timeout: 7000 }).toBeTruthy();
      return events.find(predicate);
    },
    async close() { abort.abort(); await task; },
  };
}

test("mobile Chromium and WebKit synchronize across different app processes despite unavailable optional APIs", async ({}, info) => {
  const chrome = await chromium.launch();
  const safari = await webkit.launch();
  const errors = [];
  try {
    const contextA = await chrome.newContext({ ...devices["Pixel 7"] });
    const contextB = await safari.newContext({ ...devices["iPhone 13"] });
    await contextB.addInitScript(() => {
      Reflect.deleteProperty(globalThis, "Notification");
      Reflect.deleteProperty(globalThis, "PushManager");
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true, value: { register: () => Promise.reject(new Error("service workers unavailable")) },
      });
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true, get() { throw new Error("storage unavailable"); },
      });
      globalThis.AudioContext = function () { throw new Error("audio unavailable"); };
      globalThis.webkitAudioContext = globalThis.AudioContext;
    });
    await contextB.route("**/api/config", (route) => route.fulfill({
      json: { pushEnabled: true, vapidPublicKey: "not-used", signalTtlMs: 300000 },
    }));
    const first = await contextA.newPage();
    const second = await contextB.newPage();
    first.on("pageerror", (e) => errors.push(String(e)));
    second.on("pageerror", (e) => errors.push(String(e)));
    const room = crypto.randomUUID().replaceAll("-", "");
    await Promise.all([first.goto(`${A}/r/${room}`), second.goto(`${B}/r/${room}`)]);
    await expect(first.locator(".user")).toHaveCount(2);
    await expect(second.locator(".user")).toHaveCount(2);
    const healthA = await (await fetch(`${A}/api/health`)).json();
    const healthB = await (await fetch(`${B}/api/health`)).json();
    expect(healthA.instanceId).not.toEqual(healthB.instanceId);

    const started = Date.now();
    await first.locator("#signal").click();
    await expect(second.locator('.user[data-active="true"]')).toHaveCount(1, { timeout: 3000 });
    const firstDeliveryMs = Date.now() - started;
    await second.locator("#signal").click();
    await expect(first.locator('.user[data-active="true"]')).toHaveCount(2, { timeout: 3000 });
    await expect(second).toHaveTitle("ping · 2/2");
    await expect(second.locator("body")).not.toHaveClass(/sending/);
    await first.screenshot({ path: info.outputPath("chromium-two-users.png") });
    await second.screenshot({ path: info.outputPath("webkit-two-users.png") });

    const tab = await contextA.newPage();
    await tab.goto(`${A}/r/${room}`);
    await expect(tab.locator(".user")).toHaveCount(2);
    await tab.close();
    await expect(first.locator('.user[data-online="true"]')).toHaveCount(2);

    const isolated = await contextA.newPage();
    await isolated.goto(`${A}/r/${crypto.randomUUID().replaceAll("-", "")}`);
    await expect(isolated.locator(".user")).toHaveCount(1);
    await expect(first.locator(".user")).toHaveCount(2);
    await isolated.close();
    await second.goto("about:blank");
    await expect(first.locator('.user[data-online="false"]')).toHaveCount(1);
    await expect(first.locator('.user[data-active="true"]')).toHaveCount(2);
    expect(errors).toEqual([]);
    await info.attach("cross-process-result", {
      body: JSON.stringify({ firstDeliveryMs, instanceA: healthA.instanceId, instanceB: healthB.instanceId, errors }),
      contentType: "application/json",
    });
  } finally { await chrome.close(); await safari.close(); }
});

test("Last-Event-ID replays missed pings after reconnecting to another instance", async () => {
  const room = crypto.randomUUID().replaceAll("-", "");
  const alpha = { clientId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  const bravo = { clientId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  await post(A, room, "presence", { ...alpha, online: true });
  const original = await listen(B, room, bravo);
  const baseline = await original.until((event) => event.type === "users" && event.data.users.length === 2);
  await original.close();
  const [one, two] = await Promise.all([
    post(A, room, "signal", { ...alpha, requestId: crypto.randomUUID() }),
    post(B, room, "signal", { ...bravo, requestId: crypto.randomUUID() }),
  ]);
  const reconnected = await listen(A, room, bravo, baseline.data.cursor);
  try {
    await reconnected.until((event) => event.type === "signal" && event.data.eventId === one.signal.eventId);
    await reconnected.until((event) => event.type === "signal" && event.data.eventId === two.signal.eventId);
    const state = await reconnected.until((event) => event.type === "users" && event.data.sequence === 2);
    expect(state.data.users.filter((user) => user.pingUntil > state.data.serverTime)).toHaveLength(2);
    expect(new Set(reconnected.events.filter((event) => event.type === "signal").map((event) => event.data.eventId)).size).toBe(2);
  } finally { await reconnected.close(); }
});
