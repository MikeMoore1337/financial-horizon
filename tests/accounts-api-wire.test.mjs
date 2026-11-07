import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeTransfer, encodeReversal } from '../src/domain/accounts/api-wire.ts';

const spec = JSON.parse(readFileSync(new URL('../docs/architecture/finance-sync-v1.openapi.json', import.meta.url), 'utf8'));
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const etag = '"fh.1.7.0ce5"';
function transfer(overrides = {}) {
  return {
    ifMatch: etag,
    clientMutationId: id(11),
    baseRevision: 7,
    expectedEntityRevisions: { [id(1)]: 3, [id(2)]: 4 },
    fromAccountId: id(1),
    toAccountId: id(2),
    amountMinor: 100_000,
    occurredOn: '2026-11-07',
    ...overrides,
  };
}
function reversal(overrides = {}) {
  return {
    ifMatch: etag,
    clientMutationId: id(12),
    baseRevision: 7,
    expectedEntityRevisions: { [id(13)]: 2 },
    transactionId: id(13),
    reason: 'Возврат',
    ...overrides,
  };
}
function matchesPublishedSchema(result, name) {
  const payloadSpec = spec.components.schemas[name];
  assert.deepEqual(Object.keys(result.body.payload).sort(), Object.keys(payloadSpec.properties).sort());
  for (const key of payloadSpec.required) assert.ok(Object.hasOwn(result.body.payload, key));
  const commandSpec = spec.components.schemas.Command;
  assert.deepEqual(Object.keys(result.body).sort(), Object.keys(commandSpec.properties).sort());
  assert.ok(commandSpec.properties.action.enum.includes(result.body.action));
  const conditional = commandSpec.allOf.find(c => c.if.properties.action.const === result.body.action);
  assert.equal(conditional.then.properties.payload.$ref, '#/components/schemas/' + name);
  assert.equal(result.headers['Idempotency-Key'], result.body.client_mutation_id);
  assert.match(result.headers['If-Match'], new RegExp(spec.paths['/api/finance/v1/commands'].post.parameters[0].schema.pattern));
  assert.equal(result.body.schema_version, 1);
  assert.ok(!('profile_id' in result.body));
  assert.ok(!('owner_user_id' in result.body));
  assert.ok(!('actor_user_id' in result.body));
}

test('transfer encoder matches exact published v1 OpenAPI command including headers', () => {
  const encoded = encodeTransfer(transfer());
  matchesPublishedSchema(encoded, 'AccountTransferPayload');
  assert.deepEqual(encoded.body.payload, {
    from_account_id: id(1), to_account_id: id(2),
    amount_minor: 100_000, occurred_on: '2026-11-07',
  });
  assert.deepEqual(encoded.body.expected_entity_revisions, { [id(1)]: 3, [id(2)]: 4 });
  assert.ok(Object.isFrozen(encoded.body));
  assert.ok(Object.isFrozen(encoded.body.payload));
  assert.ok(Object.isFrozen(encoded.body.expected_entity_revisions));
});

test('reversal encoder matches exact published v1 OpenAPI command, without client timestamp/id', () => {
  const encoded = encodeReversal(reversal());
  matchesPublishedSchema(encoded, 'TransactionReversePayload');
  assert.deepEqual(encoded.body.payload, { transaction_id: id(13), reason: 'Возврат' });
  assert.equal(encoded.body.expected_entity_revisions[id(13)], 2);
});

test('transfer rejects invalid amount, same-account transfer and impossible calendar dates', () => {
  for (const amountMinor of [0, -1, 1.11, 1_000_000_000_001, Number.MAX_SAFE_INTEGER, NaN, '100']) {
    assert.throws(() => encodeTransfer(transfer({ amountMinor })));
  }
  assert.throws(() => encodeTransfer(transfer({ toAccountId: id(1) })), /тот же счёт/);
  for (const occurredOn of ['2026-02-30', '2026-13-01', '2026-2-1', '']) {
    assert.throws(() => encodeTransfer(transfer({ occurredOn })), /дат/);
  }
});

test('encoder rejects weak/injected ETags, missing deps and invalid command revisions', () => {
  for (const ifMatch of ['W/"abc"', '*', 'abc', '"abc\r\nContent-Type: evil"', '"'] ) {
    assert.throws(() => encodeTransfer(transfer({ ifMatch })), /If-Match/);
  }
  assert.throws(() => encodeTransfer(transfer({ baseRevision: -1 })), /ревизия/);
  assert.throws(() => encodeTransfer(transfer({ baseRevision: 0.1 })), /ревизия/);
  assert.throws(() => encodeTransfer(transfer({ expectedEntityRevisions: { [id(1)]: 2 } })), /зависимой/);
  assert.throws(() => encodeTransfer(transfer({ expectedEntityRevisions: { [id(1)]: 2, [id(2)]: 0 } })), /ревизия сущности/);
  assert.throws(() => encodeTransfer(transfer({ clientMutationId: 'not-uuid' })), /UUID/);
  assert.throws(() => encodeReversal(reversal({ expectedEntityRevisions: {} })), /зависимой/);
  assert.throws(() => encodeReversal(reversal({ reason: ' ' })), /причину/);
});

test('same immutable envelope yields identical bytes for network retry without mutation', () => {
  const first = encodeTransfer(transfer());
  const body = JSON.stringify(first.body);
  assert.equal(JSON.stringify(first.body), body);
  assert.equal(first.body.client_mutation_id, first.headers['Idempotency-Key']);
  const second = encodeTransfer(transfer());
  assert.deepEqual(second, first);
});
