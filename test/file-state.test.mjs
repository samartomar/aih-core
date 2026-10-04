import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { checkFileState, prepare } from '../dist/core/index.js';
import { contractSupport } from '../dist/core/contracts.js';
import fileStateSchema from '../dist/core/schemas/file-state-result/1.0.0.json' with { type: 'json' };
import { policy } from './fixture.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateResult = ajv.compile(fileStateSchema);

// Match Core's canonical paths so fault-injection hooks also fire through macOS /var aliases.
const fixtureRoot = fs.realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-core-file-state-')));
const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const home = join(fixtureRoot, 'home');
before(() => { mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(originalHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const project = () => mkdtempSync(join(fixtureRoot, 'project-'));

function snapshot(dir) {
  const entries = [];
  const walk = (current, prefix) => {
    const names = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
    for (const entry of names) {
      const full = join(current, entry.name); const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) entries.push([rel, 'link', readlinkSync(full)]);
      else if (stat.isDirectory()) { entries.push([rel, 'dir', stat.mode & 0o777]); walk(full, rel); }
      else entries.push([rel, 'file', stat.mode & 0o777, sha256(readFileSync(full))]);
    }
  };
  walk(dir, '');
  return entries;
}

async function check(request, controls) {
  const result = await checkFileState(request, controls);
  assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors) + '\n' + JSON.stringify(result));
  assert.equal(result.schema, 'urn:aihq:core:file-state-result:1.0.0');
  assert.equal(result.authority, 'not-evaluated');
  assert.deepEqual(result.package, contractSupport.package);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the result is serializable data');
  return result;
}

function writeOp(id, name, content, extra = {}) {
  return { id, purpose: `Write ${name}`, kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: name }] },
    content: { literal: content }, requires: [], checks: [], ...extra };
}
function writePolicy(operations, mutate) {
  const document = policy();
  const recipe = document.selections[0].recipe.inline;
  recipe.operations = operations;
  if (mutate) mutate(document, recipe);
  return document;
}
function fileCheck(id, name, digest) {
  return { id, purpose: `Check ${name}`, kind: 'file.sha256',
    target: { root: 'project', segments: [{ literal: name }] }, sha256: digest };
}
async function expectInert(dir, fn) {
  const beforeTree = snapshot(dir); const beforeHome = snapshot(home);
  const result = await fn();
  assert.deepEqual(snapshot(dir), beforeTree, 'target tree changed');
  assert.deepEqual(snapshot(home), beforeHome, 'home tree changed');
  assert.equal(existsSync(join(home, '.aih')), false, 'no Core state may be created');
  return result;
}

test('a matching unowned file reports match without custody, state or history', async () => {
  const dir = project();
  writeFileSync(join(dir, 'TEAM.md'), "Read the project's contribution guide.\n");
  const result = await expectInert(dir, () => check({ policy: policy(), target: { project: dir } }));
  assert.equal(result.status, 'complete');
  assert.equal(result.fileState, 'match');
  assert.deepEqual(result.targets, [{ id: 'guidance/write', operationIds: ['guidance/write'],
    target: { root: 'project', path: 'TEAM.md' }, outcome: 'match', reason: 'content-match' }]);
  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.notChecked, []);
  assert.deepEqual(result.coverage, { comparedTargets: 1, unavailableTargets: 0, comparedChecks: 0, unavailableChecks: 0, notChecked: 0 });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.limits.budgetMs, 60000);
  assert.equal(result.limits.targetBytes, "Read the project's contribution guide.\n".length);
  // A match adopts nothing: a later Prepare still sees unowned content.
  const preview = await prepare({ useCase: 'policy', policy: policy(), target: { project: dir } }, { logging: 'off' });
  assert.equal(preview.review.operations[0].ownership, 'unowned');
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('an edited unowned file reports changed without effects', async () => {
  const dir = project();
  writeFileSync(join(dir, 'TEAM.md'), 'human edit\n');
  const result = await expectInert(dir, () => check({ policy: policy(), target: { project: dir } }));
  assert.equal(result.status, 'complete');
  assert.equal(result.fileState, 'changed');
  assert.equal(result.targets[0].outcome, 'changed');
  assert.equal(result.targets[0].reason, 'content-changed');
  assert.equal(readFileSync(join(dir, 'TEAM.md'), 'utf8'), 'human edit\n');
});

test('absent targets and desired removals distinguish absence from change', async () => {
  const dir = project();
  const write = await expectInert(dir, () => check({ policy: policy(), target: { project: dir } }));
  assert.equal(write.targets[0].outcome, 'absent');
  assert.equal(write.targets[0].reason, 'target-absent');
  assert.equal(write.fileState, 'changed');
  assert.equal(existsSync(join(dir, 'TEAM.md')), false);
  const removal = writePolicy([{ id: 'drop', purpose: 'Remove a stale file', kind: 'file.remove', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'STALE.md' }] }, requires: [], checks: [] }]);
  const absent = await expectInert(dir, () => check({ policy: removal, target: { project: dir } }));
  assert.equal(absent.status, 'complete');
  assert.equal(absent.fileState, 'match');
  assert.equal(absent.targets[0].outcome, 'match');
  writeFileSync(join(dir, 'STALE.md'), 'still here');
  const present = await check({ policy: removal, target: { project: dir } });
  assert.equal(present.targets[0].outcome, 'changed');
  assert.equal(present.fileState, 'changed');
  assert.equal(readFileSync(join(dir, 'STALE.md'), 'utf8'), 'still here');
});

test('JSON, JSONC and TOML entries and marked blocks use renderer equality', async () => {
  const dir = project();
  writeFileSync(join(dir, 'config.json'), '{\n  "other": 1\n}\n');
  writeFileSync(join(dir, 'settings.jsonc'), '{\n  // retained\n  "mode": "old"\n}\n');
  writeFileSync(join(dir, 'tool.toml'), 'name = "x"\n');
  writeFileSync(join(dir, 'NOTES.md'), '# BEGIN\nhello\n# END\n');
  const entry = (path, action, value) => action === 'set' ? { path, action, value: { literal: value } } : { path, action };
  const document = writePolicy([
    { id: 'json', purpose: 'Keep json key', kind: 'config.entries', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'config.json' }] }, format: 'json',
      entries: [entry(['missing'], 'remove')], requires: [], checks: [] },
    { id: 'jsonc', purpose: 'Keep jsonc mode', kind: 'config.entries', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'settings.jsonc' }] }, format: 'jsonc',
      entries: [entry(['mode'], 'set', 'old')], requires: [], checks: [] },
    { id: 'toml', purpose: 'Keep toml name', kind: 'config.entries', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'tool.toml' }] }, format: 'toml',
      entries: [entry(['name'], 'set', 'x')], requires: [], checks: [] },
    { id: 'block', purpose: 'Keep marked block', kind: 'text.block', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'NOTES.md' }] }, blockId: 'b',
      startMarker: '# BEGIN', endMarker: '# END', action: 'set', content: { literal: 'hello' }, requires: [], checks: [] }
  ]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.equal(result.status, 'complete');
  assert.equal(result.fileState, 'match');
  assert.deepEqual(result.targets.map(row => row.outcome), ['match', 'match', 'match', 'match']);
  assert.equal(readFileSync(join(dir, 'settings.jsonc'), 'utf8'), '{\n  // retained\n  "mode": "old"\n}\n');
  const changed = writePolicy([{ id: 'jsonc', purpose: 'Change mode', kind: 'config.entries', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'settings.jsonc' }] }, format: 'jsonc',
    entries: [entry(['mode'], 'set', 'new')], requires: [], checks: [] }]);
  const drift = await check({ policy: changed, target: { project: dir } });
  assert.equal(drift.fileState, 'changed');
  assert.equal(readFileSync(join(dir, 'settings.jsonc'), 'utf8'), '{\n  // retained\n  "mode": "old"\n}\n');
});

test('malformed configuration and ambiguous markers are unavailable, never repaired', async () => {
  const dir = project();
  writeFileSync(join(dir, 'broken.json'), '{bad');
  writeFileSync(join(dir, 'dup.md'), '# BEGIN\none\n# BEGIN\n# END\n');
  const entry = { path: ['enabled'], action: 'set', value: { literal: true } };
  const document = writePolicy([
    { id: 'json', purpose: 'Edit broken json', kind: 'config.entries', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'broken.json' }] }, format: 'json',
      entries: [entry], requires: [], checks: [] },
    { id: 'block', purpose: 'Edit ambiguous block', kind: 'text.block', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'dup.md' }] }, blockId: 'b',
      startMarker: '# BEGIN', endMarker: '# END', action: 'set', content: { literal: 'x' }, requires: [], checks: [] }
  ]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.equal(result.status, 'incomplete');
  assert.equal(result.fileState, 'unverified');
  assert.deepEqual(result.targets.map(row => [row.outcome, row.reason]), [
    ['unavailable', 'unsupported-json-syntax'], ['unavailable', 'ambiguous-text-block']]);
  assert.equal(result.coverage.unavailableTargets, 2);
});

test('ordered writes and disjoint edits fold to one final comparison per target', async () => {
  const dir = project();
  const ordered = writePolicy([
    writeOp('first', 'FOLD.md', 'intermediate'),
    { ...writeOp('second', 'FOLD.md', 'final'), requires: ['first'] }
  ]);
  writeFileSync(join(dir, 'FOLD.md'), 'final');
  const match = await expectInert(dir, () => check({ policy: ordered, target: { project: dir } }));
  assert.equal(match.status, 'complete');
  assert.equal(match.fileState, 'match');
  assert.equal(match.targets.length, 1);
  assert.equal(match.targets[0].id, 'guidance/first');
  assert.deepEqual(match.targets[0].operationIds, ['guidance/first', 'guidance/second']);
  // The intermediate write is not the compared state.
  writeFileSync(join(dir, 'FOLD.md'), 'intermediate');
  const stale = await check({ policy: ordered, target: { project: dir } });
  assert.equal(stale.targets[0].outcome, 'changed');
  writeFileSync(join(dir, 'BLOCKS.md'), '# A\n1\n# /A\n# B\n2\n# /B\n');
  const disjoint = writePolicy([
    { id: 'a', purpose: 'Block A', kind: 'text.block', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'BLOCKS.md' }] }, blockId: 'a',
      startMarker: '# A', endMarker: '# /A', action: 'set', content: { literal: '1' }, requires: [], checks: [] },
    { id: 'b', purpose: 'Block B', kind: 'text.block', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'BLOCKS.md' }] }, blockId: 'b',
      startMarker: '# B', endMarker: '# /B', action: 'set', content: { literal: '2' }, requires: [], checks: [] }
  ]);
  const blocks = await check({ policy: disjoint, target: { project: dir } });
  assert.equal(blocks.targets.length, 1);
  assert.deepEqual(blocks.targets[0].operationIds, ['guidance/a', 'guidance/b']);
  assert.equal(blocks.targets[0].outcome, 'match');
});

test('local pinned material matches; wrong pins, absent roots and archives are unavailable', async () => {
  const dir = project(); const source = join(fixtureRoot, 'material-'); mkdirSync(source);
  const content = Buffer.from('material content\n');
  writeFileSync(join(source, 'payload.txt'), content);
  writeFileSync(join(dir, 'PAYLOAD.md'), content);
  const materialPolicy = pin => writePolicy([{ id: 'write', purpose: 'Write payload', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'PAYLOAD.md' }] }, material: 'payload', requires: [], checks: [] }],
    (document, recipe) => { delete recipe.operations[0].content;
      recipe.materials = [{ id: 'payload', path: 'payload.txt', sha256: pin, byteLength: content.length,
        source: { kind: 'local', input: 'selected' } }]; });
  const match = await expectInert(dir, () => check({ policy: materialPolicy(sha256(content)), target: { project: dir } },
    { materialRoots: { selected: source } }));
  assert.equal(match.status, 'complete');
  assert.equal(match.fileState, 'match');
  assert.equal(match.limits.materialBytes, content.length);
  const wrongPin = await check({ policy: materialPolicy('0'.repeat(64)), target: { project: dir } },
    { materialRoots: { selected: source } });
  assert.equal(wrongPin.targets[0].outcome, 'unavailable');
  assert.equal(wrongPin.targets[0].reason, 'material-identity-mismatch');
  const absentRoot = await check({ policy: materialPolicy(sha256(content)), target: { project: dir } }, {});
  assert.equal(absentRoot.targets[0].reason, 'material-unavailable');
  const archivePolicy = writePolicy([{ id: 'write', purpose: 'Write payload', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'PAYLOAD.md' }] }, material: 'payload', requires: [], checks: [] }],
    (document, recipe) => { delete recipe.operations[0].content;
      recipe.materials = [{ id: 'payload', path: 'payload.txt', sha256: sha256(content), byteLength: content.length,
        source: { kind: 'archive', url: 'https://example.invalid/material.tar.gz', sha256: '1'.repeat(64), byteLength: 128 } }]; });
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetches++; return realFetch(...args); };
  try {
    const archived = await check({ policy: archivePolicy, target: { project: dir } });
    assert.equal(archived.targets[0].outcome, 'unavailable');
    assert.equal(archived.targets[0].reason, 'remote-material-not-admitted');
    assert.equal(fetches, 0, 'an archive source is never fetched');
    // Positive control: ordinary Prepare does attempt the same archive source.
    const preview = await prepare({ useCase: 'policy', policy: archivePolicy, target: { project: dir } }, { logging: 'off' });
    assert.ok(fetches > 0, 'the instrumented fetch proves Prepare attempted the archive');
    assert.notEqual(preview.status, 'ready');
  } finally { globalThis.fetch = realFetch; }
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('an archive recipe reference is an omission with zero fetch attempts', async () => {
  const dir = project();
  const document = policy();
  document.selections[0].recipe = { reference: { source: { kind: 'archive',
    url: 'https://example.invalid/recipe.tar.gz', sha256: '2'.repeat(64), byteLength: 256 },
    path: 'recipe.json', sha256: '3'.repeat(64), byteLength: 512, materials: [] } };
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetches++; return realFetch(...args); };
  try {
    const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
    assert.equal(result.status, 'incomplete');
    assert.equal(result.fileState, 'unverified');
    assert.deepEqual(result.targets, []);
    assert.deepEqual(result.notChecked, [{ kind: 'recipe', id: 'guidance', reason: 'remote-material-not-admitted' }]);
    assert.equal(fetches, 0);
    const preview = await prepare({ useCase: 'policy', policy: document, target: { project: dir } }, { logging: 'off' });
    assert.ok(fetches > 0, 'positive control: Prepare attempted the archive');
    assert.notEqual(preview.status, 'ready');
  } finally { globalThis.fetch = realFetch; }
});

test('a missing private input in a target path yields one null-target row', async () => {
  const dir = project();
  const document = writePolicy([writeOp('write', 'placeholder', 'x')], (document, recipe) => {
    recipe.inputs = { dir: { type: 'string', required: true, sensitive: true } };
    recipe.operations[0].target.segments = [{ input: 'dir' }, { literal: 'SECRET.md' }];
    document.selections[0].configuration = {};
  });
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.equal(result.status, 'incomplete');
  assert.equal(result.fileState, 'unverified');
  assert.deepEqual(result.targets, [{ id: 'guidance/write', operationIds: ['guidance/write'],
    target: null, outcome: 'unavailable', reason: 'input-unavailable' }]);
  assert.equal(result.coverage.unavailableTargets, 1);
  assert.equal(existsSync(join(dir, 'SECRET.md')), false);
});

test('process operations, process checks and executable prerequisites are explicit omissions', async () => {
  const dir = project();
  const processOnly = writePolicy([{ id: 'run', purpose: 'Run a tool', kind: 'process.run', scope: 'project',
    executable: { name: 'definitely-not-a-real-executable' }, args: [], cwd: { root: 'project', segments: [] },
    env: {}, acceptedExitCodes: [0], effects: ['opaque'], requires: [], checks: ['verify'] }],
    (document, recipe) => {
      recipe.prerequisites = [{ kind: 'executable', name: 'definitely-not-a-real-executable' }];
      recipe.checks = [{ id: 'verify', purpose: 'Verify by process', kind: 'process.exit',
        executable: { name: 'definitely-not-a-real-executable' }, args: [], cwd: { root: 'project', segments: [] },
        env: {}, acceptedExitCodes: [0] }];
    });
  const result = await expectInert(dir, () => check({ policy: processOnly, target: { project: dir } }));
  assert.equal(result.status, 'incomplete');
  assert.equal(result.fileState, 'unverified');
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.checks, [{ id: 'guidance/verify', outcome: 'not-checked', reason: 'process-not-checked' }]);
  assert.deepEqual(result.notChecked, [
    { kind: 'prerequisite', id: 'guidance/prerequisite-0', reason: 'process-not-checked' },
    { kind: 'process', id: 'guidance/run', reason: 'process-not-checked' }]);
  assert.equal(result.coverage.notChecked, 3);
});

test('a process-dependent target is unavailable while an independent target is observed', async () => {
  const dir = project();
  writeFileSync(join(dir, 'FREE.md'), 'free content');
  const document = writePolicy([
    { id: 'run', purpose: 'Opaque step', kind: 'process.run', scope: 'project',
      executable: { name: 'definitely-not-a-real-executable' }, args: [], cwd: { root: 'project', segments: [] },
      env: {}, acceptedExitCodes: [0], effects: ['opaque'], requires: [], checks: [] },
    { ...writeOp('dependent', 'DEP.md', 'generated'), requires: ['run'] },
    writeOp('free', 'FREE.md', 'free content')
  ]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  const dependent = result.targets.find(row => row.id === 'guidance/dependent');
  const free = result.targets.find(row => row.id === 'guidance/free');
  assert.equal(dependent.outcome, 'unavailable');
  assert.equal(dependent.reason, 'process-dependency-not-checked');
  assert.deepEqual(dependent.target, { root: 'project', path: 'DEP.md' });
  assert.equal(free.outcome, 'match');
  assert.deepEqual(result.notChecked, [{ kind: 'process', id: 'guidance/run', reason: 'process-not-checked' }]);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.fileState, 'unverified');
});

test('mixed match, mismatch and unavailable targets aggregate with accurate counts', async () => {
  const dir = project();
  writeFileSync(join(dir, 'SAME.md'), 'same');
  writeFileSync(join(dir, 'DIFF.md'), 'edited');
  writeFileSync(join(dir, 'broken.json'), '{bad');
  const document = writePolicy([
    writeOp('same', 'SAME.md', 'same'),
    writeOp('diff', 'DIFF.md', 'original'),
    { id: 'json', purpose: 'Edit broken json', kind: 'config.entries', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'broken.json' }] }, format: 'json',
      entries: [{ path: ['enabled'], action: 'set', value: { literal: true } }], requires: [], checks: [] }
  ]);
  const result = await check({ policy: document, target: { project: dir } });
  assert.equal(result.fileState, 'changed');
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.targets.map(row => row.outcome), ['match', 'changed', 'unavailable']);
  assert.deepEqual(result.coverage, { comparedTargets: 2, unavailableTargets: 1, comparedChecks: 0, unavailableChecks: 0, notChecked: 0 });
});

test('file.sha256 checks compare the live target and failures change the outcome', async () => {
  const dir = project();
  writeFileSync(join(dir, 'SUM.md'), 'summed');
  const document = writePolicy([writeOp('write', 'SUM.md', 'summed')],
    (document, recipe) => { recipe.checks = [fileCheck('sum', 'SUM.md', sha256(Buffer.from('summed')))]; });
  const match = await check({ policy: document, target: { project: dir } });
  assert.equal(match.status, 'complete');
  assert.equal(match.fileState, 'match');
  assert.deepEqual(match.checks, [{ id: 'guidance/sum', outcome: 'passed', reason: 'content-match' }]);
  assert.equal(match.coverage.comparedChecks, 1);
  const wrong = writePolicy([writeOp('write', 'SUM.md', 'summed')],
    (document, recipe) => { recipe.checks = [fileCheck('sum', 'SUM.md', '0'.repeat(64))]; });
  const failed = await check({ policy: wrong, target: { project: dir } });
  assert.equal(failed.checks[0].outcome, 'failed');
  assert.equal(failed.checks[0].reason, 'content-changed');
  assert.equal(failed.fileState, 'changed');
  const missing = writePolicy([writeOp('write', 'SUM.md', 'summed')],
    (document, recipe) => { recipe.checks = [fileCheck('sum', 'ABSENT.md', '0'.repeat(64))]; });
  const absent = await check({ policy: missing, target: { project: dir } });
  assert.equal(absent.checks[0].outcome, 'failed');
  assert.equal(absent.checks[0].reason, 'target-absent');
  assert.equal(absent.fileState, 'changed');
});

test('enterprise policies, evidence, managed sets and removals are observed without authority or custody', async () => {
  const dir = project();
  writeFileSync(join(dir, 'TEAM.md'), "Read the project's contribution guide.\n");
  const document = policy();
  document.mode = 'enterprise';
  document.selections[0].organizationSelectionId = 'org-guidance';
  document.managedSelections = [{ id: 'team-set', scope: 'project', members: ['team-guidance'] }];
  document.removals = [{ managementId: 'retired-thing', scope: 'project' }];
  document.evidence = [{ schema: 'urn:aihq:scan:evidence-association:1.0.0',
    scanId: `scan:sha256:${'a'.repeat(64)}`, location: { kind: 'file', path: join(fixtureRoot, 'missing.scan.json') } }];
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetches++; return realFetch(...args); };
  try {
    const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
    assert.equal(result.fileState, 'match');
    assert.equal(result.status, 'incomplete');
    assert.equal(result.authority, 'not-evaluated');
    assert.deepEqual(result.notChecked, [
      { kind: 'managed-set', id: 'project/team-set', reason: 'custody-not-evaluated' },
      { kind: 'removal', id: 'project/retired-thing', reason: 'custody-not-evaluated' },
      { kind: 'evidence', id: `scan:sha256:${'a'.repeat(64)}`, reason: 'evidence-not-evaluated' }]);
    assert.equal(fetches, 0, 'no organization or evidence read');
  } finally { globalThis.fetch = realFetch; }
});

test('invalid requests fail before any target read with safe diagnostics', async () => {
  const dir = project();
  writeFileSync(join(dir, 'TEAM.md'), "Read the project's contribution guide.\n");
  const opened = [];
  const original = fs.openSync;
  fs.openSync = function (...args) { opened.push(String(args[0])); return original.apply(this, args); };
  syncBuiltinESMExports();
  try {
    const sensitive = writePolicy([writeOp('write', 'TEAM.md', 'x')], (document, recipe) => {
      recipe.inputs = { secret: { type: 'string', required: true, sensitive: true } };
      recipe.operations[0].content = { input: 'secret' };
      document.selections[0].configuration = {};
    });
    const unsupported = policy();
    unsupported.schema = 'urn:aihq:core:execution-policy:99.0.0';
    const cases = [
      [{ policy: policy(), target: { project: dir }, useCase: 'policy' }, undefined, 'request-field'],
      [{ policy: policy(), target: { project: dir, extra: true } }, undefined, 'request-field'],
      [{ policy: policy() }, undefined, 'request-field'],
      [{ policy: policy(), target: { project: 'relative/path' } }, undefined, 'project-absolute'],
      [{ policy: policy(), target: { project: join(dir, 'missing') } }, undefined, 'project-directory'],
      [{ policy: policy(), target: { project: dir } }, { logging: 'off' }, 'request-field'],
      [{ policy: policy(), target: { project: dir } }, { signal: {} }, 'signal'],
      [{ policy: policy(), target: { project: dir } }, { budgetMs: 0 }, 'budget-ms'],
      [{ policy: policy(), target: { project: dir } }, { budgetMs: 60001 }, 'budget-ms'],
      [{ policy: policy(), target: { project: dir } }, { budgetMs: 1.5 }, 'budget-ms'],
      [{ policy: policy(), target: { project: dir } }, { materialRoots: { ok: 'relative' } }, 'material-root'],
      [{ policy: policy(), target: { project: dir } }, { privateInputs: 'no' }, 'private-input'],
      [{ policy: policy(), target: { project: dir } }, { privateInputs: { unknown: { x: 'y' } } }, 'private-input-unknown'],
      [{ policy: policy(), target: { project: dir } }, { privateInputs: { guidance: { text: 'x' } } }, 'private-input-unknown'],
      [{ policy: sensitive, target: { project: dir } }, { privateInputs: { guidance: { secret: 42 } } }, 'input-value'],
      [{ policy: unsupported, target: { project: dir } }, undefined, 'schema-id']
    ];
    for (const [request, controls, reason] of cases) {
      const result = controls === undefined ? await check(request) : await check(request, controls);
      assert.equal(result.status, 'invalid', reason);
      assert.equal(result.fileState, 'unverified');
      assert.deepEqual(result.targets, []);
      assert.deepEqual(result.checks, []);
      assert.deepEqual(result.notChecked, []);
      assert.equal(result.diagnostics[0].reason, reason, JSON.stringify(result.diagnostics));
    }
    const unsupportedResult = await check({ policy: unsupported, target: { project: dir } });
    assert.equal(unsupportedResult.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
    assert.equal(unsupportedResult.diagnostics[0].encountered, 'urn:aihq:core:execution-policy:99.0.0');
    assert.deepEqual(unsupportedResult.diagnostics[0].supported, ['urn:aihq:core:execution-policy:1.0.0', 'urn:aihq:core:execution-policy:1.1.0']);
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(opened.filter(path => path.startsWith(dir)).length, 0,
    `invalid requests read no targets: ${opened.join(', ')}`);
});

test('a pre-aborted signal cancels after validation with no observations', async () => {
  const dir = project();
  writeFileSync(join(dir, 'TEAM.md'), "Read the project's contribution guide.\n");
  const controller = new AbortController(); controller.abort();
  const result = await expectInert(dir, () => check({ policy: policy(), target: { project: dir } }, { signal: controller.signal }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.fileState, 'unverified');
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.checks, []);
  assert.equal(result.diagnostics[0].code, 'CANCELLED');
  const invalid = await check({ policy: { nope: true }, target: { project: dir } }, { signal: controller.signal });
  assert.equal(invalid.status, 'invalid', 'validation precedes cancellation');
  const sensitive = writePolicy([writeOp('write', 'TEAM.md', 'x')], (document, recipe) => {
    recipe.inputs = { secret: { type: 'string', required: true, sensitive: true } };
    recipe.operations[0].content = { input: 'secret' };
    document.selections[0].configuration = {};
  });
  const wrongType = await check({ policy: sensitive, target: { project: dir } },
    { signal: controller.signal, privateInputs: { guidance: { secret: 42 } } });
  assert.deepEqual([wrongType.status, wrongType.diagnostics[0].reason], ['invalid', 'input-value'],
    'a wrongly typed private value is invalid even when already cancelled');
});

test('cancellation between targets retains completed rows and stops further reads', async () => {
  const dir = project();
  for (const name of ['A.md', 'B.md', 'C.md']) writeFileSync(join(dir, name), `content of ${name}`);
  const document = writePolicy(['A.md', 'B.md', 'C.md'].map((name, index) => writeOp(`write-${index}`, name, `content of ${name}`)));
  const controller = new AbortController();
  const targetB = join(dir, 'B.md'); const targetC = join(dir, 'C.md');
  const openedAfterAbort = [];
  const beforeTree = snapshot(dir);
  const original = fs.openSync;
  fs.openSync = function (...args) {
    const path = String(args[0]);
    if (controller.signal.aborted) openedAfterAbort.push(path);
    const fd = original.apply(this, args);
    if (path === targetB) controller.abort();
    return fd;
  };
  syncBuiltinESMExports();
  let result;
  try { result = await check({ policy: document, target: { project: dir } }, { signal: controller.signal }); }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(result.status, 'cancelled');
  assert.equal(result.diagnostics[0].code, 'CANCELLED');
  assert.equal(result.targets[0].outcome, 'match', 'the first completed row is retained');
  if (result.targets[1].outcome !== 'match') assert.equal(result.targets[1].reason, 'cancelled');
  assert.equal(result.targets[2].outcome, 'unavailable');
  assert.equal(result.targets[2].reason, 'cancelled');
  assert.equal(openedAfterAbort.filter(path => path === targetC).length, 0, 'no reads after cancellation');
  assert.deepEqual(snapshot(dir), beforeTree);
});

test('a tiny budget bounds the observation and marks remaining targets', async () => {
  const dir = project();
  const names = Array.from({ length: 100 }, (_, index) => `F${String(index).padStart(3, '0')}.md`);
  for (const name of names) writeFileSync(join(dir, name), `content ${name}`);
  const document = writePolicy(names.map((name, index) => writeOp(`write-${index}`, name, `content ${name}`)));
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }, { budgetMs: 1 }));
  assert.equal(result.status, 'incomplete');
  assert.ok(result.targets.some(row => row.reason === 'budget-exhausted'), JSON.stringify(result.targets.slice(0, 3)));
  assert.ok(result.coverage.comparedTargets < 100);
  assert.equal(result.limits.budgetMs, 1);
});

test('linked parents, non-regular targets and replaced targets are unavailable', async () => {
  const dir = project(); const outside = project();
  writeFileSync(join(outside, 'x.md'), 'outside');
  symlinkSync(outside, join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(join(dir, 'subdir'));
  const document = writePolicy([
    { ...writeOp('link', 'placeholder', 'outside'), target: { root: 'project', segments: [{ literal: 'linked' }, { literal: 'x.md' }] } },
    writeOp('directory', 'subdir', 'not a file')
  ]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.deepEqual(result.targets.map(row => [row.outcome, row.reason]), [
    ['unavailable', 'target-unreadable'], ['unavailable', 'target-unreadable']]);
  // A target replaced mid-check is reported, never compared against stale bytes.
  const replaced = project();
  const target = join(replaced, 'R.md');
  writeFileSync(target, 'original');
  const original = fs.openSync;
  let opens = 0; let writing = false;
  fs.openSync = function (...args) {
    if (String(args[0]) === target && !writing) {
      opens++;
      if (opens === 2) { writing = true; try { writeFileSync(target, 'tampered'); } finally { writing = false; } }
    }
    return original.apply(this, args);
  };
  syncBuiltinESMExports();
  let raced;
  try { raced = await check({ policy: writePolicy([writeOp('write', 'R.md', 'original')]), target: { project: replaced } }); }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.ok(opens >= 2, 'the recheck opened the target again');
  assert.equal(raced.targets[0].outcome, 'unavailable');
  assert.equal(raced.targets[0].reason, 'target-changed-during-check');
  assert.equal(readFileSync(target, 'utf8'), 'tampered');
});

test('secrets in paths, content and materials never appear in the result', async () => {
  const dir = project(); const source = join(fixtureRoot, 'secret-material'); mkdirSync(source);
  const secret = 'fixture-secret-7f3c9d1e-low-entropy';
  writeFileSync(join(source, 'payload.txt'), secret);
  const document = writePolicy([{ id: 'write', purpose: 'Write secret', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ input: 'dir' }, { literal: 'OUT.md' }] }, material: 'payload', requires: [], checks: [] }],
    (document, recipe) => {
      recipe.inputs = { dir: { type: 'string', required: true, sensitive: true } };
      recipe.materials = [{ id: 'payload', path: 'payload.txt', sha256: sha256(Buffer.from(secret)), byteLength: secret.length,
        source: { kind: 'local', input: 'selected' } }];
      document.selections[0].configuration = {};
    });
  mkdirSync(join(dir, secret));
  writeFileSync(join(dir, secret, 'OUT.md'), secret);
  const result = await check({ policy: document, target: { project: dir } },
    { privateInputs: { guidance: { dir: secret } }, materialRoots: { selected: source } });
  assert.equal(result.fileState, 'match');
  const text = JSON.stringify(result);
  assert.equal(text.includes(secret), false, 'the secret value never appears');
  assert.equal(text.includes(sha256(Buffer.from(secret))), false, 'the secret digest never appears');
  assert.equal(result.targets[0].target.path, '[REDACTED]/OUT.md');
  rmSync(join(dir, secret), { recursive: true, force: true });
});

test('an oversized live target is unavailable within the member limit', async () => {
  const dir = project();
  writeFileSync(join(dir, 'BIG.md'), Buffer.alloc(16 * 1024 * 1024 + 1, 120));
  const result = await expectInert(dir, () => check({ policy: writePolicy([writeOp('write', 'BIG.md', 'x')]), target: { project: dir } }));
  assert.equal(result.targets[0].outcome, 'unavailable');
  assert.equal(result.targets[0].reason, 'limit-exceeded');
  assert.equal(result.status, 'incomplete');
});

test('an empty policy and user-scoped roots report honest state', async () => {
  const dir = project();
  const empty = await check({ policy: { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [] },
    target: { project: dir } });
  assert.equal(empty.status, 'incomplete');
  assert.equal(empty.fileState, 'unverified');
  assert.deepEqual(empty.targets, []);
  // userHome content compares without custody.
  writeFileSync(join(home, 'aih-file-state-home.md'), 'home content');
  try {
    const userDocument = writePolicy([{ ...writeOp('write', 'aih-file-state-home.md', 'home content'),
      scope: 'user', target: { root: 'userHome', segments: [{ literal: 'aih-file-state-home.md' }] } }],
      (document, recipe) => { document.selections[0].scope = 'user'; recipe.targets = ['user']; });
    const userResult = await check({ policy: userDocument, target: { project: dir } });
    assert.equal(userResult.fileState, 'match');
    assert.deepEqual(userResult.targets[0].target, { root: 'userHome', path: 'aih-file-state-home.md' });
  } finally { rmSync(join(home, 'aih-file-state-home.md'), { force: true }); }
  // An absent userState member desired absent matches without creating state.
  const stateDocument = writePolicy([{ id: 'drop', purpose: 'Drop managed content', kind: 'file.remove', scope: 'user',
    target: { root: 'userState', segments: [{ literal: 'cache.bin' }] }, requires: [], checks: [] }],
    (document, recipe) => { document.selections[0].scope = 'user'; recipe.targets = ['user']; });
  const stateResult = await check({ policy: stateDocument, target: { project: dir } });
  assert.equal(stateResult.fileState, 'match');
  assert.deepEqual(stateResult.targets[0].target, { root: 'userState', path: 'cache.bin' });
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('file.write compares the explicit POSIX mode only on POSIX', { skip: process.platform === 'win32' }, async () => {
  const dir = project();
  writeFileSync(join(dir, 'MODE.md'), 'mode content', { mode: 0o600 });
  const withMode = writePolicy([writeOp('write', 'MODE.md', 'mode content', { mode: 0o644 })]);
  const mismatch = await check({ policy: withMode, target: { project: dir } });
  assert.equal(mismatch.targets[0].outcome, 'changed');
  const matching = writePolicy([writeOp('write', 'MODE.md', 'mode content', { mode: 0o600 })]);
  const match = await check({ policy: matching, target: { project: dir } });
  assert.equal(match.targets[0].outcome, 'match');
  // No explicit mode preserves the live mode: same bytes match at any mode.
  const preserved = await check({ policy: writePolicy([writeOp('write', 'MODE.md', 'mode content')]), target: { project: dir } });
  assert.equal(preserved.targets[0].outcome, 'match');
});

test('the installed distribution still declares the produced file-state schema', () => {
  assert.deepEqual(contractSupport.contracts.find(entry => entry.id === 'urn:aihq:core:file-state-result:1.0.0'),
    { id: 'urn:aihq:core:file-state-result:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/schemas/file-state-result/1.0.0.json' });
});

test('shipped representative results validate against the public schema', () => {
  const expected = { complete: ['complete', 'match'], partial: ['incomplete', 'match'],
    invalid: ['invalid', 'unverified'], unsupported: ['invalid', 'unverified'] };
  for (const [name, [status, fileState]] of Object.entries(expected)) {
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/file-state/${name}.json`, import.meta.url), 'utf8'));
    assert.equal(validateResult(fixture), true, `${name}: ${JSON.stringify(validateResult.errors)}`);
    assert.equal(fixture.status, status, name);
    assert.equal(fixture.fileState, fileState, name);
    assert.equal(fixture.authority, 'not-evaluated', name);
    assert.equal(fixture.limits.elapsedMs, 0, name);
  }
});

function selection(id, operations, extra = {}, recipeExtra = {}) {
  return { id, managementId: `${id}-management`, scope: 'project', configuration: {}, requires: [],
    recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: `${id}-recipe`, description: `Recipe ${id}`,
      inputs: {}, materials: [], targets: ['project'], prerequisites: [], operations, checks: [], ...recipeExtra } }, ...extra };
}
const policyOf = selections => ({ schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections });
const opaque = (id, extra = {}) => ({ id, purpose: 'Opaque step', kind: 'process.run', scope: 'project',
  executable: { name: 'definitely-not-a-real-executable' }, args: [], cwd: { root: 'project', segments: [] },
  env: {}, acceptedExitCodes: [0], effects: ['opaque'], requires: [], checks: [], ...extra });
const archiveSelection = (id, extra = {}) => ({ id, managementId: `${id}-management`, scope: 'project', configuration: {},
  requires: [], recipe: { reference: { source: { kind: 'archive', url: 'https://example.invalid/recipe.tar.gz',
    sha256: '2'.repeat(64), byteLength: 256 }, path: 'recipe.json', sha256: '3'.repeat(64), byteLength: 512, materials: [] } }, ...extra });

test('process dependency is transitive through file operations and required selections', async () => {
  const dir = project();
  for (const name of ['A.md', 'B.md', 'C.md', 'D.md']) writeFileSync(join(dir, name), `content ${name}`);
  const document = policyOf([
    selection('tool', [opaque('run'),
      { ...writeOp('a', 'A.md', 'content A.md'), requires: ['run'] },
      { ...writeOp('b', 'B.md', 'content B.md'), requires: ['a'] }]),
    selection('after', [writeOp('c', 'C.md', 'content C.md')], { requires: ['tool'] }),
    selection('free', [writeOp('d', 'D.md', 'content D.md')])
  ]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.deepEqual(result.targets.map(row => [row.id, row.outcome, row.reason]), [
    ['tool/a', 'unavailable', 'process-dependency-not-checked'],
    ['tool/b', 'unavailable', 'process-dependency-not-checked'],
    ['free/d', 'match', 'content-match'],
    ['after/c', 'unavailable', 'process-dependency-not-checked']]);
  assert.deepEqual(result.notChecked, [{ kind: 'process', id: 'tool/run', reason: 'process-not-checked' }]);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.fileState, 'unverified');
  assert.equal(result.limits.targetBytes, Buffer.byteLength('content D.md'), 'only the independent target is read');
});

test('an unread recipe is inherited transitively while digest checks still observe live bytes', async () => {
  const dir = project();
  writeFileSync(join(dir, 'B.md'), 'b'); writeFileSync(join(dir, 'C.md'), 'c');
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetches++; return realFetch(...args); };
  try {
    const document = policyOf([
      archiveSelection('remote'),
      selection('middle', [writeOp('b', 'B.md', 'b')], { requires: ['remote'] }),
      selection('leaf', [writeOp('c', 'C.md', 'c')], { requires: ['middle'] },
        { checks: [fileCheck('digest', 'C.md', sha256(Buffer.from('c')))] })
    ]);
    const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
    assert.deepEqual(result.notChecked, [{ kind: 'recipe', id: 'remote', reason: 'remote-material-not-admitted' }]);
    assert.deepEqual(result.targets.map(row => [row.id, row.outcome, row.reason]), [
      ['middle/b', 'unavailable', 'remote-material-not-admitted'],
      ['leaf/c', 'unavailable', 'remote-material-not-admitted']]);
    assert.deepEqual(result.checks, [{ id: 'leaf/digest', outcome: 'passed', reason: 'content-match' }]);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.fileState, 'unverified');
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('operations from different selections fold onto one shared target in dependency order', async () => {
  const dir = project();
  const block = { id: 'block', purpose: 'Append a block', kind: 'text.block', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'SHARED.md' }] }, blockId: 'extra',
    startMarker: '<!-- extra -->', endMarker: '<!-- /extra -->', action: 'set', content: { literal: 'added' },
    requires: [], checks: [] };
  // The dependent selection is authored first; admission order still follows its requirement.
  const document = policyOf([
    selection('layer', [block], { requires: ['base'] }),
    selection('base', [writeOp('write', 'SHARED.md', 'base\n')])
  ]);
  writeFileSync(join(dir, 'SHARED.md'), 'base\n<!-- extra -->\nadded\n<!-- /extra -->\n');
  const match = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.equal(match.status, 'complete');
  assert.deepEqual(match.targets, [{ id: 'base/write', operationIds: ['base/write', 'layer/block'],
    target: { root: 'project', path: 'SHARED.md' }, outcome: 'match', reason: 'content-match' }]);
  writeFileSync(join(dir, 'SHARED.md'), 'base\n');
  const partial = await check({ policy: document, target: { project: dir } });
  assert.deepEqual([partial.targets.length, partial.targets[0].outcome, partial.fileState], [1, 'changed', 'changed']);
});

test('cancellation during admission lists unfinished recipes without reading targets', async () => {
  const dir = project(); const source = join(fixtureRoot, 'admission-material'); mkdirSync(source);
  writeFileSync(join(dir, 'TEAM.md'), 'team'); writeFileSync(join(source, 'payload.txt'), 'payload');
  const payload = Buffer.from('payload');
  const document = policyOf([
    selection('first', [writeOp('write', 'TEAM.md', 'team')]),
    selection('second', [{ id: 'write', purpose: 'Write payload', kind: 'file.write', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'PAYLOAD.md' }] }, material: 'payload', requires: [], checks: [] }],
      {}, { materials: [{ id: 'payload', path: 'payload.txt', sha256: sha256(payload), byteLength: payload.length,
        source: { kind: 'local', input: 'selected' } }] })
  ]);
  const controller = new AbortController();
  const opened = [];
  const beforeTree = snapshot(dir); const beforeHome = snapshot(home);
  const original = fs.openSync;
  fs.openSync = function (...args) {
    const path = String(args[0]); opened.push(path);
    const fd = original.apply(this, args);
    if (path === join(source, 'payload.txt')) controller.abort();
    return fd;
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await check({ policy: document, target: { project: dir } },
      { signal: controller.signal, materialRoots: { selected: source } });
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(snapshot(dir), beforeTree);
  assert.deepEqual(snapshot(home), beforeHome);
  assert.ok(opened.includes(join(source, 'payload.txt')), 'the instrumented material read triggered the abort');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.fileState, 'unverified');
  assert.deepEqual(result.targets, [{ id: 'first/write', operationIds: ['first/write'],
    target: { root: 'project', path: 'TEAM.md' }, outcome: 'unavailable', reason: 'cancelled' }]);
  assert.deepEqual(result.notChecked, [{ kind: 'recipe', id: 'second', reason: 'cancelled' }]);
  assert.equal(opened.filter(path => path.startsWith(dir)).length, 0, 'no target is read after cancellation');
});

test('strict material descriptors and unsafe authored paths are invalid even when already cancelled', async () => {
  const dir = project();
  writeFileSync(join(dir, 'TEAM.md'), 'team');
  const aborted = AbortSignal.abort();
  const unsafeReference = policyOf([{ ...archiveSelection('remote'), recipe: { reference: {
    ...archiveSelection('remote').recipe.reference, path: '../recipe.json' } } }]);
  const plainHttp = policyOf([selection('inline', [{ id: 'write', purpose: 'Write payload', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'PAYLOAD.md' }] }, material: 'payload', requires: [], checks: [] }], {},
    { materials: [{ id: 'payload', path: 'payload.txt', sha256: '4'.repeat(64), byteLength: 4,
      source: { kind: 'archive', url: 'http://example.invalid/material.tar.gz', sha256: '5'.repeat(64), byteLength: 64 } }] })]);
  const traversal = policyOf([selection('walk', [{ ...writeOp('write', 'x', 'team'),
    target: { root: 'project', segments: [{ literal: '..' }, { literal: 'TEAM.md' }] } }])]);
  const processCwd = policyOf([selection('tool', [opaque('run', { cwd: { root: 'project', segments: [{ literal: '..' }] } })])]);
  const opened = [];
  const original = fs.openSync;
  fs.openSync = function (...args) { opened.push(String(args[0])); return original.apply(this, args); };
  syncBuiltinESMExports();
  try {
    for (const [document, reason] of [[unsafeReference, 'unsafe-member-path'], [plainHttp, 'invalid-archive-url'],
      [traversal, 'invalid-path'], [processCwd, 'invalid-path']]) {
      for (const controls of [{}, { signal: aborted }]) {
        const result = await check({ policy: document, target: { project: dir } }, controls);
        assert.deepEqual([result.status, result.diagnostics[0].code, result.diagnostics[0].reason],
          ['invalid', 'INPUT_INVALID', reason], JSON.stringify(result.diagnostics));
        assert.deepEqual([result.targets, result.checks, result.notChecked], [[], [], []]);
      }
    }
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(opened.filter(path => path.startsWith(dir)).length, 0, 'invalid requests read no targets');
  const unsupported = await check({ policy: { ...policy(), schema: 'urn:aihq:core:execution-policy:99.0.0' },
    target: { project: dir } });
  assert.equal(unsupported.diagnostics[0].path, '/policy/schema', 'pointers are relative to the request');
});

test('an unreferenced digest check with an unbound optional input is unavailable, a referenced one invalid', async () => {
  const dir = project();
  writeFileSync(join(dir, 'TEAM.md'), 'team');
  const withCheck = referenced => policyOf([selection('guide', [{ ...writeOp('write', 'TEAM.md', 'team'),
    checks: referenced ? ['digest'] : [] }], {}, {
    inputs: { folder: { type: 'string', required: false } },
    checks: [{ id: 'digest', purpose: 'Check optional file', kind: 'file.sha256',
      target: { root: 'project', segments: [{ input: 'folder' }, { literal: 'OPT.md' }] }, sha256: '6'.repeat(64) }] })]);
  const unreferenced = await expectInert(dir, () => check({ policy: withCheck(false), target: { project: dir } }));
  assert.deepEqual(unreferenced.checks, [{ id: 'guide/digest', outcome: 'unavailable', reason: 'input-unavailable' }]);
  assert.deepEqual([unreferenced.status, unreferenced.fileState, unreferenced.targets[0].outcome], ['incomplete', 'unverified', 'match']);
  const preview = await prepare({ useCase: 'policy', policy: withCheck(false), target: { project: dir } }, { logging: 'off' });
  assert.notEqual(preview.status, 'invalid', 'Prepare does not resolve unreferenced checks either');
  const referencedResult = await check({ policy: withCheck(true), target: { project: dir } });
  assert.deepEqual([referencedResult.status, referencedResult.diagnostics[0].reason], ['invalid', 'input-unbound']);
});

test('a later operation on a shared target carries the earlier operation process dependency', async () => {
  const dir = project();
  for (const [name, text] of [['F.md', 'second'], ['G.md', 'g'], ['H.md', 'h']]) writeFileSync(join(dir, name), text);
  // Admission order is p, q, x, y, z: y follows x on F although it only requires q.
  const document = policyOf([selection('tool', [opaque('p'), writeOp('q', 'H.md', 'h'),
    { ...writeOp('x', 'F.md', 'first'), requires: ['p'] },
    { ...writeOp('y', 'F.md', 'second'), requires: ['q'] },
    { ...writeOp('z', 'G.md', 'g'), requires: ['y'] }])]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.deepEqual(result.targets.map(row => [row.id, row.operationIds, row.outcome, row.reason]), [
    ['tool/q', ['tool/q'], 'match', 'content-match'],
    ['tool/x', ['tool/x', 'tool/y'], 'unavailable', 'process-dependency-not-checked'],
    ['tool/z', ['tool/z'], 'unavailable', 'process-dependency-not-checked']]);
});

test('cancellation during the final observation is reported with every completed row retained', async () => {
  const dir = project();
  for (const name of ['A.md', 'B.md']) writeFileSync(join(dir, name), `content of ${name}`);
  const document = writePolicy(['A.md', 'B.md'].map((name, index) => writeOp(`write-${index}`, name, `content of ${name}`)));
  const controller = new AbortController();
  const last = join(dir, 'B.md');
  const original = fs.openSync;
  fs.openSync = function (...args) {
    const fd = original.apply(this, args);
    if (String(args[0]) === last) controller.abort();
    return fd;
  };
  syncBuiltinESMExports();
  let result;
  try { result = await check({ policy: document, target: { project: dir } }, { signal: controller.signal }); }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(result.status, 'cancelled');
  assert.equal(result.diagnostics[0].code, 'CANCELLED');
  assert.deepEqual(result.targets.map(row => row.outcome), ['match', 'match'], 'the final completed row is retained too');
});

test('a renderer failure leaves an independent digest check of the same live file comparable', async () => {
  const dir = project();
  writeFileSync(join(dir, 'config.json'), '{bad');
  const document = writePolicy([{ id: 'json', purpose: 'Edit broken json', kind: 'config.entries', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'config.json' }] }, format: 'json',
    entries: [{ path: ['enabled'], action: 'set', value: { literal: true } }], requires: [], checks: [] }],
    (document, recipe) => { recipe.checks = [fileCheck('digest', 'config.json', '7'.repeat(64))]; });
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.deepEqual(result.targets.map(row => [row.outcome, row.reason]), [['unavailable', 'unsupported-json-syntax']]);
  assert.deepEqual(result.checks, [{ id: 'guidance/digest', outcome: 'failed', reason: 'content-changed' }]);
  assert.equal(result.fileState, 'changed');
});

test('local material acquisition stops at the caller budget, not its own longer deadline', async () => {
  const dir = project(); const source = join(fixtureRoot, 'slow-material'); mkdirSync(source);
  const payload = Buffer.from('payload'); const second = Buffer.from('second');
  writeFileSync(join(source, 'payload.txt'), payload); writeFileSync(join(source, 'second.txt'), second);
  writeFileSync(join(dir, 'PAYLOAD.md'), payload);
  const document = policyOf([selection('slow', [{ id: 'write', purpose: 'Write payload', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'PAYLOAD.md' }] }, material: 'payload', requires: [], checks: [] }],
    {}, { materials: [
      { id: 'payload', path: 'payload.txt', sha256: sha256(payload), byteLength: payload.length, source: { kind: 'local', input: 'selected' } },
      { id: 'second', path: 'second.txt', sha256: sha256(second), byteLength: second.length, source: { kind: 'local', input: 'selected' } }] })]);
  const opened = [];
  const original = fs.openSync;
  fs.openSync = function (...args) {
    opened.push(String(args[0]));
    const fd = original.apply(this, args);
    // Simulate a slow open that outlasts the caller's budget but not the 60 s acquisition deadline.
    if (String(args[0]) === join(source, 'payload.txt')) { const until = performance.now() + 1500; while (performance.now() < until); }
    return fd;
  };
  syncBuiltinESMExports();
  let result;
  try { result = await check({ policy: document, target: { project: dir } }, { budgetMs: 1000, materialRoots: { selected: source } }); }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.targets.map(row => [row.outcome, row.reason]), [['unavailable', 'budget-exhausted']]);
  // Acquisition itself stopped at the caller's deadline: nothing was captured and the next member was never read.
  assert.equal(result.limits.materialBytes, 0);
  assert.equal(opened.includes(join(source, 'second.txt')), false, 'no material read after the budget expired');
});

test('a local recipe reference is admitted only through its pinned material root', async () => {
  const dir = project(); const catalog = join(fixtureRoot, 'catalog-reference'); mkdirSync(catalog);
  const recipeBytes = Buffer.from(JSON.stringify(policy().selections[0].recipe.inline));
  writeFileSync(join(catalog, 'recipe.json'), recipeBytes);
  writeFileSync(join(dir, 'TEAM.md'), "Read the project's contribution guide.\n");
  const referenced = pin => { const document = policy();
    document.selections[0].recipe = { reference: { source: { kind: 'local', input: 'catalog' }, path: 'recipe.json',
      sha256: pin, byteLength: recipeBytes.length, materials: [] } };
    return document; };
  const match = await expectInert(dir, () => check({ policy: referenced(sha256(recipeBytes)), target: { project: dir } },
    { materialRoots: { catalog } }));
  assert.deepEqual([match.status, match.fileState, match.limits.materialBytes], ['complete', 'match', recipeBytes.length]);
  const wrongPin = await check({ policy: referenced('8'.repeat(64)), target: { project: dir } }, { materialRoots: { catalog } });
  assert.deepEqual(wrongPin.notChecked, [{ kind: 'recipe', id: 'guidance', reason: 'material-identity-mismatch' }]);
  assert.deepEqual([wrongPin.status, wrongPin.fileState], ['incomplete', 'unverified']);
  const noRoot = await check({ policy: referenced(sha256(recipeBytes)), target: { project: dir } });
  assert.deepEqual(noRoot.notChecked, [{ kind: 'recipe', id: 'guidance', reason: 'material-unavailable' }]);
});

test('each operation with an omitted private path input gets its own null row', async () => {
  const dir = project();
  const document = writePolicy([writeOp('one', 'x', 'a'), writeOp('two', 'x', 'b')], (document, recipe) => {
    recipe.inputs = { dir: { type: 'string', required: true, sensitive: true } };
    for (const op of recipe.operations) op.target.segments = [{ input: 'dir' }, { literal: 'SAME.md' }];
    document.selections[0].configuration = {};
  });
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.deepEqual(result.targets.map(row => [row.id, row.operationIds, row.target, row.reason]), [
    ['guidance/one', ['guidance/one'], null, 'input-unavailable'], ['guidance/two', ['guidance/two'], null, 'input-unavailable']]);
  assert.equal(result.coverage.unavailableTargets, 2);
});

test('a policy with processes and executable prerequisites starts no child process', async () => {
  const dir = project();
  const calls = [];
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const originals = Object.fromEntries(names.map(name => [name, childProcess[name]]));
  for (const name of names) childProcess[name] = function (...args) { calls.push(name); return originals[name].apply(this, args); };
  syncBuiltinESMExports();
  try {
    const document = writePolicy([opaque('run'), writeOp('write', 'TEAM.md', 'x')], (document, recipe) => {
      recipe.prerequisites = [{ kind: 'executable', name: 'node' }];
      recipe.checks = [{ id: 'verify', purpose: 'Verify by process', kind: 'process.exit', executable: { name: 'node' },
        args: [], cwd: { root: 'project', segments: [] }, env: {}, acceptedExitCodes: [0] }];
      recipe.operations[0].checks = ['verify'];
    });
    const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
    assert.equal(result.checks[0].outcome, 'not-checked');
    assert.deepEqual(calls, [], 'no child process was started');
    childProcess.spawnSync(process.execPath, ['-e', '0']);
    assert.deepEqual(calls, ['spawnSync'], 'positive control: the instrumentation observes a child process');
  } finally {
    for (const name of names) childProcess[name] = originals[name];
    syncBuiltinESMExports();
  }
});

test('malformed JSONC and TOML targets are unavailable with the renderer reason', async () => {
  const dir = project();
  writeFileSync(join(dir, 'settings.jsonc'), '{ "a": 1, "a": 2 }');
  writeFileSync(join(dir, 'tool.toml'), '[[array]]\nname = "x"\n');
  const entry = { path: ['name'], action: 'set', value: { literal: 'x' } };
  const document = writePolicy([
    { id: 'jsonc', purpose: 'Edit duplicate jsonc', kind: 'config.entries', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'settings.jsonc' }] }, format: 'jsonc', entries: [entry], requires: [], checks: [] },
    { id: 'toml', purpose: 'Edit array-table toml', kind: 'config.entries', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'tool.toml' }] }, format: 'toml', entries: [entry], requires: [], checks: [] }]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.deepEqual(result.targets.map(row => [row.outcome, row.reason]), [
    ['unavailable', 'duplicate-json-key'], ['unavailable', 'unsupported-toml-array-table']]);
});

test('more than 4,096 distinct targets leaves the excess unavailable without reads', async () => {
  const dir = project();
  // The first 4,096 targets belong to another platform, so they count towards the limit
  // without being read; the limit itself is then independent of machine speed.
  const remove = index => ({ id: `o${index}`, purpose: 'p', kind: 'file.remove', scope: 'project',
    target: { root: 'project', segments: [{ literal: `f${index}` }] }, requires: [], checks: [] });
  const document = policyOf([
    selection('elsewhere', Array.from({ length: 4096 }, (_, index) => remove(index)), {},
      { prerequisites: [{ kind: 'platform', os: process.platform === 'win32' ? 'linux' : 'win32', architectures: ['x64', 'arm64'] }] }),
    selection('excess', [remove(4096)])
  ]);
  const opened = [];
  const original = fs.openSync;
  fs.openSync = function (...args) { opened.push(String(args[0])); return original.apply(this, args); };
  syncBuiltinESMExports();
  let result;
  try { result = await check({ policy: document, target: { project: dir } }); }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(result.targets.length, 4097);
  assert.ok(result.targets.slice(0, 4096).every(row => row.reason === 'platform-unsupported'));
  assert.deepEqual(result.targets.at(-1), { id: 'excess/o4096', operationIds: ['excess/o4096'],
    target: { root: 'project', path: 'f4096' }, outcome: 'unavailable', reason: 'limit-exceeded' });
  assert.deepEqual([result.coverage.comparedTargets, result.coverage.unavailableTargets], [0, 4097]);
  assert.deepEqual([result.status, result.fileState, result.limits.targetBytes], ['incomplete', 'unverified', 0]);
  assert.equal(opened.filter(path => path.startsWith(dir)).length, 0, 'no target beyond the limit is read');
});

test('leaf and material-source symlinks are unavailable, never followed', { skip: process.platform === 'win32' }, async () => {
  const dir = project(); const outside = project(); const source = join(fixtureRoot, 'linked-material'); mkdirSync(source);
  writeFileSync(join(outside, 'real.md'), 'outside'); symlinkSync(join(outside, 'real.md'), join(dir, 'LINK.md'));
  const payload = Buffer.from('payload');
  writeFileSync(join(outside, 'payload.txt'), payload); symlinkSync(join(outside, 'payload.txt'), join(source, 'payload.txt'));
  const document = policyOf([
    selection('leaf', [writeOp('write', 'LINK.md', 'outside')]),
    selection('material', [{ id: 'write', purpose: 'Write payload', kind: 'file.write', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'PAYLOAD.md' }] }, material: 'payload', requires: [], checks: [] }],
      {}, { materials: [{ id: 'payload', path: 'payload.txt', sha256: sha256(payload), byteLength: payload.length,
        source: { kind: 'local', input: 'selected' } }] })]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }, { materialRoots: { selected: source } }));
  assert.deepEqual(result.targets.map(row => [row.id, row.outcome, row.reason]), [
    ['leaf/write', 'unavailable', 'target-unreadable'], ['material/write', 'unavailable', 'material-unavailable']]);
});

test('a declaration larger than the whole byte bound is unavailable, not invalid, and independent targets still compare', async () => {
  const dir = project();
  writeFileSync(join(dir, 'TEAM.md'), 'team');
  const members = Array.from({ length: 33 }, (_, index) => ({ id: `m${String(index).padStart(2, '0')}`,
    path: `m${String(index).padStart(2, '0')}.bin`, sha256: 'a'.repeat(64), byteLength: 16 * 1024 * 1024 }));
  const document = policyOf([
    { id: 'huge', managementId: 'huge-management', scope: 'project', configuration: {}, requires: [],
      recipe: { reference: { source: { kind: 'local', input: 'catalog' }, path: 'recipe.json', sha256: 'b'.repeat(64),
        byteLength: 100, materials: members } } },
    selection('small', [writeOp('write', 'TEAM.md', 'team')])
  ]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }));
  assert.deepEqual(result.notChecked, [{ kind: 'recipe', id: 'huge', reason: 'limit-exceeded' }]);
  assert.deepEqual(result.targets.map(row => [row.id, row.outcome]), [['small/write', 'match']]);
  assert.deepEqual([result.status, result.fileState, result.limits.materialBytes], ['incomplete', 'unverified', 0]);
});

test('cancellation after the budget ran out marks every later unfinished target cancelled', async () => {
  const dir = project();
  const names = ['A.md', 'B.md', 'C.md', 'D.md'];
  for (const name of names) writeFileSync(join(dir, name), name);
  const document = writePolicy(names.map((name, index) => writeOp(`write-${index}`, name, name)));
  const controller = new AbortController();
  let slowed = false;
  const original = fs.openSync;
  fs.openSync = function (...args) {
    const fd = original.apply(this, args);
    if (!slowed && String(args[0]) === join(dir, 'A.md')) {
      slowed = true;
      // Outlast the budget, then abort two host turns later: B is stopped by the
      // budget first, and the abort then reaches C before it is observed.
      const until = performance.now() + 1500; while (performance.now() < until);
      setImmediate(() => setImmediate(() => controller.abort()));
    }
    return fd;
  };
  syncBuiltinESMExports();
  let result;
  try { result = await check({ policy: document, target: { project: dir } }, { signal: controller.signal, budgetMs: 1000 }); }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(result.targets.map(row => [row.outcome, row.reason]), [['match', 'content-match'],
    ['unavailable', 'budget-exhausted'], ['unavailable', 'cancelled'], ['unavailable', 'cancelled']]);
  assert.equal(result.status, 'cancelled');
});

test('material IDs that alias one pinned source file both compare from the shared capture', async () => {
  const dir = project(); const source = join(fixtureRoot, 'alias-material'); mkdirSync(source);
  const payload = Buffer.from('shared payload');
  writeFileSync(join(source, 'payload.txt'), payload);
  writeFileSync(join(dir, 'ONE.md'), payload); writeFileSync(join(dir, 'TWO.md'), payload);
  const write = (id, name, materialId) => ({ id, purpose: `Write ${name}`, kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: name }] }, material: materialId, requires: [], checks: [] });
  const pin = id => ({ id, path: 'payload.txt', sha256: sha256(payload), byteLength: payload.length, source: { kind: 'local', input: 'selected' } });
  const document = policyOf([selection('alias', [write('one', 'ONE.md', 'a'), write('two', 'TWO.md', 'b')], {},
    { materials: [pin('a'), pin('b')] })]);
  const result = await expectInert(dir, () => check({ policy: document, target: { project: dir } }, { materialRoots: { selected: source } }));
  assert.deepEqual([result.status, result.fileState, result.limits.materialBytes], ['complete', 'match', payload.length]);
  assert.deepEqual(result.targets.map(row => row.outcome), ['match', 'match']);
});
