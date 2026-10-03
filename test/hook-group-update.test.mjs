import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, apply } from '../dist/core/index.js';
import { SETTINGS, authorize, canonicalSha, groupOf, request, sandbox, sha } from './hook-group-fixture.mjs';
import { compact, controls, guard, guardWith, groupsOf, neighbor, only, prep, resolveOp, run } from './hook-group-harness.mjs';

test('an update replaces the owned group at its located index after neighbors edit in place and append', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    s.write(SETTINGS, s.read(SETTINGS).replace('"mine/a.sh"', '"mine/a-edited.sh"').replace(/\]\}\}$/, ',{"matcher":"Late"}]}}'));
    const { prepared, result } = await run(s, guardWith('guard-a', { matcher: 'Write' }));
    const op = only(prepared);
    assert.equal(op.effects, 'replace-file');
    assert.equal(op.details.hookGroup.matchedIndex, 1);
    assert.equal(op.details.hookGroup.memberBeforeSha256, canonicalSha(groupOf('guard-a')));
    assert.equal(op.details.hookGroup.memberAfterSha256, canonicalSha(groupOf('guard-a', { matcher: 'Write' })));
    assert.equal(result.completion, 'complete');
    assert.deepEqual(groupsOf(s), [neighbor('a-edited'), groupOf('guard-a', { matcher: 'Write' }), { matcher: 'Late' }]);
  } finally { s.dispose(); }
});

test('a neighbor insertion that moves the owned index still updates the same group at its new index', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    s.write(SETTINGS, s.read(SETTINGS).replace('"PreToolUse":[', '"PreToolUse":[{"matcher":"New"},'));
    const { prepared } = await run(s, guardWith('guard-a', { matcher: 'Write' }));
    assert.equal(only(prepared).details.hookGroup.matchedIndex, 2);
    assert.deepEqual(groupsOf(s), [{ matcher: 'New' }, neighbor('a'), groupOf('guard-a', { matcher: 'Write' })]);
  } finally { s.dispose(); }
});

test('an edited body is a conflict by default and a reviewed replace changes only that group', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    s.write(SETTINGS, s.read(SETTINGS).replace('"matcher":"Bash"', '"matcher":"Secret-local-matcher-9f3"'));
    const edited = s.read(SETTINGS);
    const blocked = await prep(s, guard());
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.prepared, undefined);
    assert.deepEqual(blocked.review.conflicts.map(item => [item.code, item.reason, item.path]), [['STATE_CONFLICT', 'owned-hook-edited', SETTINGS]]);
    assert.equal(only(blocked).effects, 'conflict');
    assert.equal(only(blocked).ownership, 'unowned');
    assert.equal(only(blocked).details.hookGroup.targetBeforeSha256, sha(edited));
    assert.equal(only(blocked).details.hookGroup.matchedIndex, 1);
    assert.equal(JSON.stringify(blocked).includes('Secret-local-matcher'), false, 'no observed group bytes in the review or its result');
    assert.equal(s.read(SETTINGS), edited, 'Prepare never writes');
    const stale = await prep(s, guard(), [{ selectionId: 'guard-a', operationId: 'add', choice: 'replace', observedSha256: sha('other') }]);
    assert.equal(stale.status, 'invalid');
    assert.equal(stale.diagnostics[0].reason, 'resolution-stale');
    const { prepared, result } = await run(s, guard(), { resolutions: [resolveOp(blocked, 'guard-a', 'add')] });
    assert.equal(only(prepared).effects, 'replace-file');
    assert.equal(result.completion, 'complete');
    assert.deepEqual(groupsOf(s), [neighbor('a'), groupOf('guard-a')]);
    const settled = await run(s, guard());
    assert.equal(only(settled.prepared).effects, 'already-satisfied');
    assert.equal(only(settled.prepared).ownership, 'managed');
  } finally { s.dispose(); }
});

test('a formatting-only change needs a reviewed replace, which refreshes custody without a target write', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    const reformatted = s.read(SETTINGS).replace('"matcher":"Bash"', '"matcher": "Bash"');
    s.write(SETTINGS, reformatted);
    const blocked = await prep(s, guard());
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.review.conflicts[0].reason, 'owned-hook-edited');
    const { prepared, result } = await run(s, guard(), { resolutions: [resolveOp(blocked, 'guard-a', 'add')] });
    assert.equal(only(prepared).effects, 'already-satisfied');
    assert.equal(only(prepared).details.reason, 'explicit-replace');
    assert.deepEqual(result.operations.map(item => item.application), ['already-satisfied']);
    assert.equal(s.read(SETTINGS), reformatted, 'no target write');
    assert.equal(only((await run(s, guard())).prepared).effects, 'already-satisfied');
  } finally { s.dispose(); }
});

test('a missing owned selector re-appends only with a reviewed replace and never deletes a neighbor', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    s.write(SETTINGS, compact([neighbor('a'), { matcher: 'Unrecognized' }]));
    const blocked = await prep(s, guard());
    assert.equal(blocked.review.conflicts[0].reason, 'owned-hook-missing');
    const { result } = await run(s, guard(), { resolutions: [resolveOp(blocked, 'guard-a', 'add')] });
    assert.equal(result.completion, 'complete');
    assert.deepEqual(groupsOf(s), [neighbor('a'), { matcher: 'Unrecognized' }, groupOf('guard-a')]);
  } finally { s.dispose(); }
});

test('an ambiguous selector cannot be resolved by replace', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    s.write(SETTINGS, s.read(SETTINGS).replace(/\]\}\}$/, `,${JSON.stringify(groupOf('guard-a', { note: 'copy' }))}]}}`));
    const blocked = await prep(s, guard());
    assert.equal(blocked.review.conflicts[0].reason, 'hook-selector-ambiguous');
    const forced = await prep(s, guard(), [resolveOp(blocked, 'guard-a', 'add')]);
    assert.equal(forced.status, 'blocked');
    assert.equal(forced.review.conflicts[0].reason, 'hook-selector-ambiguous');
    assert.equal(forced.prepared, undefined);
  } finally { s.dispose(); }
});

test('a neighbor edit between Prepare and Apply invalidates the review and a fresh Prepare preserves it', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    const prepared = await prepare(request(s.project, guard()), controls);
    assert.equal(prepared.status, 'ready');
    const edited = compact([neighbor('a-changed-after-review')]);
    s.write(SETTINGS, edited);
    const result = await apply(prepared.prepared, authorize(prepared), controls);
    assert.equal(result.completion, 'rejected');
    assert.equal(result.diagnostics.at(-1).code, 'REVIEW_STALE');
    assert.deepEqual(result.operations.map(item => item.application), ['not-attempted']);
    assert.equal(s.read(SETTINGS), edited);
    const fresh = await run(s, guard());
    assert.deepEqual(groupsOf(s), [neighbor('a-changed-after-review'), groupOf('guard-a')]);
    assert.equal(fresh.result.completion, 'complete');
  } finally { s.dispose(); }
});

test('a neighbor holding numbers canonical JSON cannot represent stays a neighbor and does not block an edit', async () => {
  const s = sandbox();
  try {
    const text = '{"hooks":{"PreToolUse":[{"weird":-0,"huge":1e999,"matcher":"Edit"}]}}';
    s.write(SETTINGS, text);
    const { result } = await run(s, guard());
    assert.equal(result.completion, 'complete');
    assert.equal(s.read(SETTINGS).startsWith('{"hooks":{"PreToolUse":[{"weird":-0,"huge":1e999,"matcher":"Edit"},'), true);
    const again = await run(s, guardWith('guard-a', { matcher: 'Write' }));
    assert.equal(only(again.prepared).effects, 'replace-file');
    assert.equal(s.read(SETTINGS).startsWith('{"hooks":{"PreToolUse":[{"weird":-0,"huge":1e999,"matcher":"Edit"},'), true);
  } finally { s.dispose(); }
});

test('an unreadable or empty target is a conflict and never a crash', async () => {
  const s = sandbox();
  try {
    for (const text of ['', '   ', '[]', '{"hooks":', 'not json']) {
      s.write(SETTINGS, text);
      const blocked = await prep(s, guard());
      assert.equal(blocked.status, 'blocked', JSON.stringify(text));
      assert.equal(blocked.review.conflicts[0].code, 'STATE_CONFLICT');
      assert.equal(s.read(SETTINGS), text);
    }
  } finally { s.dispose(); }
});
