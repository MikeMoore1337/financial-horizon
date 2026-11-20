import { test, expect } from '@playwright/test';
import { observe, visitGuest, view, scopedState } from './helpers.mjs';

test('React category rename form commits once and survives repeated modal openings', async ({ page, context }) => {
  const watcher = await observe(context, page);
  await visitGuest(page);
  await view(page, 'settings');
  const create = page.locator('#category-form');
  await create.locator('[name="name"]').fill('Категория 72');
  await create.locator('button[type="submit"]').click();
  let previous = await scopedState(page, 'state');
  expect(previous.categories).toContain('Категория 72');
  for (const name of ['Категория 72А', 'Категория 72Б']) {
    const oldName = previous.categories.includes('Категория 72') ? 'Категория 72' : 'Категория 72А';
    await page.locator('[data-action="edit-category"][data-category="' + oldName + '"]').click();
    await expect(page.locator('#category-dialog')).toBeVisible();
    await page.locator('#rename-category-form [name="newName"]').fill(name);
    await page.locator('#rename-category-form button[type="submit"]').click();
    await expect(page.locator('#category-dialog')).not.toBeVisible();
    const next = await scopedState(page, 'state');
    expect(next.categories.filter((category) => category === name)).toHaveLength(1);
    expect(next.revision).toBe(previous.revision + 1);
    previous = next;
  }
  await page.reload();
  await view(page, 'settings');
  await expect(page.locator('[data-category="Категория 72Б"][data-action="edit-category"]')).toHaveCount(1);
  watcher.assertClean();
});
