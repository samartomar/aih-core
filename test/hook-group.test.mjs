import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepare, apply } from '../dist/core/index.js';
import { policy as legacyPolicy } from './fixture.mjs';
import { CONTAINER, PREPARED_11, RESULT_11, SETTINGS, authorize, canonicalSha, groupOf, hookOp, hookSelection, policy11,
  request, sandbox, selectorSha, sha } from './hook-group-fixture.mjs';
import { controls, guard, only, ownershipRoots, run } from './hook-group-harness.mjs';

test('adding to a missing JSON target previews one bounded add and Apply appends once', async () => {
  const s = sandbox();
  try {
    const group = groupOf('guard-a');
    const { prepared, result } = await run(s, guard());
    assert.equal(prepared.review.schema, PREPARED_11);
    const op = only(prepared);
    assert.deepEqual({ kind: op.kind, effects: op.effects, ownership: op.ownership }, { kind: 'hook.group', effects: 'create-file', ownership: 'unowned' });
    assert.deepEqual(op.details.hookGroup, { container: CONTAINER, groupId: 'guard-a',
      selector: { path: ['hooks', 0, 'command'], valueSha256: selectorSha('guard-a') }, action: 'set', matchedIndex: null,
      memberBeforeSha256: null, memberAfterSha256: canonicalSha(group), targetBeforeSha256: null, desiredGroup: group });
    assert.equal(result.schema, RESULT_11);
    assert.equal(result.completion, 'complete');
    assert.deepEqual(result.operations.map(item => item.application), ['applied']);
    assert.deepEqual(JSON.parse(s.read(SETTINGS)), { hooks: { PreToolUse: [group] } });
  } finally { s.dispose(); }
});

test('adding to an existing JSONC array keeps every neighbor byte and a repeat is already satisfied', async () => {
  const s = sandbox();
  try {
    const before = '{\n  // keep this note\n  "other": 1,\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Edit", "hooks": [{ "type": "command", "command": "mine/other.sh" }] }\n    ],\n    "Stop": [ ]\n  }\n}\n';
    s.write(SETTINGS, before);
    const policy = policy11([hookSelection('guard-a', [hookOp('add', 'guard-a', { format: 'jsonc' })])]);
    const { prepared, result } = await run(s, policy);
    assert.equal(only(prepared).effects, 'replace-file');
    assert.equal(only(prepared).details.hookGroup.targetBeforeSha256, sha(before));
    assert.equal(result.completion, 'complete');
    const appended = '{"hooks":[{"command":"hooks/guard-a.sh","type":"command"}],"matcher":"Bash"}';
    assert.equal(s.read(SETTINGS), before.replace('"mine/other.sh" }] }\n', `"mine/other.sh" }] },\n      ${appended}\n`));
    const again = await run(s, policy);
    assert.equal(only(again.prepared).effects, 'already-satisfied');
    assert.equal(only(again.prepared).ownership, 'managed');
    assert.equal(only(again.prepared).details.hookGroup.matchedIndex, 1);
    assert.deepEqual(again.result.operations.map(item => item.application), ['already-satisfied']);
    assert.equal(s.read(SETTINGS).split('guard-a.sh').length - 1, 1);
  } finally { s.dispose(); }
});

test('a 1.0 policy keeps its 1.0 prepared/result identities and 1.0 ownership bytes', async () => {
  const s = sandbox();
  try {
    const prepared = await prepare(request(s.project, legacyPolicy()), controls);
    assert.equal(prepared.review.schema, 'urn:aihq:core:prepared-work:1.0.0');
    const result = await apply(prepared.prepared, authorize(prepared), controls);
    assert.equal(result.schema, 'urn:aihq:core:run-result:1.0.0');
    assert.equal(result.completion, 'complete');
    assert.deepEqual(ownershipRoots(s).map(root => root.schema), ['urn:aihq:core:ownership:1.0.0']);
  } finally { s.dispose(); }
});

test('the first group upgrades the ownership root to 1.1 and stores only digests', async () => {
  const s = sandbox();
  try {
    await run(s, guard());
    const roots = ownershipRoots(s);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].schema, 'urn:aihq:core:ownership:1.1.0');
    const members = Object.values(roots[0].members);
    assert.equal(members.length, 1);
    assert.equal(members[0].descriptor.kind, 'hook');
    assert.deepEqual(members[0].descriptor.selector, { path: ['hooks', 0, 'command'], valueSha256: selectorSha('guard-a') });
    assert.equal(members[0].canonicalSha256, canonicalSha(groupOf('guard-a')));
    assert.equal(JSON.stringify(roots[0]).includes('guard-a.sh'), false, 'custody never stores the selector value or group bytes');
    assert.equal(readFileSync(join(s.home, '.aih', 'core', 'ownership', roots[0].name), 'utf8').includes('"matcher"'), false);
  } finally { s.dispose(); }
});
