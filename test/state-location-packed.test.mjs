import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const expected = {
  root: { base: 'userHome', segments: ['.aih', 'core'] },
  projectMarkers: [
    { path: 'ownership', meaning: 'Ownership records: one per project folder (or home) whose files Core manages.' },
    { path: 'recovery', meaning: 'Recovery manifests and private original-file snapshots, one folder per run that changed files.' },
    { path: 'runs', meaning: 'Redacted run history, one record per run.' }
  ]
};

// The seam is the installed public package; HOME and the project are disposable.
test('packed stateLocation is portable and resolveStateLocation names the running host\'s Core state', async () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-state-location-'));
  const consumer = join(root, 'consumer'), home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(consumer); mkdirSync(home); mkdirSync(project);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const run = (args, cwd = consumer) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  try {
    const [packed] = JSON.parse(run([join(source, 'scripts/pack-distribution.mjs'), '--pack-destination', root], source));
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@aihq/core': 'file:' + join(root, packed.filename) } }));
    // Bundled dependencies install offline, as in the other packed consumers; no registry is reached.
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false']);
    copyFileSync(new URL('./fixtures/state-location-consumer.mjs', import.meta.url), join(consumer, 'check.mjs'));
    const observed = JSON.parse(run(['check.mjs', project]).trim());

    // Portable descriptors are relative and exact.
    assert.deepEqual(observed.stateLocation, expected);
    assert.equal(observed.frozen, true);

    // Host resolution: absolute paths under the running host's (disposable) home.
    const stateRoot = join(observed.home, '.aih', 'core');
    const resolved = { root: stateRoot, projectMarkers: expected.projectMarkers.map(({ path, meaning }) => ({ path: join(stateRoot, path), meaning })) };
    assert.deepEqual(observed.before, resolved);
    assert.deepEqual(observed.after, resolved);
    assert.ok([observed.after.root, ...observed.after.projectMarkers.map(marker => marker.path)].every(isAbsolute));
    // Reading the location writes nothing.
    assert.deepEqual(observed.homeAfterRead, []);

    // The descriptors match where Core actually keeps project-keyed state.
    assert.equal(observed.completion, 'complete');
    assert.deepEqual(observed.markersPresent, [true, true, true]);
    for (const marker of expected.projectMarkers) assert.ok(observed.stateEntries.includes(marker.path), marker.path);
    // Core writes no marker of its own into the project folder.
    assert.deepEqual(observed.projectEntries, ['TEAM.md']);

    // A home that is not an existing directory is refused, as Core's operations refuse it; nothing is created.
    const missingHome = join(root, 'missing-home');
    const refusal = execFileSync(process.execPath, ['--input-type=module', '-e',
      "import { resolveStateLocation } from '@aihq/core'; try { resolveStateLocation(); console.log('resolved'); } catch (error) { console.log('refused'); }"],
      { cwd: consumer, env: { ...env, HOME: missingHome, USERPROFILE: missingHome }, encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim();
    assert.equal(refusal, 'refused');
    assert.throws(() => readFileSync(missingHome), { code: 'ENOENT' });

    // The portable value bundles for a browser without Node built-ins or host discovery.
    const browser = await build({ absWorkingDir: consumer, stdin: { resolveDir: consumer, contents: `
      import { stateLocation } from '@aihq/core/contracts';
      globalThis.result = JSON.stringify(stateLocation);
    ` }, bundle: true, platform: 'browser', format: 'iife', write: false, metafile: true });
    assert.equal(Object.keys(browser.metafile.inputs).some(path => path.startsWith('node:')), false);
    const globals = { TextEncoder, TextDecoder };
    runInNewContext(browser.outputFiles[0].text, globals, { timeout: 5000 });
    assert.deepEqual(JSON.parse(globals.result), expected);

    // Public types: descriptors at ./contracts, host resolution only at the Node root.
    writeFileSync(join(consumer, 'types.mts'), `
      import { stateLocation } from '@aihq/core/contracts';
      import type { StateLocation, StateLocationMarker } from '@aihq/core/contracts';
      import { resolveStateLocation } from '@aihq/core';
      import type { ResolvedStateLocation, ResolvedStateLocationMarker } from '@aihq/core';
      const location: StateLocation = stateLocation;
      const base: 'userHome' = location.root.base;
      const segments: readonly string[] = location.root.segments;
      const marker: StateLocationMarker | undefined = location.projectMarkers[0];
      const resolved: ResolvedStateLocation = resolveStateLocation();
      const absolute: string = resolved.root;
      const resolvedMarker: ResolvedStateLocationMarker | undefined = resolved.projectMarkers[0];
      const markerPath: string | undefined = resolvedMarker?.path;
      // @ts-expect-error The portable descriptors are read-only.
      stateLocation.root.base = 'elsewhere';
      // @ts-expect-error Host resolution is not part of the portable contracts entry.
      import { resolveStateLocation as portableResolve } from '@aihq/core/contracts';
    `);
    const require = createRequire(import.meta.url);
    const compilerManifest = require.resolve('typescript/package.json');
    const compiler = join(dirname(compilerManifest), JSON.parse(readFileSync(compilerManifest, 'utf8')).bin.tsc);
    run([compiler, '--noEmit', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.mts']);
    console.log(JSON.stringify({ sha256: packed.sha256, stateLocation: 'passed', resolveStateLocation: 'passed', browser: 'passed', publicTypes: 'passed' }));
  } finally {
    assert.equal(dirname(realpathSync.native(root)), parent);
    rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }
});
