import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The seam is the installed public package: removal preparation 1.2.0 by qualified origin, named member actions and
// several removals in one review, confirmed only from run result 1.4.0 member checks, in a disposable project and home.
test('a packed consumer removes by origin, member or several in one review through the public entries', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-removal-12-'));
  const consumer = join(root, 'consumer'), home = join(root, 'home');
  mkdirSync(consumer); mkdirSync(home);
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
    copyFileSync(new URL('./fixtures/managed-removal-12-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    const receipt = JSON.parse(run(['check.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 10, JSON.stringify(receipt.checks));
    writeFileSync(join(consumer, 'types.mts'), `
      import { removalClaims, type RemovalClaims } from '@aihq/core/contracts';
      import { prepareManagedRemoval } from '@aihq/core';
      import type { ManagedRemovalsRequest, ManagedRemovalPreparationResult12, ManagedRemovalPreparationResult, RemovalMemberAction, RunResult } from '@aihq/core';
      const request: ManagedRemovalsRequest = { target: { project: '.' }, scope: 'project', removals: [
        { managementId: 'a', origin: { set: { framework: 'f', setId: 's', setSha256: '0'.repeat(64) } } },
        { managementId: 'b', origin: { reasonIncluded: 'chosen' } }, { managementId: 'c' }] };
      const many: Promise<ManagedRemovalPreparationResult12> = prepareManagedRemoval(request);
      const one: Promise<ManagedRemovalPreparationResult> = prepareManagedRemoval({ target: { project: '.' }, managementId: 'a', scope: 'project', mode: 'vibe' });
      declare const prepared: ManagedRemovalPreparationResult12; declare const run: RunResult;
      const claims: RemovalClaims = removalClaims(prepared, run);
      const action: RemovalMemberAction | undefined = prepared.removals?.[0]?.members[0]?.action;
      action satisfies 'remove' | 'restore' | 'unregister' | 'keep-shared' | 'keep-changed' | 'keep-required' | undefined;
      void many; void one; void claims;
    `);
    const require = createRequire(import.meta.url);
    const compilerManifest = require.resolve('typescript/package.json');
    const compiler = join(dirname(compilerManifest), JSON.parse(readFileSync(compilerManifest, 'utf8')).bin.tsc);
    run([compiler, '--noEmit', '--skipLibCheck', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.mts']);
  } finally {
    assert.equal(dirname(realpathSync.native(root)), parent);
    rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }
});
