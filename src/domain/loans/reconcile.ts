import { assertMoney, calendarDays, parseDate } from './math.ts';
import type { BankScheduleRow, LoanRow, ScheduleDifference, ScheduleReconciliation } from './types.ts';

function validateSchedule(rows: readonly BankScheduleRow[], name: string, requireAllocated = false): void {
  if (!Array.isArray(rows) || rows.length > 1500) throw new RangeError(`${name}: expected <=1500 rows`);
  let previous = '';
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new RangeError(`${name}: invalid row`);
    parseDate(row.date);
    if (previous && row.date <= previous) throw new RangeError(`${name}: non-increasing dates`);
    previous = row.date;
    assertMoney(row.amountCents, `${name}.amountCents`);
    for (const field of ['interestCents', 'principalCents', 'balanceCents'] as const) {
      const value = row[field];
      if (value !== null && value !== undefined) assertMoney(value, `${name}.${field}`);
    }
    if (requireAllocated && row.interestCents != null && row.principalCents != null &&
        row.interestCents + row.principalCents !== row.amountCents) {
      throw new RangeError(`${name}: amount does not equal interest + principal`);
    }
  }
}

function closureDate(rows: readonly BankScheduleRow[]): string | null {
  const last = rows[rows.length - 1];
  return last?.balanceCents === 0 && !('unpaidInterestCents' in last && last.unpaidInterestCents !== 0)
    ? last.date : null;
}

/**
 * Align by payment ordinal (not an assumed banking-calendar shift).
 * Missing bank columns remain null, NEVER incorrectly treated as zero.
 */
export function reconcileLoanSchedule(
  calculated: readonly (LoanRow | BankScheduleRow)[],
  imported: readonly BankScheduleRow[],
): ScheduleReconciliation {
  validateSchedule(calculated, 'calculated');
  validateSchedule(imported, 'imported', true);
  const rows: ScheduleDifference[] = [];
  const max = Math.max(calculated.length, imported.length);
  for (let i = 0; i < max; i++) {
    const ours = calculated[i] ?? null;
    const bank = imported[i] ?? null;
    const delta = (field: 'amountCents' | 'interestCents' | 'principalCents' | 'balanceCents') =>
      ours && bank && ours[field] != null && bank[field] != null
        ? ours[field] - bank[field] : null;
    const dateDifferenceDays = ours && bank ? calendarDays(bank.date, ours.date) : null;
    const row = {
      period: i + 1,
      calculated: ours,
      imported: bank,
      dateDifferenceDays,
      amountDeltaCents: delta('amountCents'),
      interestDeltaCents: delta('interestCents'),
      principalDeltaCents: delta('principalCents'),
      balanceDeltaCents: delta('balanceCents'),
    };
    rows.push({ ...row,
      differs: !ours || !bank || dateDifferenceDays !== 0 ||
        [row.amountDeltaCents, row.interestDeltaCents,
          row.principalDeltaCents, row.balanceDeltaCents].some(value => value !== null && value !== 0),
    });
  }
  const calculatedClosureDate = closureDate(calculated);
  const importedClosureDate = closureDate(imported);
  const closureDateDifferenceDays = calculatedClosureDate && importedClosureDate
    ? calendarDays(importedClosureDate, calculatedClosureDate) : null;
  const mismatchedRows = rows.filter(row => row.differs).length;
  return { rows, mismatchedRows, calculatedClosureDate, importedClosureDate,
    closureDateDifferenceDays,
    exactMatch: mismatchedRows === 0 && calculatedClosureDate === importedClosureDate,
  };
}
