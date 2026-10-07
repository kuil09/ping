const { test, expect, chromium, webkit, devices } = require("@playwright/test");
const crypto = require("node:crypto");
const A = process.env.PING_TEST_ORIGIN || "http://127.0.0.1:9101";
const B = process.env.PING_TEST_ORIGIN || "http://127.0.0.1:9102";
test.setTimeout(90000);
const freshRoom = () => "test_" + crypto.randomUUID().replaceAll("-", "");

async function post(base, room, action, body) {
  const response = await fetch(`${base}/api/rooms/${room}/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect(response.ok).toBeTruthy();
  return response.json();
}
async function listen(base, room, identity, cursor) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/rooms/${room}/events?${new URLSearchParams(identity)}`, {
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
      await expect.poll(() => events.some(predicate), { timeout: 10000 }).toBeTruthy();
      return events.find(predicate);
    },
    async close() { abort.abort(); await task; },
  };
}

test("mobile Chromium and WebKit: remote pings refresh the clock, not explicit availability", async ({}, info) => {
  const chrome = await chromium.launch();
  const safari = await webkit.launch();
  const errors = [];
  try {
    const contextA = await chrome.newContext({ ...devices["Pixel 7"] });
    const contextB = await safari.newContext({ ...devices["iPhone 13"] });
    for (const context of [contextA, contextB]) {
      await context.addInitScript(() => {
        window.__signals = [];
        const Native = window.EventSource;
        window.EventSource = class extends Native {
          constructor(...args) {
            super(...args);
            this.addEventListener("signal", (event) => window.__signals.push(JSON.parse(event.data)));
          }
        };
      });
    }
    await contextB.addInitScript(() => {
      Reflect.deleteProperty(globalThis, "Notification");
      Reflect.deleteProperty(globalThis, "PushManager");
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: () => Promise.reject(new Error("unavailable")) } });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("unavailable"); } });
      globalThis.AudioContext = function () { throw new Error("unavailable"); };
      globalThis.webkitAudioContext = globalThis.AudioContext;
    });
    await contextB.route("**/api/config", (route) => route.fulfill({ json: { pushEnabled: true, vapidPublicKey: "not-used", signalTtlMs: 300000 } }));
    const first = await contextA.newPage();
    const second = await contextB.newPage();
    for (const page of [first, second]) page.on("pageerror", (e) => errors.push(String(e)));
    const room = freshRoom();
    await Promise.all([first.goto(`${A}/r/${room}`), second.goto(`${B}/r/${room}`)]);
    await expect(first.locator(".user")).toHaveCount(2);
    await expect(second.locator(".user")).toHaveCount(2);
    await expect(first.locator("#ping-time")).toHaveText("--:--:--");
    const healthA = await (await fetch(`${A}/api/health`)).json();
    const healthB = await (await fetch(`${B}/api/health`)).json();
    expect(healthA.version).toBe("shared-kv-v2");
    expect(healthA.generation).toBe(healthB.generation);
    if (!process.env.PING_TEST_ORIGIN) expect(healthA.instanceId).not.toEqual(healthB.instanceId);

    await first.locator("#signal").click();
    await expect(second.locator('.user[data-active="true"]')).toHaveCount(1);
    await expect.poll(() => second.evaluate(() => window.__signals.length)).toBe(1);
    const before = Number(await first.locator("#ping-time").getAttribute("data-created-at"));
    await expect(second.locator("#ping-time")).toHaveAttribute("data-created-at", String(before));
    await second.locator("#availability").click();
    await expect(second.locator("#availability")).toHaveAttribute("aria-checked", "false");
    await expect(second.locator("#availability-state")).toHaveText("불가능");
    await expect(first.locator('.user[data-self="false"]')).toHaveAttribute("data-available", "false");
    await expect(first.locator("#ping-time")).toHaveAttribute("data-created-at", String(before));
    await second.waitForTimeout(1300);
    await second.locator("#signal").click();
    await expect(first.locator('.user[data-active="true"]')).toHaveCount(2);
    await expect.poll(async () => Number(await first.locator("#ping-time").getAttribute("data-created-at"))).toBeGreaterThan(before);
    const after = await first.locator("#ping-time").getAttribute("data-created-at");
    await expect(second.locator("#ping-time")).toHaveAttribute("data-created-at", after);
    await expect(second.locator("#availability-state")).toHaveText("불가능");
    await expect(first.locator('.user[data-self="false"]')).toHaveAttribute("data-available", "false");
    await expect(second).toHaveTitle(/^(?:05:00|04:\d{2}) · ping · 2\/2명$/);

    await first.waitForTimeout(1300);
    await first.locator("#signal").click();
    await expect.poll(() => second.evaluate(() => window.__signals.length)).toBe(3);
    await expect.poll(async () => Number(await second.locator("#ping-time").getAttribute("data-created-at"))).toBeGreaterThan(Number(after));
    const state = await (await fetch(`${A}/api/rooms/${room}/state`)).json();
    expect(state.channelPing.pingUntil - state.channelPing.createdAt).toBe(300000);
    expect(state.sequence).toBe(3);
    const latest = String(state.channelPing.createdAt);
    await first.reload();
    await expect(first.locator("#ping-time")).toHaveAttribute("data-created-at", latest);
    await expect(first.locator(".user")).toHaveCount(2);
    const tab = await contextA.newPage();
    await tab.goto(`${A}/r/${room}`);
    await expect(tab.locator(".user")).toHaveCount(2);
    await tab.close();
    const isolated = await contextA.newPage();
    await isolated.goto(`${A}/r/${freshRoom()}`);
    await expect(isolated.locator(".user")).toHaveCount(1);
    await expect(first.locator(".user")).toHaveCount(2);
    await isolated.close();
    const timeBox = await first.locator("#ping-time").boundingBox();
    const buttonBox = await first.locator("#signal").boundingBox();
    expect(timeBox.y + timeBox.height).toBeLessThan(buttonBox.y);
    await first.screenshot({ path: info.outputPath("chromium-clock-availability.png"), fullPage: true });
    await second.screenshot({ path: info.outputPath("webkit-clock-availability.png"), fullPage: true });
    await second.goto("about:blank");
    await expect(first.locator(".user")).toHaveCount(1, { timeout: 55000 });
    await expect(first.locator("#ping-clock")).toHaveAttribute("data-active", "true");
    expect(errors).toEqual([]);
    await info.attach("result", { body: JSON.stringify({ generation: healthA.generation, latestPingAt: latest, errors }), contentType: "application/json" });
  } finally { await chrome.close(); await safari.close(); }
});

test("same-browser availability toggles synchronize and failed writes do not pretend success", async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    const a = await context.newPage();
    const b = await context.newPage();
    const room = freshRoom();
    await a.goto(`${A}/r/${room}`);
    await b.goto(`${A}/r/${room}`);
    await expect(a.locator(".user")).toHaveCount(1);
    await a.locator("#availability").focus();
    await a.keyboard.press("Space");
    await expect(a.locator("#availability")).toHaveAttribute("aria-checked", "false");
    await expect(b.locator("#availability")).toHaveAttribute("aria-checked", "false");
    await b.reload();
    await expect(b.locator("#availability-state")).toHaveText("불가능");
    await a.route("**/availability", (route) => route.fulfill({ status: 503, json: { error: "test_failure" } }));
    await a.locator("#availability").click();
    await expect(a.locator("#availability")).toHaveAttribute("aria-busy", "false");
    await expect(a.locator("#availability")).toHaveAttribute("aria-checked", "false");
    await expect(a.locator("#status")).toContainText("연결 실패");
    await expect(a.locator("#ping-time")).toHaveText("--:--:--");
    await a.unroute("**/availability");
    await a.locator("#availability").click();
    await expect(b.locator("#availability")).toHaveAttribute("aria-checked", "true");
    const response = await fetch(`${B}/api/rooms/${room}/availability`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: crypto.randomUUID(), sessionId: crypto.randomUUID(), available: "false" }) });
    expect(response.status).toBe(400);
  } finally { await browser.close(); }
});

test("silent disconnect without a leave beacon expires in 45 seconds while the shared ping survives", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const room = freshRoom();
    await page.goto(`${A}/r/${room}`);
    await expect(page.locator(".user")).toHaveCount(1);
    const ghost = { clientId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const stream = await listen(B, room, ghost);
    await post(B, room, "signal", { ...ghost, requestId: crypto.randomUUID() });
    await expect(page.locator(".user")).toHaveCount(2);
    const time = await page.locator("#ping-time").getAttribute("data-created-at");
    await stream.close();
    await expect(page.locator(".user")).toHaveCount(1, { timeout: 55000 });
    await expect(page.locator("#ping-time")).toHaveAttribute("data-created-at", time);
    await expect(page.locator("#ping-clock")).toHaveAttribute("data-active", "true");
    const state = await (await fetch(`${A}/api/rooms/${room}/state`)).json();
    expect(state.users.some((user) => user.clientId === ghost.clientId)).toBe(false);
    expect(state.channelPing.pingUntil).toBeGreaterThan(state.serverTime);
  } finally { await browser.close(); }
});

test("Last-Event-ID replays missed pings after reconnecting to another instance", async () => {
  const room = freshRoom();
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

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name}: hidden-tab lifecycle keeps real SSE, countdown, attention and renewals`, async ({}, info) => {
    const browser = await engine.launch();
    const errors = [];
    try {
      const receiverContext = await browser.newContext();
      const senderContext = await browser.newContext();
      await receiverContext.addInitScript(() => {
        // Emulate lifecycle signals, not transport or the countdown clock. Headless
        // engines do not reliably hide a page when another page is brought forward.
        window.__hidden = false;
        window.__received = [];
        window.__tabHistory = [];
        Object.defineProperty(document, "visibilityState", { get: () => window.__hidden ? "hidden" : "visible" });
        Object.defineProperty(document, "hidden", { get: () => window.__hidden });
        document.hasFocus = () => !window.__hidden;
        const Native = window.EventSource;
        window.EventSource = class extends Native {
          constructor(...args) {
            super(...args);
            this.addEventListener("signal", (e) => window.__received.push(JSON.parse(e.data)));
          }
        };
        window.__setHidden = (hidden) => {
          window.__hidden = hidden;
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event(hidden ? "blur" : "focus"));
        };
        document.addEventListener("DOMContentLoaded", () => {
          const record = () => {
            const sample = { title: document.title, icon: document.querySelector('link[rel="icon"]').getAttribute("href"), at: Date.now() };
            const prev = window.__tabHistory.at(-1);
            if (!prev || prev.title !== sample.title || prev.icon !== sample.icon) window.__tabHistory.push(sample);
          };
          new MutationObserver(record).observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href"] });
        });
      });
      const receiver = await receiverContext.newPage();
      const sender = await senderContext.newPage();
      for (const page of [receiver, sender]) page.on("pageerror", (e) => errors.push(String(e)));
      const room = freshRoom();
      await Promise.all([receiver.goto(`${A}/r/${room}`), sender.goto(`${B}/r/${room}`)]);
      await expect(receiver.locator("body")).toHaveAttribute("data-tab-ui", "tab-countdown-v1");
      await expect(receiver.locator(".user")).toHaveCount(2);
      await receiver.locator("#availability").click();
      await expect(receiver.locator("#availability-state")).toHaveText("불가능");
      await receiver.evaluate(() => window.__setHidden(true));
      await sender.locator("#signal").click();
      await expect.poll(() => receiver.evaluate(() => window.__received.length)).toBe(1);
      await expect(receiver.locator("body")).toHaveAttribute("data-tab-unread", "true");
      await expect(receiver).toHaveTitle(/^\d{2}:\d{2} · (PING!|새 핑) · 1\/2명$/);
      const before = await receiver.locator("body").getAttribute("data-tab-countdown");
      await expect.poll(() => receiver.locator("body").getAttribute("data-tab-countdown")).not.toBe(before);
      await expect.poll(() => receiver.evaluate(() => new Set(window.__tabHistory.filter(x => x.icon.startsWith("data:")).map(x => x.icon)).size)).toBe(2);
      const firstEvent = await receiver.locator("#ping-clock").getAttribute("data-event-id");
      // Leave time for the countdown to fall before a distinct peer ping renews it.
      await receiver.waitForTimeout(3200);
      const earlier = await receiver.locator("body").getAttribute("data-tab-countdown");
      await sender.locator("#signal").click();
      await expect.poll(() => receiver.evaluate(() => window.__received.length)).toBe(2);
      await expect(receiver.locator("#ping-clock")).not.toHaveAttribute("data-event-id", firstEvent);
      await expect.poll(() => receiver.locator("body").getAttribute("data-tab-countdown")).toMatch(/^(05:00|04:59)$/);
      expect(await receiver.locator("body").getAttribute("data-tab-countdown")).not.toBe(earlier);
      await expect(receiver.locator("#availability-state")).toHaveText("불가능");
      await receiver.emulateMedia({ reducedMotion: "reduce" });
      await expect(receiver.locator("body")).toHaveAttribute("data-tab-pulsing", "false");
      await expect(receiver).toHaveTitle(/^\d{2}:\d{2} · PING! · 1\/2명$/);
      const steadyIcon = await receiver.locator('link[rel="icon"]').getAttribute("href");
      await receiver.waitForTimeout(1700);
      expect(await receiver.locator('link[rel="icon"]').getAttribute("href")).toBe(steadyIcon);
      await receiver.evaluate(() => window.__setHidden(false));
      await expect(receiver.locator("body")).toHaveAttribute("data-tab-unread", "false");
      await expect(receiver).toHaveTitle(/^\d{2}:\d{2} · ping · 1\/2명$/);
      await expect(receiver.locator('link[rel="icon"]')).toHaveAttribute("href", "/icon-active.svg");
      await expect(receiver.locator("#availability-state")).toHaveText("불가능");
      // A replayed snapshot must not re-arm an already acknowledged ping.
      await receiver.evaluate(() => window.__setHidden(true));
      await receiver.waitForTimeout(1200);
      await expect(receiver.locator("body")).toHaveAttribute("data-tab-unread", "false");
      expect(errors).toEqual([]);
      const history = await receiver.evaluate(() => window.__tabHistory);
      await info.attach("tab-title-and-favicon-history", { body: JSON.stringify({ engine: name, simulatedVisibility: true, nativeSSE: true, history, errors }), contentType: "application/json" });
      await receiver.evaluate(() => window.__setHidden(false));
      await receiver.screenshot({ path: info.outputPath(`${name.toLowerCase()}-tab-countdown.png`), fullPage: true });
    } finally { await browser.close(); }
  });
}
