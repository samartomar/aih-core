import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, apply } from '../dist/core/index.js';
import { apply as applyWithGuard } from '../dist/core/recipe-engine.js';
import { RECIPE_11, SETTINGS, authorize, groupOf, hookOp, hookSelection, policy11, request, sandbox, sha } from './hook-group-fixture.mjs';
import { compact, controls, groupsOf, guard, neighbor, only, opOf, ownershipRoots, prep, resolveOp, run } from './hook-group-harness.mjs';

const reasons = prepared => prepared.review.conflicts.map(item => item.reason);
const idGroup = (id, extra = {}) => ({ id, ...extra });

test('a distinct group with the same matcher and handler type is a neighbor and is preserved', async () => {
  const s = sandbox();
  try {
    const twin = groupOf('guard-twin');
    s.write(SETTINGS, compact([{ ...twin, hooks: [{ type: 'command', command: 'hooks/not-ours.sh' }] }]));
    await run(s, guard());
    assert.equal(groupsOf(s).length, 2);
    assert.equal(groupsOf(s)[0].hooks[0].command, 'hooks/not-ours.sh');
  } finally { s.dispose(); }
});

test('an identical unowned group conflicts, and only an exact reviewed adopt takes custody without a write', async () => {
  const s = sandbox();
  try {
    const text = compact([neighbor('a'), groupOf('guard-a')]);
    s.write(SETTINGS, text);
    const blocked = await prep(s, guard());
    assert.deepEqual(reasons(blocked), ['existing-content']);
    assert.equal(blocked.status, 'blocked');
    const { prepared, result } = await run(s, guard(), { resolutions: [resolveOp(blocked, 'guard-a', 'add', 'adopt')] });
    assert.equal(only(prepared).effects, 'already-satisfied');
    assert.equal(only(prepared).details.reason, 'explicit-adopt');
    assert.equal(result.completion, 'complete');
    assert.equal(s.read(SETTINGS), text, 'adoption never writes the target');
    assert.equal((await run(s, guard())).prepared.review.operations[0].ownership, 'managed');
  } finally { s.dispose(); }
  const t = sandbox();
  try {
    t.write(SETTINGS, compact([groupOf('guard-a', { matcher: 'Different' })]));
    const blocked = await prep(t, guard());
    assert.deepEqual(reasons(blocked), ['existing-content']);
    const rejected = await prep(t, guard(), [resolveOp(blocked, 'guard-a', 'add', 'adopt')]);
    assert.equal(rejected.status, 'invalid', 'adopt never takes a group with different content');
    assert.equal(rejected.diagnostics[0].reason, 'resolution-invalid');
    const duplicated = compact([groupOf('guard-a'), groupOf('guard-a')]);
    t.write(SETTINGS, duplicated);
    const ambiguous = await prep(t, guard());
    assert.deepEqual(reasons(ambiguous), ['hook-selector-ambiguous']);
  } finally { t.dispose(); }
});

const a = { path: ['id'], value: 'ida' };
const aOp = extra => hookOp('add', 'a', { selector: a, group: idGroup('ida', extra) });
const bOp = hookOp('add', 'b', { selector: { path: ['kind'], value: 'kb' }, group: { id: 'idb', kind: 'kb' } });
const two = (first, second) => policy11([hookSelection('sel-a', [first]), hookSelection('sel-b', [second])]);

test('updating A to contain the selector value managed by B conflicts before any write', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([]));
    await run(s, two(aOp({ n: 1 }), bOp));
    const before = s.read(SETTINGS);
    const blocked = await prep(s, policy11([hookSelection('sel-a', [aOp({ n: 1, kind: 'kb' })])]));
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(reasons(blocked), ['hook-selector-overlap']);
    assert.equal(s.read(SETTINGS), before);
  } finally { s.dispose(); }
});

test('an alternate selector cannot adopt an element already managed by another descriptor', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([]));
    await run(s, policy11([hookSelection('sel-a', [hookOp('add', 'a', { selector: a, group: idGroup('ida', { tag: 't' }) })])]));
    const before = s.read(SETTINGS);
    const alternate = hookOp('add', 'c', { selector: { path: ['tag'], value: 't' }, group: idGroup('ida', { tag: 't' }) });
    const policy = policy11([hookSelection('sel-c', [alternate])]);
    const blocked = await prep(s, policy);
    assert.equal(blocked.status, 'blocked');
    const adopt = await prep(s, policy, [resolveOp(blocked, 'sel-c', 'add', 'adopt')]);
    assert.equal(adopt.status, 'blocked');
    assert.deepEqual(reasons(adopt), ['hook-selector-overlap']);
    assert.equal(s.read(SETTINGS), before);
    assert.equal(Object.keys(ownershipRoots(s)[0].members).length, 1, 'no custody change');
  } finally { s.dispose(); }
});

test('a changed selector under an existing group ID conflicts; whole-selection removal and a new group ID migrate in reviewed runs', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    const moved = policy11([hookSelection('guard-a', [hookOp('add', 'guard-a', { groupId: 'guard-a', selector: { path: ['matcher'], value: 'Bash' } })])]);
    const blocked = await prep(s, moved);
    assert.deepEqual(reasons(blocked), ['hook-selector-changed']);
    const forced = await prep(s, moved, [resolveOp(blocked, 'guard-a', 'add')]);
    assert.deepEqual(reasons(forced), ['hook-selector-changed'], 'replace cannot change a selector');
    // One reviewed run: the entire management selection is removed through policy removals.
    const removal = { schema: 'urn:aihq:core:execution-policy:1.1.0', mode: 'vibe', selections: [], removals: [{ managementId: 'guard-a', scope: 'project' }] };
    const { prepared, result } = await run(s, removal);
    assert.equal(only(prepared).kind, 'hook.group');
    assert.equal(only(prepared).details.hookGroup.action, 'remove');
    assert.equal(result.completion, 'complete');
    assert.deepEqual(groupsOf(s), [neighbor('a')]);
  } finally { s.dispose(); }
});

test('a new group ID with a changed selector adds and cleans up the old group in one run only without collisions', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    const replacement = policy11([hookSelection('guard-a', [hookOp('add', 'guard-b', { groupId: 'guard-b', selector: { path: ['hooks', 0, 'command'], value: 'hooks/guard-b.sh' }, group: groupOf('guard-b') })])]);
    const { prepared, result } = await run(s, replacement);
    assert.deepEqual(prepared.review.operations.map(item => [item.kind, item.effects]), [['hook.group', 'replace-file'], ['hook.group', 'replace-file']]);
    assert.equal(result.completion, 'complete');
    assert.deepEqual(groupsOf(s), [neighbor('a'), groupOf('guard-b')]);
  } finally { s.dispose(); }
  const t = sandbox();
  try {
    t.write(SETTINGS, compact([neighbor('a')]));
    await run(t, guard());
    const colliding = policy11([hookSelection('guard-a', [hookOp('add', 'guard-b', { groupId: 'guard-b', selector: { path: ['matcher'], value: 'Bash' }, group: groupOf('guard-b') })])]);
    const blocked = await prep(t, colliding);
    assert.ok(reasons(blocked).length > 0, 'a selector matching the still-present old group needs two reviewed runs');
    assert.ok(reasons(blocked).every(reason => ['existing-content', 'hook-selector-overlap', 'hook-after-collision'].includes(reason)), reasons(blocked).join());
    assert.equal(groupsOf(t).length, 2);
  } finally { t.dispose(); }
});

test('an unsupported TOML format, a wrong container and overlapping whole-file or entry operations never write', async () => {
  const s = sandbox();
  try {
    s.write('.tool/config.toml', '[[hooks.PreToolUse]]\nmatcher = "Bash"\n');
    const toml = policy11([hookSelection('guard-a', [hookOp('add', 'guard-a', { format: 'toml', target: { root: 'project', segments: [{ literal: '.tool' }, { literal: 'config.toml' }] } })])]);
    const invalid = await prep(s, toml);
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.review, undefined);
    assert.equal(s.read('.tool/config.toml'), '[[hooks.PreToolUse]]\nmatcher = "Bash"\n');
    // A whole-file claim over the same target, then a hook group in the same run.
    const sw = sandbox();
    try {
      const file = hookSelection('whole', [{ id: 'whole', purpose: 'whole file', kind: 'file.write', scope: 'project', requires: [], checks: [],
        target: { root: 'project', segments: [{ literal: '.tool' }, { literal: 'settings.json' }] }, content: { literal: '{"hooks":{"PreToolUse":[]}}' } }]);
      const whole = await prep(sw, policy11([file, hookSelection('guard-a', [hookOp('add', 'guard-a')])]), undefined);
      assert.equal(whole.status, 'partial');
      assert.deepEqual(whole.review.operations.map(item => item.effects), ['create-file', 'conflict']);
      assert.equal(reasons(whole)[0], 'existing-content');
    } finally { sw.dispose(); }
    // A parent entry edit over the group's container after custody exists.
    const se = sandbox();
    try {
      await run(se, guard());
      const entry = hookSelection('entry', [{ id: 'entry', purpose: 'parent entry', kind: 'config.entries', scope: 'project', requires: [], checks: [], format: 'json',
        target: { root: 'project', segments: [{ literal: '.tool' }, { literal: 'settings.json' }] }, entries: [{ path: ['hooks'], action: 'set', value: { literal: { PreToolUse: [] } } }] }]);
      const before = se.read(SETTINGS);
      const blocked = await prep(se, policy11([entry]));
      assert.equal(blocked.status, 'blocked');
      assert.equal(opOf(blocked, 'entry/entry').effects, 'conflict');
      assert.equal(se.read(SETTINGS), before);
    } finally { se.dispose(); }
  } finally { s.dispose(); }
});

test('owned-claim policy-version gates reject a 1.0 policy that would touch hook custody before any mutation', async () => {
  const s = sandbox();
  try {
    await run(s, policy11([hookSelection('guard-a', [hookOp('add', 'guard-a')], {})], { managedSelections: [{ id: 'team', scope: 'project', members: ['guard-a'] }] }));
    const before = s.read(SETTINGS);
    const rootsBefore = JSON.stringify(ownershipRoots(s));
    const legacyRemoval = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [], removals: [{ managementId: 'guard-a', scope: 'project' }] };
    const legacySet = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [], managedSelections: [{ id: 'team', scope: 'project', members: [] }] };
    const legacyObsolete = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{ id: 'guard-a', managementId: 'guard-a', scope: 'project', configuration: {}, requires: [],
      recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'legacy', description: 'legacy', inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [],
        operations: [{ id: 'note', purpose: 'note', kind: 'file.write', scope: 'project', requires: [], checks: [], target: { root: 'project', segments: [{ literal: 'NOTE.md' }] }, content: { literal: 'x' } }] } } }] };
    for (const [name, policy] of [['removals', legacyRemoval], ['managed set', legacySet], ['obsolete member', legacyObsolete]]) {
      const result = await prep(s, policy);
      assert.equal(result.status, 'invalid', name);
      assert.equal(result.prepared, undefined, name);
      assert.equal(result.diagnostics[0].code, 'SCHEMA_UNSUPPORTED', name);
      assert.equal(result.diagnostics[0].reason, 'hook-group-policy-version', name);
      assert.match(result.diagnostics[0].guidance, /1\.1\.0/);
    }
    assert.equal(s.read(SETTINGS), before);
    assert.equal(JSON.stringify(ownershipRoots(s)), rootsBefore);
    // A 1.1 cleanup-only policy can remove the same custody.
    const cleanup = { schema: 'urn:aihq:core:execution-policy:1.1.0', mode: 'vibe', selections: [], removals: [{ managementId: 'guard-a', scope: 'project' }] };
    const { result } = await run(s, cleanup);
    assert.equal(result.schema, 'urn:aihq:core:run-result:1.1.0');
    assert.equal(result.completion, 'complete');
  } finally { s.dispose(); }
});

test('a 1.0 policy that references acquired 1.1 recipe bytes is unsupported after acquisition and before any mutation', async () => {
  const s = sandbox();
  const source = mkdtempSync(join(tmpdir(), 'aih-hook-source-'));
  try {
    const recipe = hookSelection('guard-a', [hookOp('add', 'guard-a')]).recipe.inline;
    const raw = Buffer.from(JSON.stringify(recipe));
    writeFileSync(join(source, 'recipe.json'), raw);
    const selection = { id: 'guard-a', managementId: 'guard-a', scope: 'project', configuration: {}, requires: [],
      recipe: { reference: { source: { kind: 'local', input: 'source' }, path: 'recipe.json', sha256: sha(raw), byteLength: raw.length, materials: [] } } };
    const host = { materialRoots: { source } };
    const old = await prepare(request(s.project, { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [selection] }), { ...controls, ...host });
    assert.equal(old.status, 'invalid');
    assert.equal(old.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
    assert.equal(old.diagnostics[0].encountered, RECIPE_11);
    assert.equal(existsSync(join(s.home, '.aih', 'core', 'ownership')), false);
    assert.equal(s.read(SETTINGS), null);
    const current = await run(s, policy11([selection]), { controls: host });
    assert.equal(current.result.completion, 'complete');
    assert.equal(groupsOf(s).length, 1);
  } finally { s.dispose(); }
});

test('a group managed in user scope upgrades the user ownership root and its removal downgrades it', async () => {
  const s = sandbox();
  try {
    const target = { root: 'userHome', segments: [{ literal: '.tool' }, { literal: 'settings.json' }] };
    const userPolicy = action => policy11([hookSelection('user-guard', [hookOp(action === 'set' ? 'add' : 'drop', 'guard-a', { scope: 'user', target, action })], { scope: 'user' })]);
    await run(s, userPolicy('set'));
    const file = join(s.home, '.tool', 'settings.json');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse, [groupOf('guard-a')]);
    assert.deepEqual(ownershipRoots(s).map(root => root.schema), ['urn:aihq:core:ownership:1.1.0']);
    await run(s, userPolicy('remove'));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse, []);
    assert.deepEqual(ownershipRoots(s).map(root => root.schema), ['urn:aihq:core:ownership:1.0.0']);
  } finally { s.dispose(); }
});

test('cancellation before a later staged edit keeps the earlier effect, journals recovery, and claims no full success', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    const policy = policy11([hookSelection('first', [hookOp('add', 'first')]), hookSelection('second', [hookOp('add', 'second')])]);
    const prepared = await prepare(request(s.project, policy), controls);
    assert.equal(prepared.status, 'ready');
    const abort = new AbortController(); let calls = 0;
    const result = await applyWithGuard(prepared.prepared, authorize(prepared), { ...controls, signal: abort.signal }, () => { calls += 1; if (calls === 3) abort.abort(); });
    assert.equal(result.completion, 'cancelled');
    assert.deepEqual(result.operations.map(item => item.application), ['applied', 'not-attempted']);
    assert.equal(groupsOf(s).length, 2);
    assert.ok(result.recovery, 'the recovery journal reference is returned');
    assert.ok(existsSync(join(s.home, '.aih', 'core', result.recovery)));
    const fresh = await run(s, policy);
    assert.deepEqual(fresh.prepared.review.operations.map(item => item.effects), ['already-satisfied', 'replace-file']);
    assert.equal(groupsOf(s).length, 3);
  } finally { s.dispose(); }
});
