/** UTC-only calendar helpers. Month anchor is never chained from a clamped February day. */
export const MAX_MONTHS = 1_200;

export function assertGoalDate(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('Date must use YYYY-MM-DD');
  }
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError('Date is outside the supported calendar range');
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
}

export function monthDue(startDate: string, offset: number): string {
  assertGoalDate(startDate);
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > MAX_MONTHS) {
    throw new RangeError('Month offset exceeds allowed range');
  }
  const startYear = Number(startDate.slice(0, 4));
  const startMonth = Number(startDate.slice(5, 7));
  const anchor = Number(startDate.slice(8, 10));
  const index = startYear * 12 + startMonth - 1 + offset;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  if (year > 2200) throw new RangeError('Date exceeds year 2200');
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(anchor, maxDay)).padStart(2, '0')}`;
}

/** Dates of every regular monthly installment through the inclusive deadline. */
export function goalDueDates(startDate: string, targetDate: string): string[] {
  assertGoalDate(startDate);
  assertGoalDate(targetDate);
  if (targetDate < startDate) throw new RangeError('Deadline precedes goal start');
  const dates: string[] = [];
  for (let i = 1; i <= MAX_MONTHS; i += 1) {
    // There can be no further in-range installments after December 2200.
    if (Number(startDate.slice(0, 4)) * 12 + Number(startDate.slice(5, 7)) - 1 + i > 2200 * 12 + 11) {
      return dates;
    }
    const due = monthDue(startDate, i);
    if (due > targetDate) return dates;
    dates.push(due);
  }
  // Never silently truncate a goal's schedule.
  if (targetDate > monthDue(startDate, MAX_MONTHS)) {
    throw new RangeError('Goal schedule exceeds 1200 months');
  }
  return dates;
}
