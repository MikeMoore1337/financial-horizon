/**
 * Advisory-only parser for free-text XLSX recurrence comments. No storage writes,
 * automatic expense conversion, balance mutations or inferred due dates.
 *
 * The UI must ask the user to confirm a reserve, its amount and next due date.
 */
export type ReservePeriodHint =
  | {
      readonly status: 'suggestion';
      readonly periodMonths: number;
      readonly confirmationRequired: true;
    }
  | {
      readonly status: 'invalid';
      readonly reason: 'out-of-range' | 'ambiguous' | 'oversized' | 'unsupported';
      readonly confirmationRequired: true;
    };

const MAX_NOTE_LENGTH = 2_000;
const MONTHS_MAX = 60;

function extractValues(text: string, re: RegExp, factor: number, result: number[]): void {
  for (const match of text.matchAll(re)) {
    const count = Number(match[1]);
    result.push(count * factor);
  }
}

/**
 * Recognizes unambiguous Russian frequency phrases in imported spreadsheets.
 * Returns null for unrelated notes. Never guesses a payment date or transfers
 * the parsed payment into a new reserve automatically.
 */
export function parseReservePeriodHint(note: unknown): ReservePeriodHint | null {
  if (typeof note !== 'string' || !note.trim()) return null;
  const normalized = note
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length > MAX_NOTE_LENGTH) {
    return { status: 'invalid', reason: 'oversized', confirmationRequired: true };
  }

  // Do not silently ignore an explicitly stated but unsupported frequency.
  // Such spreadsheet rows must be reviewed rather than converted to a monthly bill.
  const frequencyMarker = /(?:^|[^\p{L}\p{N}])(?:раз\s+в|каждые|каждый)\s+/gu;
  const supportedPeriod = /^(?:\d+\s*(?:мес(?:\.|яц(?:ев|а)?)?|год(?:а|ов)?|лет)|полгода|квартал|год|месяц)(?!\p{L})/u;
  // A bare "год оплаты" or "месяц оплаты" is explanatory metadata, not
  // a second duration. Require a numeric count unless there is an explicit
  // alternative connector before a standalone duration word.
  const trailingCountedPeriod = /^\s*\(?\s*(?:(или|либо|и|\/|\+|,)\s*)?(?:[-+]?\d+(?:[.,]\d+)?|один|одна|одно|два|две|три|четыре|пять)\s*(?:мес(?:\.|яц(?:ев|а)?)?|год(?:а|ов)?|лет|квартал(?:а|ов)?|полгода|недел(?:я|и|ь|ю)|дн(?:я|ей|и)|день)(?!\p{L})/u;
  const trailingNamedAlternative = /^\s*\(?\s*(или|либо|и|\/|\+)\s*(?:месяц|год|полгода|квартал)(?!\p{L})/u;
  const invalidContinuation = (rest: string): ReservePeriodHint | null => {
    const tail = trailingCountedPeriod.exec(rest) ?? trailingNamedAlternative.exec(rest);
    if (!tail) return null;
    const alternative = tail[1] === 'или' || tail[1] === 'либо' || tail[1] === '/';
    return {
      status: 'invalid',
      reason: alternative ? 'ambiguous' : 'unsupported',
      confirmationRequired: true,
    };
  };
  for (const marker of normalized.matchAll(frequencyMarker)) {
    const valueStart = (marker.index ?? 0) + marker[0].length;
    const expression = normalized.slice(valueStart);
    const period = supportedPeriod.exec(expression);
    if (!period) {
      return { status: 'invalid', reason: 'unsupported', confirmationRequired: true };
    }
    // Never accept the prefix of a composite or alternative interval:
    // "1 год 6 месяцев" and "3 месяца или 6 месяцев" require confirmation.
    const conflict = invalidContinuation(expression.slice(period[0].length));
    if (conflict) return conflict;
  }

  const values: number[] = [];
  // Match only self-contained expressions; unrelated numbers such as "2026" in
  // a note must not be interpreted as a frequency.
  extractValues(
    normalized,
    /(?:^|[^\p{L}\p{N}])(?:раз\s+в|каждые|каждый)\s+(\d+)\s*мес(?:\.|яц(?:ев|а)?)?(?!\p{L})/gu,
    1,
    values,
  );
  extractValues(
    normalized,
    /(?:^|[^\p{L}\p{N}])(?:раз\s+в|каждые|каждый)\s+(\d+)\s*(?:год(?:а|ов)?|лет)(?!\p{L})/gu,
    12,
    values,
  );

  const aliases: readonly [RegExp, number][] = [
    [/(?:^|[^\p{L}\p{N}])ежегодно(?!\p{L})/gu, 12],
    [/(?:^|[^\p{L}\p{N}])(?:раз\s+в\s+год|каждый\s+год)(?!\p{L})/gu, 12],
    [/(?:^|[^\p{L}\p{N}])(?:раз\s+в\s+полгода|каждые\s+полгода)(?!\p{L})/gu, 6],
    [/(?:^|[^\p{L}\p{N}])(?:раз\s+в\s+квартал|каждый\s+квартал)(?!\p{L})/gu, 3],
    [/(?:^|[^\p{L}\p{N}])(?:ежемесячно|раз\s+в\s+месяц|каждый\s+месяц)(?!\p{L})/gu, 1],
  ];
  for (const [re, months] of aliases) {
    for (const match of normalized.matchAll(re)) {
      // An alias like "ежегодно" has no frequencyMarker; still check what
      // immediately follows it before declaring a single period.
      const afterAlias = normalized.slice((match.index ?? 0) + match[0].length);
      const conflict = invalidContinuation(afterAlias);
      if (conflict) return conflict;
      values.push(months);
    }
  }
  if (values.length === 0) return null;
  if (values.some((months) => !Number.isSafeInteger(months) || months < 1 || months > MONTHS_MAX)) {
    return { status: 'invalid', reason: 'out-of-range', confirmationRequired: true };
  }
  if (new Set(values).size !== 1) {
    return { status: 'invalid', reason: 'ambiguous', confirmationRequired: true };
  }
  return { status: 'suggestion', periodMonths: values[0]!, confirmationRequired: true };
}
