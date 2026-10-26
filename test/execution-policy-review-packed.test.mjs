import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The seam is the installed public package: execution policy 1.4.0 through validatePolicy, Prepare and Apply,
// with Catalog items rendered by @aihq/core/harness, in a disposable project and home.
test('a packed consumer prepares execution policy 1.4.0 into prepared work 1.6.0 and reads REVIEW_STALE bindings', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-policy-review-'));
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
    copyFileSync(new URL('./fixtures/execution-policy-review-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    copyFileSync(new URL('./fixtures/root-a.pem', import.meta.url), join(consumer, 'root-a.pem'));
    const receipt = JSON.parse(run(['check.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 13, JSON.stringify(receipt.checks));
    writeFileSync(join(consumer, 'types.mts'), `
      import type { ExecutionPolicy, InclusionOrigin, SelectionMetadata } from '@aihq/core/contracts';
      import type { PreparedReview, PreparedSelection, RunResult, StaleBinding } from '@aihq/core';
      const origin: InclusionOrigin = { reasonIncluded: 'in-set', set: { framework: 'f', setId: 's', setSha256: '0'.repeat(64) }, options: { a: ['b'] } };
      declare const metadata: SelectionMetadata;
      metadata.origins satisfies InclusionOrigin[];
      declare const policy: ExecutionPolicy;
      policy.excludedItems?.[0]?.itemId satisfies string | undefined;
      declare const review: PreparedReview;
      const entry: PreparedSelection | undefined = review.selections?.[0];
      entry?.deliveredSize?.alwaysLoaded?.chars satisfies number | undefined;
      review.operations[0]?.selectionId satisfies string | null | undefined;
      declare const result: RunResult;
      result.diagnostics[0]?.changed satisfies StaleBinding | undefined;
      void origin;
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
