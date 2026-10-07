import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { linkSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
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

test('diagnostic items classify the parent at its own location and leave root parents null', t => {
  const cell = cellFixture(t), records = [], plan = planFixture();
  plan.home = [{ path: '.claude/projects', inspected: false, exclusions: ['*/memory'] }];
  mkdirSync(join(cell.home, '.claude', 'projects', 'privacy-canary-parent', 'memory'), { recursive: true });
  assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
  assert.match(records[0].items[0].parent, /^unknown-/);
  assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
  const rootCell = cellFixture(t), rootRecords = [];
  writeFileSync(join(rootCell.home, 'privacy-canary-root'), '');
  checkNativePersistence(rootCell, planFixture(), () => {}, value => rootRecords.push(value));
  assert.equal(rootRecords[0].items[0].parent, null);
});

const cachePath = '.cache/claude-cli-nodejs';

test('diagnostics collect offenders across branches and both roots without reading rejected bytes', t => {
  const cell = cellFixture(t), records = [], plan = planFixture();
  mkdirSync(join(cell.home, '.claude')); writeFileSync(join(cell.home, '.claude', 'sessions'), 'privacy-canary-content');
  mkdirSync(join(cell.home, '.config')); writeFileSync(join(cell.home, '.config', 'anthropic'), 'privacy-canary-content');
  writeFileSync(join(cell.project, 'CLAUDE.md'), 'privacy-canary-content');
  let opened = 0;
  const read = t.mock.method(fs, 'openSync', () => { opened++; throw Error('Rejected contents must not be opened'); });
  syncBuiltinESMExports();
  try {
    assert.equal(checkNativePersistence(cell, plan, () => {}), false);
    assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
    assert.deepEqual(records[0].items.map(({ root, depth, parent }) => ({ root, depth, parent })), [
      { root: 'home', depth: 1, parent: null }, { root: 'home', depth: 2, parent: '.claude' },
      { root: 'home', depth: 1, parent: null }, { root: 'home', depth: 2, parent: '.config' },
      { root: 'project', depth: 1, parent: null }
    ]);
    assert.equal(records[0].class, 'unexpected-entry');
    assert.equal(opened, 0);
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
});

test('parent disclosure stays opaque for wrong case, wrong location and repeated dynamic parents', t => {
  for (const parts of [['.Claude'], ['privacy-canary-parent', '.claude'], ['privacy-canary-parent']]) {
    const cell = cellFixture(t), records = [], plan = planFixture();
    mkdirSync(join(cell.home, ...parts), { recursive: true });
    writeFileSync(join(cell.home, ...parts, 'privacy-canary-child-a'), '');
    writeFileSync(join(cell.home, ...parts, 'privacy-canary-child-b'), '');
    checkNativePersistence(cell, plan, () => {}, value => records.push(value));
    const children = records[0].items.filter(item => item.depth === parts.length + 1);
    assert.equal(children.length, 2);
    assert.match(children[0].parent, /^unknown-/); assert.match(children[1].parent, /^unknown-/);
    assert.notEqual(children[0].parent, children[1].parent);
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
  }
});

test('later metadata read failures preserve the first failure and leave coverage truncated', t => {
  const cell = cellFixture(t), records = [], plan = planFixture();
  writeFileSync(join(cell.home, 'a-privacy-canary-offender'), '');
  mkdirSync(join(cell.home, 'b-privacy-canary-unreadable'));
  writeFileSync(join(cell.project, 'CLAUDE.md'), '');
  const original = fs.readdirSync;
  const read = t.mock.method(fs, 'readdirSync', (path, ...args) => path === join(cell.home, 'b-privacy-canary-unreadable') ?
    (() => { throw Error('privacy-canary-read-error'); })() : original(path, ...args));
  syncBuiltinESMExports();
  try {
    assert.equal(checkNativePersistence(cell, plan, () => {}), false);
    assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
    assert.equal(records[0].class, 'unexpected-entry'); assert.equal(records[0].truncated, true);
    assert.ok(records[0].items.some(item => item.root === 'project' && item.token === 'CLAUDE.md'));
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
});

test('continued diagnostics never enumerate links or changed directory identity boundaries', t => {
  const cell = cellFixture(t), records = [], plan = planFixture();
  writeFileSync(join(cell.home, 'a-privacy-canary-offender'), '');
  const target = join(cell.path, 'privacy-canary-link-target'); mkdirSync(target);
  writeFileSync(join(target, 'CLAUDE.md'), 'privacy-canary-outside');
  const link = join(cell.home, 'b-privacy-canary-link');
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const unstable = join(cell.home, 'c-privacy-canary-unstable'); mkdirSync(unstable);
  const originalStat = fs.lstatSync, originalRead = fs.readdirSync;
  let seen = 0, crossed = 0;
  const stat = t.mock.method(fs, 'lstatSync', (path, options) => {
    const value = originalStat(path, options);
    // Numeric Windows inode values may round away +1; mode is an exactly represented identity field.
    if (path === unstable && ++seen >= 2) Object.defineProperty(value, 'mode', { value: options?.bigint ? value.mode ^ 0o010n : value.mode ^ 0o010 });
    return value;
  });
  const read = t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === link || path === unstable) crossed++;
    return originalRead(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
    assert.equal(records[0].class, 'unexpected-entry');
    assert.equal(crossed, 0, 'links and changed directory identities must never be enumerated');
    assert.equal(records[0].items.some(item => item.token === 'CLAUDE.md'), false);
    assert.equal(records[0].items.filter(item => item.kind === 'other').length, 1);
  } finally { stat.mock.restore(); read.mock.restore(); syncBuiltinESMExports(); }
});

test('continued diagnostics spend the remaining entry budget and stop at the depth boundary', t => {
  const cell = cellFixture(t), records = [], plan = planFixture();
  const state = join(cell.home, 'b-state'); mkdirSync(state);
  plan.home = [{ path: 'b-state', inspected: false, exclusions: [] }];
  writeFileSync(join(cell.home, 'a-privacy-canary-offender'), '');
  // A metadata-only tree can reach a traversal cap without reaching the offender cap.
  for (let i = 0; i < 4096; i++) writeFileSync(join(state, String(i)), '');
  let entries = 0;
  const original = fs.lstatSync;
  const stat = t.mock.method(fs, 'lstatSync', (path, options) => {
    if (!options?.bigint && path.startsWith(state + sep)) entries++;
    return original(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(checkNativePersistence(cell, plan, () => {}), false);
    assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
    assert.ok(entries <= 4094); assert.equal(records[0].class, 'unexpected-entry');
    assert.equal(records[0].truncated, true);
  } finally { stat.mock.restore(); syncBuiltinESMExports(); }
  rmSync(state, { recursive: true }); mkdirSync(join(state, ...Array(32).fill('d')), { recursive: true });
  const deepest = join(state, ...Array(32).fill('d'));
  const lastAllowed = join(state, ...Array(31).fill('d')); let reachedLastAllowed = false, crossedDepth = 0;
  const originalRead = fs.readdirSync;
  const read = t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === lastAllowed) reachedLastAllowed = true;
    if (path === deepest) crossedDepth++;
    return originalRead(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(checkNativePersistence(cell, plan, () => {}, () => {}), false);
    assert.equal(reachedLastAllowed, true);
    assert.equal(crossedDepth, 0, 'depth boundary must not be enumerated');
  }
  finally { read.mock.restore(); syncBuiltinESMExports(); }
});

test('a later lstat failure does not replace the original class or hide another root', t => {
  const cell = cellFixture(t), records = [], plan = planFixture();
  writeFileSync(join(cell.home, 'a-privacy-canary-first'), '');
  const missing = join(cell.home, 'b-privacy-canary-read-failure'); writeFileSync(missing, '');
  writeFileSync(join(cell.project, 'CLAUDE.md'), '');
  const original = fs.lstatSync;
  const stat = t.mock.method(fs, 'lstatSync', (path, options) => {
    if (path === missing) throw Error('privacy-canary-read-failure'); return original(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
    assert.equal(records[0].class, 'unexpected-entry');
    assert.equal(records[0].items.some(item => item.kind === 'other'), true);
    assert.equal(records[0].items.some(item => item.root === 'project'), true);
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
  } finally { stat.mock.restore(); syncBuiltinESMExports(); }
});

test('failed pins forbid diagnostic traversal of the cell', t => {
  const cell = cellFixture(t), plan = planFixture(), records = [];
  cell.pins = pathPins(cell.path); cell.pins.at(-1).identity = 'invalid';
  let enumerated = 0;
  const read = t.mock.method(fs, 'readdirSync', () => { enumerated++; throw Error('No crossing failed pins'); });
  syncBuiltinESMExports();
  try {
    assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
    assert.equal(enumerated, 0); assert.equal(records[0].class, 'pins');
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
});

test('diagnostics add no budget or cancellation gate after a decision', t => {
  for (const reason of ['cancelled', 'budget-exhausted']) {
    const cell = cellFixture(t), plan = planFixture(), records = [];
    writeFileSync(join(cell.home, 'privacy-canary-offender'), ''); mkdirSync(join(cell.project, 'privacy-canary-branch'));
    let without = 0, withDiagnostics = 0;
    assert.equal(checkNativePersistence(cell, plan, () => { without++; }), false);
    assert.equal(checkNativePersistence(cell, plan, () => {
      if (++withDiagnostics > without) throw new NativeStop(reason);
    }, value => records.push(value)), false);
    assert.equal(withDiagnostics, without); assert.equal(records.length, 1);
  }
});
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
  if (expectedItem) {
    const { parent, ...item } = records[0].items[0];
    assert.deepEqual(item, expectedItem);
    assert.ok(parent === null || typeof parent === 'string');
  }
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

test('the failed walk collects at most 16 metadata offenders and marks them partial', t => {
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
    if (failureClass === 'limit') {
      assert.throws(() => checkNativePersistence(cell, plan, () => {}), error => error.reason === 'limit-exceeded');
      assert.throws(operation, error => error.reason === 'limit-exceeded');
    } else {
      assert.equal(checkNativePersistence(cell, plan, () => {}), false);
      assert.equal(operation(), false);
    }
    assert.equal(records.length, 1); assert.equal(records[0].class, failureClass);
    assert.ok(records[0].items.length <= 16); assert.equal(records[0].truncated, true);
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
    if (failureClass === 'inspected-state') {
      assert.equal(records[0].inspectedDiagnosis.reason, 'unknown-global-key');
      assert.match(records[0].inspectedDiagnosis.token, /^unknown-/);
    }
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

test('diagnostic traversal compares exact directory identities above the safe-integer range', t => {
  const cell = cellFixture(t), records = [], plan = planFixture();
  writeFileSync(join(cell.home, 'a-privacy-canary-offender'), '');
  const swapped = join(cell.home, 'b-privacy-canary-swapped'); mkdirSync(swapped);
  writeFileSync(join(swapped, 'privacy-canary-inner'), '');
  // Distinct inode IDs that round to the same JavaScript number.
  const before = 9007199254740992n, after = 9007199254740993n;
  assert.equal(Number(before), Number(after));
  const originalStat = fs.lstatSync, originalRead = fs.readdirSync;
  let calls = 0, crossed = 0;
  const stat = t.mock.method(fs, 'lstatSync', (path, options) => {
    const value = originalStat(path, options);
    if (path !== swapped) return value;
    const ino = ++calls >= 2 ? after : before;
    Object.defineProperty(value, 'ino', { value: options?.bigint ? ino : Number(ino) });
    return value;
  });
  const read = t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === swapped) crossed++;
    return originalRead(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(checkNativePersistence(cell, plan, () => {}, value => records.push(value)), false);
    assert.equal(records[0].class, 'unexpected-entry');
    assert.equal(crossed, 0, 'a directory whose exact identity changed must never be enumerated');
  } finally { stat.mock.restore(); read.mock.restore(); syncBuiltinESMExports(); }
});
