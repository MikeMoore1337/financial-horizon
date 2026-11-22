import {test,expect} from '@playwright/test';
import {observe,visitGuest,logoutViaUi,view,addEntry,scopedState} from './helpers.mjs';

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
 // Populate real native IndexedDB for the owner so the test can prove
 // that opening/cancelling import never mutates or removes existing records.
 await addEntry(page,'E2E owner local entry preserved',{amount:'43.27'});
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
 expect(snapshot?.entries.some(e=>e.title==='E2E owner local entry preserved')).toBe(true);
 await logoutViaUi(page);
 await visitGuest(page);
 await view(page,'settings');
 await expect(page.locator('[data-action="cloud-import"]')).toHaveCount(0);
 expect(importPosts).toEqual([]);
 expect(await scopedState(page,'account-state-v2:'+owner.id)).toEqual(snapshot);
 watch.assertClean();
});

test('#69 populated profile shows a read-only inventory and cannot submit',async({page,context})=>{
 const importPosts=[];
 page.on('request',req=>{
  if(req.method()==='POST'&&new URL(req.url()).pathname.startsWith('/api/finance/v1/import/'))
   importPosts.push(new URL(req.url()).pathname);
 });
 await visitGuest(page);
 const created=await context.request.post('/__e2e__/personal-session?enable_finance_stub=true&enable_reserves_stub=true&enable_transaction_stub=true');
 expect(created.status()).toBe(200);
 const owner=(await created.json()).user;
 await page.goto('/?auth=success');
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 await addEntry(page,'Synthetic local preview',{amount:'43.27'});
 await view(page,'settings');
 const before=await scopedState(page,'account-state-v2:'+owner.id);
 await page.locator('[data-action="backup"]').click();
 await page.locator('#password-form [name="password"]').fill('Example-only-passphrase-2026!');
 const download=page.waitForEvent('download');
 await page.locator('#password-form button[type="submit"]').click();
 const backup=await download;
 // The browser and IndexedDB are real; the finance HTTP server is synthetic.
 await page.locator('[data-action="cloud-import"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await backup.path());
 await page.locator('#password-form [name="password"]').fill('Example-only-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Проверка профилей');
 await expect(page.locator('#cloud-import-summary')).toContainText('обязательств 2');
 await expect(page.locator('#cloud-import-summary')).toContainText('резервов 2');
 await expect(page.locator('#cloud-import-summary')).toContainText('операций 1');
 await expect(page.locator('#cloud-import-summary')).toContainText('Выберите действие для каждой записи');
 await expect(page.locator('#cloud-import-summary')).toContainText('Сходство не доказывает дубль');
 await expect(page.locator('#cloud-import-final-consent')).not.toBeVisible();
 await page.locator('#cloud-import-comparison summary').first().click();
 await expect(page.locator('#cloud-import-comparison')).toContainText('Synthetic local preview');
 await expect(page.locator('#cloud-import-comparison')).toContainText('Хостинг');
 await page.locator('#cloud-import-comparison summary').last().click();
 await expect(page.locator('#cloud-import-comparison')).toContainText('Synthetic transaction');
 await expect(page.locator('#cloud-import-comparison')).toContainText('Основной счёт:');
 await expect(page.locator('#cloud-import-comparison')).toContainText(
  new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2,minimumFractionDigits:0}).format(-123.45));
 await expect(page.locator('[data-action="confirm-cloud-import"]')).toBeDisabled();
 await page.locator('#cloud-import-comparison select').first().selectOption('add');
 await page.locator('[data-action="prepare-cloud-merge"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Проверьте план переноса');
 await expect(page.locator('#cloud-import-dialog')).toContainText('сервер получит расшифрованные финансовые данные');
 await expect(page.locator('#cloud-import-summary')).toContainText('Добавить: 1, связать с сервером: 0');
 await expect(page.locator('#cloud-import-comparison label p').first()).toHaveText('Добавить отдельную запись');
 expect(await page.locator('#cloud-import-comparison').innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
 await expect(page.locator('#cloud-import-final-consent')).not.toBeChecked();
 await expect(page.locator('[data-action="prepare-cloud-merge"]')).not.toBeVisible();
 await expect(page.locator('[data-action="confirm-cloud-import"]')).toBeEnabled();
 expect(await page.locator('#cloud-import-dialog .dialog-body').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 expect(importPosts).toEqual([]);
 expect(await scopedState(page,'account-state-v2:'+owner.id)).toEqual(before);
 await page.getByRole('button',{name:'Отмена'}).click();
 await expect(page.locator('#cloud-import-comparison')).toBeEmpty();
});
