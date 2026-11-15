import {test,expect} from '@playwright/test';
import {observe,visitGuest,logoutViaUi,view,scopedState} from './helpers.mjs';

test('#69 import entry only for verified FH owner, no automatic financial POST',async({page,context})=>{
 const watch=await observe(context,page);
 const importPosts=[];
 page.on('request',req=>{
  if(req.method()==='POST'&&new URL(req.url()).pathname.startsWith('/api/finance/v1/import/')){
   importPosts.push(new URL(req.url()).pathname);
  }
 });
 await visitGuest(page);
 await view(page,'settings');
 await expect(page.locator('[data-action="backup"]')).toBeVisible();
 await expect(page.locator('[data-action="verify-backup"]')).toBeVisible();
 await expect(page.locator('[data-action="cloud-import"]')).toHaveCount(0);
 expect(importPosts).toEqual([]);

 // Create a genuine revocable FH AuthStore cookie with the isolated E2E
 // identity fixture. Avoid consuming the global mail registration quota,
 // which made unrelated browser tests rate-limited after retries.
 const created=await context.request.post('/__e2e__/personal-session');
 expect(created.status()).toBe(200);
 const owner=(await created.json()).user;
 expect(owner.id).toMatch(/^[0-9a-f]{32}$/);
 // A browser tab that was previously in guest mode retains its guest
 // sessionStorage key. Follow the app's actual successful-auth callback
 // transition, which clears guest mode and still revalidates the FH cookie.
 await page.goto('/?auth=success');
 await expect(page).toHaveURL('http://127.0.0.1:8791/');
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 await view(page,'settings');
 const launch=page.locator('[data-action="cloud-import"]');
 await expect(launch).toBeVisible();
 await expect(launch).toHaveText(/Перенести данные в аккаунт/);
 expect(importPosts).toEqual([]);

 // File selection merely requests local password validation. No stage,
 // commit or restore POST can occur without a separate final owner consent.
 await launch.click();
 await page.locator('#cloud-import-file').setInputFiles({
  name:'synthetic-encrypted.json',mimeType:'application/json',
  buffer:Buffer.from('{"format":"financial-horizon-backup","version":1,"kdf":"PBKDF2-SHA256","iterations":310000,"salt":"AA","iv":"AA","ciphertext":"AA"}'),
 });
 await expect(page.locator('#password-dialog')).toBeVisible();
 await expect(page.locator('#password-heading')).toContainText('Проверить шифрованную копию для переноса');
 expect(importPosts).toEqual([]);
 await page.locator('#password-dialog .dialog-head button[value="cancel"]').click();
 await expect(page.locator('#password-dialog')).not.toBeVisible();
 expect(importPosts).toEqual([]);

 // A real logout removes the owner-only entry, not the local finance data.
 const snapshot=await scopedState(page,'account-state-v2:'+owner.id);
 await logoutViaUi(page);
 await visitGuest(page);
 await view(page,'settings');
 await expect(page.locator('[data-action="cloud-import"]')).toHaveCount(0);
 expect(importPosts).toEqual([]);
 expect(snapshot).toBeTruthy();
 watch.assertClean();
});
