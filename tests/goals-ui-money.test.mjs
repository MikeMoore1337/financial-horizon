import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoalRubles } from '../src/domain/goals/ui-money.ts';

test('RUB input parses whole and fractional kopecks exactly', () => {
  assert.equal(parseGoalRubles('120000'), 12_000_000);
  assert.equal(parseGoalRubles('1 234,5'), 123_450);
  assert.equal(parseGoalRubles('1\u00a0234.05'), 123_405);
  assert.equal(parseGoalRubles('0,01'), 1);
  assert.equal(parseGoalRubles('0', false), 0);
  assert.equal(parseGoalRubles('10000000000', false), 1_000_000_000_000);
});
test('RUB input rejects decimals > two digits and malformed separators', () => {
  for (const text of ['1,234','1.999','1 23','12,',' 1, 2','01','1,2,3','1e6','-10','∞','NaN','10 RUB','1\n200','0.00']) {
    assert.throws(() => parseGoalRubles(text), /сумм|диапазона/i, text);
  }
});
test('RUB input rejects unsafe, negative and non-text inputs', () => {
  for (const value of ['10000000000,01','999999999999','5000000000000','',null,12]) {
    assert.throws(() => parseGoalRubles(value), /сумм|диапазона/i);
  }
});
