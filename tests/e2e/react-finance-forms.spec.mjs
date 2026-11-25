import { test, expect } from '@playwright/test';
import { observe, visitGuest, view, nativeDb } from './helpers.mjs';

test('React finance forms keep native field IDs and do not write money on passive opening', async ({ page, context }) => {
  const watcher = await observe(context, page);
  await visitGuest(page);
  const before = await nativeDb(page);
  for (const id of ['entry', 'loan', 'payment', 'settlement', 'password']) {
    await expect(page.locator('#' + id + '-dialog > #' + id + '-form')).toHaveCount(1);
  }
  await page.locator('#top-add').click();
  await expect(page.locator('#entry-dialog')).toBeVisible();
  await page.locator('#entry-form [value="cancel"]').first().click();
  await expect(page.locator('#entry-dialog')).not.toBeVisible();
  await view(page, 'settings');
  await page.locator('[data-action="backup"]').click();
  await expect(page.locator('#password-dialog')).toBeVisible();
  await expect(page.locator('#password-form [name="password"]')).toHaveAttribute('type', 'password');
  await page.keyboard.press('Escape');
  await expect(page.locator('#password-dialog')).not.toBeVisible();
  expect(await nativeDb(page)).toEqual(before);
  watcher.assertClean();
});
