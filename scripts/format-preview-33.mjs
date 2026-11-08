// One-time isolated CI formatter. Prints only public source files; no writes or secrets.
import fs from 'node:fs/promises';
import prettier from 'prettier';
const paths = ['src/react/Accounts.tsx', 'tests/react/accounts.test.tsx'];
for (const path of paths) {
  const original = await fs.readFile(path, 'utf8');
  const config = await prettier.resolveConfig(path);
  const formatted = await prettier.format(original, { ...config, filepath: path });
  console.log('FH33_FORMAT_JSON:' + JSON.stringify({ path, formatted }));
}
