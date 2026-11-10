import { sha256 } from './normalize.ts';
import type {
  AccountBalanceProjection, AccountBalanceSnapshot, BankImportPreview,
  ExistingBankMovement, ImportBatchPlan, ImportUndoPlan, ReconciledBankRow,
  ReconciliationResult, NormalizedBankOperation,
} from './types.ts';

function matchesFinancialFields(saved: ExistingBankMovement, current: NormalizedBankOperation): boolean {
  return saved.accountId === current.accountId &&
    saved.date === current.date &&
    saved.amountCents === current.amountCents &&
    saved.kind === current.kind &&
    (saved.targetAccountId === undefined ||
      saved.targetAccountId === current.targetAccountId) &&
    (saved.category === undefined || saved.category === current.category) &&
    (saved.currency === undefined || saved.currency === current.currency);
}

function possibleTransfer(m: ExistingBankMovement, n: NormalizedBankOperation): boolean {
  if (m.kind !== 'transfer' || n.kind !== 'transfer') return false;
  if (m.date !== n.date || m.amountCents !== n.amountCents) return false;
  // Same transfer from two different own-account statements may be represented
  // with different notes, bank IDs or opposite account directions.
  return (
    (m.accountId === n.accountId &&
      (m.targetAccountId === undefined || m.targetAccountId === n.targetAccountId)) ||
    (m.accountId === n.targetAccountId &&
      (m.targetAccountId === undefined || m.targetAccountId === n.accountId))
  );
}

/** Exact source keys/external IDs are duplicates; fuzzy matching needs user review.
 * Indexes make reconciliation proportional to the file + relevant matches,
 * rather than scanning the entire ledger once per statement row.
 */
export function reconcileBankStatement(
  preview: BankImportPreview, existing: readonly ExistingBankMovement[],
): ReconciliationResult {
  const bySource = new Map<string, ExistingBankMovement[]>();
  const byBankId = new Map<string, ExistingBankMovement[]>();
  const byFingerprint = new Map<string, ExistingBankMovement[]>();
  const byLegacyContent = new Map<string, ExistingBankMovement[]>();
  const byTransferAccount = new Map<string, ExistingBankMovement[]>();
  const ledgerOrder = new Map<ExistingBankMovement, number>();
  const bucket = <T>(map: Map<string, T[]>, key: string, item: T) => {
    const items = map.get(key);
    if (items) items.push(item);
    else map.set(key, [item]);
  };
  const identity = (...fields: (string | number | null | undefined)[]) =>
    JSON.stringify(fields);
  // Older manually recorded movements may have no bank-import fingerprint.
  // Compare their essential fields conservatively, for manual review only.
  const legacySignature = (m: Pick<ExistingBankMovement,
    'accountId' | 'date' | 'kind' | 'amountCents' | 'targetAccountId' | 'description'>) =>
    identity(m.accountId, m.date, m.kind, m.amountCents, m.targetAccountId ?? null,
      m.description.trim().toLocaleLowerCase('ru-RU'));
  for (const movement of existing) {
    if (movement.voidedAt) continue;
    ledgerOrder.set(movement, ledgerOrder.size);
    if (movement.sourceKey) bucket(bySource, movement.sourceKey, movement);
    if (movement.externalId) {
      bucket(byBankId, identity(movement.accountId, movement.externalId), movement);
    }
    if (movement.fingerprint) bucket(byFingerprint, movement.fingerprint, movement);
    else if (movement.kind !== 'transfer') {
      bucket(byLegacyContent, legacySignature(movement), movement);
    }
    if (movement.kind === 'transfer') {
      bucket(byTransferAccount,
        identity(movement.date, movement.amountCents, movement.accountId), movement);
    }
  }

  const seenBankIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const seenTransfers = new Set<string>();
  const transferIdentity = (op: NormalizedBankOperation) => op.kind === 'transfer'
    ? identity(op.date, op.amountCents,
        ...[op.accountId, op.targetAccountId || ''].sort())
    : null;

  const rows: ReconciledBankRow[] = preview.rows.map(row => {
    const op = row.operation;
    if (!op) return { ...row, status: 'invalid', existingIds: [] };
    const sourceMatches = bySource.get(op.sourceKey) || [];
    if (sourceMatches.length) {
      const differs = sourceMatches.length !== 1 || sourceMatches.some(x =>
        !matchesFinancialFields(x, op) ||
        (x.externalId !== undefined && x.externalId !== null && op.externalId &&
          x.externalId !== op.externalId));
      return {
        ...row, status: differs ? 'invalid' : 'duplicate',
        existingIds: sourceMatches.map(x => x.id),
        warnings: differs ? [...row.warnings, {
          code: 'SOURCE_KEY_CONFLICT', severity: 'error', row: row.rowNumber,
          message: 'Та же строка уже проведена с другим сопоставлением колонок',
        } as const] : row.warnings,
      };
    }
    const bankKey = op.externalId ? identity(op.accountId, op.externalId) : null;
    const bankIdMatches = bankKey ? byBankId.get(bankKey) || [] : [];
    if (bankIdMatches.length) {
      const changed = bankIdMatches.length !== 1 ||
        bankIdMatches.some(x => !matchesFinancialFields(x, op));
      return {
        ...row, status: changed ? 'invalid' : 'duplicate',
        existingIds: bankIdMatches.map(x => x.id),
        warnings: changed ? [...row.warnings, {
          code: 'EXTERNAL_ID_CONFLICT', severity: 'error', row: row.rowNumber,
          message: 'Идентификатор банка уже используется другой операцией',
        } as const] : row.warnings,
      };
    }
    if (bankKey && seenBankIds.has(bankKey)) {
      return {
        ...row, status: 'invalid', existingIds: [],
        warnings: [...row.warnings, {
          code: 'DUPLICATE_EXTERNAL_ID', severity: 'error', row: row.rowNumber,
          message: 'Одинаковый идентификатор банка в пределах выписки',
        }],
      };
    }

    const candidates = new Set(byFingerprint.get(op.fingerprint) || []);
    // Missing legacy fingerprints must not cause an unseen duplicate to be
    // classified as ready. Such matches are never promoted to exact duplicates.
    for (const candidate of byLegacyContent.get(legacySignature(op)) || []) {
      candidates.add(candidate);
    }
    if (op.kind === 'transfer') {
      for (const accountId of [op.accountId, op.targetAccountId]) {
        if (!accountId) continue;
        for (const candidate of byTransferAccount.get(
          identity(op.date, op.amountCents, accountId)) || []) {
          if (possibleTransfer(candidate, op)) candidates.add(candidate);
        }
      }
    }
    const suspicious = [...candidates].sort((a, b) =>
      (ledgerOrder.get(a) ?? 0) - (ledgerOrder.get(b) ?? 0));
    const transferKey = transferIdentity(op);
    const repeatInFile = seenFingerprints.has(op.fingerprint) ||
      (transferKey !== null && seenTransfers.has(transferKey));
    if (bankKey) seenBankIds.add(bankKey);
    seenFingerprints.add(op.fingerprint);
    if (transferKey !== null) seenTransfers.add(transferKey);
    if (suspicious.length || repeatInFile) {
      return {
        ...row, status: 'possible-duplicate',
        existingIds: [...new Set(suspicious.map(x => x.id))],
      };
    }
    return { ...row, status: 'ready', existingIds: [] };
  });
  return {
    rows,
    ready: rows.filter(x => x.status === 'ready').length,
    duplicates: rows.filter(x => x.status === 'duplicate').length,
    possibleDuplicates: rows.filter(x => x.status === 'possible-duplicate').length,
    invalid: rows.filter(x => x.status === 'invalid').length,
  };
}

/** Generates a deterministic proposal. Only #33 can atomically commit it. */
export async function draftBankImportBatch(
  reconciliation: ReconciliationResult,
  confirmedSourceKeys: readonly string[],
  explicitlyAcceptedPossibleDuplicates: readonly string[] = [],
): Promise<ImportBatchPlan> {
  if (new Set(confirmedSourceKeys).size !== confirmedSourceKeys.length) {
    throw new Error('Повторяющаяся операция в подтверждении');
  }
  const allow = new Set(explicitlyAcceptedPossibleDuplicates);
  if (allow.size !== explicitlyAcceptedPossibleDuplicates.length) throw new Error('Повторный выбор исключения');
  const presentRows = reconciliation.rows.filter(x => x.operation);
  const index = new Map(presentRows.map(x => [x.operation!.sourceKey, x]));
  if (index.size !== presentRows.length) {
    throw new Error('Повторяющиеся исходные ключи в партии импорта');
  }
  const operations: NormalizedBankOperation[] = [];
  for (const sourceKey of confirmedSourceKeys) {
    const candidate = index.get(sourceKey);
    if (!candidate?.operation || !['ready', 'possible-duplicate'].includes(candidate.status) ||
        candidate.warnings.some(w => w.severity === 'error')) {
      throw new Error('Нельзя проводить неизвестную, ошибочную или уже учтённую операцию');
    }
    if (candidate.status === 'possible-duplicate' && !allow.has(sourceKey)) {
      throw new Error('Неоднозначное совпадение требует явного подтверждения');
    }
    operations.push(Object.freeze({ ...candidate.operation }));
  }
  if (operations.length === 0) throw new Error('Не выбрано ни одной операции');
  for (const key of allow) {
    if (!confirmedSourceKeys.includes(key) || index.get(key)?.status !== 'possible-duplicate') {
      throw new Error('Некорректное исключение из сверки');
    }
  }
  const sorted = [...operations].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  const sourceKeys = Object.freeze(sorted.map(x => x.sourceKey));
  // Length-aware JSON encoding prevents separator injection/collisions when
  // a bank description contains ASCII record/unit separators.
  const confirmation = JSON.stringify(sorted.map(op => [
    op.sourceKey, op.accountId, op.targetAccountId, op.date,
    op.kind, op.amountCents, op.category, op.externalId, op.description,
  ]));
  return Object.freeze({
    batchKey: await sha256('bank-import-v2:' + confirmation),
    sourceKeys, operations: Object.freeze(operations), expectedOperationCount: operations.length,
    journal: Object.freeze(operations.map(op => Object.freeze({
      type: 'planned' as const, sourceKey: op.sourceKey, sourceRow: op.sourceRow,
    }))),
  });
}

/** Fail-closed undo proposal; does not remove or mutate any movement. */
export function draftBankImportUndo(
  batch: ImportBatchPlan, existing: readonly ExistingBankMovement[],
): ImportUndoPlan {
  const owned = existing.filter(x => x.importBatchKey === batch.batchKey && !x.voidedAt);
  if (owned.length !== batch.expectedOperationCount ||
      new Set(owned.map(x => x.id)).size !== owned.length ||
      new Set(owned.map(x => x.sourceKey)).size !== owned.length ||
      batch.sourceKeys.some(key => !owned.some(x => x.sourceKey === key))) {
    throw new Error('Невозможно безопасно отменить частично изменённую партию');
  }
  // A mismatch can indicate manual edits, newly linked payments or a stale
  // snapshot. This only verifies the proposal; #33 must repeat it atomically.
  for (const operation of batch.operations) {
    const record = owned.find(x => x.sourceKey === operation.sourceKey);
    if (!record || record.linkedPaymentId ||
        record.fingerprint !== operation.fingerprint ||
        record.accountId !== operation.accountId ||
        (record.targetAccountId ?? null) !== operation.targetAccountId ||
        record.date !== operation.date || record.kind !== operation.kind ||
        record.amountCents !== operation.amountCents ||
        record.description !== operation.description ||
        (record.category ?? null) !== operation.category ||
        (record.externalId ?? null) !== operation.externalId ||
        (record.currency ?? 'RUB') !== operation.currency) {
      throw new Error('Партия изменена или связана с оплатой; требуется ручная сверка');
    }
  }
  return {
    batchKey: batch.batchKey,
    movementIds: owned.map(x => x.id).sort(),
    expectedOperationCount: owned.length,
  };
}

/** Recalculate all participating accounts, excluding internal transfers from P&L. */
export function projectAccountBalances(
  plan: ImportBatchPlan, snapshots: readonly AccountBalanceSnapshot[],
): AccountBalanceProjection[] {
  const positions = new Map<string, { current: number; delta: number; expected?: number }>();
  for (const account of snapshots) {
    if (positions.has(account.accountId) || !Number.isSafeInteger(account.currentCents)) {
      throw new Error('Неверный снимок финансовых счетов');
    }
    if (account.statementClosingCents !== undefined &&
        !Number.isSafeInteger(account.statementClosingCents)) throw new Error('Неверный остаток выписки');
    positions.set(account.accountId, {
      current: account.currentCents, delta: 0, expected: account.statementClosingCents,
    });
  }
  const add = (accountId: string, amountCents: number) => {
    const position = positions.get(accountId);
    if (!position) throw new Error('Неизвестный счёт при сверке баланса');
    position.delta += amountCents;
    if (!Number.isSafeInteger(position.delta)) throw new Error('Переполнение финансового остатка');
  };
  for (const op of plan.operations) {
    if (!Number.isSafeInteger(op.amountCents) || op.amountCents <= 0 ||
        op.amountCents > 1_000_000_000_000) {
      throw new Error('Некорректная сумма для проведения');
    }
    add(op.accountId, op.kind === 'income' ? op.amountCents : -op.amountCents);
    if (op.kind === 'transfer') {
      if (!op.targetAccountId || op.accountId === op.targetAccountId) throw new Error('Некорректный перевод');
      add(op.targetAccountId, op.amountCents);
    }
  }
  return [...positions].map(([accountId, position]) => {
    const projectedCents = position.current + position.delta;
    if (!Number.isSafeInteger(projectedCents)) throw new Error('Переполнение финансового остатка');
    const discrepancyCents = position.expected === undefined ? null : projectedCents - position.expected;
    if (discrepancyCents !== null && !Number.isSafeInteger(discrepancyCents)) {
      throw new Error('Переполнение суммы расхождения');
    }
    return {
      accountId, currentCents: position.current,
      deltaCents: position.delta, projectedCents, discrepancyCents,
    };
  });
}
