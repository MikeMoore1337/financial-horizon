import { test, expect } from '@playwright/test';
import { observe, visitGuest, view, nativeDb } from './helpers.mjs';

test('React toolbar delegates add and theme without duplicate financial writes', async ({ page, context }) => {
  const watcher = await observe(context, page);
  await visitGuest(page);
  const before = await nativeDb(page);
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  await page.locator('#top-add').click();
  await expect(page.locator('#entry-dialog')).toBeVisible();
  await page.locator('#entry-form button[value="cancel"]').click();
  await expect(page.locator('#entry-dialog')).not.toBeVisible();
  await page.locator('#theme-toggle').click();
  const theme = await page.locator('body').getAttribute('data-theme');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('#theme-toggle')).toHaveAttribute(
    'aria-label',
    theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему',
  );
  await view(page, 'loans');
  await expect(page.locator('#toolbar-title')).toHaveText('Кредиты');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-theme', theme);
  expect(await nativeDb(page)).toEqual(before);
  watcher.assertClean();
});
