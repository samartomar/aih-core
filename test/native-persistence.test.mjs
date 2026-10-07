import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkNativePersistence } from '../dist/core/internal/native-cell.js';
import { createPersistenceDiagnosticClassifier } from '../src/harness/native/persistence-diagnostics.mjs';
import { inspectClaudeGlobalState } from '../src/harness/native/claude-state.mjs';
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
