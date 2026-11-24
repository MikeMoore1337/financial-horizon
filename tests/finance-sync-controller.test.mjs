import test from 'node:test';
import assert from 'node:assert/strict';
import {FinanceSyncController} from '../src/cloud/finance-sync-controller.mjs';

const actor = 'a'.repeat(32);
const origin = 'https://synthetic-finance.invalid';
const json = value => new Response(JSON.stringify(value), {status:200,
  headers:{'Content-Type':'application/json'}});

test('controller refuses a server without the profile fence before opening IndexedDB', async () => {
  let calls = 0;
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = {open() {throw Error('IndexedDB must not be opened');}};
  const controller = new FinanceSyncController({verifiedActorUserId:actor, origin,
    fetchImpl:async () => ++calls === 1 ? json({authenticated:true,user:{id:actor}})
      : json({ok:true, profile_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payment_guard_v1:true})});
  try {
    await assert.rejects(() => controller.createLocal('synthetic passphrase for testing', true), /безопасную синхронизацию/);
    assert.equal(calls, 2);
  } finally {controller.close(); globalThis.indexedDB = previous;}
});

test('controller revokes its UI when the live authenticated actor differs', async () => {
  let closed = 0, calls = 0;
  const controller = new FinanceSyncController({verifiedActorUserId:actor, origin,
    onClose:() => {closed++;}, fetchImpl:async () => {
      calls++; return json({authenticated:true,user:{id:'b'.repeat(32)}});
    }});
  await assert.rejects(() => controller.createLocal('synthetic passphrase for testing', true), /аккаунт/);
  assert.equal(calls, 1);
  assert.equal(closed, 1);
  await assert.rejects(() => controller.read(), /отозван/);
});

test('logout during session verification cannot create a keyset', async () => {
  let release;
  const response = new Promise(resolve => {release = resolve;});
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = {open() {throw Error('IndexedDB must not be opened');}};
  const controller = new FinanceSyncController({verifiedActorUserId:actor, origin,
    fetchImpl:async () => response});
  try {
    const pending = controller.createLocal('synthetic passphrase for testing', true);
    controller.close();
    release(json({authenticated:true,user:{id:actor}}));
    await assert.rejects(() => pending, /отозван/);
  } finally {controller.close(); globalThis.indexedDB = previous;}
});
