const { test, expect, chromium, webkit, devices } = require("@playwright/test");
const crypto = require("node:crypto");
const A = process.env.PING_TEST_ORIGIN || "http://127.0.0.1:9101";
const B = process.env.PING_TEST_ORIGIN || "http://127.0.0.1:9102";
const fresh = () => "history_" + crypto.randomUUID().replaceAll("-", "");
test.setTimeout(90000);
async function name(page, value) {
  await page.locator("#nickname").fill(value); await page.locator("#nickname-save").click();
  await expect(page.locator("#nickname-feedback")).toHaveText("저장됨");
}
async function openHistory(page) {
  if (!(await page.locator("#history").getAttribute("open") !== null)) await page.locator("#history > summary").click();
}

test("nicknames and independent opt-in availability synchronize; local timeline is collapsed, durable and clearable", async ({}, info) => {
  const chrome = await chromium.launch(), safari = await webkit.launch(), errors = [];
  try {
    const ca = await chrome.newContext({ ...devices["Pixel 7"], colorScheme: "light" });
    const cb = await safari.newContext({ ...devices["iPhone 13"], colorScheme: "light" });
    const a = await ca.newPage(), b = await cb.newPage(), room = fresh();
    for (const p of [a, b]) p.on("pageerror", e => errors.push(String(e)));
    await Promise.all([a.goto(`${A}/r/${room}`), b.goto(`${B}/r/${room}`)]);
    for (const p of [a, b]) {
      await expect(p.locator(".user")).toHaveCount(2);
      await expect(p.locator("#availability")).toHaveAttribute("aria-checked", "false");
      await expect(p.locator("#history")).not.toHaveAttribute("open", "");
      await expect(p.locator("#nickname")).toHaveValue("");
    }
    const config = await (await fetch(`${A}/api/config`)).json();
    expect(config.defaultAvailable).toBe(false); expect(config.profileUi).toBe("nickname-v1");
    await name(a, "니트로"); await name(b, "구름");
    await expect(a.locator('.user[data-self="false"] .user-name')).toHaveText("구름");
    await expect(b.locator('.user[data-self="false"] .user-name')).toHaveText("니트로");
    await expect(a.locator("#member-count")).toHaveText("2명 · 0명 가능");
    await a.locator("#signal").click(); await expect(b.locator('.user[data-active="true"]')).toHaveCount(1);
    await expect(a.locator("#availability-state")).toHaveText("불가능");
    await b.locator("#availability").click(); await expect(a.locator('.user[data-self="false"]')).toHaveAttribute("data-available", "true");
    await b.locator("#signal").click(); await expect(a.locator('.user[data-active="true"]')).toHaveCount(2);
    await a.screenshot({ path: info.outputPath("mobile-history-collapsed.png"), fullPage: true });
    await openHistory(a); await openHistory(b);
    await expect(a.locator('.history-entry[data-kind="ping"]')).toHaveCount(2);
    await expect(b.locator('.history-entry[data-kind="ping"]')).toHaveCount(2);
    await expect(a.locator('.history-entry[data-kind="availability"]')).toHaveCount(1);
    await expect(a.locator('.history-entry[data-kind="availability"]')).toContainText("구름");
    await expect(a.locator('.history-entry[data-kind="availability"]')).toContainText("가능으로 변경");
    const names = await a.locator('.history-entry[data-kind="ping"] .history-name').allTextContents();
    expect(names).toContain("니트로"); expect(names).toContain("구름");
    await name(b, "바람"); await expect(a.locator('.user[data-self="false"] .user-name')).toHaveText("바람");
    await expect(a.locator('.history-entry[data-kind="nickname"]').last()).toBeVisible();
    expect(await a.locator('.history-entry[data-kind="ping"] .history-name').allTextContents()).toEqual(names);
    const state = await (await fetch(`${A}/api/rooms/${room}/state`)).json();
    const pingId = state.channelPing.eventId;
    await a.reload(); await openHistory(a);
    await expect(a.locator('.history-entry[data-kind="ping"]')).toHaveCount(2);
    await expect(a.locator("#nickname")).toHaveValue("니트로");
    await expect(a.locator("#availability-state")).toHaveText("불가능");
    const sibling = await ca.newPage(); await sibling.goto(`${A}/r/${room}`); await openHistory(sibling);
    await expect(sibling.locator(".user")).toHaveCount(2); await expect(sibling.locator('.history-entry[data-kind="ping"]')).toHaveCount(2);
    await name(a, "니트로 개발"); await expect(sibling.locator("#nickname")).toHaveValue("니트로 개발");
    await expect(sibling.locator('.history-entry[data-kind="nickname"]')).toContainText(["니트로"]);
    await a.locator('[data-filter="ping"]').click(); await expect(a.locator(".history-entry")).toHaveCount(2);
    await a.locator('[data-filter="all"]').click();
    await a.screenshot({ path: info.outputPath("mobile-local-history.png"), fullPage: true });
    await b.screenshot({ path: info.outputPath("webkit-local-history.png"), fullPage: true });
    await a.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await a.screenshot({ path: info.outputPath("mobile-local-history-dark.png"), fullPage: true });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const isolated = await ca.newPage(); await isolated.goto(`${A}/r/${fresh()}`);
    await expect(isolated.locator("#history-count")).toHaveText("0"); await isolated.close();
    await a.locator("#history-clear").click(); await a.locator("#history-clear-cancel").click();
    await expect(a.locator('.history-entry[data-kind="ping"]')).toHaveCount(2);
    await a.locator("#history-clear").click(); await a.locator("#history-clear-confirm").click();
    await expect(a.locator("#history-count")).toHaveText("0"); await expect(sibling.locator("#history-count")).toHaveText("0");
    await a.reload(); await openHistory(a); await expect(a.locator('.history-entry[data-kind="ping"]')).toHaveCount(0);
    await expect(a.locator("#ping-clock")).toHaveAttribute("data-event-id", pingId);
    await expect(a.locator("#nickname")).toHaveValue("니트로 개발");
    await expect(b.locator('.history-entry[data-kind="ping"]')).toHaveCount(2);
    expect(errors).toEqual([]);
    await info.attach("local-history-result", { body: JSON.stringify({ freshChannel: true, initialUnavailable: true, peerNicknameSync: true, retainedPingNames: names, clearKeptChannelPing: pingId, errors }), contentType: "application/json" });
  } finally { await chrome.close(); await safari.close(); }
});

test("nickname validation and failed saves preserve confirmed peer state; markup remains plain text", async () => {
  const browser = await chromium.launch();
  try {
    const ca = await browser.newContext(), cb = await browser.newContext();
    const a = await ca.newPage(), b = await cb.newPage(), room = fresh();
    await Promise.all([a.goto(`${A}/r/${room}`), b.goto(`${B}/r/${room}`)]);
    await expect(a.locator(".user")).toHaveCount(2);
    await name(a, "<b>니트로</b>");
    await expect(b.locator('.user[data-self="false"] .user-name')).toHaveText("<b>니트로</b>");
    await expect(b.locator(".user-name b")).toHaveCount(0);
    await openHistory(b); await expect(b.locator(".history-name b")).toHaveCount(0);
    await a.locator("#nickname").fill("가".repeat(21)); await a.locator("#nickname-save").click();
    await expect(a.locator("#nickname")).toHaveAttribute("aria-invalid", "true");
    await expect(b.locator('.user[data-self="false"] .user-name')).toHaveText("<b>니트로</b>");
    await a.locator("#nickname").fill("수정 중"); await a.waitForTimeout(5500); await expect(a.locator("#nickname")).toHaveValue("수정 중");
    await a.route("**/nickname", route => route.fulfill({ status: 503, json: { error: "test_failure" } }));
    await a.locator("#nickname-save").click(); await expect(a.locator("#nickname-feedback")).toContainText("저장 실패");
    await expect(b.locator('.user[data-self="false"] .user-name')).toHaveText("<b>니트로</b>");
    await expect(a.locator("#availability-state")).toHaveText("불가능"); await expect(a.locator("#ping-time")).toHaveText("--:--:--");
    await a.unroute("**/nickname"); await a.locator("#nickname-save").click(); await expect(b.locator('.user[data-self="false"] .user-name')).toHaveText("수정 중");
    const invalid = await fetch(`${B}/api/rooms/${room}/nickname`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: crypto.randomUUID(), sessionId: crypto.randomUUID(), nickname: { html: "bad" } }) });
    expect(invalid.status).toBe(400);
  } finally { await browser.close(); }
});

test("history quota exhaustion does not block signaling or availability", async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(), errors = [];
    await context.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("ping:history:")) throw new DOMException("quota", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    const page = await context.newPage(); page.on("pageerror", e => errors.push(String(e)));
    await page.goto(`${A}/r/${fresh()}`); await expect(page.locator(".user")).toHaveCount(1);
    await name(page, "로컬"); await page.locator("#signal").click(); await openHistory(page);
    await expect(page.locator("#history-note")).toContainText("로컬 저장 불가");
    await expect(page.locator('.history-entry[data-kind="ping"]')).toHaveCount(1);
    await page.locator("#availability").click(); await expect(page.locator("#availability-state")).toHaveText("가능");
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});
