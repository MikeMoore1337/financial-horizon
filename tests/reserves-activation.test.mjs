import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('#6 production activation has a single explicit reserves flag and preserves existing finance gates', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const enabled = '<meta name="fh-finance-reserves" content="enabled">';
  const disabled = '<meta name="fh-finance-reserves" content="disabled">';
  assert.equal(html.split(enabled).length - 1, 1);
  assert.equal(html.includes(disabled), false);
  assert.equal(html.includes('<meta name="fh-finance-accounts" content="enabled">'), true);
  assert.equal(html.includes('<meta name="fh-finance-import" content="enabled">'), true);
});
