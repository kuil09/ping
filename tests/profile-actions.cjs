const { expect, test } = require('@playwright/test');

// Exercise the real tap/submit path. No forced click, retry click, or direct API save.
async function setNickname(page, value, { touch = false } = {}) {
  const activate = locator => touch ? locator.tap() : locator.click();
  try {
    if (!(await page.locator('#nickname-form').isVisible())) await activate(page.locator('.user[data-self="true"] .user-profile'));
    await page.locator('#nickname').fill(value);
    await page.evaluate(() => {
      window.__nicknameActions = [];
      if (window.__nicknameDiagnosticsInstalled) return;
      window.__nicknameDiagnosticsInstalled = true;
      for (const type of ['pointerdown', 'pointerup', 'click', 'submit']) {
        document.querySelector('#nickname-form').addEventListener(type, event => {
          window.__nicknameActions.push({ type, pointerType: event.pointerType, target: event.target.id, at: performance.now() });
        }, true);
      }
    });
    await activate(page.locator('#nickname-save'));
    await expect(page.locator('#nickname-form')).toBeHidden();
    await expect(page.locator('.user[data-self="true"] .user-name')).toHaveText(value.normalize('NFC').trim().replace(/\s+/gu, ' '));
    await expect(page.locator('#availability')).toBeEnabled();
  } catch (error) {
    // Manual contexts are not covered by fixture traces; keep actionable diagnostics.
    if (!page.isClosed()) await test.info().attach('nickname-save-failure', {
      body: JSON.stringify(await page.evaluate(() => ({
        actions: window.__nicknameActions,
        step: document.body.dataset.profileStep, ready: document.body.dataset.ready,
        form: document.querySelector('#nickname-form')?.outerHTML,
        value: document.querySelector('#nickname')?.value,
        focused: document.activeElement?.id,
        status: document.querySelector('#status')?.textContent,
      }))), contentType: 'application/json',
    });
    throw error;
  }
}
module.exports = { setNickname };
