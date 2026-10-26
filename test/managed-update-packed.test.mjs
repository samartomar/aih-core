import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The seam is the installed public package: managed update preparation 1.0.0 to an explicit replacement, keeping the
// management id and local edits as conflicts, applied through the ordinary Apply, in a disposable project and home.
test('a packed consumer updates to an explicit replacement through the public entries, keeping local edits', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-update-'));
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
    copyFileSync(new URL('./fixtures/managed-update-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    const receipt = JSON.parse(run(['check.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 9, JSON.stringify(receipt.checks));
    writeFileSync(join(consumer, 'types.mts'), `
      import { prepareUpdate } from '@aihq/core';
      import type { ManagedUpdateRequest, ManagedUpdatePreparationResult, UpdateEntry, UpdateMemberAction, UpdateItemFacts } from '@aihq/core';
      declare const replacement: ManagedUpdateRequest['updates'][number]['replacement'];
      const request: ManagedUpdateRequest = { target: { project: '.' }, scope: 'project', updates: [{ managementId: 'a', replacement }] };
      const preview: Promise<ManagedUpdatePreparationResult> = prepareUpdate(request, { privateInputs: {}, materialRoots: {} });
      declare const prepared: ManagedUpdatePreparationResult;
      const entry: UpdateEntry | undefined = prepared.updates?.[0];
      const facts: UpdateItemFacts | null | undefined = entry?.from;
      const action: UpdateMemberAction | undefined = entry?.members[0]?.action;
      action satisfies 'add' | 'replace' | 'unchanged' | 'remove' | 'restore' | 'unregister' | 'keep-shared' | 'conflict' | undefined;
      void preview; void facts;
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
