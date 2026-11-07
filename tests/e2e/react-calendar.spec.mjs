import { test, expect } from '@playwright/test';
import { observe, visitGuest, view, nativeDb } from './helpers.mjs';

test('React calendar stays read-only across legacy navigation and keyboard actions', async ({page,context}) => {
  const watcher=await observe(context,page);
  await visitGuest(page);
  const before=await nativeDb(page);
  for(const screen of ['calendar','overview','calendar','settings','calendar']) {
    await view(page,screen);
    await expect(page.locator('#toolbar-title')).toHaveText(
      {calendar:'Календарь',overview:'Обзор',settings:'Настройки'}[screen]);
  }
  const day=page.locator('.cal-day:not(.selected)').first();
  await day.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cal-day.selected')).toBeFocused();
  await expect(page.locator('.cal-day.selected')).toHaveAttribute('aria-pressed','true');
  const first=await page.locator('.cal-day').first().getAttribute('data-date');
  await page.getByRole('button',{name:'Следующий месяц'}).click();
  const next=await page.locator('.cal-day').first().getAttribute('data-date');
  expect(next).not.toBe(first);
  expect(await nativeDb(page)).toEqual(before);
  watcher.assertClean();
});

test('React calendar retains both themes and widths from 320 to 2560 CSS px', async ({page,context}) => {
  const watcher=await observe(context,page);
  await visitGuest(page);
  for (const width of [320,360,393,768,1150,1151,1440,2560]) {
    await page.setViewportSize({width,height:900});
    for (const theme of ['light','dark']) {
      if (await page.locator('body').getAttribute('data-theme')!==theme) await page.locator('#theme-toggle').click();
      await view(page,'calendar');
      const size=await page.evaluate(()=>({
        scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
        width:document.documentElement.clientWidth,
        days:document.querySelectorAll('.cal-day').length,
      }));
      expect(size.scroll,'No horizontal scroll at '+width+'/'+theme).toBeLessThanOrEqual(size.width+1);
      expect(size.days).toBeGreaterThanOrEqual(28);
      expect(size.days).toBeLessThanOrEqual(31);
    }
  }
  watcher.assertClean();
});
