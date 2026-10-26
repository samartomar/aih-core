import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Trust selection, explicit updates and historical authentication use only installed public entries.
// All cache, home and generated-key repository fixtures are disposable.
test('packed public trust client preserves default and authenticates selected updates', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-trust-update-'));
  const consumer = join(root, 'consumer'), home = join(root, 'home'), hosts = join(root, 'hosts');
  mkdirSync(consumer); mkdirSync(home); mkdirSync(hosts);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const run = (args, cwd = consumer) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  try {
    const [packed] = JSON.parse(run([join(source, 'scripts/pack-distribution.mjs'), '--pack-destination', root], source));
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dependencies: { '@aihq/core': 'file:' + join(root, packed.filename) } }));
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false']);
    copyFileSync(new URL('./fixtures/trust-update-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    for (const name of ['test-dsse-0.0.1.trust.json', 'test-dsse-0.0.1.artifact.json'])
      copyFileSync(new URL('./fixtures/evidence/' + name, import.meta.url), join(hosts, name));
    const receipt = JSON.parse(run(['check.mjs', hosts]).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    writeFileSync(join(consumer, 'types.mts'), `
      import { createTufTrustClient, getTrustSnapshot, getVerificationTrust,
        getCurrentTrustStatus, getCatalogIndexTrust } from '@aihq/core/harness/runtime';
      import type { TrustSnapshot, TufTrustClientOptions } from '@aihq/core/harness/runtime';
      declare const options: TufTrustClientOptions;
      const snapshot: TrustSnapshot = await createTufTrustClient(options).update();
      const defaults: TrustSnapshot = getTrustSnapshot();
      const status: 'current' | 'revoked' | 'unknown' = getCurrentTrustStatus(snapshot, {keyId:'id'});
      const trust = await getVerificationTrust(defaults);
      trust.keys satisfies readonly {identity:string; keyId:string; publicKeySpkiBase64:string}[];
      const indexTrust: 'none' | {readonly tufRoot:Uint8Array} = getCatalogIndexTrust(snapshot);
    `);
    const require = createRequire(import.meta.url);
    const manifest = require.resolve('typescript/package.json');
    const compiler = join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsc);
    run([compiler, '--noEmit', '--skipLibCheck', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.mts']);
  } finally {
    assert.equal(dirname(realpathSync.native(root)), parent);
    rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }
});
