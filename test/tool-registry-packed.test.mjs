import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The registry seam is the installed public package: @aihq/core/harness, /contracts, the root entry and schema exports.
test('a packed consumer lists registry tools, is refused unobserved tools and declares 1.1 organization targets', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-tool-registry-'));
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
    copyFileSync(new URL('./fixtures/tool-registry-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    const golden = fileURLToPath(new URL('./fixtures/tool-registry/offered-tools.json', import.meta.url));
    const receipt = JSON.parse(run(['check.mjs', golden]).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 10);
    writeFileSync(join(consumer, 'types.mts'), `
      import { listTools, selectTool, toolRegistry, validateToolRegistry } from '@aihq/core/harness';
      import type { RegistryTool, ToolRegistry, ToolSelection, ToolSurface } from '@aihq/core/harness';
      import { validateOrganizationTarget } from '@aihq/core/contracts';
      import type { OrganizationTargetDeclaration, OrganizationTargetDeclaration11 } from '@aihq/core/contracts';
      const registry: ToolRegistry = toolRegistry;
      const offered: readonly RegistryTool[] = listTools({ includeUnobserved: true });
      const surface: ToolSurface = offered[0]!.surface;
      const selection: ToolSelection = selectTool('claude-code');
      if (selection.status === 'selected') selection.tool.aliases satisfies readonly string[];
      else selection.reason satisfies 'tool-not-observed' | 'unknown-tool';
      const declared: OrganizationTargetDeclaration11 = { schema: 'urn:aihq:core:organization-target:1.1.0',
        tool: { id: 'claude', surface }, repository: 'github.com/example-org/app' };
      const either: OrganizationTargetDeclaration = declared;
      validateOrganizationTarget(either); validateToolRegistry(registry);
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
