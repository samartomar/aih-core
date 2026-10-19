import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { prepare, apply, prepareManagedRemoval } from '../dist/core/index.js';
import { policy } from './fixture.mjs';
import { sandbox, authorize } from './hook-group-fixture.mjs';

let live = [];
const open = () => { const s = sandbox('aih-directories-'); live.push(s); return s; };
afterEach(() => { for (const s of live.reverse()) s.dispose(); live = []; });

async function install(s, mutate, resolutions) {
  const document = policy();
  document.selections[0].recipe.inline.operations[0].target.segments =
    ['delivered', 'nested', 'TEAM.md'].map(literal => ({ literal }));
  mutate?.(document);
  const prepared = await prepare({ useCase: 'policy', policy: document, target: { project: s.project },
    ...(resolutions ? { resolutions } : {}) }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
}

async function reviewRemoval(s, managementId = 'team-guidance', scope = 'project') {
  const result = await prepareManagedRemoval({ target: { project: s.project }, managementId, scope, mode: 'vibe' }, { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.equal(result.preparation.status, 'ready', JSON.stringify(result));
  return result.preparation;
}
async function remove(s, id, scope) {
  const prepared = await reviewRemoval(s, id, scope);
  const run = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
}

test('reviewed removal removes empty nested directories created by setup', async () => {
  const s = open();
  await install(s);
  const removal = await prepareManagedRemoval({ target: { project: s.project },
    managementId: 'team-guidance', scope: 'project', mode: 'vibe' }, { logging: 'off' });
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
  const prepared = removal.preparation;
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(existsSync(join(s.project, 'delivered', 'nested', 'TEAM.md')), true);
  const run = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(join(s.project, 'delivered', 'nested', 'TEAM.md')), false);
  assert.equal(existsSync(join(s.project, 'delivered')), false);
  assert.equal(existsSync(s.project), true);
});

test('removal stops at a parent that existed before setup', async () => {
  const s = open();
  mkdirSync(join(s.project, 'delivered'));
  await install(s);
  await remove(s);
  assert.equal(existsSync(join(s.project, 'delivered', 'nested')), false);
  assert.equal(existsSync(join(s.project, 'delivered')), true);
});

test('foreign content added after review retains its directory while empty created children are removed', async () => {
  const s = open();
  await install(s);
  const prepared = await reviewRemoval(s);
  assert.deepEqual(prepared.review.operations[0].details.declaredEffects, [
    'Remove setup-created directory if empty: delivered',
    'Remove setup-created directory if empty: delivered/nested'
  ]);
  writeFileSync(join(s.project, 'delivered', 'personal.txt'), 'keep');
  const run = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(join(s.project, 'delivered', 'nested')), false);
  assert.equal(readFileSync(join(s.project, 'delivered', 'personal.txt'), 'utf8'), 'keep');
});

test('shared sibling ownership retains parents until the last selection is removed', async () => {
  const s = open();
  await install(s, document => {
    const other = structuredClone(document.selections[0]);
    other.id = 'other'; other.managementId = 'other';
    other.recipe.inline.operations[0].target.segments = ['delivered', 'sibling', 'OTHER.md'].map(literal => ({ literal }));
    document.selections.push(other);
  });
  await remove(s);
  assert.equal(existsSync(join(s.project, 'delivered', 'nested')), false);
  assert.equal(existsSync(join(s.project, 'delivered', 'sibling', 'OTHER.md')), true);
  await remove(s, 'other');
  assert.equal(existsSync(join(s.project, 'delivered')), false);
});

test('two selections sharing one file retain its directory until the final owner removes it', async () => {
  const s = open();
  await install(s);
  await install(s, document => {
    document.selections[0].id = 'second'; document.selections[0].managementId = 'second';
  }, [{ selectionId: 'second', operationId: 'write', choice: 'adopt',
    observedSha256: createHash('sha256').update(readFileSync(join(s.project, 'delivered', 'nested', 'TEAM.md'))).digest('hex') }]);
  await remove(s);
  assert.equal(existsSync(join(s.project, 'delivered', 'nested', 'TEAM.md')), true);
  await remove(s, 'second');
  assert.equal(existsSync(join(s.project, 'delivered')), false);
});

test('managed-set subtraction uses the same bounded directory cleanup', async () => {
  const s = open();
  await install(s, document => { document.managedSelections = [{ id: 'set', scope: 'project', members: ['team-guidance'] }]; });
  const document = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [],
    managedSelections: [{ id: 'set', scope: 'project', members: [] }] };
  const prepared = await prepare({ useCase: 'policy', policy: document, target: { project: s.project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(join(s.project, 'delivered')), false);
});

test('old file custody without directory evidence never implies directory ownership', async () => {
  const s = open();
  await install(s);
  const digest = createHash('sha256').update(realpathSync.native(s.project)).digest('hex');
  const receipt = join(s.home, '.aih', 'core', 'ownership', `${digest}.json`);
  const legacy = JSON.parse(readFileSync(receipt, 'utf8'));
  delete legacy.directories;
  legacy.schema = 'urn:aihq:core:ownership:1.0.0';
  writeFileSync(receipt, JSON.stringify(legacy));
  await remove(s);
  assert.equal(existsSync(join(s.project, 'delivered', 'nested', 'TEAM.md')), false);
  assert.equal(existsSync(join(s.project, 'delivered', 'nested')), true);
});

test('a replaced directory before review is preserved even when it contains unchanged managed bytes', async () => {
  const s = open();
  await install(s);
  renameSync(join(s.project, 'delivered'), join(s.project, 'old-delivered'));
  mkdirSync(join(s.project, 'delivered', 'nested'), { recursive: true });
  writeFileSync(join(s.project, 'delivered', 'nested', 'TEAM.md'), "Read the project's contribution guide.\n");
  await remove(s);
  assert.equal(existsSync(join(s.project, 'delivered', 'nested')), true);
});

test('a directory replaced by a link after review rejects Apply and preserves both trees', async () => {
  const s = open();
  await install(s);
  const prepared = await reviewRemoval(s);
  renameSync(join(s.project, 'delivered'), join(s.project, 'original'));
  symlinkSync(join(s.project, 'original'), join(s.project, 'delivered'), process.platform === 'win32' ? 'junction' : 'dir');
  const run = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.ok(run.diagnostics.some(item => item.code === 'REVIEW_STALE'), JSON.stringify(run));
  assert.equal(existsSync(join(s.project, 'original', 'nested', 'TEAM.md')), true);
});

test('user-home cleanup is scoped to setup-created descendants and keeps the home', async () => {
  const s = open();
  await install(s, document => {
    const selection = document.selections[0]; selection.scope = 'user';
    selection.recipe.inline.targets = ['user'];
    const op = selection.recipe.inline.operations[0]; op.scope = 'user'; op.target.root = 'userHome';
  });
  await remove(s, 'team-guidance', 'user');
  assert.equal(existsSync(join(s.home, 'delivered')), false);
  assert.equal(existsSync(s.home), true);
});
