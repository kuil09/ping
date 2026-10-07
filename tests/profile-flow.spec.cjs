const { test, expect, chromium, webkit, devices } = require("@playwright/test");
const { setNickname } = require("./profile-actions.cjs");
const crypto = require("node:crypto");
const A = process.env.PING_TEST_ORIGIN || "http://127.0.0.1:9101";
const B = process.env.PING_TEST_ORIGIN || "http://127.0.0.1:9102";
const fresh = () => "profile_" + crypto.randomUUID().replaceAll("-", "");

for (const [label, engine, device] of [["Chromium", chromium, "Pixel 7"], ["WebKit", webkit, "iPhone 13"]]) {
  test(`${label}: enter a name, collapse to my profile, then explicitly toggle availability`, async ({}, info) => {
    const browser = await engine.launch();
    const errors = [];
    try {
      const context = await browser.newContext({ ...devices[device], colorScheme: "light" });
      const peerContext = await browser.newContext({ ...devices[device] });
      const page = await context.newPage(), peer = await peerContext.newPage(), room = fresh();
      for (const p of [page, peer]) p.on("pageerror", e => errors.push(String(e)));
      await Promise.all([page.goto(`${A}/r/${room}`), peer.goto(`${B}/r/${room}`)]);
      await expect(page.locator("body")).toHaveAttribute("data-profile-flow", "nickname-first-v1");
      await expect(page.locator(".user")).toHaveCount(2);
      await expect(page.locator("#nickname-form")).toBeVisible();
      await expect(page.locator("#self-profile")).toBeHidden();
      await expect(page.locator("#availability-control")).toBeHidden();
      await expect(page.locator("#availability")).toBeDisabled();
      await expect(page.locator("#signal")).toBeDisabled();
      await expect(page.locator("#nickname-cancel")).toBeHidden();
      await page.screenshot({ path: info.outputPath("01-nickname-entry.png"), fullPage: true });
      await page.locator("#nickname").fill("   "); await page.locator("#nickname-save").click();
      await expect(page.locator("#nickname-feedback")).toHaveText("닉네임을 입력하세요.");
      await expect(page.locator("#availability-control")).toBeHidden();
      await page.route("**/nickname", r => r.fulfill({ status: 503, json: { error: "test_failure" } }));
      await page.locator("#nickname").fill("니트로"); await page.locator("#nickname-save").click();
      await expect(page.locator("#nickname-feedback")).toContainText("저장 실패");
      await expect(page.locator("#nickname")).toHaveValue("니트로");
      await expect(page.locator("#self-profile")).toBeHidden();
      await expect(page.locator("#availability")).toBeDisabled();
      await page.unroute("**/nickname");
      await setNickname(page, "니트로"); await setNickname(peer, "구름");
      await expect(page.locator("#self-profile")).toBeVisible();
      await expect(page.locator("#nickname")).toBeHidden();
      await expect(page.locator("#availability-state")).toHaveText("불가능");
      await expect(peer.locator('.user[data-self="false"] .user-name')).toHaveText("니트로");
      const profileBox = await page.locator("#self-profile").boundingBox();
      const statusBox = await page.locator("#availability").boundingBox();
      expect(profileBox.y + profileBox.height).toBeLessThan(statusBox.y);
      await page.screenshot({ path: info.outputPath("02-profile-ready.png"), fullPage: true });
      await page.locator("#availability").click();
      await expect(peer.locator('.user[data-self="false"]')).toHaveAttribute("data-available", "true");
      await page.locator("#self-profile").focus(); await page.keyboard.press("Enter");
      await expect(page.locator("#nickname")).toBeFocused();
      await expect(page.locator("#self-profile")).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("#availability")).toBeDisabled();
      await page.locator("#nickname").fill("수정 중");
      await peer.locator("#signal").click();
      await expect(page.locator("#ping-clock")).toHaveAttribute("data-active", "true");
      await expect(page.locator("#nickname")).toHaveValue("수정 중");
      await expect(page.locator("#availability-state")).toHaveText("가능");
      await page.screenshot({ path: info.outputPath("03-profile-editing.png"), fullPage: true });
      await page.locator("#nickname-cancel").click();
      await expect(page.locator("#nickname-form")).toBeHidden();
      await expect(page.locator("#profile-name")).toHaveText("니트로");
      await expect(page.locator("#availability-state")).toHaveText("가능");
      await expect(peer.locator('.user[data-self="false"] .user-name')).toHaveText("니트로");
      await page.locator('.user[data-self="true"] .user-profile').click();
      await expect(page.locator("#nickname")).toBeFocused();
      await page.locator("#nickname").fill(" "); await page.locator("#nickname-save").click();
      await expect(page.locator("#nickname-feedback")).toHaveText("닉네임을 입력하세요.");
      await page.locator("#nickname").press("Escape");
      await expect(page.locator("#nickname-form")).toBeHidden();
      await expect(page.locator("#self-profile")).toBeFocused();
      await setNickname(page, "니트로 개발");
      await expect(peer.locator('.user[data-self="false"] .user-name')).toHaveText("니트로 개발");
      await expect(page.locator("#availability-state")).toHaveText("가능");
      await page.reload();
      await expect(page.locator("#nickname-form")).toBeHidden();
      await expect(page.locator("#profile-name")).toHaveText("니트로 개발");
      await expect(page.locator("#availability-state")).toHaveText("가능");
      const sibling = await context.newPage(); await sibling.goto(`${A}/r/${room}`);
      await expect(sibling.locator("#nickname-form")).toBeHidden();
      await setNickname(page, "새 이름");
      await expect(sibling.locator("#profile-name")).toHaveText("새 이름");
      await expect(sibling.locator("#nickname-form")).toBeHidden();
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.screenshot({ path: info.outputPath("04-profile-dark.png"), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
}

test("a pending nickname cannot unlock the toggle before its confirmed application", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${A}/r/${fresh()}`); await expect(page.locator("#nickname")).toBeEnabled();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/nickname", async route => { await gate; await route.continue(); });
    await page.locator("#nickname").fill("천천히"); await page.locator("#nickname-save").click();
    await expect(page.locator("#nickname-form")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#availability")).toBeDisabled();
    await expect(page.locator("#self-profile")).toBeHidden();
    await expect(page.locator("#nickname")).toHaveJSProperty("readOnly", true);
    release();
    await expect(page.locator("#nickname-form")).toBeHidden();
    await expect(page.locator("#availability")).toBeEnabled();
    await expect(page.locator("#availability-state")).toHaveText("불가능");
  } finally { await browser.close(); }
});
