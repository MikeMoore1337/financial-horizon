import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,addEntry,scopedState,nativeDb} from './helpers.mjs';

test('React settings: categories CRUD, archive and history use one legacy dispatcher',async({page,context})=>{
 const watcher=await observe(context,page);
 await page.setViewportSize({width:1280,height:800});
 await visitGuest(page);
 await view(page,'settings');
 const id='#category-form';
 await page.locator(id+' [name="name"]').fill('React E2E category');
 await page.locator(id+' button[type="submit"]').click();
 await expect(page.locator('[data-settings-card="categories"] .category-name').filter({hasText:'React E2E category'})).toHaveCount(1);
 const current=await scopedState(page,'state');
 expect(current.categories).toContain('React E2E category');
 await expect(page.locator(id+' [name="name"]')).toHaveValue('');
 await page.locator('[data-action="edit-category"][data-category="React E2E category"]').click();
 await expect(page.locator('#category-dialog')).toBeVisible();
 await page.locator('#rename-category-form [name="newName"]').fill('React E2E renamed');
 await page.locator('#rename-category-form button[type="submit"]').click();
 await expect(page.locator('#category-dialog')).not.toBeVisible();
 await expect(page.locator('[data-settings-card="categories"]')).toContainText('React E2E renamed');
 await page.locator('[data-action="delete-category"][data-category="React E2E renamed"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).categories.includes('React E2E renamed')).toBe(false);
 await addEntry(page,'E2E React archive',{kind:'expense',amount:'100'});
 await view(page,'obligations');
 await page.locator('.records-table tbody tr').filter({hasText:'E2E React archive'})
  .locator('[data-action="archive-entry"]').click();
 await page.locator('#confirm-yes').click();
 await view(page,'settings');
 await expect(page.locator('[data-settings-card="archive"]')).toContainText('E2E React archive');
 await page.locator('[data-settings-card="archive"] [data-action="restore-item"]').click();
 await expect.poll(async()=>!(await scopedState(page,'state')).entries.find(x=>x.title==='E2E React archive').deletedAt).toBe(true);
 await expect(page.locator('[data-settings-card="history"]')).toContainText('Последние изменения');
 watcher.assertClean();
});

test('React settings: storage note is rendered by React and passive navigation never writes IDB',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 const before=await nativeDb(page);
 await view(page,'settings');
 await expect(page.locator('#storage-status')).toHaveAttribute('role','status');
 await expect(page.locator('#storage-status')).toContainText(/хранение|Очистка/i);
 for(const width of [320,360,393,768,1150,1151,1440,2560]){
  await page.setViewportSize({width,height:900});
  for(const theme of ['light','dark']){
   if(await page.locator('body').getAttribute('data-theme')!==theme)
    await page.locator('#theme-toggle').click();
   await view(page,'settings');
   const result=await page.evaluate(()=>({
     width:document.documentElement.clientWidth,
     scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
     cards:document.querySelectorAll('[data-settings-card]').length,
   }));
   expect(result.cards).toBe(7);
   expect(result.scroll,'overflow '+width+'/'+theme).toBeLessThanOrEqual(result.width+1);
  }
 }
 expect(await nativeDb(page)).toEqual(before);
 watcher.assertClean();
});
