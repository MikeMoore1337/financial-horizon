import type { DayCount, Rounding } from './types.ts';

// Integer millionths of a percent: 100% = 100_000_000 units.
const PERCENT_SCALE = 100_000_000n;
const FACTORS = 360n * 365n * 366n;
export const INTEREST_DENOMINATOR = PERCENT_SCALE * FACTORS;
export const MAX_CENTS = 1_000_000_000_000;

export function assertMoney(value: number, name: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_CENTS) {
    throw new RangeError(`${name} must be an integer number of kopecks within allowed bounds`);
  }
}

export function assertRate(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) {
    throw new RangeError('annualRateMicroPercent must be an integer between 0 and 100%');
  }
}

export function parseDate(date: string): number {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError('Expected a YYYY-MM-DD date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || year < 1900 || year > 2200) {
    throw new RangeError('Date is outside the supported range (1900-2200)');
  }
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }
  return epoch / 86_400_000;
}

export function calendarDays(from: string, to: string): number {
  return parseDate(to) - parseDate(from);
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function yearOf(date: string): number { return Number(date.slice(0, 4)); }

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Uses the original month anchor, never chains from the clamped February date. */
export function monthDueDate(firstDueDate: string, monthsAhead: number, anchorDay: number): string {
  const year = Number(firstDueDate.slice(0, 4));
  const month = Number(firstDueDate.slice(5, 7));
  const index = year * 12 + month - 1 + monthsAhead;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  if (y > 2200) throw new RangeError('Schedule date exceeds supported range');
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(anchorDay, daysInMonth(y, m))).padStart(2, '0')}`;
}

function thirtyE360(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number];
  return 360 * (y2 - y1) + 30 * (m2 - m1) + Math.min(30, d2) - Math.min(30, d1);
}

/** Exact integer numerator of the fraction of a kopeck of accrued interest. */
export function interestNumerator(
  balanceCents: number, annualRateMicroPercent: number,
  from: string, to: string, convention: DayCount,
): bigint {
  const elapsed = calendarDays(from, to);
  if (elapsed < 0) throw new RangeError('Interest period must not run backwards');
  if (elapsed === 0 || balanceCents === 0 || annualRateMicroPercent === 0) return 0n;
  const base = BigInt(balanceCents) * BigInt(annualRateMicroPercent);
  if (convention === 'ACT/360') return base * BigInt(elapsed) * (FACTORS / 360n);
  if (convention === 'ACT/365F') return base * BigInt(elapsed) * (FACTORS / 365n);
  if (convention === '30E/360') return base * BigInt(thirtyE360(from, to)) * (FACTORS / 360n);
  if (convention !== 'ACT/ACT-ISDA') throw new RangeError('Unknown day count convention');
  let cursor = from;
  let result = 0n;
  while (cursor < to) {
    const year = yearOf(cursor);
    const nextYear = `${year + 1}-01-01`;
    const end = nextYear < to ? nextYear : to;
    const denominator = isLeapYear(year) ? 366n : 365n;
    result += base * BigInt(calendarDays(cursor, end)) * (FACTORS / denominator);
    cursor = end;
  }
  return result;
}

export function roundFraction(numerator: bigint, denominator: bigint, mode: Rounding): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (2n * remainder > denominator ||
      (2n * remainder === denominator && (mode === 'HALF_UP' || quotient % 2n !== 0n))) {
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}

export function toSafeMoney(amount: bigint): number {
  if (amount < 0n || amount > BigInt(MAX_CENTS)) {
    throw new RangeError('Calculated amount exceeds supported monetary range');
  }
  return Number(amount);
}
