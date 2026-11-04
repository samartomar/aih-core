import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The seam is the installed public package (C76): Scan evidence shown with a plan request in a disposable project and
// home, through the public API and the `aih` bin. `@aihq/scan` beside Core is the Core-side scan-read-fixture (Scan's
// own read module trusting only a TEST-ONLY signing universe) and `@aihq/catalog` is catalog-node-fixture; plans and
// content are Core-side fixtures.
test('a packed consumer shows Scan evidence with signer-bound memory, and Scan never decides what runs', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-scan-packed-'));
  const consumer = join(root, 'consumer'), home = join(root, 'home');
  mkdirSync(consumer); mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const run = (args, cwd = consumer) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 600_000 });
  try {
    const [packed] = JSON.parse(run([join(source, 'scripts/pack-distribution.mjs'), '--pack-destination', root], source));
    cpSync(new URL('./fixtures/scan-read-fixture/', import.meta.url), join(root, 'scan-fixture'), { recursive: true });
    cpSync(new URL('./fixtures/catalog-node-fixture/', import.meta.url), join(root, 'catalog-fixture'), { recursive: true });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
      '@aihq/core': 'file:' + join(root, packed.filename), '@aihq/scan': 'file:' + join(root, 'scan-fixture'),
      '@aihq/catalog': 'file:' + join(root, 'catalog-fixture') } }));
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--install-links']);
    // The installed Core declares Scan only as an optional peer, for `@aihq/scan/read` alone.
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/@aihq/core/package.json'), 'utf8'));
    assert.equal(manifest.dependencies['@aihq/scan'], undefined);
    assert.equal(typeof manifest.peerDependencies['@aihq/scan'], 'string');
    assert.deepEqual(manifest.peerDependenciesMeta['@aihq/scan'], { optional: true });
    mkdirSync(join(consumer, 'scan-read-fixture'));
    copyFileSync(new URL('./fixtures/scan-read-fixture/vectors.json', import.meta.url), join(consumer, 'scan-read-fixture/vectors.json'));
    for (const name of ['plan-scan-consumer.mjs', 'plan-fixture.mjs', 'scan-fixture.mjs'])
      copyFileSync(new URL(`./fixtures/${name}`, import.meta.url), join(consumer, name));
    const receipt = JSON.parse(run(['plan-scan-consumer.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 9, JSON.stringify(receipt.checks));
    // Without Scan installed, supplied evidence is an explicit unavailable result, never a crash or a gate.
    rmSync(join(consumer, 'node_modules/@aihq/scan'), { recursive: true });
    const without = JSON.parse(run(['plan-scan-consumer.mjs', 'without-scan']).trim().split('\n').at(-1));
    assert.equal(without.status, 'passed', JSON.stringify(without));
  } finally {
    assert.equal(dirname(realpathSync.native(root)), parent);
    rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }
});
