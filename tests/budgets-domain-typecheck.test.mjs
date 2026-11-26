import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('budget domain strict TypeScript check without shared tsconfig changes', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  execFileSync(process.execPath, [tsc, '--project', 'src/domain/budgets/tsconfig.json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: 'pipe',
  });
});
