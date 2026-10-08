const { test, expect, chromium, webkit, devices } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { setNickname } = require('./profile-actions.cjs');
const WebSocket = require('ws');
const ORIGIN = 'http://127.0.0.1:8787';
// This file explicitly owns context traces; avoid starting both tracing systems.
test.use({ trace: 'off' });

for (const [label, engine, device] of [['Chromium', chromium, 'Pixel 7'], ['WebKit', webkit, 'iPhone 13']]) {
  test(`${label}: form text stays stable across clock ticks and peer updates; sixteen touch saves apply once`, async ({}, info) => {
    const browser = await engine.launch();
    const context = await browser.newContext({ ...devices[device], serviceWorkers: 'block' });
    // Save the browser context trace before closing its manually-created browser.
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    let page, peer;
    const errors = [];
    try {
      page = await context.newPage();
      page.on('pageerror', error => errors.push(String(error)));
      const roomId = randomUUID().replaceAll('-', '');
      await page.goto(`${ORIGIN}/r/${roomId}`);
      await expect(page.locator('#nickname')).toBeEnabled();
      await page.locator('#nickname').fill('첫 이름');
      await expect(page.locator('#nickname-save')).toBeEnabled();
      await page.evaluate(() => {
        window.__profileMutations = 0;
        window.__buttonTextNode = document.querySelector('#nickname-save').firstChild;
        window.__observer = new MutationObserver(records => { window.__profileMutations += records.length; });
        window.__observer.observe(document.querySelector('#nickname-form'), {
          childList: true, characterData: true, attributes: true, subtree: true,
        });
      });
      // This deterministic assertion fails with the old 250 ms control-render loop.
      await page.waitForTimeout(1250);
      expect(await page.evaluate(() => window.__profileMutations)).toBe(0);
      expect(await page.evaluate(() => window.__buttonTextNode === document.querySelector('#nickname-save').firstChild)).toBe(true);
      await page.evaluate(() => window.__observer.disconnect());
      await page.locator('#nickname-save').click();
      await expect(page.locator('#nickname-form')).toBeHidden();
      await expect(page.locator('#availability-state')).toHaveText('불가능');
      await page.locator('#signal').click();
      await expect(page.locator('#ping-clock')).toHaveAttribute('data-active', 'true');
      await page.evaluate(() => {
        window.__profileSubmits = 0;
        document.querySelector('#nickname-form').addEventListener('submit', () => window.__profileSubmits++);
      });
      for (let i = 0; i < 16; i++) {
        await setNickname(page, `반복 저장 ${i + 1}`);
        await expect(page.locator('#availability-state')).toHaveText('불가능');
        expect(await page.evaluate(() => window.__profileSubmits)).toBe(i + 1);
        await page.waitForTimeout(180);
      }
      await page.locator('.user-profile').click();
      await page.locator('#nickname').fill('작성 중');
      peer = new WebSocket(`${ORIGIN.replace('http', 'ws')}/api/rooms/${roomId}/ws`, { headers: { Origin: ORIGIN } });
      const messages = [];
      peer.on('message', data => messages.push(JSON.parse(data.toString())));
      await new Promise((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject); });
      peer.send(JSON.stringify({ type: 'hello', protocol: 'ping-ws-v1', credential: 'e'.repeat(64), visible: true }));
      await expect.poll(() => messages.some(m => m.type === 'welcome')).toBe(true);
      const id = randomUUID();
      peer.send(JSON.stringify({ type: 'nickname', id, nickname: '상대' }));
      await expect.poll(() => messages.some(m => m.type === 'ack' && m.id === id)).toBe(true);
      await expect(page.locator('.user[data-self="false"] .user-name')).toHaveText('상대');
      await page.evaluate(() => { window.__profileMutations = 0; window.__observer.observe(document.querySelector('#nickname-form'), {
        childList: true, characterData: true, attributes: true, subtree: true,
      }); });
      peer.send(JSON.stringify({ type: 'signal', id: randomUUID() }));
      await expect.poll(() => messages.some(m => m.type === 'ack' && m.signal)).toBe(true);
      await page.waitForTimeout(1100);
      expect(await page.evaluate(() => window.__profileMutations)).toBe(0);
      await expect(page.locator('#nickname')).toHaveValue('작성 중');
      await page.evaluate(() => window.__observer.disconnect());
      await page.locator('#nickname-cancel').click();
      await expect(page.locator('.user[data-self="true"] .user-name')).toHaveText('반복 저장 16');
      expect(errors).toEqual([]);
    } finally {
      if (page && !page.isClosed()) {
        await info.attach('profile-final-state', { body: JSON.stringify(await page.evaluate(() => ({
          step: document.body.dataset.profileStep, ready: document.body.dataset.ready,
          form: document.querySelector('#nickname-form')?.outerHTML,
          submits: window.__profileSubmits, mutations: window.__profileMutations,
        }))), contentType: 'application/json' });
      }
      peer?.close();
      await context.tracing.stop({ path: info.outputPath('profile-context-trace.zip') });
      await browser.close();
    }
  });
}
