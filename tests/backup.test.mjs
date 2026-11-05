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
