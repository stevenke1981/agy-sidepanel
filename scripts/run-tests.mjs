// Cross-platform test runner: expands test files itself (Node 20 on Windows cannot glob,
// Node 21+ treats directory args as files), then runs `node --test <files...>`.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DIRS = ['host/test', 'extension/test', 'scripts/test'];
const isTest = (name) => /\.test\.(m?js)$/.test(name);

const files = DIRS.flatMap((dir) => {
  try {
    return readdirSync(dir).filter(isTest).map((f) => join(dir, f));
  } catch {
    return [];
  }
});

if (files.length === 0) {
  process.stderr.write('no test files found\n');
  process.exit(1);
}
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
