/** Strict Gregorian calendar. UTC is used only as date arithmetic, never as wall-clock time. */
const DAY_MS = 86_400_000;

export function dayNumber(iso: string): number {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new RangeError(`Invalid ISO calendar date: ${String(iso)}`);
  }
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`Invalid ISO calendar date: ${iso}`);
  }
  const d = new Date(0);
  // setUTCFullYear avoids Date.UTC's special interpretation of years 00..99.
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new RangeError(`Invalid ISO calendar date: ${iso}`);
  }
  return d.getTime() / DAY_MS;
}

export function isoDay(day: number): string {
  if (!Number.isSafeInteger(day)) throw new RangeError('Invalid day number');
  const value = new Date(day * DAY_MS).toISOString().slice(0, 10);
  if (!/^\d{4}-/.test(value)) throw new RangeError('Date outside supported year range');
  return value;
}

export function addMonthsAnchored(iso: string, months: number, dayAnchor?: number): string {
  dayNumber(iso);
  if (!Number.isSafeInteger(months)) throw new RangeError('Month offset must be integer');
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const anchor = dayAnchor ?? Number(iso.slice(8, 10));
  if (!Number.isSafeInteger(anchor) || anchor < 1 || anchor > 31) {
    throw new RangeError('Day anchor must be 1..31');
  }
  const index = (year - 1) * 12 + month - 1 + months;
  if (index < 0 || index >= 9999 * 12) throw new RangeError('Month offset out of range');
  const targetYear = Math.floor(index / 12) + 1;
  const targetMonth = index % 12 + 1;
  const last = new Date(0);
  last.setUTCFullYear(targetYear, targetMonth, 0);
  last.setUTCHours(0, 0, 0, 0);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(anchor, last.getUTCDate())).padStart(2, '0')}`;
}
