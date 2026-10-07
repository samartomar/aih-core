import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { linkSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkNativePersistence } from '../dist/core/internal/native-cell.js';
import { createPersistenceDiagnosticClassifier } from '../src/harness/native/persistence-diagnostics.mjs';
import { claudeStatePaths, inspectClaudeGlobalState } from '../src/harness/native/claude-state.mjs';
import { pathPins, sha256 } from '../dist/core/internal/host-files.js';
import { NativeStop } from '../dist/core/internal/native-input.js';

// Controlled cell mutations isolate Core's individual persistence layers; no product operation targets source.
function cellFixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'aih-persistence-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const home = join(path, 'home'), project = join(path, 'project'); mkdirSync(home); mkdirSync(project);
  return { path, home, project, pins: [], configurationPins: [], configurationFacts: [], tree: [], bytes: new Map() };
}
const planFixture = () => ({ home: [], project: [], classify: createPersistenceDiagnosticClassifier().entry });

const cachePath = '.cache/claude-cli-nodejs';
const claudePlan = () => ({ ...claudeStatePaths, classify: createPersistenceDiagnosticClassifier().entry });
function cacheFixture(t) {
  const cell = cellFixture(t), cache = join(cell.home, ...cachePath.split('/'));
  mkdirSync(cache, { recursive: true });
  return { cell, cache, plan: claudePlan() };
}
function refused(cell, plan, failureClass, expectedItem) {
  const records = [];
  assert.equal(checkNativePersistence(cell, plan, () => {}, record => records.push(record)), false);
  assert.equal(records.length, 1); assert.equal(records[0].class, failureClass);
  if (expectedItem) assert.deepEqual(records[0].items[0], expectedItem);
  assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
  assert.equal(records[0].truncated, true);
}

test('Claude log cache accepts inert configuration-looking names without inspecting their bytes', t => {
  const { cell, cache, plan } = cacheFixture(t);
  mkdirSync(join(cache, 'privacy-canary-cwd', 'mcp-logs-privacy-canary-server'), { recursive: true });
  for (const name of ['settings.json', 'CLAUDE.md']) {
    writeFileSync(join(cache, name), 'privacy-canary-unparsed-input');
    writeFileSync(join(cache, 'privacy-canary-cwd', 'mcp-logs-privacy-canary-server', name), 'privacy-canary-content');
  }
  plan.inspect = () => { throw Error('Uninspected cache must not read contents'); };
  const records = [];
  assert.equal(checkNativePersistence(cell, plan, () => {}, record => records.push(record)), true);
  assert.deepEqual(records, []);
  rmSync(cache, { recursive: true });
  // The retained rule accepts an ordinary single-link file at this exact uninspected root.
  writeFileSync(cache, 'privacy-canary-inert-file');
  assert.equal(checkNativePersistence(cell, plan, () => {}), true);
});

for (const [root, path, depth, token] of [
  ['home', '.cache/other', 2, 'unknown-1'],
  ['home', '.cache/claude-cli-nodejs2', 2, 'unknown-1'],
  ['home', '.cache/claude-cli', 2, 'unknown-1'],
  ['home', '.Cache/claude-cli-nodejs', 1, 'unknown-1'],
  ['home', '.cache/privacy-canary-sibling', 2, 'unknown-1'],
  ['project', '.cache/claude-cli-nodejs', 1, 'unknown-1'],
]) test(`Claude log cache refuses undeclared ${root} ${path}`, t => {
  const { cell, plan } = cacheFixture(t);
  // Keep the alternate parent spelling observable on case-insensitive Windows filesystems.
  if (path.startsWith('.Cache/')) rmSync(join(cell.home, '.cache'), { recursive: true });
  mkdirSync(join(cell[root], ...path.split('/')), { recursive: true });
  refused(cell, plan, 'unexpected-entry', { root, depth, kind: 'dir', token });
});

for (const [position, failureClass, depth, token] of [
  ['parent', 'unexpected-entry', 1, '.cache'],
  ['root', 'state-tree-entry', 2, 'claude-cli-nodejs'],
  ['descendant', 'state-tree-entry', 3, 'unknown-1'],
]) test(`Claude log cache refuses a symlink at its ${position}`, t => {
  const { cell, cache, plan } = cacheFixture(t);
  const target = join(cell.path, 'privacy-canary-link-target'); mkdirSync(target);
  const link = position === 'parent' ? join(cell.home, '.cache') : position === 'root' ? cache : join(cache, 'privacy-canary-link');
  if (position !== 'descendant') rmSync(link, { recursive: true });
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  refused(cell, plan, failureClass, { root: 'home', depth, kind: 'other', token });
});

for (const position of ['root', 'descendant']) test(`Claude log cache refuses hard-linked files at its ${position}`, t => {
  const { cell, cache, plan } = cacheFixture(t);
  const source = join(cell.path, 'privacy-canary-hardlink-source'); writeFileSync(source, 'privacy-canary-stderr');
  if (position === 'root') rmSync(cache, { recursive: true });
  linkSync(source, position === 'root' ? cache : join(cache, 'privacy-canary-log.jsonl'));
  refused(cell, plan, 'state-tree-entry', { root: 'home', depth: position === 'root' ? 2 : 3,
    kind: 'file', token: position === 'root' ? 'claude-cli-nodejs' : 'unknown-1' });
});

for (const position of ['root', 'descendant']) test(`Claude log cache refuses special-file metadata at its ${position}`, t => {
  const { cell, cache, plan } = cacheFixture(t);
  const special = position === 'root' ? cache : join(cache, 'privacy-canary-special');
  if (position === 'descendant') writeFileSync(special, '');
  // Windows cannot create POSIX special files. Supply that shape only at the filesystem syscall boundary.
  const original = fs.lstatSync;
  const mock = t.mock.method(fs, 'lstatSync', (path, options) => path === special ?
    { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false } : original(path, options));
  syncBuiltinESMExports();
  try {
    refused(cell, plan, 'state-tree-entry', { root: 'home', depth: position === 'root' ? 2 : 3,
      kind: 'other', token: position === 'root' ? 'claude-cli-nodejs' : 'unknown-1' });
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

for (const limit of ['depth', 'entries']) test(`Claude log cache retains the ${limit} limit and opaque diagnostics`, t => {
  const { cell, cache, plan } = cacheFixture(t), records = [];
  if (limit === 'depth') mkdirSync(join(cache, ...Array(32).fill('privacy-canary-deep')), { recursive: true });
  else for (let i = 0; i < 4096; i++) writeFileSync(join(cache, `privacy-canary-${i}`), '');
  assert.throws(() => checkNativePersistence(cell, plan, () => {}, record => records.push(record)), error => error.reason === 'limit-exceeded');
  assert.equal(records.length, 1); assert.equal(records[0].class, 'limit');
  assert.match(records[0].items[0].token, /^unknown-\d+$/);
  assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
});

for (const [root, path] of [['home', '.claude/settings.json'], ['project', 'CLAUDE.md']]) {
  test(`Claude log cache does not permit mutation of selected ${root} configuration`, t => {
    const { cell, plan } = cacheFixture(t), file = join(cell[root], ...path.split('/'));
    mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'selected');
    cell.tree = [{ root, path, member: { byteLength: 8, sha256: sha256('selected') } }];
    assert.equal(checkNativePersistence(cell, plan, () => {}), true);
    writeFileSync(file, 'privacy-canary-mutated-configuration');
    refused(cell, plan, 'selected-member');
  });
}

test('the first failed walk collects at most 16 cheap sibling offenders and marks them partial', t => {
  const cell = cellFixture(t), records = [], plan = planFixture();
  for (let i = 0; i < 20; i++) writeFileSync(join(cell.home, `privacy-canary-${i}`), 'privacy-canary-content');
  assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
  assert.equal(records.length, 1); assert.equal(records[0].class, 'unexpected-entry');
  assert.equal(records[0].items.length, 16); assert.equal(records[0].truncated, true);
  assert.deepEqual(records[0].items.map(item => item.token), Array.from({ length: 16 }, (_, i) => `unknown-${i + 1}`));
  assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
});

for (const failureClass of ['pins', 'configuration-facts', 'selected-member', 'unexpected-entry',
  'state-tree-entry', 'inspected-state', 'read-failure', 'limit']) {
  test(`controlled cell mutation diagnoses ${failureClass} without changing its boolean or limit stop`, t => {
    const cell = cellFixture(t), plan = planFixture(), records = [];
    const file = join(cell.project, 'CLAUDE.md');
    writeFileSync(file, 'selected');
    cell.tree = [{ root: 'project', path: 'CLAUDE.md', member: { byteLength: 8, sha256: sha256('selected') } }];
    assert.equal(checkNativePersistence(cell, plan, () => {}), true);
    switch (failureClass) {
      case 'pins':
        cell.configurationPins = [pathPins(file)]; renameSync(file, join(cell.project, 'moved'));
        writeFileSync(file, 'selected'); break;
      case 'configuration-facts': {
        const stat = lstatSync(file, { bigint: true });
        cell.configurationFacts = [{ path: file, identity: `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.birthtimeNs}:${stat.size}` }];
        writeFileSync(file, 'modified selected'); break;
      }
      case 'selected-member': writeFileSync(file, 'mutated'); break;
      case 'unexpected-entry': mkdirSync(join(cell.home, '.claude')); mkdirSync(join(cell.home, '.claude', 'todos')); break;
      case 'state-tree-entry':
        plan.home = [{ path: 'state', inspected: false, exclusions: ['*/memory'] }];
        mkdirSync(join(cell.home, 'state', 'privacy-canary-project', 'memory'), { recursive: true }); break;
      case 'inspected-state': {
        const classifier = createPersistenceDiagnosticClassifier(); plan.classify = classifier.entry;
        plan.home = [{ path: '.claude.json', inspected: true, exclusions: [] }];
        plan.inspect = (_root, _path, bytes, diagnose) => inspectClaudeGlobalState(bytes, { classifyKey: classifier.key, diagnose });
        writeFileSync(join(cell.home, '.claude.json'), '{"privacy-canary-key":"privacy-canary-value"}'); break;
      }
      case 'read-failure': renameSync(cell.home, join(cell.path, 'moved-home')); break;
      case 'limit': {
        plan.home = [{ path: 'state', inspected: false, exclusions: [] }];
        mkdirSync(join(cell.home, 'state', ...Array(32).fill('deep')), { recursive: true }); break;
      }
    }
    const operation = () => checkNativePersistence(cell, plan, () => {}, value => records.push(value));
    if (failureClass === 'limit') assert.throws(operation, error => error.reason === 'limit-exceeded');
    else assert.equal(operation(), false);
    assert.equal(records.length, 1); assert.equal(records[0].class, failureClass);
    assert.ok(records[0].items.length <= 16); assert.equal(records[0].truncated, true);
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
    if (failureClass === 'inspected-state') assert.deepEqual(records[0].inspectedDiagnosis, { reason: 'unknown-global-key', token: 'unknown-1' });
  });
}

test('unsafe state-tree descendants stay opaque even when named todos', t => {
  const cell = cellFixture(t), plan = planFixture(), records = [];
  plan.home = [{ path: '.claude/projects', inspected: false, exclusions: [] }];
  mkdirSync(join(cell.home, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(cell.home, '.claude', 'projects', 'source'), 'sensitive');
  linkSync(join(cell.home, '.claude', 'projects', 'source'), join(cell.home, '.claude', 'projects', 'todos'));
  assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
  assert.equal(records[0].class, 'state-tree-entry');
  assert.match(records[0].items[0].token, /^unknown-/);
  assert.equal(records[0].items.some(item => item.token === 'todos'), false);
});

test('cancellation and budget stops do not create persistence failure records', t => {
  const cell = cellFixture(t), plan = planFixture(), records = [];
  for (const reason of ['cancelled', 'budget-exhausted']) {
    const error = new NativeStop(reason);
    assert.throws(() => checkNativePersistence(cell, plan, () => { throw error; }, value => records.push(value)), value => value === error);
  }
  assert.deepEqual(records, []);
});

test('an inspected state file disappearing at read time diagnoses a read failure', t => {
  const cell = cellFixture(t), plan = planFixture(), records = [];
  const file = join(cell.home, '.claude.json'); writeFileSync(file, '{}');
  plan.home = [{ path: '.claude.json', inspected: true, exclusions: [] }]; plan.inspect = () => true;
  let checked = 0;
  assert.equal(checkNativePersistence(cell, plan, () => { if (++checked === 3) rmSync(file); }, value => records.push(value)), false);
  assert.equal(records[0].class, 'read-failure');
  assert.deepEqual(records[0].inspectedDiagnosis, { reason: 'read-failure', token: null });
});

test('inspected state byte and container limits produce closed diagnoses', t => {
  const cell = cellFixture(t), plan = planFixture(), records = [];
  plan.home = [{ path: 'client.json', inspected: true, exclusions: [] }]; plan.inspect = () => true;
  const file = join(cell.home, 'client.json');
  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
  assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
  assert.equal(records[0].class, 'inspected-state');
  assert.deepEqual(records[0].inspectedDiagnosis, { reason: 'oversized', token: null });
  rmSync(file); mkdirSync(file);
  assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
  assert.deepEqual(records[1].inspectedDiagnosis, { reason: 'not-record', token: null });
});

test('state entry count retains the original limit-exceeded stop and one partial record', t => {
  const cell = cellFixture(t), plan = planFixture(), records = [];
  plan.home = [{ path: 'state', inspected: false, exclusions: [] }]; mkdirSync(join(cell.home, 'state'));
  for (let i = 0; i < 4096; i++) writeFileSync(join(cell.home, 'state', String(i)), '');
  assert.throws(() => checkNativePersistence(cell, plan, () => {}, value => records.push(value)), error => error.reason === 'limit-exceeded');
  assert.equal(records.length, 1); assert.equal(records[0].class, 'limit'); assert.equal(records[0].truncated, true);
});

test('a diagnostic observer failure cannot replace the persistence decision', t => {
  const cell = cellFixture(t), plan = planFixture(); writeFileSync(join(cell.home, 'unexpected'), '');
  plan.classify = () => { throw Error('observer failure'); };
  assert.equal(checkNativePersistence(cell, plan, () => {}, () => { throw Error('observer failure'); }), false);
});
