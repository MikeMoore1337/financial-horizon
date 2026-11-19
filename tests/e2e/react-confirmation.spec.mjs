import { test, expect } from '@playwright/test';
import { observe, visitGuest, view, nativeDb } from './helpers.mjs';

test('React confirmation cancel and Escape never mutate stored finances', async ({ page, context }) => {
  const watcher = await observe(context, page);
  await visitGuest(page);
  const before = await nativeDb(page);
  await view(page, 'settings');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('[data-action="clear"]').click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await expect(page.locator('#confirmation-title')).toHaveText('Удалить всю бухгалтерию?');
    if (attempt === 0) await page.locator('#confirm-cancel').click();
    else await page.keyboard.press('Escape');
    await expect(page.locator('#confirmation-dialog')).not.toBeVisible();
  }
  expect(await nativeDb(page)).toEqual(before);
  watcher.assertClean();
});
