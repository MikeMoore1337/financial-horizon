import {createHash,randomUUID} from 'node:crypto';
import {test,expect} from '@playwright/test';
import {visitGuest,view,addEntry,scopedState} from './helpers.mjs';

const origin='http://127.0.0.1:8791';
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):
 Array.isArray(value)?'['+value.map(canonical).join(',')+']':
 '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
async function snapshot(request){
 const res=await request.get('/api/finance/v1/state?limit_entities=5000');
 expect(res.status()).toBe(200);
 return {body:await res.json(),etag:res.headers().etag};
}
async function post(request,path,data,etag){
 return request.post(path,{headers:{Origin:origin,'If-Match':etag},data});
}

test('#69 real browser and PostgreSQL: review precedes a deduplicated merge',async({page,context},testInfo)=>{
 test.setTimeout(120_000);
 if(process.env.FH_E2E_REAL_FINANCE!=='yes')test.skip();
 await visitGuest(page);
 const created=await context.request.post('/__e2e__/personal-session');
 expect(created.status()).toBe(200);
 const owner=(await created.json()).user;
 await page.goto('/?auth=success');
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 await addEntry(page,'Synthetic existing obligation',{amount:'43.27'});
 const original=await scopedState(page,'account-state-v2:'+owner.id);
 const bootstrap=await context.request.post('/api/auth/email/finance/session',{headers:{Origin:origin},data:{}});
 expect(bootstrap.status()).toBe(200);
 let before=await snapshot(context.request);
 const raw=canonical(original),sha=createHash('sha256').update(raw).digest('hex');
 const manifest={schema_version:1,source_scope:'account:'+owner.id,source_revision:original.revision,
  source_sha256:sha,expected_server_revision:before.body.revision,external_encrypted_backup_checked:true,
  explicit_owner_consent:true,explicit_guest_transfer:false,
  rows:['entries','loans','settlements','loanPayments'].flatMap(kind=>original[kind].map(row=>({
   record_type:kind,source_record_id:row.id,
  })))};
 expect((await post(context.request,'/api/finance/v1/import/manifest',{manifest},before.etag)).status()).toBe(202);
 expect((await post(context.request,'/api/finance/v1/import/commit',{manifest,source_canonical_json:raw},before.etag)).status()).toBe(201);
 before=await snapshot(context.request);
 const existing=before.body.entities.find(row=>row.kind==='obligation');
 const accountId=randomUUID(),mutation=randomUUID();
 const account=await context.request.post('/api/finance/v2/commands',{headers:{Origin:origin,
  'If-Match':before.etag,'Idempotency-Key':mutation},data:{schema_version:2,client_mutation_id:mutation,
  base_revision:before.body.revision,action:'account.create',expected_entity_revisions:{},
  payload:{id:accountId,name:'Synthetic kept account',kind:'bank',currency:'RUB',opening_minor:12345}}});
 expect(account.status()).toBe(201);
 await addEntry(page,'Synthetic new obligation',{amount:'89.31'});
 const localBefore=await scopedState(page,'account-state-v2:'+owner.id);
 before=await snapshot(context.request);
 const posts=[];
 page.on('request',req=>{if(req.method()==='POST'&&new URL(req.url()).pathname.startsWith('/api/finance/v1/import/'))posts.push(new URL(req.url()).pathname);});
 await view(page,'settings');
 await page.locator('[data-action="backup"]').click();
 await page.locator('#password-form [name="password"]').fill('Synthetic-passphrase-2026!');
 const downloading=page.waitForEvent('download');
 await page.locator('#password-form button[type="submit"]').click();
 const backup=await downloading;
 await page.locator('[data-action="cloud-import"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await backup.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Проверка профилей');
 await page.locator('#cloud-import-comparison summary').first().click();
 const localIds=localBefore.entries.map(row=>row.id);
 await page.locator(`#cloud-import-comparison select[data-source-id="${localIds[0]}"]`).selectOption('link:'+existing.id);
 await page.locator(`#cloud-import-comparison select[data-source-id="${localIds[1]}"]`).selectOption('add');
 await page.locator('[data-action="prepare-cloud-merge"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Проверьте план переноса');
 await expect(page.locator('#cloud-import-summary')).toContainText('Добавить: 1, связать с сервером: 1');
 await page.screenshot({path:testInfo.outputPath('synthetic-preview.png')});
 expect(posts).toEqual([]);
 expect((await snapshot(context.request)).body.entities).toEqual(before.body.entities);
 await page.locator('#cloud-import-final-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Добавлено 1, сопоставлено 1');
 expect(posts).toEqual(['/api/finance/v1/import/commit','/api/finance/v1/import/restore']);
 const after=await snapshot(context.request);
 expect(after.body.entities).toHaveLength(before.body.entities.length+1);
 expect(after.body.entities.find(row=>row.id===existing.id)).toEqual(existing);
 expect(after.body.entities.find(row=>row.id===accountId).data.balance_minor).toBe(12345);
 expect(await scopedState(page,'account-state-v2:'+owner.id)).toEqual(localBefore);
});

test('#69 local account bank history links a server account and preserves the original',async({page,context})=>{
 test.setTimeout(120_000);
 if(process.env.FH_E2E_REAL_FINANCE!=='yes')test.skip();
 const created=await context.request.post('/__e2e__/personal-session');
 expect(created.status()).toBe(200);
 const owner=(await created.json()).user;
 await page.goto('/?auth=success');
 await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 await addEntry(page,'Synthetic personal source',{amount:'2.00'});
 expect((await context.request.post('/api/auth/email/finance/session',{headers:{Origin:origin},data:{}})).status()).toBe(200);
 const before=await snapshot(context.request),accountId=randomUUID(),mutation=randomUUID();
 const createdAccount=await context.request.post('/api/finance/v2/commands',{headers:{Origin:origin,
  'If-Match':before.etag,'Idempotency-Key':mutation},data:{schema_version:2,client_mutation_id:mutation,
  base_revision:before.body.revision,action:'account.create',expected_entity_revisions:{},
  payload:{id:accountId,name:'Synthetic personal bank',kind:'bank',currency:'RUB',opening_minor:20000}}});
 expect(createdAccount.status()).toBe(201);
 await page.evaluate(async(userId)=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('financial-horizon-browser-v1',1);
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite'),store=tx.objectStore('finance');
   const key='account-state-v2:'+userId,request=store.get(key);
   request.onsuccess=()=>{
    const value=request.result,revision=value.revision+1,id='11111111-1111-4111-8111-111111111111';
    value.revision=revision;
    value.bankStatements={version:1,accounts:[{id,name:'Synthetic personal bank',currency:'RUB',openingMinor:20000}],
     operations:[{sourceKey:'a'.repeat(64),fingerprint:'b'.repeat(64),externalId:'SYN-PERSONAL',date:'2026-11-01',
      amountCents:500,kind:'expense',description:'Synthetic personal operation',accountId:id,targetAccountId:null,
      category:null,batchKey:'c'.repeat(64)}],
     batches:[{batchKey:'c'.repeat(64),fileDigest:'d'.repeat(64),operationCount:1,
      committedStateRevision:revision,cancelledStateRevision:null}]};
    store.put(value,key);
   };
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });db.close();
 },owner.id);
 await page.reload();await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 const localBefore=await scopedState(page,'account-state-v2:'+owner.id);
 await view(page,'settings');await page.locator('[data-action="backup"]').click();
 await page.locator('#password-form [name="password"]').fill('Synthetic-passphrase-2026!');
 const downloading=page.waitForEvent('download');await page.locator('#password-form button[type="submit"]').click();
 const backup=await downloading;
 await page.locator('[data-action="cloud-import"]').click();
 await page.locator('#cloud-import-file').setInputFiles(await backup.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-passphrase-2026!');
 await page.locator('#password-form button[type="submit"]').click();
 await expect(page.locator('#cloud-import-heading')).toHaveText('Сравнение банковской истории');
 const groups=page.locator('#cloud-import-comparison summary');
 for(let index=0;index<await groups.count();index++)await groups.nth(index).click();
 const planner=page.locator('select[data-merge-kind]');
 for(let index=0;index<await planner.count();index++)await planner.nth(index).selectOption('add');
 await page.locator('select[data-bank-account]').selectOption('link:'+accountId);
 await page.locator('select[data-bank-operation]').selectOption('add');
 await page.locator('[data-action="prepare-cloud-merge"]').click();
 await expect(page.locator('#cloud-import-comparison')).toContainText('итог 195');
 await expect(page.locator('#cloud-import-guest-consent')).not.toBeVisible();
 await page.locator('#cloud-import-final-consent').check();
 await page.locator('[data-action="confirm-cloud-import"]').click();
 await expect(page.locator('#cloud-import-summary')).toContainText('Остатки и банковские операции сверены');
 const after=await snapshot(context.request);
 expect(after.body.entities.filter(x=>x.kind==='account')).toHaveLength(1);
 expect(after.body.entities.find(x=>x.id===accountId).data.balance_minor).toBe(19500);
 expect(after.body.entities.filter(x=>x.kind==='transaction')).toHaveLength(1);
 expect(await scopedState(page,'account-state-v2:'+owner.id)).toEqual(localBefore);
});
