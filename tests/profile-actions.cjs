const { expect } = require("@playwright/test");

// Exercise the public flow; do not pre-populate storage or bypass the real nickname API.
async function setNickname(page, value) {
  if (!(await page.locator("#nickname-form").isVisible())) await page.locator("#self-profile").click();
  await page.locator("#nickname").fill(value);
  await page.locator("#nickname-save").click();
  await expect(page.locator("#nickname-form")).toBeHidden();
  await expect(page.locator("#profile-name")).toHaveText(value.normalize("NFC").trim().replace(/\s+/gu, " "));
  await expect(page.locator("#availability")).toBeEnabled();
}
module.exports = { setNickname };
