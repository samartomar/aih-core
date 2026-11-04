import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The seam is the installed public package (C76): render steps and recipe-origin proofs through the `@aihq/catalog`
// installed beside Core, in a disposable project and home, through the public API and the `aih` bin. That Catalog
// package and the producer documents are Core-side fixtures (version 0.0.0-core-fixture), not Catalog output; final
// validation needs the delivered Catalog artifact.
test('a packed consumer renders through the Catalog beside it, proves a recipe origin, and restores on removal', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-render-packed-'));
  const consumer = join(root, 'consumer'), home = join(root, 'home');
  mkdirSync(consumer); mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const run = (args, cwd = consumer) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 600_000 });
  try {
    const [packed] = JSON.parse(run([join(source, 'scripts/pack-distribution.mjs'), '--pack-destination', root], source));
    cpSync(new URL('./fixtures/catalog-node-fixture/', import.meta.url), join(root, 'catalog-fixture'), { recursive: true });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
      '@aihq/core': 'file:' + join(root, packed.filename), '@aihq/catalog': 'file:' + join(root, 'catalog-fixture') } }));
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--install-links']);
    for (const name of ['plan-render-consumer.mjs', 'plan-fixture.mjs'])
      copyFileSync(new URL(`./fixtures/${name}`, import.meta.url), join(consumer, name));
    const receipt = JSON.parse(run(['plan-render-consumer.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 3, JSON.stringify(receipt.checks));
  } finally {
    assert.equal(dirname(realpathSync.native(root)), parent);
    rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }
});
