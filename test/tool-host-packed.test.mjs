import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The host inspection seam is the installed public package: @aihq/core/harness/runtime. Projects, homes and
// PATH folders are disposable; nothing under them is run.
test('a packed consumer inspects a disposable project and isolated home without running anything', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-tool-host-'));
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
    copyFileSync(new URL('./fixtures/tool-host-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    const receipt = JSON.parse(run(['check.mjs', hosts]).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 9);
    writeFileSync(join(consumer, 'types.mts'), `
      import { inspectToolHost } from '@aihq/core/harness/runtime';
      import type { ToolHostBlocker, ToolHostItem, ToolHostResult, ToolHostWarning } from '@aihq/core/harness/runtime';
      const item: ToolHostItem = { framework: 'example', itemId: 'review', kind: 'skill', key: 'review',
        executables: ['node'], inputs: ['TOKEN'], requires: [{ framework: 'example', itemId: 'base' }] };
      const result: ToolHostResult = await inspectToolHost({ tool: 'claude', project: '/project', items: [item] }, { budgetMs: 1000 });
      if (result.status === 'complete') {
        const blocker: ToolHostBlocker | undefined = result.hostBlockers[0];
        if (blocker?.code === 'executable-missing') blocker.executable satisfies string;
        const warning: ToolHostWarning | undefined = result.warnings[0];
        if (warning?.code === 'same-key-elsewhere') warning.where satisfies 'user' | 'parent-folder' | 'plugin';
        result.stale satisfies boolean | 'unchecked';
        if (result.installedVersion.state === 'known') result.installedVersion.version satisfies string;
      }
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
