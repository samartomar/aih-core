import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import inventorySchema from '../dist/core/schemas/managed-inventory-result/1.0.0.json' with { type: 'json' };
import { apply, listManagedSelections, prepare } from '../dist/core/index.js';
import { policy } from './fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-managed-inventory-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const home = join(scratch, 'home');
before(() => { mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

test('empty managed inventory is complete and creates no custody state', async () => {
  const project = mkdtempSync(join(scratch, 'project-'));
  const result = await listManagedSelections({ target: { project }, scope: 'both' });
  assert.equal(result.schema, 'urn:aihq:core:managed-inventory-result:1.0.0');
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.target, { project: realpathSync.native(project) });
  assert.equal(result.scope, 'both');
  assert.deepEqual(result.selections, []);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.limits.budgetMs, 30000);
  const validate = new Ajv2020({ strict: true }).compile(inventorySchema);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('inventory lists a managed project selection but not matching bytes in a clone', async () => {
  const project = mkdtempSync(join(scratch, 'owned-'));
  const first = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first.diagnostics));
  const applied = await apply(first.prepared,
    { reviewDigest: first.review.reviewDigest, approved: true, origin: 'automation' }, { logging: 'off' });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));

  const inventory = await listManagedSelections({ target: { project }, scope: 'project' });
  assert.equal(inventory.status, 'complete', JSON.stringify(inventory.diagnostics));
  assert.deepEqual(inventory.selections, [{ managementId: 'team-guidance', scope: 'project',
    custody: 'claim', memberCount: 1, sharedMemberCount: 0 }]);

  const clone = mkdtempSync(join(scratch, 'clone-'));
  writeFileSync(join(clone, 'TEAM.md'), readFileSync(join(project, 'TEAM.md')));
  const other = await listManagedSelections({ target: { project: clone }, scope: 'project' });
  assert.equal(other.status, 'complete');
  assert.deepEqual(other.selections, []);
});

test('inventory validates its public request and cancellation without creating state', async () => {
  const project = mkdtempSync(join(scratch, 'invalid-'));
  const hadState = existsSync(join(home, '.aih'));
  const invalid = await listManagedSelections({ target: { project }, scope: 'both', extra: true });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.diagnostics[0].reason, 'request-shape');
  const relative = await listManagedSelections({ target: { project: 'relative/path' }, scope: 'both' });
  assert.equal(relative.status, 'invalid');
  assert.equal(relative.diagnostics[0].reason, 'request-shape');
  const budget = await listManagedSelections({ target: { project }, scope: 'both' }, { budgetMs: 0 });
  assert.equal(budget.status, 'invalid');
  assert.equal(budget.diagnostics[0].reason, 'budget-ms');
  const validate = new Ajv2020({ strict: true }).compile(inventorySchema);
  assert.equal(validate(budget), true, JSON.stringify(validate.errors));
  const cancelled = await listManagedSelections({ target: { project }, scope: 'both' },
    { signal: AbortSignal.abort() });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.selections, []);
  assert.equal(existsSync(join(home, '.aih')), hadState);
});

test('user scoped custody is listed independently of project scope', async () => {
  const project = mkdtempSync(join(scratch, 'user-'));
  const document = policy();
  document.selections[0].scope = 'user';
  document.selections[0].recipe.inline.targets = ['user'];
  document.selections[0].recipe.inline.operations[0].scope = 'user';
  document.selections[0].recipe.inline.operations[0].target.root = 'userState';
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first.diagnostics));
  const applied = await apply(first.prepared,
    { reviewDigest: first.review.reviewDigest, approved: true, origin: 'automation' }, { logging: 'off' });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
  const projectOnly = await listManagedSelections({ target: { project }, scope: 'project' });
  assert.deepEqual(projectOnly.selections, []);
  const userOnly = await listManagedSelections({ target: { project }, scope: 'user' });
  assert.equal(userOnly.status, 'complete', JSON.stringify(userOnly.diagnostics));
  assert.deepEqual(userOnly.selections, [{ managementId: 'team-guidance', scope: 'user',
    custody: 'claim', memberCount: 1, sharedMemberCount: 0 }]);
});

test('two recorded claims on one custody member each report one shared member', async () => {
  const project = mkdtempSync(join(scratch, 'shared-'));
  const first = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first.diagnostics));
  const applied = await apply(first.prepared,
    { reviewDigest: first.review.reviewDigest, approved: true, origin: 'automation' }, { logging: 'off' });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
  const key = createHash('sha256').update(realpathSync.native(project)).digest('hex');
  const receipt = join(home, '.aih', 'core', 'ownership', `${key}.json`);
  const state = JSON.parse(readFileSync(receipt));
  const member = Object.values(state.members)[0];
  member.claims.push({ ...member.claims[0], managementId: 'other-guidance' });
  writeFileSync(receipt, JSON.stringify(state));
  const inventory = await listManagedSelections({ target: { project }, scope: 'project' });
  assert.equal(inventory.status, 'complete', JSON.stringify(inventory.diagnostics));
  assert.deepEqual(inventory.selections, ['other-guidance', 'team-guidance'].map(managementId => ({
    managementId, scope: 'project', custody: 'claim', memberCount: 1, sharedMemberCount: 1
  })));
});

test('claimless custody is reconciled and corrupt foreign custody makes user inventory incomplete', async () => {
  const project = mkdtempSync(join(scratch, 'legacy-'));
  const first = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first.diagnostics));
  const applied = await apply(first.prepared,
    { reviewDigest: first.review.reviewDigest, approved: true, origin: 'automation' }, { logging: 'off' });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
  const key = createHash('sha256').update(realpathSync.native(project)).digest('hex');
  const receipt = join(home, '.aih', 'core', 'ownership', `${key}.json`);
  const original = readFileSync(receipt);
  try {
    const legacy = JSON.parse(original);
    delete Object.values(legacy.members)[0].claims;
    delete Object.values(legacy.members)[0].descriptor;
    writeFileSync(receipt, JSON.stringify(legacy));
    const listed = await listManagedSelections({ target: { project }, scope: 'project' });
    assert.equal(listed.status, 'complete', JSON.stringify(listed.diagnostics));
    assert.deepEqual(listed.selections, [{ managementId: 'team-guidance', scope: 'project',
      custody: 'legacy-reconcile', memberCount: 1, sharedMemberCount: 0 }]);
    writeFileSync(receipt, '{');
    const own = await listManagedSelections({ target: { project }, scope: 'project' });
    assert.equal(own.status, 'incomplete');
    assert.equal(own.diagnostics[0].reason, 'ownership-unverifiable');
    const other = mkdtempSync(join(scratch, 'foreign-'));
    const user = await listManagedSelections({ target: { project: other }, scope: 'user' });
    assert.equal(user.status, 'incomplete');
    assert.equal(user.diagnostics[0].reason, 'ownership-unverifiable');
    const otherProject = await listManagedSelections({ target: { project: other }, scope: 'project' });
    assert.equal(otherProject.status, 'complete');
  } finally { writeFileSync(receipt, original); }
});

const sha = value => createHash('sha256').update(value).digest('hex');
let homeNow = home;
/** A new home whose protected custody root Core itself created, by applying one throwaway selection. */
async function freshHome() {
  homeNow = realpathSync.native(mkdtempSync(join(scratch, 'home-')));
  process.env.HOME = homeNow; process.env.USERPROFILE = homeNow;
  const seeded = await prepare({ useCase: 'policy', policy: policy(), target: { project: mkdtempSync(join(scratch, 'seed-')) } }, { logging: 'off' });
  const run = await apply(seeded.prepared, { reviewDigest: seeded.review.reviewDigest, approved: true, origin: 'automation' }, { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
}
const receiptFile = root => join(homeNow, '.aih', 'core', 'ownership', `${sha(root)}.json`);
const claimKey = (scope, id, anchor) => `${scope}:${sha(process.platform === 'win32' ? anchor.toLowerCase() : anchor)}:${id}`;
const claim = (scope, managementId) => ({ managementId, scope, sets: [], requires: [] });
const ownership = (target, extra = {}) => ({ schema: 'urn:aihq:core:ownership:1.0.0', target, members: {}, ...extra });
const selectionsOf = (target, claims) => Object.fromEntries(claims.map(item => [claimKey(item.scope, item.managementId, target), item]));
/** Writes a protected-store receipt the way Core's own tests do, and returns an undo function. */
function plant(root, value) {
  mkdirSync(join(homeNow, '.aih', 'core', 'ownership'), { recursive: true });
  const path = receiptFile(root); const previous = existsSync(path) ? readFileSync(path) : undefined;
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return () => { if (previous === undefined) rmSync(path, { force: true }); else writeFileSync(path, previous); };
}
const valid = result => { const check = new Ajv2020({ strict: true }).compile(inventorySchema); assert.equal(check(result), true, JSON.stringify(check.errors)); };

test('a zero-member top-level claim is listed once, merged with member claims and sorted deterministically', async () => {
  await freshHome();
  const project = realpathSync.native(mkdtempSync(join(scratch, 'zero-')));
  const homeRoot = realpathSync.native(homeNow);
  const undo = [
    plant(project, ownership(project, {
      selections: selectionsOf(project, [claim('project', 'zeta'), claim('project', 'beta'), claim('project', 'Alpha')]),
      members: { 'b.md': { managementId: 'beta', recipeIdentity: `sha256:${'a'.repeat(64)}`, sha256: sha('b'), mode: 0o644,
        descriptor: { kind: 'file', path: 'b.md' }, claims: [claim('project', 'beta')] } } })),
    plant(homeRoot, ownership(homeRoot, { selections: selectionsOf(homeRoot, [claim('user', 'global-one')]) }))
  ];
  try {
    const result = await listManagedSelections({ target: { project }, scope: 'both' });
    assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
    valid(result);
    assert.deepEqual(result.selections.map(item => [item.scope, item.managementId, item.custody, item.memberCount, item.sharedMemberCount]), [
      ['project', 'Alpha', 'claim', 0, 0], ['project', 'beta', 'claim', 1, 0], ['project', 'zeta', 'claim', 0, 0],
      ['user', 'global-one', 'claim', 0, 0]], 'code point order, project before user, one row per pair');
    const projectOnly = await listManagedSelections({ target: { project }, scope: 'project' });
    assert.deepEqual(projectOnly.selections.map(item => item.managementId), ['Alpha', 'beta', 'zeta']);
    const userOnly = await listManagedSelections({ target: { project }, scope: 'user' });
    assert.deepEqual(userOnly.selections.map(item => item.managementId), ['global-one']);
    assert.equal(JSON.stringify(result).includes('.aih'), false, 'no receipt paths leak');
  } finally { undo.reverse().forEach(fn => fn()); }
});

test('a foreign project receipt with identical claims adds nothing to this project or the user view', async () => {
  await freshHome();
  const project = realpathSync.native(mkdtempSync(join(scratch, 'mine-')));
  const foreign = realpathSync.native(mkdtempSync(join(scratch, 'theirs-')));
  const undo = plant(foreign, ownership(foreign, { selections: selectionsOf(foreign, [claim('project', 'their-selection')]) }));
  try {
    for (const scope of ['project', 'user', 'both']) {
      const result = await listManagedSelections({ target: { project }, scope });
      assert.equal(result.status, 'complete', `${scope}: ${JSON.stringify(result.diagnostics)}`);
      assert.deepEqual(result.selections, [], scope);
    }
  } finally { undo(); }
});

test('claimless custody in a root shared by project and home is omitted with an ambiguous-scope diagnostic', async () => {
  await freshHome();
  const homeRoot = realpathSync.native(homeNow);
  const undo = plant(homeRoot, ownership(homeRoot, { members: { 'legacy.md': {
    managementId: 'legacy-item', recipeIdentity: `sha256:${'a'.repeat(64)}`, sha256: sha('x'), mode: 0o644 } } }));
  try {
    for (const scope of ['project', 'user', 'both']) {
      const result = await listManagedSelections({ target: { project: homeNow }, scope });
      assert.equal(result.status, 'incomplete', scope);
      assert.deepEqual(result.diagnostics.map(item => [item.code, item.reason]), [['PREREQUISITE_UNAVAILABLE', 'ambiguous-scope']], scope);
      assert.deepEqual(result.selections, [], `${scope}: the ambiguous record is omitted, not assigned`);
      valid(result);
    }
  } finally { undo(); }
});

test('mixed claimed and claimless members make the whole selection legacy-reconcile with both counted', async () => {
  await freshHome();
  const project = realpathSync.native(mkdtempSync(join(scratch, 'mixed-')));
  const identity = `sha256:${'a'.repeat(64)}`;
  const undo = plant(project, ownership(project, { members: {
    'new.md': { managementId: 'mixed', recipeIdentity: identity, sha256: sha('n'), mode: 0o644, descriptor: { kind: 'file', path: 'new.md' }, claims: [claim('project', 'mixed')] },
    'old.md': { managementId: 'mixed', recipeIdentity: identity, sha256: sha('o'), mode: 0o644 } } }));
  try {
    const result = await listManagedSelections({ target: { project }, scope: 'project' });
    assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
    assert.deepEqual(result.selections, [{ managementId: 'mixed', scope: 'project', custody: 'legacy-reconcile', memberCount: 2, sharedMemberCount: 0 }]);
  } finally { undo(); }
});

test('count, byte and output bounds return incomplete limit-exceeded instead of a truncated complete list', async () => {
  await freshHome();
  const project = realpathSync.native(mkdtempSync(join(scratch, 'bounds-')));
  const store = join(homeNow, '.aih', 'core', 'ownership');
  mkdirSync(store, { recursive: true });
  const cleanup = [];
  const expectLimit = async (label, scope) => {
    const result = await listManagedSelections({ target: { project }, scope });
    assert.equal(result.status, 'incomplete', `${label}: ${JSON.stringify(result.diagnostics)}`);
    assert.deepEqual(result.diagnostics.map(item => [item.code, item.reason]), [['PREREQUISITE_UNAVAILABLE', 'limit-exceeded']], label);
    assert.deepEqual(result.selections, [], `${label}: no silently truncated rows`);
    valid(result);
  };
  try {
    // Count: more than 8192 enumerated receipt entries.
    const names = Array.from({ length: 8193 }, (_, index) => `${index.toString(16).padStart(64, '0')}.json`);
    for (const name of names) writeFileSync(join(store, name), '{}');
    await expectLimit('count', 'user');
    names.forEach(name => rmSync(join(store, name), { force: true }));
    // Bytes: valid receipts (each under the 1 MiB per-file cap) totalling more than 32 MiB.
    const padded = Array.from({ length: 36 }, (_, index) => {
      const target = join(scratch, `pad-${index}`);
      const text = JSON.stringify(ownership(target));
      return [join(store, `${sha(target)}.json`), text + ' '.repeat(1_000_000 - text.length)];
    });
    for (const [path, text] of padded) writeFileSync(path, text);
    try { await expectLimit('bytes', 'user'); } finally { padded.forEach(([path]) => rmSync(path, { force: true })); }
    // Output: valid claims whose serialized rows exceed 1 MiB.
    const homeRoot = realpathSync.native(homeNow);
    const ids = Array.from({ length: 4096 }, (_, index) => `${index.toString(36).padStart(8, '0')}${'x'.repeat(120)}`);
    // One member per receipt carries 4096 claims, which stays under the 1 MiB per-receipt cap.
    const crowded = (root, scope) => ownership(root, { members: { 'crowded.md': { managementId: ids[0], sha256: sha('c'), mode: 0o644,
      recipeIdentity: `sha256:${'a'.repeat(64)}`, descriptor: { kind: 'file', path: 'crowded.md' }, claims: ids.map(id => claim(scope, id)) } } });
    cleanup.push(plant(project, crowded(project, 'project')));
    cleanup.push(plant(homeRoot, crowded(homeRoot, 'user')));
    await expectLimit('output', 'both');
  } finally { cleanup.reverse().forEach(fn => fn()); }
});

test('an exhausted time budget returns incomplete time-budget', async () => {
  await freshHome();
  const project = realpathSync.native(mkdtempSync(join(scratch, 'budget-')));
  const store = join(homeNow, '.aih', 'core', 'ownership');
  mkdirSync(store, { recursive: true });
  const names = Array.from({ length: 2000 }, (_, index) => `${(index + 1).toString(16).padStart(64, 'e')}.json`);
  for (const name of names) writeFileSync(join(store, name), '{}');
  try {
    const result = await listManagedSelections({ target: { project }, scope: 'user' }, { budgetMs: 1 });
    assert.equal(result.status, 'incomplete', JSON.stringify(result));
    assert.deepEqual(result.diagnostics.map(item => [item.code, item.reason]), [['PREREQUISITE_UNAVAILABLE', 'time-budget']]);
    assert.equal(result.limits.budgetMs, 1);
    valid(result);
  } finally { names.forEach(name => rmSync(join(store, name), { force: true })); }
});
