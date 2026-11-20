/**
 * #38 guest-only bank ledger. Stored as one optional part of the existing
 * versioned finance state; storage.updateState provides the IDB transaction,
 * CAS, scope isolation, backup and rollback. No network access.
 *
 * Planned obligations and historic loanPayment facts are NOT bank balances.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MINOR = 1_000_000_000_000;
const MAX_ACCOUNTS = 100;
const MAX_OPERATIONS = 5000;
const MAX_BATCHES = 5000;
const MAX_BATCH_OPERATIONS = 1000;
const fail = (message = 'Повреждён локальный журнал банковских операций') => { throw Error(message); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeDate = value => typeof value === 'string' && DATE.test(value) &&
  Number.isFinite(new Date(value + 'T00:00:00.000Z').getTime()) &&
  new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
const distinct = values => new Set(values).size === values.length;

export function emptyGuestBankLedger() {
  return { version: 1, accounts: [], operations: [], batches: [] };
}

export function readGuestBankLedger(state) {
  const value = state?.bankStatements;
  return validateGuestBankLedger(value === undefined ? emptyGuestBankLedger() : value);
}

/** Validate restored/legacy guest backups BEFORE any local state is accepted. */
export function validateGuestBankLedger(value) {
  if (!plain(value) || value.version !== 1 ||
      !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS ||
      !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS ||
      !Array.isArray(value.batches) || value.batches.length > MAX_BATCHES) fail();
  const ids = new Set(), batches = new Map(), rows = new Set(), external = new Set();
  for (const account of value.accounts) {
    if (!plain(account) || !UUID.test(account.id) || ids.has(account.id) ||
        typeof account.name !== 'string' || !account.name.trim() || account.name.length > 160 ||
        !integer(account.openingMinor, -MAX_MINOR, MAX_MINOR) || account.currency !== 'RUB') fail();
    ids.add(account.id);
  }
  for (const batch of value.batches) {
    if (!plain(batch) || !HASH.test(batch.batchKey) || !HASH.test(batch.fileDigest) ||
        batches.has(batch.batchKey) ||
        !integer(batch.committedStateRevision, 1, Number.MAX_SAFE_INTEGER) ||
        (batch.cancelledStateRevision !== null &&
         (!integer(batch.cancelledStateRevision, batch.committedStateRevision + 1, Number.MAX_SAFE_INTEGER))) ||
        !integer(batch.operationCount, 1, MAX_BATCH_OPERATIONS)) fail();
    batches.set(batch.batchKey, batch);
  }
  const counts = new Map();
  for (const op of value.operations) {
    if (!plain(op) || !HASH.test(op.sourceKey) || rows.has(op.sourceKey) ||
        !HASH.test(op.fingerprint) || !HASH.test(op.batchKey) ||
        !batches.has(op.batchKey) || !ids.has(op.accountId) ||
        !safeDate(op.date) || !integer(op.amountCents, 1, MAX_MINOR) ||
        !['income','expense','transfer'].includes(op.kind) ||
        typeof op.description !== 'string' || op.description.length > 500 ||
        (op.category !== null && (typeof op.category !== 'string' || op.category.length > 160)) ||
        (op.externalId !== null && (typeof op.externalId !== 'string' ||
         op.externalId.length < 1 || op.externalId.length > 150)) ||
        (op.targetAccountId !== null && !ids.has(op.targetAccountId)) ||
        (op.kind === 'transfer') !== (op.targetAccountId !== null) ||
        op.targetAccountId === op.accountId) fail();
    rows.add(op.sourceKey);
    if (op.externalId !== null) {
      const bankId = JSON.stringify([op.accountId,op.externalId]);
      if (external.has(bankId)) fail();
      external.add(bankId);
    }
    counts.set(op.batchKey, (counts.get(op.batchKey) || 0) + 1);
  }
  for (const [id,batch] of batches) if (counts.get(id) !== batch.operationCount) fail();
  // Validate every actual cash position: rejected imported/rollback histories
  // cannot silently create an unsafe Number or an unlimited balance.
  for (const account of value.accounts) guestBankBalance(value, account.id);
  return value;
}

export function guestBankBalance(data, accountId) {
  const account = data.accounts.find(item => item.id === accountId);
  if (!account) fail('Счёт не найден');
  let value = account.openingMinor;
  const batchByKey = new Map(data.batches.map(batch => [batch.batchKey,batch]));
  for (const op of data.operations) {
    if (batchByKey.get(op.batchKey)?.cancelledStateRevision !== null) continue;
    if (op.accountId === accountId)
      value += op.kind === 'income' ? op.amountCents : -op.amountCents;
    if (op.kind === 'transfer' && op.targetAccountId === accountId) value += op.amountCents;
    if (!integer(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))
      fail('Переполнение локального остатка');
  }
  return value;
}

export function guestBankMovements(data) {
  validateGuestBankLedger(data);
  const batchByKey = new Map(data.batches.map(batch => [batch.batchKey,batch]));
  return data.operations.map(op => ({
    id: op.sourceKey, sourceKey: op.sourceKey, fingerprint: op.fingerprint,
    externalId: op.externalId, accountId: op.accountId,
    targetAccountId: op.targetAccountId, date: op.date, amountCents: op.amountCents,
    kind: op.kind, description: op.description, category: op.category, currency:'RUB',
    importBatchKey: op.batchKey,
    voidedAt: batchByKey.get(op.batchKey).cancelledStateRevision === null
      ? null : op.date,
  }));
}

export function addGuestBankAccount(state, account, expectedRevision) {
  if (state.version !== 2 || state.revision !== expectedRevision) fail('Локальная база изменилась');
  const ledger = structuredClone(readGuestBankLedger(state));
  if (!plain(account) || !UUID.test(account.id) ||
      typeof account.name !== 'string' || !account.name.trim() || account.name.length > 160 ||
      !integer(account.openingMinor, -MAX_MINOR, MAX_MINOR) ||
      ledger.accounts.length >= MAX_ACCOUNTS || ledger.accounts.some(x => x.id === account.id))
    fail('Недопустимые параметры нового счёта');
  ledger.accounts.push({id: account.id, name: account.name.trim(),currency:'RUB',
    openingMinor:account.openingMinor});
  state.bankStatements = validateGuestBankLedger(ledger);
  return state.bankStatements;
}

/** Called SYNCHRONOUSLY inside storage.updateState's single IDB transaction. */
export function commitGuestBankBatch(state, plan, fileDigest, expectedRevision) {
  if (state.version !== 2 || state.revision !== expectedRevision) fail('Локальная база изменилась');
  const ledger = structuredClone(readGuestBankLedger(state));
  if (!plan || !HASH.test(plan.batchKey) || !HASH.test(fileDigest) ||
      !Array.isArray(plan.operations) || !Array.isArray(plan.sourceKeys) ||
      plan.operations.length < 1 || plan.operations.length > MAX_BATCH_OPERATIONS ||
      plan.operations.length !== plan.expectedOperationCount ||
      !distinct(plan.sourceKeys) || plan.sourceKeys.length !== plan.operations.length)
    fail('Недопустимая партия импорта');
  const already = ledger.batches.find(x => x.batchKey === plan.batchKey);
  if (already) fail('Эта партия уже учтена. Новых операций: 0');
  if (ledger.operations.length + plan.operations.length > MAX_OPERATIONS ||
      ledger.batches.length >= MAX_BATCHES)
    fail('Локальный банковский журнал достиг лимита. Создайте зашифрованную копию.');
  const keys = new Set(ledger.operations.map(op => op.sourceKey));
  const external = new Set(ledger.operations.filter(op => op.externalId !== null)
    .map(op => JSON.stringify([op.accountId,op.externalId])));
  for (const op of plan.operations) {
    if (!op || !HASH.test(op.sourceKey) || !HASH.test(op.fingerprint) ||
        !plan.sourceKeys.includes(op.sourceKey) ||
        !ledger.accounts.some(x => x.id === op.accountId) ||
        (op.kind === 'transfer' && !ledger.accounts.some(x => x.id === op.targetAccountId)) ||
        keys.has(op.sourceKey) ||
        (op.externalId !== null && external.has(JSON.stringify([op.accountId,op.externalId]))))
      fail('Повторная или неизвестная операция. Выполните новую сверку.');
    // Old planner payment facts do NOT carry a bank-account identity. Never
    // silently treat the same date/amount as a second real cash debit.
    if (op.kind === 'expense' && [
      ...(state.loanPayments || []), ...(state.settlements || []),
    ].some(paid => !paid.voidedAt && paid.date === op.date &&
      paid.amountCents === op.amountCents))
      fail('Банковское списание совпадает с ранее отмеченным платежом. Нужна ручная сверка.');
    keys.add(op.sourceKey);
    if (op.externalId !== null) external.add(JSON.stringify([op.accountId,op.externalId]));
    ledger.operations.push({
      sourceKey: op.sourceKey, fingerprint: op.fingerprint,
      externalId: op.externalId, date: op.date, amountCents: op.amountCents,
      kind: op.kind, description: op.description, accountId: op.accountId,
      targetAccountId: op.targetAccountId, category: op.category, batchKey: plan.batchKey,
    });
  }
  ledger.batches.push({batchKey:plan.batchKey,fileDigest,
    operationCount:plan.operations.length,committedStateRevision:expectedRevision+1,
    cancelledStateRevision:null});
  state.bankStatements = validateGuestBankLedger(ledger);
  return state.bankStatements;
}

/** Append-only cancellation: never deletes original bank facts. */
export function undoGuestBankBatch(state, batchKey, expectedRevision) {
  if (state.version !== 2 || state.revision !== expectedRevision) fail('Локальная база изменилась');
  const ledger = structuredClone(readGuestBankLedger(state));
  if (!HASH.test(batchKey)) fail('Неизвестная партия');
  const batch = ledger.batches.find(x => x.batchKey === batchKey);
  if (!batch || batch.cancelledStateRevision !== null) fail('Партия недоступна для отмены');
  if (expectedRevision !== batch.committedStateRevision)
    fail('Состояние изменилось после импорта. Автоматическая отмена запрещена.');
  batch.cancelledStateRevision = expectedRevision + 1;
  state.bankStatements = validateGuestBankLedger(ledger);
  return state.bankStatements;
}
