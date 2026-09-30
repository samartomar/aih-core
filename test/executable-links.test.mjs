import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepare, apply } from '../dist/core/index.js';

const parent = realpathSync(tmpdir());
const root = mkdtempSync(join(parent, 'aih-native-executable-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => {
  mkdirSync(join(root, 'home'));
  process.env.HOME = join(root, 'home'); process.env.USERPROFILE = join(root, 'home');
});
after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(dirname(realpathSync(root)), parent);
  rmSync(root, { recursive: true });
});

function request(project, executable, marker) {
  return { useCase: 'policy', target: { project }, policy: {
    schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
      id: 'native', managementId: 'native-tool', scope: 'project', configuration: {}, requires: [],
      recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'native-executable',
        description: 'Execute an existing native tool by its reviewed identity', inputs: {}, materials: [], targets: ['project'], prerequisites: [],
        operations: [{ id: 'run', purpose: 'Run the selected existing executable', kind: 'process.run', scope: 'project',
          executable: { name: executable }, args: [{ literal: '-e' },
            { literal: "require('node:fs').writeFileSync(process.argv[1],'ran')" }, { literal: marker }],
          cwd: { root: 'project', segments: [] }, env: {}, timeoutMs: 10000, maxOutputBytes: 1024,
          acceptedExitCodes: [0], effects: ['Write the fixture marker'], requires: [], checks: [] }], checks: [] } }
    }] } };
}
const authorize = preparation => ({ approved: true, origin: 'automation', reviewDigest: preparation.review.reviewDigest });
const controls = { logging: 'off' };

test('a reviewed executable alias rejects retargeting before the process starts', async t => {
  const project = mkdtempSync(join(root, 'alias-'));
  const first = join(project, 'first.exe'), second = join(project, 'second.exe'), alias = join(project, 'tool.exe');
  for (const file of [first, second]) { copyFileSync(process.execPath, file); chmodSync(file, 0o700); }
  try { symlinkSync(first, alias, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create executable symlinks'); return; } throw error; }
  const marker = join(project, 'ran.txt');
  const preparation = await prepare(request(project, alias, marker), controls);
  assert.equal(preparation.status, 'ready', JSON.stringify(preparation.diagnostics));
  assert.equal(preparation.review.operations[0].details.executable, alias);
  unlinkSync(alias); symlinkSync(second, alias, 'file');
  const result = await apply(preparation.prepared, authorize(preparation), controls);
  assert.equal(result.operations[0].reason, 'executable-changed');
  assert.equal(result.operations[0].effectsUncertain, false);
  assert.equal(existsSync(marker), false);
});

test('an existing hardlinked executable runs while its reviewed bytes remain unchanged', async () => {
  const project = mkdtempSync(join(root, 'hardlink-'));
  const executable = join(project, 'tool.exe'), otherName = join(project, 'same-tool.exe');
  copyFileSync(process.execPath, executable); chmodSync(executable, 0o700); linkSync(executable, otherName);
  const marker = join(project, 'ran.txt');
  const preparation = await prepare(request(project, executable, marker), controls);
  assert.equal(preparation.status, 'ready', JSON.stringify(preparation.diagnostics));
  const result = await apply(preparation.prepared, authorize(preparation), controls);
  assert.equal(result.operations[0].application, 'applied', JSON.stringify(result));
  assert.equal(existsSync(marker), true);
});

test('a reviewed executable rejects an intermediate alias retarget before spawning', async t => {
  const project = mkdtempSync(join(root, 'intermediate-'));
  const first = join(project, 'first.exe'), second = join(project, 'second.exe');
  const middle = join(project, 'middle.exe'), alias = join(project, 'tool.exe');
  for (const file of [first, second]) { copyFileSync(process.execPath, file); chmodSync(file, 0o700); }
  try { symlinkSync(first, middle, 'file'); symlinkSync(middle, alias, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create executable symlinks'); return; } throw error; }
  const marker = join(project, 'ran.txt');
  const preparation = await prepare(request(project, alias, marker), controls);
  assert.equal(preparation.status, 'ready', JSON.stringify(preparation.diagnostics));
  unlinkSync(middle); symlinkSync(second, middle, 'file');
  const result = await apply(preparation.prepared, authorize(preparation), controls);
  assert.equal(result.operations[0].reason, 'executable-changed');
  assert.equal(result.operations[0].effectsUncertain, false);
  assert.equal(existsSync(marker), false);
});

test('an executable alias preserves the selected launcher name', async t => {
  const project = mkdtempSync(join(root, 'launcher-'));
  const executable = join(project, 'dispatcher.exe'), alias = join(project, 'tool.exe');
  copyFileSync(process.execPath, executable); chmodSync(executable, 0o700);
  try { symlinkSync(executable, alias, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create executable symlinks'); return; } throw error; }
  const marker = join(project, 'ran.txt');
  const input = request(project, alias, marker);
  input.policy.selections[0].recipe.inline.operations[0].args[1].literal =
    "require('node:assert/strict').equal(require('node:path').basename(process.argv0),'tool.exe');require('node:fs').writeFileSync(process.argv[1],'ran')";
  const prepared = await prepare(input, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const result = await apply(prepared.prepared, authorize(prepared), controls);
  assert.equal(result.operations[0].application, 'applied', JSON.stringify(result));
  assert.equal(existsSync(marker), true);
});
