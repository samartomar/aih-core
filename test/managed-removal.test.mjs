import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepare, apply, listManagedSelections, prepareManagedRemoval } from '../dist/core/index.js';
import { policy } from './fixture.mjs';
import { sandbox } from './hook-group-fixture.mjs';
import { fakeFetch, orgRoutes, orgSource, orgDocument, enterprisePolicy } from './fixtures/github-org.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const approve = prepared => ({ reviewDigest: prepared.review.reviewDigest, approved: true, origin: 'automation' });
const removal = (s, extra = {}) => ({ target: { project: s.project }, managementId: 'team-guidance', scope: 'project', mode: 'vibe', ...extra });
const runsDir = s => join(s.home, '.aih', 'core', 'runs');
const receiptPath = (s, root) => join(s.home, '.aih', 'core', 'ownership', `${sha(root)}.json`);

/** Installs the standard project guidance selection through the ordinary policy path. */
async function install(s, mutate) {
  const document = policy(); mutate?.(document);
  const prepared = await prepare({ useCase: 'policy', policy: document, target: { project: s.project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const result = await apply(prepared.prepared, approve(prepared), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result));
}

let live = [];
const open = () => { const s = sandbox('aih-managed-removal-'); live.push(s); return s; };
afterEach(() => { for (const s of live) s.dispose(); live = []; });

test('an unknown management ID is an explicit effect-free absence with no handle or history', async () => {
  const s = open();
  const result = await prepareManagedRemoval(removal(s));
  assert.equal(result.schema, 'urn:aihq:core:managed-removal-preparation:1.0.0');
  assert.equal(result.package.name, '@aihq/core');
  assert.equal(result.disposition, 'absent', JSON.stringify(result));
  assert.deepEqual([result.scope, result.mode, result.managementId], ['project', 'vibe', 'team-guidance']);
  assert.equal(Object.hasOwn(result, 'preparation'), false);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(existsSync(runsDir(s)), false);
});

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const claimKey = (scope, id, anchor) => `${scope}:${sha(process.platform === 'win32' ? anchor.toLowerCase() : anchor)}:${id}`;
const projectReceipt = s => receiptPath(s, realpathSync.native(s.project));
const rewriteReceipt = (s, change) => { const path = projectReceipt(s); const value = readJson(path); change(value); writeFileSync(path, JSON.stringify(value)); };
const alsoNamed = (selection, id, file, extra = {}) => {
  const copy = structuredClone(selection);
  copy.id = id; copy.managementId = id; Object.assign(copy, extra);
  copy.recipe.inline.operations[0].target.segments = [{ literal: file }];
  return copy;
};

test('a final claim prepares the existing reviewed removal and approved apply removes only that member', async () => {
  const s = open();
  await install(s);
  writeFileSync(join(s.project, 'human.txt'), 'untouched');
  const result = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.equal(result.preparation.status, 'ready', JSON.stringify(result.preparation.diagnostics));
  assert.equal(result.preparation.review.schema, 'urn:aihq:core:prepared-work:1.1.0');
  assert.deepEqual(result.preparation.review.operations.map(op => [op.kind, op.effects, op.ownership]), [['file.remove', 'remove-file', 'managed']]);
  assert.equal(existsSync(join(s.project, 'TEAM.md')), true);
  const run = await apply(result.preparation.prepared, approve(result.preparation), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(join(s.project, 'TEAM.md')), false);
  assert.equal(readFileSync(join(s.project, 'human.txt'), 'utf8'), 'untouched');
  assert.equal((await prepareManagedRemoval(removal(s))).disposition, 'absent');
});

test('a claim another selection requires is retained with a fixed reason and no handle', async () => {
  const s = open();
  const base = policy().selections[0];
  await install(s, document => { document.selections = [alsoNamed(base, 'base-item', 'BASE.md'), alsoNamed(base, 'top-item', 'TOP.md', { requires: ['base-item'] })]; });
  const retained = await prepareManagedRemoval(removal(s, { managementId: 'base-item' }), { logging: 'off' });
  assert.equal(retained.disposition, 'retained', JSON.stringify(retained));
  assert.deepEqual(retained.diagnostics.map(item => [item.code, item.reason]), [['PREREQUISITE_UNAVAILABLE', 'dependency-retained']]);
  assert.equal(Object.hasOwn(retained, 'preparation'), false);
  assert.equal(existsSync(join(s.project, 'BASE.md')), true);
  const top = await prepareManagedRemoval(removal(s, { managementId: 'top-item' }), { logging: 'off' });
  assert.equal(top.disposition, 'prepared', JSON.stringify(top));
});

test('a dependency claim change after a removal review rejects Apply before removing the selected member', async () => {
  const s = open();
  const base = policy().selections[0];
  await install(s, document => { document.selections = [alsoNamed(base, 'base-item', 'BASE.md'),
    alsoNamed(base, 'top-item', 'TOP.md', { requires: ['base-item'] })]; });
  const top = await prepareManagedRemoval(removal(s, { managementId: 'top-item' }), { logging: 'off' });
  assert.equal(top.disposition, 'prepared', JSON.stringify(top));
  assert.equal(top.preparation.status, 'ready', JSON.stringify(top.preparation.diagnostics));
  rewriteReceipt(s, value => {
    const topClaim = Object.values(value.selections).find(item => item.managementId === 'top-item');
    topClaim.requires = [];
  });
  const stale = await apply(top.preparation.prepared, approve(top.preparation), { logging: 'off' });
  assert.notEqual(stale.completion, 'complete', JSON.stringify(stale));
  assert.equal(existsSync(join(s.project, 'TOP.md')), true, 'no reviewed removal runs after a dependency changes');
});

test('claimless legacy custody asks for reconciliation, including when mixed with a claimed member', async () => {
  const s = open();
  await install(s);
  rewriteReceipt(s, value => { delete value.selections; for (const member of Object.values(value.members)) { delete member.claims; delete member.descriptor; } });
  const legacy = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(legacy.disposition, 'reconcile-required', JSON.stringify(legacy));
  assert.deepEqual(legacy.diagnostics.map(item => [item.code, item.reason]), [['PREREQUISITE_UNAVAILABLE', 'legacy-reconcile']]);
  assert.match(legacy.diagnostics[0].guidance, /original recipe/);
  assert.equal(Object.hasOwn(legacy, 'preparation'), false);
  // A claimed member plus a claimless one under one ID refuses the whole ID.
  const s2 = open();
  await install(s2);
  rewriteReceipt(s2, value => { value.members['OLD.md'] = { managementId: 'team-guidance', recipeIdentity: Object.values(value.members)[0].recipeIdentity, sha256: sha('x'), mode: 0o644 }; });
  assert.equal((await prepareManagedRemoval(removal(s2), { logging: 'off' })).disposition, 'reconcile-required');
});

test('unverifiable custody is unavailable, never the same as absence; foreign damage matters only to user scope', async () => {
  const s = open();
  await install(s);
  assert.equal((await prepareManagedRemoval(removal(s, { managementId: 'other' }))).disposition, 'absent');
  writeFileSync(join(s.home, '.aih', 'core', 'ownership', `${'f'.repeat(64)}.json`), '{ not json');
  const project = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(project.disposition, 'prepared', JSON.stringify(project));
  const user = await prepareManagedRemoval(removal(s, { scope: 'user', managementId: 'anything' }));
  assert.deepEqual([user.disposition, user.diagnostics[0].code, user.diagnostics[0].reason], ['unavailable', 'PREREQUISITE_UNAVAILABLE', 'ownership-unverifiable']);
  writeFileSync(projectReceipt(s), '{ not json');
  const own = await prepareManagedRemoval(removal(s));
  assert.deepEqual([own.disposition, own.diagnostics[0].reason], ['unavailable', 'ownership-unverifiable']);
});

test('a zero-member claim prepares a custody-only Vibe removal that apply carries out', async () => {
  const s = open();
  await install(s);
  rewriteReceipt(s, value => {
    value.members = {};
    value.selections = { [claimKey('project', 'team-guidance', realpathSync.native(s.project))]: { managementId: 'team-guidance', scope: 'project', sets: [], requires: [] } };
  });
  const result = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.deepEqual(result.preparation.review.operations, []);
  assert.ok(result.preparation.prepared);
  const run = await apply(result.preparation.prepared, approve(result.preparation), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal((await prepareManagedRemoval(removal(s))).disposition, 'absent');
});

test('requests that mix modes, sources or forbidden controls are invalid before any custody read', async () => {
  const s = open();
  const source = { provider: 'github', repository: { owner: 'o', name: 'n' }, path: 'p.json', revision: { kind: 'commit', value: 'a'.repeat(40) } };
  const cases = [
    [removal(s, { organizationSource: source }), {}, 'organization-source'],
    [removal(s, { mode: 'enterprise' }), {}, 'organization-source'],
    [removal(s, { extra: 1 }), {}, 'request-shape'],
    [removal(s, { managementId: 'bad id' }), {}, 'request-shape'],
    [removal(s, { scope: 'both' }), {}, 'request-shape'],
    [removal(s, { target: { project: 'relative' } }), {}, 'request-shape'],
    [removal(s), { privateInputs: {} }, 'request-shape'],
    [removal(s), { materialRoots: {} }, 'request-shape'],
    [removal(s), { evidence: {} }, 'request-shape'],
    [null, {}, 'request-shape']
  ];
  for (const [request, controls, reason] of cases) {
    const result = await prepareManagedRemoval(request, controls);
    assert.deepEqual([result.disposition, result.diagnostics.map(item => [item.code, item.reason])], ['invalid', [['INPUT_INVALID', reason]]], reason);
    assert.equal(Object.hasOwn(result, 'preparation'), false);
  }
  const partial = await prepareManagedRemoval(removal(s, { scope: 'both' }));
  assert.equal(Object.hasOwn(partial, 'scope'), false);
  assert.equal(partial.managementId, 'team-guidance');
  assert.equal(existsSync(join(s.home, '.aih')), false);
});

test('an already-aborted signal cancels without reading custody or writing history', async () => {
  const s = open();
  await install(s);
  const result = await prepareManagedRemoval(removal(s), { signal: AbortSignal.abort() });
  assert.deepEqual([result.disposition, result.diagnostics.map(item => [item.code, item.reason])], ['cancelled', [['CANCELLED', 'cancelled']]]);
  assert.equal(existsSync(runsDir(s)), false);
});

test('preflight-only dispositions write no history while a prepared one keeps the ordinary record', async () => {
  const s = open();
  assert.equal((await prepareManagedRemoval(removal(s))).disposition, 'absent');
  await install(s);
  assert.equal(existsSync(runsDir(s)), false);
  const result = await prepareManagedRemoval(removal(s));
  assert.equal(result.disposition, 'prepared');
  assert.equal(result.preparation.record.status, 'written');
  assert.equal(existsSync(runsDir(s)), true);
});

test('custody that changes while preparing is unavailable and exposes no handle', async () => {
  const s = open();
  await install(s);
  // The engine reads custody synchronously inside the call; this write lands after that read.
  const pending = prepareManagedRemoval(removal(s));
  writeFileSync(join(s.home, '.aih', 'core', 'ownership', `${'e'.repeat(64)}.json`), '{ later }');
  const result = await pending;
  assert.deepEqual([result.disposition, result.diagnostics.map(item => item.reason)], ['unavailable', ['ownership-changed']]);
  assert.equal(Object.hasOwn(result, 'preparation'), false);
  assert.equal(existsSync(runsDir(s)), false, 'a changed preflight must not write routine history');
});

const originalFetch = globalThis.fetch;
const stubOrg = (document, counter) => {
  const inner = fakeFetch(orgRoutes({ bytes: Buffer.from(JSON.stringify(document)) }));
  globalThis.fetch = (...args) => { counter.calls++; return inner(...args); };
};
const enterprise = (s, extra = {}) => removal(s, { mode: 'enterprise', organizationSource: orgSource(), ...extra });

test('Enterprise removal of a zero-member claim is refused before the engine or organization source is touched', async () => {
  const s = open();
  await install(s);
  rewriteReceipt(s, value => {
    value.members = {};
    value.selections = { [claimKey('project', 'team-guidance', realpathSync.native(s.project))]: { managementId: 'team-guidance', scope: 'project', sets: [], requires: [] } };
  });
  const counter = { calls: 0 };
  try {
    stubOrg(orgDocument(enterprisePolicy(), { lifecycle: { remove: true } }), counter);
    const result = await prepareManagedRemoval(enterprise(s), { logging: 'off' });
    assert.deepEqual([result.disposition, result.diagnostics.map(item => [item.code, item.reason])], ['unavailable', [['AUTHORITY_DENIED', 'metadata-only-removal']]]);
    assert.equal(Object.hasOwn(result, 'preparation'), false);
    assert.equal(counter.calls, 0);
    // Explicit local Vibe maintenance of the same claim remains available.
    assert.equal((await prepareManagedRemoval(removal(s), { logging: 'off' })).disposition, 'prepared');
  } finally { globalThis.fetch = originalFetch; }
});

test('Enterprise removal delegates admission to lifecycle.remove and keeps the denial inside the preparation', async () => {
  const s = open();
  await install(s);
  const counter = { calls: 0 };
  try {
    stubOrg(orgDocument(enterprisePolicy()), counter);
    const denied = await prepareManagedRemoval(enterprise(s), { logging: 'off' });
    assert.equal(denied.disposition, 'prepared', JSON.stringify(denied));
    assert.equal(denied.preparation.status, 'blocked');
    assert.equal(denied.preparation.prepared, undefined);
    assert.deepEqual(denied.preparation.diagnostics.map(item => [item.code, item.reason]), [['AUTHORITY_DENIED', 'lifecycle-remove']]);
    assert.equal(existsSync(join(s.project, 'TEAM.md')), true);
    stubOrg(orgDocument(enterprisePolicy(), { lifecycle: { remove: true } }), counter);
    const admitted = await prepareManagedRemoval(enterprise(s), { logging: 'off' });
    assert.equal(admitted.disposition, 'prepared', JSON.stringify(admitted));
    assert.equal(admitted.preparation.status, 'ready', JSON.stringify(admitted.preparation.diagnostics));
    assert.equal(admitted.preparation.review.mode, 'enterprise');
    const run = await apply(admitted.preparation.prepared, approve(admitted.preparation), { logging: 'off' });
    assert.equal(run.completion, 'complete', JSON.stringify(run));
    assert.equal(existsSync(join(s.project, 'TEAM.md')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('Enterprise removal rejects a changed organization source after review', async () => {
  const s = open();
  await install(s);
  const counter = { calls: 0 };
  try {
    stubOrg(orgDocument(enterprisePolicy(), { lifecycle: { remove: true } }), counter);
    const prepared = await prepareManagedRemoval(enterprise(s), { logging: 'off' });
    assert.equal(prepared.disposition, 'prepared', JSON.stringify(prepared));
    assert.equal(prepared.preparation.status, 'ready', JSON.stringify(prepared.preparation.diagnostics));
    stubOrg(orgDocument(enterprisePolicy()), counter);
    const stale = await apply(prepared.preparation.prepared, approve(prepared.preparation), { logging: 'off' });
    assert.notEqual(stale.completion, 'complete', JSON.stringify(stale));
    assert.equal(existsSync(join(s.project, 'TEAM.md')), true, 'changed authority cannot remove managed content');
  } finally { globalThis.fetch = originalFetch; }
});

test('claimless custody in a receipt shared by project and home has no scope and is unavailable', async () => {
  const s = open();
  await install(s);
  // Treat the home as the project: the one receipt then answers for both scopes.
  const home = realpathSync.native(s.home);
  const claimlessHome = { schema: 'urn:aihq:core:ownership:1.0.0', target: home, members: { 'LEGACY.md': {
    managementId: 'legacy-item', recipeIdentity: `sha256:${'a'.repeat(64)}`, sha256: sha('x'), mode: 0o644 } } };
  writeFileSync(receiptPath(s, home), JSON.stringify(claimlessHome));
  for (const scope of ['project', 'user']) {
    const result = await prepareManagedRemoval({ target: { project: s.home }, managementId: 'legacy-item', scope, mode: 'vibe' }, { logging: 'off' });
    assert.deepEqual([result.disposition, result.diagnostics.map(item => item.reason)], ['unavailable', ['ambiguous-scope']], scope);
  }
});

const inventoryOf = (s, scope = 'project') => listManagedSelections({ target: { project: s.project }, scope });

test('removing a non-final shared-member claim revokes only that claim and keeps the member for the other claimant', async () => {
  const s = open();
  await install(s);
  rewriteReceipt(s, value => { const member = Object.values(value.members)[0]; member.claims.push({ ...member.claims[0], managementId: 'other-guidance' }); });
  const before = await inventoryOf(s);
  assert.deepEqual(before.selections.map(item => [item.managementId, item.sharedMemberCount]), [['other-guidance', 1], ['team-guidance', 1]]);
  const result = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.equal(result.preparation.status, 'ready', JSON.stringify(result.preparation.diagnostics));
  assert.equal(result.preparation.review.operations.some(op => op.effects === 'remove-file'), false, 'a shared member is never a file removal');
  const run = await apply(result.preparation.prepared, approve(result.preparation), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(join(s.project, 'TEAM.md')), true, 'the other claimant keeps the bytes');
  const after = await inventoryOf(s);
  assert.deepEqual(after.selections, [{ managementId: 'other-guidance', scope: 'project', custody: 'claim', memberCount: 1, sharedMemberCount: 0 }]);
  assert.equal((await prepareManagedRemoval(removal(s))).disposition, 'absent');
  // The remaining claim is now final: its removal is the bounded file effect.
  const last = await prepareManagedRemoval(removal(s, { managementId: 'other-guidance' }), { logging: 'off' });
  assert.deepEqual(last.preparation.review.operations.map(op => op.effects), ['remove-file']);
});

test('legacy custody refuses removal until the original recipe is reselected, then removal prepares', async () => {
  const s = open();
  await install(s);
  rewriteReceipt(s, value => { delete value.selections; for (const member of Object.values(value.members)) { delete member.claims; delete member.descriptor; } });
  assert.deepEqual((await inventoryOf(s)).selections.map(item => item.custody), ['legacy-reconcile']);
  const refused = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(refused.disposition, 'reconcile-required');
  assert.equal(existsSync(join(s.project, 'TEAM.md')), true);
  // Reselecting the original recipe under the same management ID establishes the explicit claim.
  const reselect = await prepare({ useCase: 'policy', policy: policy(), target: { project: s.project } }, { logging: 'off' });
  assert.equal(reselect.status, 'ready', JSON.stringify(reselect.diagnostics));
  const done = await apply(reselect.prepared, approve(reselect), { logging: 'off' });
  assert.equal(done.completion, 'complete', JSON.stringify(done));
  assert.deepEqual((await inventoryOf(s)).selections.map(item => [item.managementId, item.custody]), [['team-guidance', 'claim']]);
  const again = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(again.disposition, 'prepared', JSON.stringify(again));
  const run = await apply(again.preparation.prepared, approve(again.preparation), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(join(s.project, 'TEAM.md')), false);
});

test('edited managed content is a reviewed conflict that is never silently deleted', async () => {
  const s = open();
  await install(s);
  writeFileSync(join(s.project, 'TEAM.md'), 'My own edits.\n');
  const result = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.equal(result.preparation.status, 'blocked');
  assert.equal(result.preparation.prepared, undefined, 'a blocked review offers no Apply handle');
  assert.deepEqual(result.preparation.review.operations.map(op => op.effects), ['conflict']);
  assert.deepEqual(result.preparation.review.conflicts.map(item => item.reason), ['managed-content-changed']);
  assert.deepEqual(result.preparation.resolutionInputs, [], 'generated cleanup has no keyed resolution');
  assert.match(result.preparation.diagnostics[0].guidance, /manual/i,
    'unkeyed lifecycle cleanup gives a manual recovery path');
  assert.equal(readFileSync(join(s.project, 'TEAM.md'), 'utf8'), 'My own edits.\n');
  assert.deepEqual((await inventoryOf(s)).selections.map(item => item.managementId), ['team-guidance'], 'the claim survives so recovery stays possible');
});

test('missing managed content is an already-satisfied review that drops only the claim and recreates nothing', async () => {
  const s = open();
  await install(s);
  rmSync(join(s.project, 'TEAM.md'));
  const result = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.equal(existsSync(join(s.project, 'TEAM.md')), false);
  assert.deepEqual(result.preparation.resolutionInputs, []);
  assert.deepEqual(result.preparation.review.operations.map(op => op.effects), ['already-satisfied']);
  const run = await apply(result.preparation.prepared, approve(result.preparation), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(join(s.project, 'TEAM.md')), false, 'removal never recreates or adopts content');
  assert.deepEqual((await inventoryOf(s)).selections, []);
});

test('a target edit or custody change after review rejects Apply before any effect', async () => {
  const s = open();
  await install(s);
  const first = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(first.preparation.status, 'ready', JSON.stringify(first.preparation.diagnostics));
  writeFileSync(join(s.project, 'TEAM.md'), 'Changed after review.\n');
  const staleTarget = await apply(first.preparation.prepared, approve(first.preparation), { logging: 'off' });
  assert.notEqual(staleTarget.completion, 'complete', JSON.stringify(staleTarget));
  assert.equal(readFileSync(join(s.project, 'TEAM.md'), 'utf8'), 'Changed after review.\n');
  writeFileSync(join(s.project, 'TEAM.md'), policy().selections[0].configuration.text);

  const second = await prepareManagedRemoval(removal(s), { logging: 'off' });
  assert.equal(second.preparation.status, 'ready', JSON.stringify(second.preparation.diagnostics));
  // A new claimant appears in custody after review: the reviewed final-claim effect is no longer true.
  rewriteReceipt(s, value => { const member = Object.values(value.members)[0]; member.claims.push({ ...member.claims[0], managementId: 'late-claimant' }); });
  const staleReceipt = await apply(second.preparation.prepared, approve(second.preparation), { logging: 'off' });
  assert.notEqual(staleReceipt.completion, 'complete', JSON.stringify(staleReceipt));
  assert.equal(existsSync(join(s.project, 'TEAM.md')), true, 'a stale review removes nothing');
  assert.deepEqual((await inventoryOf(s)).selections.map(item => item.managementId), ['late-claimant', 'team-guidance']);
});
