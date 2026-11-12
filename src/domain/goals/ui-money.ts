import { MAX_GOAL_CENTS } from './engine.ts';

/** Exact RUB text parser for a UI boundary; bank accounting stays integer kopecks. */
export function parseGoalRubles(input: string, requirePositive = true): number {
  if (typeof input !== 'string') throw new TypeError('Сумма должна быть строкой');
  const value = input.trim();
  if (!/^(?:0|[1-9]\d{0,11}|[1-9]\d{0,2}(?:[ \u00a0]\d{3})+)(?:[,.]\d{1,2})?$/.test(value)) {
    throw new RangeError('Введите сумму в рублях, не более двух знаков после запятой');
  }
  const [major, minor = ''] = value.replace(/[ \u00a0]/g, '').replace(',', '.').split('.');
  if (major === undefined) throw new RangeError('Введите сумму в рублях');
  const cents = BigInt(major) * 100n + BigInt(minor.padEnd(2, '0'));
  if ((requirePositive && cents === 0n) || cents > BigInt(MAX_GOAL_CENTS)) {
    throw new RangeError('Сумма вне допустимого диапазона');
  }
  return Number(cents);
}
