import test from 'node:test';
import assert from 'node:assert/strict';
import {
 emptyState,validateState,getMonthEvents,upsertPaymentMethod,deletePaymentMethod,
 choosePrimaryPaymentMethod,safePaymentUrl,validQrData,MAX_PAYMENT_METHODS,
} from '../finance.js';
import {migrateState} from '../state-migrations.js';
import {encryptBackup,decryptBackup} from '../backup.js';

function fixture(){
 const state=emptyState();
 state.entries.push({id:'expense-1',kind:'expense',recurrence:'monthly',title:'Интернет',
  amountCents:190000,date:'2026-11-15',category:'Связь'});
 state.settlements.push({id:'settle-1',entryId:'expense-1',occurrence:'2026-11',
  amountCents:50000,date:'2026-11-15',createdAt:'2026-11-15T12:00:00Z'});
 return state;
}
const method=(type,value)=>({type,label:type,value,primary:false});
const qrData='data:image/png;base64,'+
 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';

test('five supported types and primary CRUD never alter recorded amounts',()=>{
 const state=fixture(),before=structuredClone(state);
 let counter=0;const opts={idFactory:()=>String(++counter)};
 const ids=[
  upsertPaymentMethod(state,'expense-1',method('payment_url','https://billing.example/pay'),opts),
  upsertPaymentMethod(state,'expense-1',{type:'qr_image',label:'QR',imageData:qrData,primary:false},opts),
  upsertPaymentMethod(state,'expense-1',method('sbp_link','https://qr.nspk.ru/example'),opts),
  upsertPaymentMethod(state,'expense-1',method('requisites','Получатель: ООО Пример'),opts),
  upsertPaymentMethod(state,'expense-1',method('instructions','Оплатить в личном кабинете'),opts),
 ];
 assert.equal(state.entries[0].paymentMethodsVersion,1);
 assert.equal(state.entries[0].paymentMethods.length,5);
 choosePrimaryPaymentMethod(state,'expense-1',ids[3]);
 assert.equal(state.entries[0].paymentMethods.find(x=>x.primary).id,ids[3]);
 upsertPaymentMethod(state,'expense-1',{id:ids[4],...method('instructions','Новая инструкция'),primary:true},opts);
 assert.equal(state.entries[0].paymentMethods.find(x=>x.primary).id,ids[4]);
 deletePaymentMethod(state,'expense-1',ids[4]);
 assert.equal(state.entries[0].paymentMethods.find(x=>x.primary).id,ids[0]);
 for(const id of ids.slice(0,4))deletePaymentMethod(state,'expense-1',id);
 assert.equal(state.entries[0].paymentMethods.length,0);
 assert.deepEqual(state.settlements,before.settlements);
 assert.deepEqual(getMonthEvents(state,'2026-11'),getMonthEvents(before,'2026-11'));
 assert.doesNotThrow(()=>validateState(state));
});
test('method count, record ownership and link scheme guardrails',()=>{
 const state=fixture();
 assert.throws(()=>upsertPaymentMethod(state,'missing',method('payment_url','https://ok.example')));
 state.entries[0].kind='income';
 assert.throws(()=>upsertPaymentMethod(state,'expense-1',method('payment_url','https://ok.example')));
 state.entries[0].kind='expense';state.entries[0].recurrence='once';
 assert.throws(()=>upsertPaymentMethod(state,'expense-1',method('payment_url','https://ok.example')));
 state.entries[0].recurrence='monthly';
 for(const url of ['http://billing.example','data:text/plain,hi','https://user@billing.example',
  'https://localhost/pay','https://127.0.0.1/pay'])
  assert.throws(()=>safePaymentUrl(url));
 assert.equal(safePaymentUrl('https://billing.example/pay').hostname,'billing.example');
 for(let i=0;i<MAX_PAYMENT_METHODS;i++)
  upsertPaymentMethod(state,'expense-1',method('payment_url','https://ok.example/'+i),
   {idFactory:()=>String(i)});
 assert.throws(()=>upsertPaymentMethod(state,'expense-1',method('instructions','Седьмой')));
});
test('QR signature validation and damaged-image recoverability',()=>{
 assert.equal(validQrData(qrData),true);
 assert.equal(validQrData('data:image/jpeg;base64,'+qrData.split(',')[1]),false);
 assert.equal(validQrData('data:image/png;base64,invalid'),false);
 const state=fixture();
 assert.throws(()=>upsertPaymentMethod(state,'expense-1',{type:'qr_image',label:'QR',primary:true,
  imageData:'data:image/png;base64,invalid'}));
 upsertPaymentMethod(state,'expense-1',{type:'qr_image',label:'QR',primary:true,imageData:qrData},
  {idFactory:()=> 'qr-id'});
 state.entries[0].paymentMethods[0].imageData='data:image/png;base64,invalid';
 assert.doesNotThrow(()=>validateState(state));
 deletePaymentMethod(state,'expense-1','qr-id');
});
test('optional payment metadata migration, legacy input and encrypted recovery',async()=>{
 const old=fixture();old.version=1;delete old.revision;
 const before=structuredClone(old);
 const upgraded=migrateState(old);
 assert.equal(upgraded.version,2);assert.deepEqual(old,before);
 assert.equal(upgraded.entries[0].paymentMethods,undefined);
 const state=fixture();
 upsertPaymentMethod(state,'expense-1',method('requisites','Реквизиты для оплаты'),
  {idFactory:()=> 'method-1'});
 const legacy=structuredClone(state);delete legacy.entries[0].paymentMethodsVersion;
 assert.equal(migrateState(legacy).entries[0].paymentMethodsVersion,1);
 assert.equal(legacy.entries[0].paymentMethodsVersion,undefined);
 const copy=await encryptBackup(state,'Synthetic-backup-passphrase');
 const restored=await decryptBackup(copy,'Synthetic-backup-passphrase');
 assert.deepEqual(restored,state);
 assert.deepEqual(restored.settlements,state.settlements);
 assert.deepEqual(getMonthEvents(restored,'2026-11'),getMonthEvents(state,'2026-11'));
});
