const { expect } = require("@playwright/test");

// Exercise the current public flow: only the own member card edits an existing name.
async function setNickname(page, value) {
  if (!(await page.locator("#nickname-form").isVisible())) await page.locator('.user[data-self="true"] .user-profile').click();
  await page.locator("#nickname").fill(value);
  await page.locator("#nickname-save").click();
  await expect(page.locator("#nickname-form")).toBeHidden();
  await expect(page.locator('.user[data-self="true"] .user-name')).toHaveText(value.normalize("NFC").trim().replace(/\s+/gu, " "));
  await expect(page.locator("#availability")).toBeEnabled();
}
module.exports = { setNickname };
