import type {
  BankImportAuditSummary, ImportBatchPlan, ReconciliationResult,
} from './types.ts';

const MAX_ERROR_ROWS = 200;
const safeCode = (code: string): string =>
  /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN_WARNING';

/**
 * A proposal for a privacy-safe audit entry.
 *
 * Deliberately excludes file names, descriptions, amounts, account IDs,
 * external bank IDs, source hashes, warning messages and imported file bytes.
 * This does not write a log; #33/#67 own atomic persisted audit receipts.
 */
export function summarizeBankImportAudit(
  reconciliation: ReconciliationResult,
  batch?: ImportBatchPlan,
): BankImportAuditSummary {
  const counts = new Map<string, number>();
  const rejected: { rowNumber: number; codes: readonly string[] }[] = [];
  let ready = 0, duplicate = 0, possibleDuplicate = 0, invalid = 0;
  const selected = new Set(batch?.sourceKeys || []);
  if (batch && (batch.sourceKeys.length !== batch.expectedOperationCount ||
      batch.operations.length !== batch.expectedOperationCount ||
      new Set(batch.sourceKeys).size !== batch.sourceKeys.length ||
      batch.operations.some(op => !selected.has(op.sourceKey)))) {
    throw new Error('Некорректная импортная партия для журнала');
  }
  for (const row of reconciliation.rows) {
    if (row.status === 'ready') ready++;
    else if (row.status === 'duplicate') duplicate++;
    else if (row.status === 'possible-duplicate') possibleDuplicate++;
    else if (row.status === 'invalid') invalid++;
    else throw new Error('Неизвестный статус сверки операции');
    const codes = [...new Set(row.warnings.map(warning => safeCode(warning.code)))].sort();
    for (const code of codes) counts.set(code, (counts.get(code) || 0) + 1);
    if (row.status === 'invalid' && rejected.length < MAX_ERROR_ROWS) {
      if (!Number.isInteger(row.rowNumber) || row.rowNumber < 1) {
        throw new Error('Некорректный номер строки импорта');
      }
      rejected.push(Object.freeze({ rowNumber: row.rowNumber, codes: Object.freeze(codes) }));
    }
    if (batch?.sourceKeys.includes(row.operation?.sourceKey || '') && (
      !row.operation || (row.status !== 'ready' && row.status !== 'possible-duplicate'))) {
      throw new Error('Журнал получил неподтверждённую или повторную операцию');
    }
    if (row.operation) selected.delete(row.operation.sourceKey);
  }
  if (selected.size) throw new Error('В партии есть ключи вне проверенной выписки');
  const warningCounts = [...counts].sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => Object.freeze({ code, count }));
  return Object.freeze({
    version: 1 as const,
    reviewedRows: reconciliation.rows.length, ready, duplicate,
    possibleDuplicate, invalid, plannedRows: batch?.expectedOperationCount || 0,
    warningCounts: Object.freeze(warningCounts),
    errorRows: Object.freeze(rejected),
    omittedErrorRows: Math.max(0, invalid - rejected.length),
  });
}
