import { sha256 } from './normalize.ts';
import type {
  AccountBalanceProjection, AccountBalanceSnapshot, BankImportPreview,
  ExistingBankMovement, ImportBatchPlan, ImportUndoPlan, ReconciledBankRow,
  ReconciliationResult, NormalizedBankOperation,
} from './types.ts';

function sameTransfer(a: NormalizedBankOperation, b: NormalizedBankOperation): boolean {
  if (a.kind !== 'transfer' || b.kind !== 'transfer') return false;
  return a.date === b.date && a.amountCents === b.amountCents && (
    (a.accountId === b.accountId && a.targetAccountId === b.targetAccountId) ||
    (a.accountId === b.targetAccountId && b.accountId === a.targetAccountId)
  );
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

/** Exact source keys/external IDs are duplicates; fuzzy matching needs user review. */
export function reconcileBankStatement(
  preview: BankImportPreview, existing: readonly ExistingBankMovement[],
): ReconciliationResult {
  const active = existing.filter(x => !x.voidedAt);
  const previous: NormalizedBankOperation[] = [];
  const rows: ReconciledBankRow[] = preview.rows.map(row => {
    const op = row.operation;
    if (!op) return { ...row, status: 'invalid', existingIds: [] };
    const sourceMatches = active.filter(x => x.sourceKey === op.sourceKey);
    if (sourceMatches.length) {
      const differs = sourceMatches.some(x => x.fingerprint &&
        x.fingerprint !== op.fingerprint);
      return {
        ...row, status: differs ? 'invalid' : 'duplicate',
        existingIds: sourceMatches.map(x => x.id),
        warnings: differs ? [...row.warnings, {
          code: 'SOURCE_KEY_CONFLICT', severity: 'error', row: row.rowNumber,
          message: 'Та же строка уже проведена с другим сопоставлением колонок',
        } as const] : row.warnings,
      };
    }
    const bankIdMatches = op.externalId ? active.filter(x =>
      x.externalId === op.externalId && x.accountId === op.accountId) : [];
    if (bankIdMatches.length) {
      const changed = bankIdMatches.some(x => x.fingerprint && x.fingerprint !== op.fingerprint);
      return {
        ...row, status: changed ? 'invalid' : 'duplicate',
        existingIds: bankIdMatches.map(x => x.id),
        warnings: changed ? [...row.warnings, {
          code: 'EXTERNAL_ID_CONFLICT', severity: 'error', row: row.rowNumber,
          message: 'Идентификатор банка уже используется другой операцией',
        } as const] : row.warnings,
      };
    }
    if (op.externalId && previous.some(x => x.externalId === op.externalId &&
      x.accountId === op.accountId)) {
      return {
        ...row, status: 'invalid', existingIds: [],
        warnings: [...row.warnings, {
          code: 'DUPLICATE_EXTERNAL_ID', severity: 'error', row: row.rowNumber,
          message: 'Одинаковый идентификатор банка в пределах выписки',
        }],
      };
    }
    const suspicious = active.filter(x =>
      x.fingerprint === op.fingerprint || possibleTransfer(x, op),
    );
    const repeatInFile = previous.some(x => x.fingerprint === op.fingerprint || sameTransfer(x, op));
    previous.push(op);
    if (suspicious.length || repeatInFile) return {
      ...row, status: 'possible-duplicate',
      existingIds: [...new Set(suspicious.map(x => x.id))],
    };
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
  const index = new Map(reconciliation.rows.filter(x => x.operation).map(x => [x.operation!.sourceKey, x]));
  const operations: NormalizedBankOperation[] = [];
  for (const sourceKey of confirmedSourceKeys) {
    const candidate = index.get(sourceKey);
    if (!candidate?.operation || candidate.status === 'duplicate' || candidate.status === 'invalid') {
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
  const confirmation = sorted.map(op => [
    op.sourceKey, op.accountId, op.targetAccountId || '', op.date,
    op.kind, op.amountCents, op.category || '', op.externalId || '', op.description,
  ].join('\u001f')).join('\u001e');
  return Object.freeze({
    batchKey: await sha256('bank-import-v1\u001e' + confirmation),
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
    if (!Number.isSafeInteger(op.amountCents) || op.amountCents <= 0) {
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
