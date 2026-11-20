import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// A synthetic, inert adapter E2E. No import from app.js or storage.js.
const toJS=path=>ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
const urls={
  vault:'/__e2e_fa_vault__.js',
  session:'/__e2e_fa_session__.js',
  atomic:'/__e2e_fa_atomic__.js',
  migrate:'/__e2e_fa_migrate__.js',
  adapter:'/__e2e_fa_adapter__.js',
};
const scripts=new Map([
  [urls.vault,toJS('../../src/security/local-vault.ts')],
  [urls.session,toJS('../../src/security/local-budget-session.ts')
    .replace(/['"]\.\/local-vault\.ts['"]/g,JSON.stringify(urls.vault))],
  [urls.atomic,toJS('../../src/security/protected-atomic-candidate.ts')
    .replace(/['"]\.\/local-vault\.ts['"]/g,JSON.stringify(urls.vault))],
  [urls.migrate,toJS('../../state-migrations.ts')],
  [urls.adapter,toJS('../../src/security/protected-finance-adapter.ts')
    .replace(/['"]\.\.\/\.\.\/state-migrations\.ts['"]/g,JSON.stringify(urls.migrate))
    .replace(/['"]\.\/protected-atomic-candidate\.ts['"]/g,JSON.stringify(urls.atomic))],
]);

test('native IndexedDB protected finance adapter preserves outbox across edits and offline restart',async({page,context})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/__e2e_fa_*.js',route=>route.fulfill({
    status:200,contentType:'text/javascript',
    body:scripts.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  await page.goto('/__e2e__/ready');
  const current=await page.evaluate(async()=>{
    const atomic=await import('/__e2e_fa_atomic__.js');
    const {LocalBudgetSession}=await import('/__e2e_fa_session__.js');
    const adapter=await import('/__e2e_fa_adapter__.js');
    const {createSampleState}=await import('/finance.js');
    const scope='guest:protected-finance-browser';
    const passphrase='protected finance adapter phrase 2026';
    const state=createSampleState();
    state.entries[0].title='SECRET_ADAPTER_ENTRY_TITLE';
    const candidate=await atomic.createAtomicEncryptedCandidate(scope,passphrase,{
      snapshot:state,outbox:[{id:'ORIGINAL_PENDING_OUTBOX',amountCents:111}],conflicts:[],
    },2);
    const session=new LocalBudgetSession();session.selectScope(scope);
    await session.unlock(await atomic.getAtomicEncryptedKeyset(scope),{passphrase});
    const before=await adapter.readProtectedFinance(scope,session);
    const after=await adapter.updateProtectedFinance(scope,session,(draft,outbox)=>{
      draft.entries[0].amountCents+=456;
      outbox.push({id:'NEW_PENDING_OUTBOX',amountCents:456});
    },{expectedRevision:0,expectedEpoch:0});
    let rejected=false;
    try{
      await adapter.updateProtectedFinance(scope,session,()=>{}, {expectedEpoch:0});
    }catch{rejected=true;}
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open(atomic.ATOMIC_ENCRYPTED_DB,1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    const persisted=await new Promise((resolve,reject)=>{
      const tx=db.transaction(['keysets','bundles'],'readonly');
      const k=tx.objectStore('keysets').getAll();
      const b=tx.objectStore('bundles').getAll();
      tx.oncomplete=()=>resolve(JSON.stringify([k.result,b.result]));
      tx.onerror=()=>reject(tx.error);
    });
    db.close();
    session.logout();
    return {
      original:before.outbox.length,epoch:after.epoch,revision:after.state.revision,
      pending:after.outbox.length,rejected,locked:session.state==='unselected',
      noPlaintext:!['SECRET_ADAPTER_ENTRY_TITLE','ORIGINAL_PENDING_OUTBOX',
        'NEW_PENDING_OUTBOX',passphrase,candidate.recoveryKey]
        .some(secret=>persisted.includes(secret)),
    };
  });
  expect(current).toEqual({original:1,epoch:1,revision:1,pending:2,
    rejected:true,locked:true,noPlaintext:true});

  await page.reload();
  await page.evaluate(async()=>{
    globalThis.__faAtomic=await import('/__e2e_fa_atomic__.js');
    globalThis.__faSession=await import('/__e2e_fa_session__.js');
    globalThis.__faAdapter=await import('/__e2e_fa_adapter__.js');
  });
  await context.setOffline(true);
  try{
    const fresh=await page.evaluate(async()=>{
      const scope='guest:protected-finance-browser';
      const session=new globalThis.__faSession.LocalBudgetSession();
      session.selectScope(scope);
      await session.unlock(await globalThis.__faAtomic.getAtomicEncryptedKeyset(scope),
        {passphrase:'protected finance adapter phrase 2026'});
      const state=await globalThis.__faAdapter.readProtectedFinance(scope,session);
      session.logout();
      return {offline:!navigator.onLine,epoch:state.epoch,revision:state.state.revision,
        amount:state.state.entries[0].amountCents,queue:state.outbox.length,
        locked:session.state==='unselected'};
    });
    expect(fresh.offline).toBe(true);
    expect(fresh.epoch).toBe(1);
    expect(fresh.revision).toBe(1);
    expect(fresh.queue).toBe(2);
    expect(fresh.locked).toBe(true);
    expect(Number.isSafeInteger(fresh.amount)).toBe(true);
  }finally{await context.setOffline(false);}
  expect(errors).toEqual([]);
});
