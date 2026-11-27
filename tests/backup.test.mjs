import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleState} from '../finance.js';
import {encryptBackup,decryptBackup} from '../backup.js';
test('encrypted backup roundtrip and wrong password rejection',async()=>{
 const data=createSampleState();
 const pass='my-strong-passphrase-2026';
 const encrypted=await encryptBackup(data,pass);
 const json=JSON.parse(encrypted);
 assert.equal(json.format,'financial-horizon-backup');
 assert.equal(json.kdf,'PBKDF2-SHA256');
 assert.ok(json.ciphertext.length>0);
 assert.ok(!encrypted.includes('Зарплата'),'Plain finance data leaked into encrypted JSON');
 const restored=await decryptBackup(encrypted,pass);
 assert.deepEqual(restored,data);
 await assert.rejects(()=>decryptBackup(encrypted,'wrong-password-long-enough'),/Неверный пароль/);
 await assert.rejects(()=>encryptBackup(data,'short'),/не короче/);
});

test('backup rejects JSON values that would be lost or silently rewritten',async()=>{
 const pass='synthetic backup passphrase 2026';
 for(const value of [undefined,NaN,Infinity,-0,new Date(0),[undefined]]){
  const state=createSampleState();state.futureField={value};
  await assert.rejects(()=>encryptBackup(state,pass),/JSON|данн/);
  assert.ok(Object.hasOwn(state.futureField,'value'));
 }
});

test('backup pins the original snapshot before asynchronous key derivation',async()=>{
 const state=createSampleState(),pass='synthetic backup passphrase 2026';
 const expected=structuredClone(state);
 const pending=encryptBackup(state,pass);
 state.entries[0].title='CHANGED_WHILE_DERIVING';
 state.entries[0].amountCents+=1;
 const restored=await decryptBackup(await pending,pass);
 assert.deepEqual(restored,expected);
});

test('backup refuses output larger than the supported restore format',async()=>{
 const state=createSampleState();
 state.futureField='x'.repeat(6_000_100);
 await assert.rejects(()=>encryptBackup(state,'synthetic backup passphrase 2026'),/слишком большая/);
});
