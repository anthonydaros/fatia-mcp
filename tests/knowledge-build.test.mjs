import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
test('knowledge rebuilds reproducibly in a standalone checkout without external kb directories', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-kb-build-')), checkout = path.join(dir, 'checkout');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(checkout, 'scripts'), { recursive: true });
  for (const name of ['build-knowledge.mjs', 'validate-knowledge.mjs']) await fs.copyFile(path.join(ROOT, 'scripts', name), path.join(checkout, 'scripts', name));
  await fs.cp(path.join(ROOT, 'knowledge'), path.join(checkout, 'knowledge'), { recursive: true });
  await fs.cp(path.join(ROOT, 'tests/fixtures'), path.join(checkout, 'tests/fixtures'), { recursive: true });
  const run = script => execFileSync(process.execPath, [`scripts/${script}.mjs`], { cwd: checkout, env: { PATH: process.env.PATH || '' }, encoding: 'utf8' });
  assert.match(run('build-knowledge'), /knowledge\/ built/);
  const first = await fs.readFile(path.join(checkout, 'knowledge/manifest.json'));
  assert.match(run('validate-knowledge'), /OK/); run('build-knowledge');
  assert.deepEqual(await fs.readFile(path.join(checkout, 'knowledge/manifest.json')), first);
});
