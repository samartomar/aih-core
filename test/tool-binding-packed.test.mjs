import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The binding seam is the installed public package: @aihq/core/harness and its schema and fixture exports.
test('a packed consumer reads the observed binding table and derives platform-scoped support', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-tool-binding-'));
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
    copyFileSync(new URL('./fixtures/tool-binding-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    const receipt = JSON.parse(run(['check.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 11);
    writeFileSync(join(consumer, 'types.mts'), `
      import { deriveCellSupport, selectBindingCell, toolBindingKinds, toolBindings, validateToolBinding } from '@aihq/core/harness';
      import type { BindingKind, BindingObservation, BindingSelection, CellSupport, ToolBinding, ToolLayout } from '@aihq/core/harness';
      const binding: ToolBinding = toolBindings[0]!;
      const kind: BindingKind = toolBindingKinds[0]!;
      const layout: ToolLayout = binding.layouts[kind];
      const observations: readonly BindingObservation[] = layout.observations;
      const derived: CellSupport = deriveCellSupport({ kind, observations, platform: { os: 'windows', arch: 'x64' }, installedVersion: '1.0.0' });
      derived.support satisfies 'native' | 'none' | 'unconfirmed';
      const selection: BindingSelection = selectBindingCell({ tool: 'kiro', kind: 'hook', platform: { os: 'windows', arch: 'x64' } });
      if (selection.status === 'selected') selection.layout satisfies ToolLayout;
      else if (selection.reason === 'kind-not-native') selection.cell.reason satisfies string;
      validateToolBinding(binding).valid satisfies boolean;
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
