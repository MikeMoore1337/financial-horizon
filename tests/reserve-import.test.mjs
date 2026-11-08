import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReservePeriodHint } from '../src/domain/reserves/import-suggestions.ts';

const suggested = (months) => ({
  status: 'suggestion',
  periodMonths: months,
  confirmationRequired: true,
});
const invalid = (reason) => ({
  status: 'invalid',
  reason,
  confirmationRequired: true,
});

for (const [text, months] of [
  ['Раз в 3 мес', 3],
  ['РАЗ В 12 МЕСЯЦЕВ', 12],
  ['каждые 2 месяца', 2],
  ['каждый 1 месяц', 1],
  ['Раз в 60 мес.', 60],
  ['ежегодно', 12],
  ['раз в год', 12],
  ['каждый год', 12],
  ['раз в 2 года', 24],
  ['каждые 5 лет', 60],
  ['раз в полгода', 6],
  ['каждые полгода', 6],
  ['раз в квартал', 3],
  ['каждый квартал', 3],
  ['ежемесячно', 1],
  ['раз в месяц', 1],
  ['взнос за страховку, раз в 3 мес. До 31 числа', 3],
  ['оплата за 2026 год: каждые 6 месяцев', 6],
  ['Ежегодно (раз в год)', 12],
  ['каждые 3 месяца; раз в 3 мес', 3],
  ['налог раз\nв 12 месяцев', 12],
  [' раз в 6 мес ', 6],
  ['раз в 3 месяца, месяц оплаты — июнь', 3],
  ['ежегодно (год оплаты 2026)', 12],
  ['каждые 2 года (год оплаты 2028)', 24],
  ['раз в 6 мес., месяц платежа - июль', 6],
  ['ежемесячно (месяц оплаты - текущий)', 1],
]) {
  test('XLSX recurrence hint: ' + JSON.stringify(text), () => {
    assert.deepEqual(parseReservePeriodHint(text), suggested(months));
  });
}

test('all 1..60-month periods are accepted and deterministic', () => {
  for (let months = 1; months <= 60; months++) {
    assert.deepEqual(parseReservePeriodHint('Раз в ' + months + ' мес'), suggested(months));
  }
});

for (const [text, reason] of [
  ['Раз в 0 мес', 'out-of-range'],
  ['Раз в 61 месяцев', 'out-of-range'],
  ['раз в 6 лет', 'out-of-range'],
  ['раз в 9999999999999999999999999 мес', 'out-of-range'],
  ['раз в 3 мес; ежегодно', 'ambiguous'],
  ['раз в квартал или раз в полгода', 'ambiguous'],
  ['Ежегодно; каждые 3 месяца', 'ambiguous'],
  ['Счёт за январь: ' + 'x'.repeat(2100), 'oversized'],
  ['раз в 2 недели', 'unsupported'],
  ['Раз в 3 дня', 'unsupported'],
  ['раз в -3 мес', 'unsupported'],
  ['раз в 1,5 месяца', 'unsupported'],
  ['каждые 3 месяца, но раз в 2 недели', 'unsupported'],
  ['ежегодно, но каждый -1 год', 'unsupported'],
  ['раз в 1 год 6 месяцев', 'unsupported'],
  ['раз в 1 год и 6 месяцев', 'unsupported'],
  ['раз в 1 год, 6 месяцев', 'unsupported'],
  ['раз в 2 года 6 мес', 'unsupported'],
  ['раз в 3 месяца или 6 месяцев', 'ambiguous'],
  ['раз в 3 месяца либо 6 месяцев', 'ambiguous'],
  ['раз в 3 месяца/6 месяцев', 'ambiguous'],
  ['раз в 3 месяца (либо 6 месяцев)', 'ambiguous'],
  ['раз в 3 месяца и полгода', 'unsupported'],
  ['раз в 3 месяца, 6 месяцев', 'unsupported'],
  ['ежегодно или 6 месяцев', 'ambiguous'],
  ['ежемесячно или 3 месяца', 'ambiguous'],
  ['ежегодно и 6 месяцев', 'unsupported'],
  ['ежемесячно 3 месяца', 'unsupported'],
  ['ежегодно (или 2 года)', 'ambiguous'],
  ['каждый год или 6 месяцев', 'ambiguous'],
  ['раз в полгода или 3 месяца', 'ambiguous'],
  ['ежегодно или год', 'ambiguous'],
  ['раз в 3 месяца или месяц', 'ambiguous'],
  ['ежегодно и полгода', 'unsupported'],
  ['ежегодно или 1 квартал', 'ambiguous'],
  ['раз в 6 месяцев или 1 квартал', 'ambiguous'],
  ['ежегодно или два квартала', 'ambiguous'],
  ['ежемесячно или две недели', 'ambiguous'],
  ['раз в 3 месяца или 2 дня', 'ambiguous'],
  ['ежегодно или 1 день', 'ambiguous'],
  ['раз в 3 месяца или 21 день', 'ambiguous'],
  ['ежемесячно или один день', 'ambiguous'],
  ['раз в 3 месяца 1 квартал', 'unsupported'],
]) {
  test('XLSX uncertain recurrence stays invalid, never auto-converted: ' + text.slice(0, 40), () => {
    assert.deepEqual(parseReservePeriodHint(text), invalid(reason));
  });
}

for (const note of [
  '',
  ' ',
  'Примечание без периодичности',
  '2026 год',
  '2 мес',
  'В мае и августе',
  null,
  undefined,
  3,
  12,
  {},
  ['раз в 3 мес'],
]) {
  test('XLSX unrelated note is not guessed: ' + JSON.stringify(note), () => {
    assert.equal(parseReservePeriodHint(note), null);
  });
}

test('recognized XLSX hint is advisory: amount, due date and reserve are not fabricated', () => {
  const source = Object.freeze({ title: 'Подписка', note: 'Раз в 3 мес', amountCents: 50000 });
  const result = parseReservePeriodHint(source.note);
  assert.deepEqual(Object.keys(result).sort(), ['confirmationRequired', 'periodMonths', 'status']);
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.periodMonths, 3);
  assert.deepEqual(source, { title: 'Подписка', note: 'Раз в 3 мес', amountCents: 50000 });
});
