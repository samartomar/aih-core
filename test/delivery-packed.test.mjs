import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The delivery seam is the installed public package: renderDelivery and checkCompatibility from @aihq/core/harness,
// recipe identity from @aihq/core/contracts and Enterprise Prepare/Apply from @aihq/core, in a disposable home.
test('a packed consumer renders Catalog items as ordinary recipes and checks static compatibility', () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-delivery-'));
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
    copyFileSync(new URL('./fixtures/delivery-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    const receipt = JSON.parse(run(['check.mjs']).trim().split('\n').at(-1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checks.length, 23);
    writeFileSync(join(consumer, 'types.mts'), `
      import { checkCompatibility, deliveryMaterialRoot, renderDelivery, toolBindings } from '@aihq/core/harness';
      import type { CatalogItem, CompatibilityEntry, CompatibilityResult, DeliveryRefusal, ItemCompatibility, PluginRouteGuidance,
        RenderedDelivery, SetCompatibility, StaticBlockerCode } from '@aihq/core/harness';
      declare const item: CatalogItem;
      const binding = toolBindings[0]!;
      const rendered: RenderedDelivery | DeliveryRefusal = renderDelivery({ tool: 'claude', item, binding, scope: 'project', platform: { os: 'windows', arch: 'x64' }, installedVersion: '2.1.308' });
      if (rendered.status === 'rendered') rendered.recipe.materials[0]!.source.input satisfies typeof deliveryMaterialRoot;
      const entries: CompatibilityEntry[] = [{ item, excluded: false, sets: [{ framework: 'f', setId: 's', setSha256: '0'.repeat(64) }] }];
      const result: CompatibilityResult | DeliveryRefusal = checkCompatibility({ tool: 'claude', platform: { os: 'linux', arch: 'x64' }, items: entries, binding, installedVersion: '2.1.308' });
      if (result.status === 'checked') {
        const first: ItemCompatibility = result.items[0]!;
        first.deliveredSize.alwaysLoaded.chars satisfies number;
        first.staticBlockers[0]?.code satisfies StaticBlockerCode | undefined;
        const set: SetCompatibility | undefined = result.sets[0];
        set?.fit satisfies 'full' | 'partial' | 'none' | undefined;
      }
      const guided = checkCompatibility({ tool: 'claude', platform: { os: 'linux', arch: 'x64' }, items: entries, binding,
        nativeRoutes: [{ framework: 'f', lines: ['Claude Code: /plugin install x@y'] }] });
      if (guided.status === 'checked') {
        const route: PluginRouteGuidance | undefined = guided.pluginRoutes?.[0];
        route?.state satisfies 'listed' | 'not-listed' | 'not-supplied' | undefined;
        route?.source satisfies 'catalog-native-routes' | undefined;
        route?.lines satisfies string[] | undefined;
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
