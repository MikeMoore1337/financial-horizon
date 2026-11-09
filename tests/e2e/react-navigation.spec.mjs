import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,nativeDb} from './helpers.mjs';

const pages=['overview','calendar','obligations','loans','settings'];
const labels={overview:'Обзор',calendar:'Календарь',obligations:'Обязательства',loans:'Кредиты',settings:'Настройки'};

test('React desktop and mobile navigation never overlap, lose current section or write to IndexedDB',async({page,context})=>{
  const watcher=await observe(context,page);
  await visitGuest(page);
  const before=await nativeDb(page);
  for(const width of [320,360,393,768,1150,1151,1440,2560]){
    await page.setViewportSize({width,height:900});
    for(const v of pages){
      await view(page,v);
      await expect(page.locator('#toolbar-title')).toHaveText(labels[v]);
      await expect(page.locator('.sidebar-nav [data-view]')).toHaveCount(5);
      await expect(page.locator('.bottom-nav [data-view]')).toHaveCount(5);
      await expect(page.locator('.sidebar-nav [data-view="'+v+'"]')).toHaveAttribute('aria-current','page');
      await expect(page.locator('.bottom-nav [data-view="'+v+'"]')).toHaveAttribute('aria-current','page');
      const bounds=await page.evaluate(()=>({
        documentWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
        clientWidth:document.documentElement.clientWidth,
      }));
      expect(bounds.documentWidth,'overflow '+width+'/'+v).toBeLessThanOrEqual(bounds.clientWidth+1);
    }
  }
  expect(await nativeDb(page)).toEqual(before);
  watcher.assertClean();
});

test('React navigation retains keyboard activation, theme and PWA installed shell on reload',async({page,context})=>{
  const watcher=await observe(context,page);
  await visitGuest(page);
  await page.setViewportSize({width:393,height:852});
  const loans=page.locator('.bottom-nav [data-view="loans"]');
  await loans.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#toolbar-title')).toHaveText('Кредиты');
  await expect(loans).toHaveAttribute('aria-current','page');
  await page.locator('#theme-toggle').click();
  const theme=await page.locator('body').getAttribute('data-theme');
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await page.reload();
  await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
  await expect(page.locator('body')).toHaveAttribute('data-theme',theme);
  await view(page,'calendar');
  const count=await page.locator('.cal-day').count();
  expect(count).toBeGreaterThanOrEqual(28);
  expect(count).toBeLessThanOrEqual(31);
  watcher.assertClean();
});
