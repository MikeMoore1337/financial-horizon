import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCents } from '../src/types/finance.ts';

test('typed monetary boundary rejects unsafe integers, negatives and floating-point amounts', () => {
  for (const value of [0, 1, 199, Number.MAX_SAFE_INTEGER]) {
    assert.doesNotThrow(() => assertCents(value));
  }
  for (const value of [-1, 0.01, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertCents(value), RangeError);
  }
});
