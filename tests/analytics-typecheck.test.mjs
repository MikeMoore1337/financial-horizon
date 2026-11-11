import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('isolated analytics module passes strict TypeScript typecheck', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  execFileSync(process.execPath, [compiler, '--project', 'src/domain/analytics/tsconfig.json'], {
    cwd: root, encoding: 'utf8', timeout: 60_000, stdio: 'pipe',
  });
});
