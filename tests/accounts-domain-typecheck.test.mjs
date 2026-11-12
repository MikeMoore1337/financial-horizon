import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('accounts domain passes strict TypeScript typecheck without shared tsconfig edits', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  execFileSync(process.execPath, [tsc, '--project', 'src/domain/accounts/tsconfig.json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: 'pipe',
  });
});
