import {createHash,randomUUID} from 'node:crypto';
import {test,expect} from '@playwright/test';
import {visitGuest,view,addEntry,scopedState} from './helpers.mjs';

const origin='http://127.0.0.1:8791';
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):
 Array.isArray(value)?'['+value.map(canonical).join(',')+']':
 '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
async function snapshot(request){
 const response=await request.get('/api/finance/v1/state?limit_entities=5000');
 expect(response.status()).toBe(200);
 return {body:await response.json(),etag:response.headers().etag};
}

test('#69 confirmed guest source merges without changing guest or account local data',async({page,context})=>{
 test.setTimeout(120_000);
 if(process.env.FH_E2E_REAL_FINANCE!=='yes')test.skip();
 const created=await context.request.post('/__e2e__/personal-session');
 expect(created.status()).toBe(200);
 const owner=(await created.json()).user;
 await page.goto('/?auth=success');
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 const bootstrap=await context.request.post('/api/auth/email/finance/session',{headers:{Origin:origin},data:{}});
 expect(bootstrap.status()).toBe(200);
 let before=await snapshot(context.request);
 const accountId=randomUUID(),mutation=randomUUID();
 const account=await context.request.post('/api/finance/v2/commands',{headers:{Origin:origin,
  'If-Match':before.etag,'Idempotency-Key':mutation},data:{schema_version:2,client_mutation_id:mutation,
  base_revision:before.body.revision,action:'account.create',expected_entity_revisions:{},
  payload:{id:accountId,name:'Synthetic preserved account',kind:'bank',currency:'RUB',opening_minor:12345}}});
 expect(account.status()).toBe(201);
 before=await snapshot(context.request);

 const guest=await context.newPage();
 await visitGuest(guest);
 await addEntry(guest,'Synthetic guest obligation',{amount:'43.27'});
 const guestBefore=await scopedState(guest,'guest-state-v2');
 const accountBefore=await scopedState(page,'account-state-v2:'+owner.id);
 await view(guest,'settings');
 await guest.locator('[data-action="backup"]').click();
 await guest.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 const downloading=guest.waitForEvent('download');
 await guest.locator('#password-form button[type="submit"]').click();
 const backup=await downloading;
 const posts=[];
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/finance/v1/import/'))posts.push(new URL(request.url()).pathname);});
 await view(page,'settings');
 await page.locator('[data-action="cloud-import-guest"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await backup.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Гостевая копия');
 await page.locator('#cloud-import-comparison summary').first().click();
 await expect(page.locator('#cloud-import-comparison')).toContainText('Synthetic guest obligation');
 await page.locator('#cloud-import-comparison select').first().selectOption('add');
 await page.locator('[data-action="prepare-cloud-merge"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Проверьте план переноса');
 await page.locator('#cloud-import-final-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#toast')).toContainText('Отдельно подтвердите перенос гостевой копии');
 expect(posts).toEqual([]);
 await page.locator('#cloud-import-guest-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Добавлено 1');
 expect(posts).toEqual(['/api/finance/v1/import/commit','/api/finance/v1/import/restore']);
 const after=await snapshot(context.request);
 expect(after.body.entities).toHaveLength(before.body.entities.length+1);
 expect(after.body.entities.find(row=>row.id===accountId).data.balance_minor).toBe(12345);
 expect(await scopedState(guest,'guest-state-v2')).toEqual(guestBefore);
 expect(await scopedState(page,'account-state-v2:'+owner.id)).toEqual(accountBefore);
 await guest.close();
});

for(const cancelled of [false,true])test(`#69 guest bank history is reviewed and transferred atomically; cancelled=${cancelled}`,async({page,context})=>{
 test.setTimeout(120_000);
 if(process.env.FH_E2E_REAL_FINANCE!=='yes')test.skip();
 const created=await context.request.post('/__e2e__/personal-session');
 expect(created.status()).toBe(200);
 await page.goto('/?auth=success');
 await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 const guest=await context.newPage();
 await visitGuest(guest);
 await addEntry(guest,'Synthetic bank source',{amount:'2.00'});
 await guest.evaluate(async(cancelled)=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('financial-horizon-browser-v1',1);
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite'),store=tx.objectStore('finance'),request=store.get('guest-state-v2');
   request.onsuccess=()=>{
    const value=request.result,revision=value.revision+1,id='11111111-1111-4111-8111-111111111111';
    value.revision=revision;
    value.bankStatements={version:1,accounts:[{id,name:'Synthetic bank account',currency:'RUB',openingMinor:10000}],
     operations:[{sourceKey:'a'.repeat(64),fingerprint:'b'.repeat(64),externalId:'SYN-1',date:'2026-11-01',
      amountCents:500,kind:'expense',description:'Synthetic bank operation',accountId:id,targetAccountId:null,
      category:null,batchKey:'c'.repeat(64)}],
     batches:[{batchKey:'c'.repeat(64),fileDigest:'d'.repeat(64),operationCount:1,
      committedStateRevision:revision,cancelledStateRevision:null}]};
    if(cancelled){value.revision++;value.bankStatements.batches[0].cancelledStateRevision=value.revision;}
    store.put(value,'guest-state-v2');
   };
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
  db.close();
 },cancelled);
 await guest.reload();
 await expect(guest.locator('#save-indicator')).toHaveText('Локальная база готова');
 const guestBefore=await scopedState(guest,'guest-state-v2');
 await view(guest,'settings');
 await guest.locator('[data-action="backup"]').click();
 await guest.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 const downloading=guest.waitForEvent('download');
 await guest.locator('#password-form button[type="submit"]').click();
 const backup=await downloading;
 const posts=[];
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/finance/v1/import/'))posts.push(new URL(request.url()).pathname);});
 await view(page,'settings');
 await page.locator('[data-action="cloud-import-guest"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await backup.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Сравнение банковской истории');
 await expect(page.locator('#cloud-import-summary')).toContainText('Выберите действие для каждой записи');
 const groups=page.locator('#cloud-import-comparison summary');
 for(let index=0;index<await groups.count();index++)await groups.nth(index).click();
 await expect(page.locator('#cloud-import-comparison')).toContainText('Synthetic bank account');
 await expect(page.locator('#cloud-import-comparison')).toContainText('Synthetic bank operation');
 await expect(page.locator('[data-action="confirm-cloud-import"]')).toBeDisabled();
 expect(posts).toEqual([]);
 const planner=page.locator('select[data-merge-kind]');
 for(let index=0;index<await planner.count();index++)await planner.nth(index).selectOption('add');
 await page.locator('select[data-bank-account]').selectOption('add:bank');
 await page.locator('select[data-bank-operation]').selectOption('add');
 await page.locator('[data-action="prepare-cloud-merge"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Проверьте план переноса');
 await expect(page.locator('#cloud-import-summary')).toContainText('проводок '+(cancelled?2:1));
 await expect(page.locator('#cloud-import-comparison')).toContainText('Итог после переноса по счетам');
 await expect(page.locator('#cloud-import-comparison')).toContainText(cancelled?'итог 100':'итог 95');
 expect(posts).toEqual([]);
 await page.locator('#cloud-import-final-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#toast')).toContainText('Отдельно подтвердите перенос гостевой копии');
 expect(posts).toEqual([]);
 await page.locator('#cloud-import-guest-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Сервер вернул точную копию исходных данных');
 expect(posts).toEqual(['/api/finance/v1/import/commit','/api/finance/v1/import/restore']);
 const result=await snapshot(context.request);
 const account=result.body.entities.find(x=>x.kind==='account'&&x.data.name==='Synthetic bank account');
 expect(account.data.opening_minor).toBe(10000);
 expect(account.data.balance_minor).toBe(cancelled?10000:9500);
 expect(result.body.entities.filter(x=>x.kind==='transaction')).toHaveLength(cancelled?2:1);
 expect(await scopedState(guest,'guest-state-v2')).toEqual(guestBefore);
 const history=await context.request.get('/api/finance/v2/bank-import/rows');
 expect(history.status()).toBe(200);
 const bankRow=(await history.json()).rows[0];
 await page.locator('[data-action="cancel-cloud-import"]').first().click();
 await guest.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('financial-horizon-browser-v1',1);
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite'),store=tx.objectStore('finance'),request=store.get('guest-state-v2');
   request.onsuccess=()=>{const state=request.result;state.revision++;
    state.audit.push({description:'Synthetic replay',date:'2026-11-15'});
    store.put(state,'guest-state-v2');};
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });db.close();
 });
 await visitGuest(guest);await view(guest,'settings');
 await guest.locator('[data-action="backup"]').click();
 await guest.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 const secondDownload=guest.waitForEvent('download');
 await guest.locator('#password-form button[type="submit"]').click();
 const secondBackup=await secondDownload;
 await page.locator('[data-action="cloud-import-guest"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await secondBackup.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Сравнение банковской истории');
 const againGroups=page.locator('#cloud-import-comparison summary');
 for(let index=0;index<await againGroups.count();index++)await againGroups.nth(index).click();
 const previousObligation=result.body.entities.find(x=>x.kind==='obligation'&&x.data.title==='Synthetic bank source');
 expect(previousObligation).toBeTruthy();
 const replayPlanner=page.locator('select[data-merge-kind]');
 expect(await replayPlanner.count()).toBe(1);
 await replayPlanner.selectOption('link:'+previousObligation.id);
 await page.locator('select[data-bank-account]').selectOption('link:'+account.id);
 await page.locator('select[data-bank-operation]').selectOption('add');
 await page.locator('[data-action="prepare-cloud-merge"]').click();
 await expect(page.locator('#toast')).toContainText('уже есть на сервере');
 expect(posts).toEqual(['/api/finance/v1/import/commit','/api/finance/v1/import/restore']);
 await page.locator('select[data-bank-operation]').selectOption('link:'+bankRow.transaction_id);
 await page.locator('[data-action="prepare-cloud-merge"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('банковские операции: добавить 0, связать 1');
 await expect(page.locator('#cloud-import-comparison')).toContainText(cancelled?'итог 100':'итог 95');
 await page.locator('#cloud-import-final-consent').check();
 await page.locator('#cloud-import-guest-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Сервер вернул точную копию исходных данных');
 const afterReplay=await snapshot(context.request);
 expect(afterReplay.body.entities.filter(x=>x.kind==='transaction')).toHaveLength(cancelled?2:1);
 expect(afterReplay.body.entities.find(x=>x.kind==='account'&&x.id===account.id).data.balance_minor).toBe(cancelled?10000:9500);
 expect(posts).toEqual(['/api/finance/v1/import/commit','/api/finance/v1/import/restore',
  '/api/finance/v1/import/commit','/api/finance/v1/import/restore']);
 await guest.close();
});

test('#69 changing accounts after guest preview prevents any import',async({page,context})=>{
 test.setTimeout(120_000);
 if(process.env.FH_E2E_REAL_FINANCE!=='yes')test.skip();
 const first=await context.request.post('/__e2e__/personal-session');
 expect(first.status()).toBe(200);
 const firstUser=(await first.json()).user;
 await page.goto('/?auth=success');
 await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 const guest=await context.newPage();await visitGuest(guest);
 await addEntry(guest,'Synthetic guest isolated',{amount:'34.50'});
 const guestBefore=await scopedState(guest,'guest-state-v2');
 await view(guest,'settings');await guest.locator('[data-action="backup"]').click();
 await guest.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 const downloading=guest.waitForEvent('download');
 await guest.locator('#password-form button[type="submit"]').click();
 const backup=await downloading;
 const posts=[];
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/finance/v1/import/'))posts.push(new URL(request.url()).pathname);});
 await view(page,'settings');await page.locator('[data-action="cloud-import-guest"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await backup.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Гостевая копия');
 await page.locator('#cloud-import-guest-consent').check();
 await page.locator('#cloud-import-final-consent').check();
 const second=await context.request.post('/__e2e__/personal-session');
 expect(second.status()).toBe(200);
 expect((await second.json()).user.id).not.toBe(firstUser.id);
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page).toHaveURL(/account\.html/);
 expect(posts).toEqual([]);
 expect(await scopedState(guest,'guest-state-v2')).toEqual(guestBefore);
 const secondBootstrap=await context.request.post('/api/auth/email/finance/session',{headers:{Origin:origin},data:{}});
 expect(secondBootstrap.status()).toBe(200);
 expect((await snapshot(context.request)).body.entities).toEqual([]);
 await guest.close();
});

test('#69 guest source can be imported into an empty profile without deleting either source',async({page,context})=>{
 test.setTimeout(120_000);
 if(process.env.FH_E2E_REAL_FINANCE!=='yes')test.skip();
 const created=await context.request.post('/__e2e__/personal-session');
 expect(created.status()).toBe(200);
 const owner=(await created.json()).user;
 await page.goto('/?auth=success');
 await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 const guest=await context.newPage();await visitGuest(guest);
 await addEntry(guest,'Synthetic guest first import',{amount:'45.67'});
 const guestBefore=await scopedState(guest,'guest-state-v2');
 const accountBefore=await scopedState(page,'account-state-v2:'+owner.id);
 await view(guest,'settings');await guest.locator('[data-action="backup"]').click();
 await guest.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 const downloading=guest.waitForEvent('download');
 await guest.locator('#password-form button[type="submit"]').click();
 const backup=await downloading;
 await view(page,'settings');await page.locator('[data-action="cloud-import-guest"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await backup.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Гостевая копия');
 await page.locator('#cloud-import-guest-consent').check();
 await page.locator('#cloud-import-final-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Перенесено 1 записей');
 const after=await snapshot(context.request);
 expect(after.body.entities.filter(row=>row.kind==='obligation')).toHaveLength(1);
 expect(after.body.entities.filter(row=>row.kind==='account')).toHaveLength(0);
 expect(await scopedState(guest,'guest-state-v2')).toEqual(guestBefore);
 expect(await scopedState(page,'account-state-v2:'+owner.id)).toEqual(accountBefore);
 await guest.close();
});

test('#69 previous guest record is linked and not duplicated in a later merge',async({page,context})=>{
 test.setTimeout(120_000);
 if(process.env.FH_E2E_REAL_FINANCE!=='yes')test.skip();
 const created=await context.request.post('/__e2e__/personal-session');expect(created.status()).toBe(200);
 await page.goto('/?auth=success');await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 const guest=await context.newPage();await visitGuest(guest);
 await addEntry(guest,'Synthetic previously imported guest',{amount:'12.34'});
 const initial=await scopedState(guest,'guest-state-v2');
 expect((await context.request.post('/api/auth/email/finance/session',{headers:{Origin:origin},data:{}})).status()).toBe(200);
 let before=await snapshot(context.request);
 const raw=canonical(initial),manifest={schema_version:1,source_scope:'guest:local-guest-v1',
  source_revision:initial.revision,source_sha256:createHash('sha256').update(raw).digest('hex'),
  expected_server_revision:before.body.revision,external_encrypted_backup_checked:true,
  explicit_owner_consent:true,explicit_guest_transfer:true,
  rows:['entries','loans','settlements','loanPayments'].flatMap(kind=>initial[kind].map(row=>({record_type:kind,source_record_id:row.id})))};
 const headers={Origin:origin,'If-Match':before.etag};
 expect((await context.request.post('/api/finance/v1/import/manifest',{headers,data:{manifest}})).status()).toBe(202);
 expect((await context.request.post('/api/finance/v1/import/commit',{headers,data:{manifest,source_canonical_json:raw}})).status()).toBe(201);
 before=await snapshot(context.request);
 const old=before.body.entities.find(row=>row.kind==='obligation');
 await addEntry(guest,'Synthetic new guest obligation',{amount:'56.78'});
 const original=await scopedState(guest,'guest-state-v2');
 await view(guest,'settings');await guest.locator('[data-action="backup"]').click();
 await guest.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 const downloading=guest.waitForEvent('download');await guest.locator('#password-form button[type="submit"]').click();
 const backup=await downloading;
 await view(page,'settings');await page.locator('[data-action="cloud-import-guest"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await backup.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-guest-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await page.locator('#cloud-import-comparison summary').first().click();
 await page.locator(`#cloud-import-comparison select[data-source-id="${original.entries[0].id}"]`).selectOption('link:'+old.id);
 await page.locator(`#cloud-import-comparison select[data-source-id="${original.entries[1].id}"]`).selectOption('add');
 await page.locator('[data-action="prepare-cloud-merge"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Добавить: 1, связать с сервером: 1');
 await page.locator('#cloud-import-guest-consent').check();await page.locator('#cloud-import-final-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Добавлено 1, сопоставлено 1');
 const after=await snapshot(context.request);
 expect(after.body.entities).toHaveLength(before.body.entities.length+1);
 expect(after.body.entities.find(row=>row.id===old.id)).toEqual(old);
 expect(await scopedState(guest,'guest-state-v2')).toEqual(original);
 await guest.close();
});
