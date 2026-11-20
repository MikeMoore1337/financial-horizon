import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileSignedBankMovements, validateSignedBankHistoryPage,
  loadOlderSignedBankHistory,
} from '../src/importers/bank-statements/server.ts';
import { reconcileBankStatement } from '../src/importers/bank-statements/reconcile.ts';
import { BankCommitError } from '../src/importers/bank-statements/save.ts';

const account = '11111111-1111-4111-8111-111111111111';
const transaction = '22222222-2222-4222-8222-222222222222';
const reversal = '33333333-3333-4333-8333-333333333333';
const source = 'a'.repeat(64);
const fingerprint = 'b'.repeat(64);
const etag = '"fh-bank-synthetic-strong-etag"';
const date = '2026-11-07';

function sampleRow(status) {
  return {
    transaction_id: transaction,
    source_key: source,
    fingerprint,
    external_id: null,
    kind: 'income',
    account_id: account,
    target_account_id: null,
    occurred_on: date,
    amount_minor: 12000,
    description: 'Синтетический возврат',
    category: null,
    status,
  };
}

function ledger(withReversal) {
  const transactions = [{
    id: transaction, kind: 'income', occurredOn: date,
    note: 'Синтетический возврат', reversedTransactionId: null,
  }];
  if (withReversal) transactions.push({
    id: reversal, kind: 'reversal', occurredOn: '2026-11-08',
    note: 'Отмена синтетики', reversedTransactionId: transaction,
  });
  return {
    ledger: {
      transactions,
      postings: [{ transactionId: transaction, accountId: account, signedMinor: 12000 }],
      paymentLinks: [],
    },
  };
}

test('cancelled server bank rows retain original source keys but are excluded from fuzzy cash matching', () => {
  const rows = [sampleRow('cancelled')];
  const saved = reconcileSignedBankMovements(ledger(true), rows);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sourceKey, source);
  assert.equal(saved[0].voidedAt, date);
  assert.equal(saved[0].externalId, null);

  const clone = { ...saved[0],
    sourceKey: 'c'.repeat(64), fingerprint: 'd'.repeat(64),
  };
  const operation = {
    sourceRow: 2, sourceKey: clone.sourceKey, fingerprint: clone.fingerprint,
    externalId: null, date, amountCents: 12000, kind: 'income',
    description: 'Синтетический возврат',
    accountId: account, targetAccountId: null, currency: 'RUB', category: null,
  };
  const preview = { rows: [{ rowNumber: 2, operation, warnings: [] }] };
  const newFile = reconcileBankStatement(preview, saved);
  assert.equal(newFile.rows[0].status, 'ready');
  assert.deepEqual(newFile.rows[0].existingIds, []);
  const oldFile = reconcileBankStatement({
    rows: [{ ...preview.rows[0], operation: {
      ...operation, sourceKey: source, fingerprint,
    } }],
  }, saved);
  assert.equal(oldFile.rows[0].status, 'duplicate');
});

test('signed bank snapshot rejects impossible cancellation/ledger mismatch', () => {
  assert.throws(() => reconcileSignedBankMovements(ledger(false),
    [sampleRow('cancelled')]), BankCommitError);
  assert.throws(() => reconcileSignedBankMovements(ledger(true),
    [sampleRow('committed')]), BankCommitError);
  const saved = reconcileSignedBankMovements(ledger(false),[sampleRow('committed')]);
  assert.equal(saved[0].voidedAt, null);
});

function historyBatch(revision) {
  return {
    batch_id: 'batch-'+revision,
    batch_key: revision.toString(16).padStart(64,'0'),
    status: 'committed', operation_count: 1,
    committed_revision: revision, cancelled_revision: null,
    committed_at: '2026-11-07T08:00:00+00:00',
  };
}

test('history above 100 batches is paginated, not treated as a failed financial snapshot', async () => {
  const first100 = Array.from({length:100}, (_,index)=>historyBatch(101-index));
  const first = validateSignedBankHistoryPage({
    schema_version:1,revision:101,batches:first100,
    has_more:true,next_cursor:2,
  },etag,101,etag);
  assert.equal(first.batches.length,100);
  assert.equal(first.historyNextCursor,2);

  const urlSeen = [];
  const fake = async (url, options) => {
    urlSeen.push([url,options.method]);
    return new Response(JSON.stringify({
      schema_version:1,revision:101,batches:[historyBatch(1)],
      has_more:false,next_cursor:null,
    }),{
      status:200,
      headers:{ETag:etag,'Content-Type':'application/json'},
    });
  };
  const older = await loadOlderSignedBankHistory({
    revision:101,etag,historyNextCursor:first.historyNextCursor,
  },fake);
  assert.deepEqual(urlSeen,[[
    '/api/finance/v2/bank-import/batches?limit=100&cursor=2','GET',
  ]]);
  assert.equal(older.batches.length,1);
  assert.equal(older.batches[0].committed_revision,1);
  assert.equal(older.historyNextCursor,null);
});

test('history cursor, sorting and ETag mismatches fail closed', () => {
  const batch=historyBatch(3);
  const page={schema_version:1,revision:4,batches:[batch],
    has_more:false,next_cursor:null};
  assert.throws(() => validateSignedBankHistoryPage(page,'"changed"',4,etag),BankCommitError);
  assert.throws(() => validateSignedBankHistoryPage(
    { ...page,has_more:true,next_cursor:3 },etag,4,etag),BankCommitError);
  assert.throws(() => validateSignedBankHistoryPage(
    { ...page,batches:[batch,batch] },etag,4,etag),BankCommitError);
  assert.throws(() => validateSignedBankHistoryPage(page,etag,4,etag,3),BankCommitError);
});
