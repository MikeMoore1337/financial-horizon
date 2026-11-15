import {test,expect} from '@playwright/test';
import {observe,visitGuest,registerViaUi,logoutViaUi,view,scopedState} from './helpers.mjs';

test('#69 import entry only for verified FH owner, no automatic financial POST',async({page,context,request})=>{
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

 const email='e2e-personal-import-'+test.info().project.name+'@example.invalid';
 await registerViaUi(page,request,email);
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
 await page.locator('#password-dialog button[value="cancel"]').click();
 await expect(page.locator('#password-dialog')).not.toBeVisible();
 expect(importPosts).toEqual([]);

 // A real logout removes the owner-only entry, not the local finance data.
 const snapshot=await scopedState(page,'account-state-v2:'+(await page.evaluate(async()=>{
  const r=await fetch('/api/auth/email/me',{credentials:'same-origin',cache:'no-store'});
  return (await r.json()).user.id;
 })));
 await logoutViaUi(page);
 await visitGuest(page);
 await view(page,'settings');
 await expect(page.locator('[data-action="cloud-import"]')).toHaveCount(0);
 expect(importPosts).toEqual([]);
 expect(snapshot).toBeTruthy();
 watch.assertClean();
});
