import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistryCertificates } from './fixtures/tls-registry.mjs';

// The seam is the installed public package (C76): AI setup acquisition through plan requests in a disposable project and
// home, through the public API and the `aih` bin. Artifacts, qualifications and the Python interpreter are Core-side
// fixtures (acquire-fixture.mjs, fake-python.cjs); they prove no real tool, interpreter or qualification.
test('a packed consumer acquires AI setups installed-interpreter-first, falls back after a real failure, refuses untrusted TLS and removes the folder', async () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-acquire-packed-'));
  const consumer = join(root, 'consumer'), home = join(root, 'home');
  mkdirSync(consumer); mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_EXTRA_CA_CERTS;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const run = (args, cwd = consumer) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 900_000 });
  try {
    const [packed] = JSON.parse(run([join(source, 'scripts/pack-distribution.mjs'), '--pack-destination', root], source));
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
      '@aihq/core': 'file:' + join(root, packed.filename) } }));
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false']);
    for (const name of ['plan-acquire-consumer.mjs', 'acquire-fixture.mjs', 'plan-fixture.mjs', 'fake-python.cjs'])
      copyFileSync(new URL(`./fixtures/${name}`, import.meta.url), join(consumer, name));
    writeFileSync(join(consumer, 'certificates.json'), JSON.stringify(await createRegistryCertificates(['localhost'])));
    const receipt = JSON.parse(run(['plan-acquire-consumer.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.deepEqual(receipt.checks, ['untrusted-tls-refused-at-prepare', 'cli-installs-native-archive-with-repaired-trust',
      'installed-interpreter-first', 'forced-failure-uses-reviewed-fallback', 'removal-removes-ai-setup-folder']);
  } finally {
    assert.equal(dirname(realpathSync.native(root)), parent);
    rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }
});
