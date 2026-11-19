import { test, expect } from '@playwright/test';
import { observe, visitGuest, nativeDb } from './helpers.mjs';

test('React auxiliary dialogs retain all native IDs and consent stays unchecked', async ({ page, context }) => {
  const watcher = await observe(context, page);
  await visitGuest(page);
  const before = await nativeDb(page);
  await expect(page.locator('#payment-methods-dialog #payment-method-form')).toHaveCount(1);
  await expect(page.locator('#payment-methods-dialog #payment-method-type option')).toHaveCount(5);
  await expect(page.locator('#excel-import-dialog [role="region"]')).toHaveCount(2);
  await expect(page.locator('#cloud-import-dialog #cloud-import-final-consent')).not.toBeChecked();
  await expect(page.locator('#cloud-import-dialog #cloud-import-preserve-zero-account')).not.toBeChecked();
  expect(await nativeDb(page)).toEqual(before);
  watcher.assertClean();
});
