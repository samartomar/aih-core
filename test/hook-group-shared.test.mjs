import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../dist/core/index.js';
import { memberKey } from '../dist/core/internal/recipe-lifecycle.js';
import { SETTINGS, authorize, canonicalSha, groupOf, hookOp, hookSelection, policy11, sandbox, sha } from './hook-group-fixture.mjs';
import { controls, groupsOf, neighbor, compact, opOf, ownershipRoots, prep, resolveOp, run } from './hook-group-harness.mjs';

const GROUP = groupOf('shared');
const SHARED = canonicalSha(GROUP);
const select = (id, action = 'set') => hookSelection(id, [hookOp(action === 'set' ? 'add' : 'drop', 'shared', { action })]);
const claim = (...ids) => policy11(ids.map(id => select(id)));
const drop = (ids, extras = {}) => policy11(ids.map(id => select(id, 'remove')), extras);
const claimants = s => ownershipRoots(s).flatMap(root => Object.values(root.members)).flatMap(member => (member.claims ?? []).map(item => item.managementId)).sort();
const reasons = prepared => prepared.review.conflicts.map(item => item.reason);

async function shared(s, ...ids) {
  s.write(SETTINGS, compact([neighbor('a')]));
  await run(s, claim(...ids));
  return s.read(SETTINGS);
}
const edit = (s, from, to) => { const text = s.read(SETTINGS).replace(from, to); s.write(SETTINGS, text); return text; };

test('a different format cannot adopt a group already held by another hook descriptor', async () => {
  for (const [firstFormat, secondFormat] of [['json', 'jsonc'], ['jsonc', 'json']]) {
    const s = sandbox();
    try {
      const first = policy11([hookSelection('first', [hookOp('add', 'shared', { format: firstFormat })])]);
      await run(s, first);
      const before = s.read(SETTINGS);
      const second = policy11([hookSelection('second', [hookOp('add', 'shared', { format: secondFormat })])]);
      const blocked = await prep(s, second);
      assert.equal(blocked.status, 'blocked');
      const adopted = await prep(s, second, [resolveOp(blocked, 'second', 'add', 'adopt')]);
      assert.equal(adopted.status, 'blocked', 'another format must not establish a second owner of one element');
      assert.equal(s.read(SETTINGS), before);
      assert.deepEqual(claimants(s), ['first']);
    } finally { s.dispose(); }
  }
});

test('removal preserves a group when a pre-fix receipt has a second format owner', async () => {
  const s = sandbox();
  try {
    await run(s, policy11([hookSelection('first', [hookOp('add', 'shared', { format: 'json' })])]));
    const before = s.read(SETTINGS);
    const root = ownershipRoots(s).find(item => Object.values(item.members).some(member => member.managementId === 'first'));
    assert.ok(root);
    const owner = Object.values(root.members)[0];
    const descriptor = { ...owner.descriptor, format: 'jsonc' };
    root.members[memberKey(descriptor)] = { ...owner, managementId: 'second', descriptor,
      claims: [{ managementId: 'second', scope: 'project', sets: [], requires: [] }] };
    writeFileSync(join(s.home, '.aih', 'core', 'ownership', root.name), JSON.stringify({
      schema: root.schema, target: root.target, members: root.members
    }));
    const authored = await prep(s, policy11([hookSelection('first', [hookOp('drop', 'shared', { action: 'remove' })])]));
    assert.equal(authored.status, 'blocked');
    assert.equal(opOf(authored, 'first/drop').effects, 'conflict');
    const lifecycle = await prep(s, policy11([], { removals: [{ managementId: 'first', scope: 'project' }] }));
    assert.equal(lifecycle.status, 'blocked');
    assert.equal(lifecycle.review.operations[0].effects, 'conflict');
    assert.equal(s.read(SETTINGS), before);
    assert.deepEqual(claimants(s), ['first', 'second']);
  } finally { s.dispose(); }
});

test('two selections claiming one group are one managed member and the second is custody only', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    const { prepared, result } = await run(s, claim('claim-a', 'claim-b'));
    assert.deepEqual(prepared.review.operations.map(item => item.effects), ['replace-file', 'already-satisfied']);
    assert.deepEqual(result.operations.map(item => item.application), ['applied', 'already-satisfied']);
    assert.equal(groupsOf(s).length, 2);
    assert.deepEqual(claimants(s), ['claim-a', 'claim-b']);
  } finally { s.dispose(); }
});

test('removing one of two valid claims keeps the group, revokes only that claim, and writes nothing', async () => {
  const s = sandbox();
  try {
    const before = await shared(s, 'claim-a', 'claim-b');
    const { prepared, result } = await run(s, drop(['claim-a']));
    const op = opOf(prepared, 'claim-a/drop');
    assert.equal(op.effects, 'already-satisfied');
    assert.equal(op.details.hookGroup.memberAfterSha256, SHARED, 'the retained group keeps its digest');
    assert.equal(op.details.hookGroup.matchedIndex, 1);
    assert.equal(op.details.hookGroup.desiredGroup, null);
    assert.equal(result.operations[0].application, 'already-satisfied');
    assert.equal(s.read(SETTINGS), before);
    assert.deepEqual(claimants(s), ['claim-b']);
  } finally { s.dispose(); }
});

test('two authored removals in one run retain on the first and delete once on the last', async () => {
  const s = sandbox();
  try {
    const before = await shared(s, 'claim-a', 'claim-b');
    const { prepared, result } = await run(s, drop(['claim-a', 'claim-b']));
    const [first, second] = prepared.review.operations;
    assert.deepEqual([first.effects, second.effects], ['already-satisfied', 'replace-file']);
    assert.equal(first.details.hookGroup.memberAfterSha256, SHARED);
    assert.equal(second.details.hookGroup.memberAfterSha256, null);
    assert.equal(first.details.hookGroup.targetBeforeSha256, sha(before));
    assert.equal(second.details.hookGroup.targetBeforeSha256, sha(before), 'its overlay input is unchanged by the retaining step');
    assert.ok(second.requires.includes(first.id));
    assert.equal(result.completion, 'complete');
    assert.deepEqual(groupsOf(s), [neighbor('a')]);
    assert.deepEqual(claimants(s), []);
  } finally { s.dispose(); }
});

test('after formatting drift the first removal needs its own replace and the dependent removal then deletes once', async () => {
  const s = sandbox();
  try {
    await shared(s, 'claim-a', 'claim-b');
    const drifted = edit(s, '"matcher":"Bash"', '"matcher": "Bash"');
    const blocked = await prep(s, drop(['claim-a', 'claim-b']));
    assert.deepEqual(reasons(blocked), ['owned-hook-edited', 'hook-prior-conflict']);
    const [first, second] = blocked.review.operations;
    assert.deepEqual([first.effects, second.effects], ['conflict', 'conflict']);
    assert.ok(second.requires.includes(first.id), 'the conflicted earlier step is listed in requires');
    assert.equal(second.details.hookGroup.memberAfterSha256, null, 'no deletion is proposed');
    const { prepared, result } = await run(s, drop(['claim-a', 'claim-b']), { resolutions: [resolveOp(blocked, 'claim-a', 'drop')] });
    assert.deepEqual(prepared.review.operations.map(item => item.effects), ['already-satisfied', 'replace-file']);
    assert.equal(result.completion, 'complete');
    assert.equal(drifted.includes('"matcher": "Bash"'), true);
    assert.deepEqual(groupsOf(s), [neighbor('a')]);
  } finally { s.dispose(); }
});

test('authored removal then lifecycle removals retain then delete once from projected custody', async () => {
  const s = sandbox();
  try {
    await shared(s, 'claim-a', 'claim-b');
    const policy = drop(['claim-a'], { removals: [{ managementId: 'claim-b', scope: 'project' }] });
    const { prepared, result } = await run(s, policy);
    const [authored, cleanup] = prepared.review.operations;
    assert.deepEqual([authored.effects, cleanup.effects], ['already-satisfied', 'replace-file']);
    assert.deepEqual([cleanup.kind, cleanup.details.hookGroup.action], ['hook.group', 'remove']);
    assert.match(cleanup.id, /^lifecycle\/remove-/);
    assert.equal(result.completion, 'complete');
    assert.deepEqual(groupsOf(s), [neighbor('a')]);
    assert.deepEqual(claimants(s), []);
  } finally { s.dispose(); }
});

test('with formatting drift an unreviewed authored removal blocks dependent lifecycle cleanup and a reviewed replace unblocks it', async () => {
  const s = sandbox();
  try {
    await shared(s, 'claim-a', 'claim-b');
    edit(s, '"matcher":"Bash"', '"matcher": "Bash"');
    const policy = drop(['claim-a'], { removals: [{ managementId: 'claim-b', scope: 'project' }] });
    const blocked = await prep(s, policy);
    assert.deepEqual(reasons(blocked), ['owned-hook-edited', 'hook-prior-conflict'], 'the prior conflict wins over managed-content-changed');
    assert.equal(blocked.review.operations[1].effects, 'conflict');
    const { prepared, result } = await run(s, policy, { resolutions: [resolveOp(blocked, 'claim-a', 'drop')] });
    assert.deepEqual(prepared.review.operations.map(item => item.effects), ['already-satisfied', 'replace-file']);
    assert.equal(result.completion, 'complete');
    assert.deepEqual(groupsOf(s), [neighbor('a')]);
  } finally { s.dispose(); }
});

test('a reviewed formatting refresh then lifecycle cleanup of one of three claims reads and writes the projected owner', async () => {
  const s = sandbox();
  try {
    await shared(s, 'claim-a', 'claim-b', 'claim-c');
    const drifted = edit(s, '"matcher":"Bash"', '"matcher": "Bash"');
    const policy = drop(['claim-a'], { removals: [{ managementId: 'claim-b', scope: 'project' }] });
    const blocked = await prep(s, policy);
    const { prepared, result } = await run(s, policy, { resolutions: [resolveOp(blocked, 'claim-a', 'drop')] });
    assert.deepEqual(prepared.review.operations.map(item => item.effects), ['already-satisfied', 'already-satisfied']);
    assert.equal(prepared.review.conflicts.length, 0, 'no false managed-content-changed from stale ownership');
    assert.equal(result.completion, 'complete');
    assert.equal(s.read(SETTINGS), drifted);
    assert.deepEqual(claimants(s), ['claim-c']);
    const later = await run(s, drop(['claim-c']));
    assert.deepEqual(groupsOf(s), [neighbor('a')], 'the surviving claim holds refreshed custody and deletes cleanly');
    assert.equal(later.result.completion, 'complete');
  } finally { s.dispose(); }
});

test('a conflicted first removal blocks the dependent removal under partial Apply', async () => {
  const s = sandbox();
  try {
    await shared(s, 'claim-a', 'claim-b');
    const edited = edit(s, '"matcher":"Bash"', '"matcher":"Changed"');
    const prepared = await prep(s, drop(['claim-a', 'claim-b']));
    assert.equal(prepared.status, 'blocked');
    assert.deepEqual(reasons(prepared), ['owned-hook-shared-drift', 'hook-prior-conflict']);
    const lifecycle = await prep(s, drop(['claim-a'], { removals: [{ managementId: 'claim-b', scope: 'project' }] }));
    assert.deepEqual(reasons(lifecycle), ['owned-hook-shared-drift', 'hook-prior-conflict']);
    // A partial run: an unrelated file write is available, so a handle exists and the dependent step is refused.
    const extra = hookSelection('other', [{ id: 'note', purpose: 'unrelated note', kind: 'file.write', scope: 'project', requires: [], checks: [],
      target: { root: 'project', segments: [{ literal: 'NOTE.md' }] }, content: { literal: 'note' } }]);
    const mixed = drop(['claim-a', 'claim-b']); mixed.selections.push(extra);
    const partial = await prep(s, mixed);
    assert.equal(partial.status, 'partial');
    const result = await apply(partial.prepared, authorize(partial, { allowPartial: true }), controls);
    const byId = Object.fromEntries(partial.review.operations.map((item, index) => [item.id, result.operations[index]]));
    assert.equal(byId['claim-a/drop'].reason, 'conflict');
    assert.equal(byId['claim-b/drop'].reason, 'dependency-not-satisfied');
    assert.equal(result.completion, 'incomplete');
    assert.equal(s.read(SETTINGS), edited);
    assert.equal(s.read('NOTE.md'), 'note');
  } finally { s.dispose(); }
});

test('a changing set, a canonical edit and a non-final removal after a canonical edit cannot be resolved by replace while another claim survives', async () => {
  const s = sandbox();
  try {
    await shared(s, 'claim-a', 'claim-b');
    const change = policy11([hookSelection('claim-a', [hookOp('add', 'shared', { group: groupOf('shared', { matcher: 'Write' }) })])]);
    const changed = await prep(s, change);
    assert.deepEqual(reasons(changed), ['hook-shared-change']);
    const forced = await prep(s, change, [resolveOp(changed, 'claim-a', 'add')]);
    assert.deepEqual(reasons(forced), ['hook-shared-change']);
    assert.equal(forced.status, 'blocked');
    edit(s, '"matcher":"Bash"', '"matcher":"Changed"');
    const drift = await prep(s, claim('claim-a', 'claim-b'));
    assert.equal(reasons(drift)[0], 'owned-hook-shared-drift');
    const retire = await prep(s, drop(['claim-a']));
    assert.deepEqual(reasons(retire), ['owned-hook-shared-drift']);
    const forcedRetire = await prep(s, drop(['claim-a']), [resolveOp(retire, 'claim-a', 'drop')]);
    assert.deepEqual(reasons(forcedRetire), ['owned-hook-shared-drift']);
    assert.equal(forcedRetire.prepared, undefined);
  } finally { s.dispose(); }
});

test('formatting drift with two claims: removal needs replace and then keeps the group; lifecycle cleanup has no keyed replace', async () => {
  const s = sandbox();
  try {
    await shared(s, 'claim-a', 'claim-b');
    const drifted = edit(s, '"matcher":"Bash"', '"matcher": "Bash"');
    const blocked = await prep(s, drop(['claim-a']));
    assert.deepEqual(reasons(blocked), ['owned-hook-edited']);
    const { prepared, result } = await run(s, drop(['claim-a']), { resolutions: [resolveOp(blocked, 'claim-a', 'drop')] });
    assert.equal(only(prepared).effects, 'already-satisfied');
    assert.equal(result.completion, 'complete');
    assert.equal(s.read(SETTINGS), drifted, 'the group stays for the other claim and nothing is written');
    assert.deepEqual(claimants(s), ['claim-b']);
  } finally { s.dispose(); }
  const t = sandbox();
  try {
    await shared(t, 'claim-a', 'claim-b');
    edit(t, '"matcher":"Bash"', '"matcher": "Bash"');
    const unrelated = hookSelection('other', [{ id: 'note', purpose: 'unrelated note', kind: 'file.write', scope: 'project', requires: [], checks: [],
      target: { root: 'project', segments: [{ literal: 'NOTE.md' }] }, content: { literal: 'note' } }]);
    const lifecycle = await prep(t, policy11([unrelated], { removals: [{ managementId: 'claim-b', scope: 'project' }] }));
    assert.deepEqual(reasons(lifecycle), ['managed-content-changed']);
    assert.equal(lifecycle.review.operations.find(item => item.id.startsWith('lifecycle/')).effects, 'conflict');
  } finally { t.dispose(); }
  function only(prepared) { return prepared.review.operations[0]; }
});

test('implicit obsolete-member cleanup of an edited group preserves custody with managed-content-changed', async () => {
  const s = sandbox();
  try {
    await shared(s, 'claim-a');
    edit(s, '"matcher":"Bash"', '"matcher":"Changed"');
    const retained = hookSelection('claim-a', [{ id: 'note', purpose: 'a different member', kind: 'file.write', scope: 'project', requires: [], checks: [],
      target: { root: 'project', segments: [{ literal: 'NOTE.md' }] }, content: { literal: 'note' } }]);
    const prepared = await prep(s, policy11([retained]));
    assert.deepEqual(reasons(prepared), ['managed-content-changed']);
    const cleanup = prepared.review.operations.find(item => item.id.startsWith('lifecycle/'));
    assert.deepEqual([cleanup.kind, cleanup.effects, cleanup.details.hookGroup.action], ['hook.group', 'conflict', 'remove']);
    assert.deepEqual(claimants(s), ['claim-a'], 'custody is intact');
    assert.match(prepared.review.conflicts[0].guidance, /Restore the recorded content or reconcile every claim manually/);
  } finally { s.dispose(); }
});

test('repeating a removal after its claim was revoked is already satisfied while another claim keeps the group', async () => {
  const s = sandbox();
  try {
    const before = await shared(s, 'claim-a', 'claim-b');
    await run(s, drop(['claim-a']));
    const { prepared, result } = await run(s, drop(['claim-a']));
    assert.equal(prepared.review.operations[0].effects, 'already-satisfied');
    assert.deepEqual(prepared.review.conflicts, []);
    assert.equal(result.completion, 'complete');
    assert.equal(result.operations[0].application, 'already-satisfied');
    assert.equal(s.read(SETTINGS), before, 'the shared group is untouched');
    assert.deepEqual(claimants(s), ['claim-b'], 'the surviving claim keeps custody');
    assert.equal((await prep(s, drop(['claim-a']))).status, 'ready', 'and the removal stays repeatable');
  } finally { s.dispose(); }
});

test('an unowned identical group is still existing content for a removal that holds no claim', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a'), GROUP]));
    const prepared = await prep(s, drop(['claim-a']));
    assert.deepEqual(reasons(prepared), ['existing-content']);
  } finally { s.dispose(); }
});
