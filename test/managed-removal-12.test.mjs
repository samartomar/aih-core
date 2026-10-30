import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepare, apply, prepareManagedRemoval } from '../dist/core/index.js';
import { removalClaims } from '../dist/core/contracts.js';
import { policy } from './fixture.mjs';
import { sandbox } from './hook-group-fixture.mjs';
import { fakeFetch, orgRoutes, orgSource, orgDocument, enterprisePolicy } from './fixtures/github-org.mjs';

// Removal preparation 1.2.0 keeps every single-id safeguard per removal; these cover the dispositions the packed
// consumer cannot reach without editing protected custody.
const sha = value => createHash('sha256').update(value).digest('hex');
const approve = review => ({ reviewDigest: review.reviewDigest, approved: true, origin: 'automation' });
const many = (s, removals, extra = {}) => ({ target: { project: s.project }, scope: 'project', removals, ...extra });
const runsDir = s => join(s.home, '.aih', 'core', 'runs');
const projectReceipt = s => join(s.home, '.aih', 'core', 'ownership', `${sha(realpathSync.native(s.project))}.json`);
const rewriteReceipt = (s, change) => { const value = JSON.parse(readFileSync(projectReceipt(s), 'utf8')); change(value); writeFileSync(projectReceipt(s), JSON.stringify(value)); };
const reasons = result => result.removals.map(entry => [entry.managementId, entry.disposition, entry.diagnostics.map(item => item.reason)]);

async function install(s, mutate) {
  const document = policy(); mutate?.(document);
  const prepared = await prepare({ useCase: 'policy', policy: document, target: { project: s.project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal((await apply(prepared.prepared, approve(prepared.review), { logging: 'off' })).completion, 'complete');
}
const named = (selection, id, file) => {
  const copy = structuredClone(selection);
  copy.id = id; copy.managementId = id;
  copy.recipe.inline.operations[0].target.segments = [{ literal: file }];
  return copy;
};

let live = [];
const open = () => { const s = sandbox('aih-removal-12-'); live.push(s); return s; };
afterEach(() => { for (const s of live) s.dispose(); live = []; });

test('legacy custody stays reconcile-required per removal while the rest of the request is prepared', async () => {
  const s = open();
  const base = policy().selections[0];
  await install(s, document => { document.selections = [named(base, 'legacy', 'LEGACY.md'), named(base, 'fresh', 'FRESH.md')]; });
  rewriteReceipt(s, value => {
    for (const [key, claim] of Object.entries(value.selections ?? {})) if (claim.managementId === 'legacy') delete value.selections[key];
    for (const member of Object.values(value.members)) if (member.managementId === 'legacy') { delete member.claims; delete member.descriptor; }
  });
  const result = await prepareManagedRemoval(many(s, [{ managementId: 'legacy' }, { managementId: 'fresh' }]), { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.deepEqual(reasons(result), [['legacy', 'reconcile-required', ['legacy-reconcile']], ['fresh', 'prepared', []]]);
  assert.match(result.removals[0].diagnostics[0].guidance, /original recipe/);
  assert.deepEqual(result.preparation.review.operations.map(op => op.details.target), [join(realpathSync.native(s.project), 'FRESH.md')]);
});

test('an origin cannot be removed from a selection that recorded none; the whole selection still can', async () => {
  const s = open();
  await install(s);
  const byOrigin = await prepareManagedRemoval(many(s, [{ managementId: 'team-guidance', origin: { reasonIncluded: 'chosen' } }]));
  assert.deepEqual([byOrigin.disposition, reasons(byOrigin)], ['not-prepared', [['team-guidance', 'reconcile-required', ['origin-unrecorded']]]]);
  assert.equal(existsSync(runsDir(s)), false, 'preflight-only dispositions write no history');
  const whole = await prepareManagedRemoval(many(s, [{ managementId: 'team-guidance' }]));
  assert.deepEqual(whole.removals[0].members.map(member => [member.kind, member.action, member.operationId]), [['file', 'remove', 'lifecycle/remove-0']]);
});

test('a member another selection claims is keep-shared and "removed" still holds for the removed selection', async () => {
  const s = open();
  await install(s);
  rewriteReceipt(s, value => { const member = Object.values(value.members)[0]; member.claims.push({ ...member.claims[0], managementId: 'other-guidance' }); });
  const result = await prepareManagedRemoval(many(s, [{ managementId: 'team-guidance' }]), { logging: 'off' });
  assert.deepEqual(result.removals[0].members.map(member => [member.action, member.reason]), [['keep-shared', 'another-selection']]);
  const run = await apply(result.preparation.prepared, approve(result.preparation.review), { logging: 'off' });
  assert.equal(run.completion, 'complete');
  assert.deepEqual(removalClaims(result, run).removals.map(item => item.claim), ['removed']);
  assert.equal(existsSync(join(s.project, 'TEAM.md')), true);
});

test('whole-request failures: invalid shapes, unverifiable custody and cancellation carry no removals', async () => {
  const s = open();
  const source = orgSource();
  for (const [request, controls, reason] of [
    [many(s, [{ managementId: 'a', origin: { set: { framework: 'f', setId: 's' } } }]), {}, 'request-shape'],
    [many(s, [{ managementId: 'a', origin: { reasonIncluded: 'in-set' } }]), {}, 'request-shape'],
    [many(s, [{ managementId: 'a', extra: 1 }]), {}, 'request-shape'],
    [many(s, [{ managementId: 'a' }]), { privateInputs: {} }, 'request-shape'],
    [many(s, [{ managementId: 'a' }], { mode: 'enterprise' }), {}, 'organization-source'],
    [many(s, [{ managementId: 'a' }], { organizationSource: source }), {}, 'organization-source'],
    [many(s, [{ managementId: 'a', origin: { reasonIncluded: 'chosen' } }, { managementId: 'a', origin: { reasonIncluded: 'chosen' } }]), {}, 'removal-conflict']
  ]) {
    const result = await prepareManagedRemoval(request, controls);
    assert.equal(result.schema, 'urn:aihq:core:managed-removal-preparation:1.2.0');
    assert.deepEqual([result.disposition, result.diagnostics.map(item => item.reason)], ['invalid', [reason]], reason);
    assert.equal(Object.hasOwn(result, 'removals'), false);
  }
  const cancelled = await prepareManagedRemoval(many(s, [{ managementId: 'a' }]), { signal: AbortSignal.abort() });
  assert.deepEqual([cancelled.disposition, Object.hasOwn(cancelled, 'removals')], ['cancelled', false]);
  await install(s);
  writeFileSync(projectReceipt(s), '{broken');
  const unverifiable = await prepareManagedRemoval(many(s, [{ managementId: 'team-guidance' }]));
  assert.deepEqual([unverifiable.disposition, unverifiable.diagnostics.map(item => item.reason)], ['unavailable', ['ownership-unverifiable']]);
});

const originalFetch = globalThis.fetch;
test('Enterprise keeps its custody-only refusal per removal and delegates file removal to lifecycle admission', async () => {
  const s = open();
  const base = policy().selections[0];
  // The organization admits removal of the standard guidance recipe; "empty" keeps only its claim.
  await install(s, document => { document.selections = [named(base, 'empty', 'EMPTY.md'), base]; });
  // A claim recorded without members: only custody would change.
  rewriteReceipt(s, value => {
    for (const [key, member] of Object.entries(value.members)) if (member.managementId === 'empty') delete value.members[key];
    // A claim identity names the project as Core does: in lower case on Windows, whose paths are case-insensitive.
    const anchor = process.platform === 'win32' ? realpathSync.native(s.project).toLowerCase() : realpathSync.native(s.project);
    value.selections = { ...value.selections, [`project:${sha(anchor)}:empty`]: { managementId: 'empty', scope: 'project', sets: [], requires: [] } };
  });
  const counter = { calls: 0 };
  try {
    // A denial stops the inner preparation before its review: nothing is listed and the entry carries the reason.
    const deniedFetch = fakeFetch(orgRoutes({ bytes: Buffer.from(JSON.stringify(orgDocument(enterprisePolicy()))) }));
    globalThis.fetch = (...args) => { counter.calls++; return deniedFetch(...args); };
    const denied = await prepareManagedRemoval(many(s, [{ managementId: 'team-guidance' }], { mode: 'enterprise', organizationSource: orgSource() }), { logging: 'off' });
    assert.deepEqual([denied.disposition, denied.preparation.status, Object.hasOwn(denied, 'reviewDigest')], ['prepared', 'blocked', false]);
    assert.deepEqual([denied.removals[0].members, denied.removals[0].diagnostics.map(item => item.reason)], [[], ['lifecycle-remove']]);
    const inner = fakeFetch(orgRoutes({ bytes: Buffer.from(JSON.stringify(orgDocument(enterprisePolicy(), { lifecycle: { remove: true } }))) }));
    globalThis.fetch = (...args) => { counter.calls++; return inner(...args); };
    const result = await prepareManagedRemoval(many(s, [{ managementId: 'empty' }, { managementId: 'team-guidance' }], { mode: 'enterprise', organizationSource: orgSource() }), { logging: 'off' });
    assert.deepEqual(reasons(result), [['empty', 'unavailable', ['metadata-only-removal']], ['team-guidance', 'prepared', []]]);
    assert.equal(result.removals[0].diagnostics[0].code, 'AUTHORITY_DENIED');
    assert.equal(result.preparation.status, 'ready', JSON.stringify(result.preparation.diagnostics));
    assert.equal(result.preparation.review.mode, 'enterprise');
    const run = await apply(result.preparation.prepared, approve(result.preparation.review), { logging: 'off' });
    assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
    assert.deepEqual(removalClaims(result, run).removals.map(item => item.claim), ['not-confirmed', 'removed']);
  } finally { globalThis.fetch = originalFetch; }
});
