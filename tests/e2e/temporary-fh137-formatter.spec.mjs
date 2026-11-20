import { test } from '@playwright/test';
import * as prettier from 'prettier';
import { readFile } from 'node:fs/promises';

// Temporary, public-source-only formatting transport to use the repository-pinned Prettier.
// Removed from the PR branch before any merge or deployment.
test('FH137 temporary formatter (public source, no runtime state)', async () => {
  for (const [name, path] of [
    ['CENTER', 'src/react/PaymentCenter.tsx'],
    ['TESTS', 'tests/react/payment-center.test.tsx'],
  ]) {
    const original = await readFile(path, 'utf8');
    const options = (await prettier.resolveConfig(path)) ?? {};
    const formatted = await prettier.format(original, { ...options, filepath: path });
    console.log('FH137_FORMAT_BEGIN_' + name + ':' + Buffer.from(formatted, 'utf8').toString('base64') + ':FH137_FORMAT_END_' + name);
  }
});
