import { sha256 } from './normalize.ts';
import type {
  AccountBalanceProjection, AccountBalanceSnapshot, BankImportPreview,
  ExistingBankMovement, ImportBatchPlan, ImportUndoPlan, ReconciledBankRow,
  ReconciliationResult, NormalizedBankOperation,
} from './types.ts';

function sameTransfer(a: NormalizedBankOperation, b: NormalizedBankOperation): boolean {
  if (a.kind !== 'transfer' || b.kind !== 'transfer') return false;
  return a.date === b.date && a.amountCents === b.amountCents &&
    a.accountId === b.targetAccountId && b.accountId === a.targetAccountId;
}
function possibleTransfer(m: ExistingBankMovement, n: NormalizedBankOperation): boolean {
  if (m.kind !== 'transfer' || n.kind !== 'transfer') return false;
  return m.date === n.date && m.amountCents === n.amountCents &&
    m.accountId === n.targetAccountId;
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
    const matches = active.filter(x =>
      x.sourceKey === op.sourceKey ||
      (Boolean(op.externalId) && x.externalId === op.externalId && x.accountId === op.accountId),
    );
    const exact = matches.filter(x =>
      x.sourceKey === op.sourceKey ||
      (x.fingerprint === op.fingerprint && x.kind === op.kind &&
        x.amountCents === op.amountCents && x.date === op.date),
    );
    if (exact.length) return {
      ...row, status: 'duplicate', existingIds: exact.map(x => x.id),
    };
    const suspicious = active.filter(x =>
      x.fingerprint === op.fingerprint || possibleTransfer(x, op),
    );
    const repeatInFile = previous.some(x => x.fingerprint === op.fingerprint || sameTransfer(x, op));
    previous.push(op);
    if (matches.length || suspicious.length || repeatInFile) return {
      ...row, status: 'possible-duplicate',
      existingIds: [...new Set([...matches, ...suspicious].map(x => x.id))],
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
    operations.push(candidate.operation);
  }
  if (operations.length === 0) throw new Error('Не выбрано ни одной операции');
  for (const key of allow) {
    if (!confirmedSourceKeys.includes(key) || index.get(key)?.status !== 'possible-duplicate') {
      throw new Error('Некорректное исключение из сверки');
    }
  }
  const sourceKeys = operations.map(x => x.sourceKey).sort();
  return {
    batchKey: await sha256('bank-import-v1\u001f' + sourceKeys.join('\u001f')),
    sourceKeys, operations, expectedOperationCount: operations.length,
    journal: operations.map(op => ({ type: 'planned', sourceKey: op.sourceKey, sourceRow: op.sourceRow })),
  };
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
