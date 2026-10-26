import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The seam is the installed public package: one-server MCP approval rendered by Harness and reviewed, applied,
// inventoried and removed by Core through the public entries, in a disposable project and home.
test('a packed consumer allows one MCP server, never overwrites a choice and never publishes an input value', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-mcp-approval-'));
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
    copyFileSync(new URL('./fixtures/mcp-approval-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    const receipt = JSON.parse(run(['check.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 13, JSON.stringify(receipt.checks));
    writeFileSync(join(consumer, 'types.mts'), `
      import { renderDelivery, toolBindings } from '@aihq/core/harness';
      import type { ApprovalLocation, CatalogItem, DeliveryRefusal, ItemRef, RenderedDelivery } from '@aihq/core/harness';
      import type { ApprovalMarker, ConfigMemberOperation, Operation } from '@aihq/core';
      declare const item: CatalogItem;
      const grant: ItemRef = { framework: 'f', itemId: 'github' };
      const rendered: RenderedDelivery | DeliveryRefusal = renderDelivery({ tool: 'claude', item, binding: toolBindings[0]!, scope: 'project', grantApproval: grant });
      if (rendered.status === 'refused') rendered.guidance satisfies string | undefined;
      else rendered.recipe.schema satisfies 'urn:aihq:core:recipe:1.0.0' | 'urn:aihq:core:recipe:1.1.0' | 'urn:aihq:core:recipe:1.4.0';
      const location: ApprovalLocation | undefined = toolBindings[0]!.layouts['mcp-server'].register?.approvalLocation;
      const member: ConfigMemberOperation = { id: 'approve', purpose: 'Allow one server', kind: 'config.member', scope: 'project',
        target: { root: 'project', segments: [{ literal: 'settings.json' }] }, format: 'json', container: ['enabled'], action: 'add',
        value: { literal: 'github' }, exclusiveWith: [['denied']], approval: { tool: 'claude' } satisfies ApprovalMarker, requires: [], checks: [] };
      const operation: Operation = member;
      void location; void operation;
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
