import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,addEntry,scopedState} from './helpers.mjs';

test('synthetic encrypted export and recovery from downloaded file',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E sample for restore',{amount:'991.72'});
 await view(page,'settings');
 await page.locator('[data-action="backup"]').click();
 await page.locator('#password-form [name="password"]').fill('Example-only-passphrase-2026!');
 const transfer=page.waitForEvent('download');
 await page.locator('#password-form button[type="submit"]').click();
 const downloaded=await transfer;
 expect(downloaded.suggestedFilename()).toContain('encrypted.json');

 // The user's saved AES-GCM file can be independently read and compared
 // with this browser without replacement, uploads or a confirmation dialog.
 const beforeVerify = await scopedState(page,'state');
 await page.locator('[data-action="verify-backup"]').click();
 await page.locator('#verify-backup-file').setInputFiles(await downloaded.path());
 await expect(page.locator('#password-dialog')).toBeVisible();
 await expect(page.locator('#password-heading')).toHaveText('Проверить копию без восстановления');
 await page.locator('#password-form [name="password"]').fill('Example-only-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#password-dialog')).not.toBeVisible();
 await expect(page.locator('#backup-verify-status')).toContainText('полностью совпадает');
 await expect(page.locator('#backup-verify-status')).toContainText('Данные не менялись');
 expect(await scopedState(page,'state')).toEqual(beforeVerify);

 await page.locator('[data-action="clear"]').click();
 await page.locator('#confirm-yes').click();
 await expect.poll(async()=> (await scopedState(page,'state')).entries.length).toBe(0);
 await page.locator('[data-action="restore"]').click();
 await page.locator('#restore-file').setInputFiles(await downloaded.path());
 await expect(page.locator('#password-dialog')).toBeVisible();
 await page.locator('#password-form [name="password"]').fill('Example-only-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#confirmation-dialog')).toBeVisible();
 await page.locator('#confirm-yes').click();
 await expect.poll(async()=> (await scopedState(page,'state')).entries.some(e=>e.title==='E2E sample for restore')).toBe(true);
 await page.reload();
 expect((await scopedState(page,'state')).entries[0].amountCents).toBe(99172);
 watcher.assertClean();
});
