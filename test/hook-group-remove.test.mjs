import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS, canonicalSha, groupOf, hookOp, hookSelection, policy11, sandbox } from './hook-group-fixture.mjs';
import { compact, groupsOf, guard, neighbor, only, ownershipRoots, prep, run } from './hook-group-harness.mjs';

const OWNED = '{"hooks":[{"command":"hooks/guard-a.sh","type":"command"}],"matcher":"Bash"}';
const jsoncAdd = policy11([hookSelection('guard-a', [hookOp('add', 'guard-a', { format: 'jsonc' })])]);
const jsoncRemove = policy11([hookSelection('guard-a', [hookOp('drop', 'guard-a', { format: 'jsonc', action: 'remove' })])]);
const wrap = array => `{\n  // header comment\n  "hooks": {\n    "PreToolUse": ${array}\n  } // tail comment\n}\n`;

/** Adds the group, then replaces the array text while keeping the owned bytes, so custody stays valid. */
async function owned(s, layout) {
  s.write(SETTINGS, wrap('[]'));
  await run(s, jsoncAdd);
  s.write(SETTINGS, wrap(layout));
  return s.read(SETTINGS);
}

const layouts = {
  first: ['[\n      OWNED,\n      {"a":1},\n      {"b":2}\n    ]', '[\n      \n      {"a":1},\n      {"b":2}\n    ]'],
  middle: ['[\n      {"a":1},\n      OWNED,\n      {"b":2}\n    ]', '[\n      {"a":1},\n      \n      {"b":2}\n    ]'],
  last: ['[\n      {"a":1},\n      {"b":2},\n      OWNED\n    ]', '[\n      {"a":1},\n      {"b":2}\n    ]'],
  'last with trailing comma': ['[{"a":1},OWNED,]', '[{"a":1}]'],
  singleton: ['[\n      OWNED\n    ]', '[\n      \n    ]'],
  'singleton with trailing comma': ['[OWNED,]', '[]']
};
for (const [name, [layout, expected]] of Object.entries(layouts)) {
  test(`JSONC removal of a ${name} member deletes only the element and its comma`, async () => {
    const s = sandbox();
    try {
      const before = await owned(s, layout.replace('OWNED', OWNED));
      const { prepared, result } = await run(s, jsoncRemove);
      const op = only(prepared);
      assert.equal(op.effects, 'replace-file');
      assert.equal(op.details.hookGroup.action, 'remove');
      assert.equal(op.details.hookGroup.memberBeforeSha256, canonicalSha(groupOf('guard-a')));
      assert.equal(op.details.hookGroup.memberAfterSha256, null);
      assert.equal(op.details.hookGroup.desiredGroup, null);
      assert.equal(result.completion, 'complete');
      assert.equal(s.read(SETTINGS), before.replace(layout.replace('OWNED', OWNED), expected), 'bytes outside the span, including comments, are untouched');
    } finally { s.dispose(); }
  });
}

test('removing the final claim leaves an empty array, keeps the file, and downgrades ownership to 1.0', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    assert.equal(ownershipRoots(s)[0].schema, 'urn:aihq:core:ownership:1.1.0');
    const removal = policy11([hookSelection('guard-a', [hookOp('drop', 'guard-a', { action: 'remove' })])]);
    await run(s, removal);
    assert.deepEqual(groupsOf(s), [neighbor('a')]);
    assert.deepEqual(ownershipRoots(s).map(root => root.schema), ['urn:aihq:core:ownership:1.0.0']);
    assert.equal(Object.keys(ownershipRoots(s)[0].members).length, 0);
    const again = await run(s, removal);
    assert.equal(only(again.prepared).effects, 'already-satisfied', 'an already absent owned group is satisfied');
    s.write(SETTINGS, compact([]));
    await run(s, guard());
    await run(s, removal);
    assert.deepEqual(groupsOf(s), [], 'the emptied array and its file remain');
  } finally { s.dispose(); }
});

test('adjacent or trailing JSONC comments that a comma edit would move are conflicts with no write', async () => {
  const cases = {
    'comment after the owned comma': '[\n      OWNED, // about owned\n      {"a":1}\n    ]',
    'comment before the owned member': '[\n      {"a":1},\n      // about owned\n      OWNED\n    ]',
    'block comment after the owned member': '[\n      {"a":1},\n      OWNED /* last */\n    ]',
    'comment before the singleton': '[ /* only */ OWNED ]'
  };
  for (const [name, layout] of Object.entries(cases)) {
    const s = sandbox();
    try {
      const before = await owned(s, layout.replace('OWNED', OWNED));
      const prepared = await prep(s, jsoncRemove);
      assert.equal(prepared.status, 'blocked', name);
      assert.deepEqual(prepared.review.conflicts.map(item => [item.code, item.reason]), [['STATE_CONFLICT', 'hook-edit-unsafe']], name);
      assert.equal(s.read(SETTINGS), before, name);
    } finally { s.dispose(); }
  }
});

test('JSONC append follows the preceding element style and conflicts rather than moving a comment', async () => {
  const cases = [
    ['trailing comma is kept', '[{"a":1},]', `[{"a":1},${OWNED},]`],
    ['no trailing comma stays without one', '[{"a":1}]', `[{"a":1},${OWNED}]`],
    ['empty array inserts directly after the bracket', '[\n    ]', `[${OWNED}\n    ]`],
    ['pretty array reuses indentation', '[\n      {"a":1}\n    ]', `[\n      {"a":1},\n      ${OWNED}\n    ]`]
  ];
  for (const [name, layout, expected] of cases) {
    const s = sandbox();
    try {
      s.write(SETTINGS, wrap(layout));
      await run(s, jsoncAdd);
      assert.equal(s.read(SETTINGS), wrap(expected), name);
    } finally { s.dispose(); }
  }
  for (const [name, layout] of [['comment before the closing bracket', '[{"a":1} // last note\n    ]'], ['comment-only empty array', '[ // nothing yet\n    ]']]) {
    const s = sandbox();
    try {
      s.write(SETTINGS, wrap(layout));
      const prepared = await prep(s, jsoncAdd);
      assert.equal(prepared.status, 'blocked', name);
      assert.equal(prepared.review.conflicts[0].reason, 'hook-edit-unsafe', name);
      assert.equal(s.read(SETTINGS), wrap(layout), name);
    } finally { s.dispose(); }
  }
});

test('unsupported syntax, a wrong container type and strict JSON comments are conflicts before any write', async () => {
  const cases = [
    ['strict JSON with a comment', '{"hooks":{"PreToolUse":[]}} // note\n', guard(), 'unsupported-json-syntax'],
    ['container is an object', '{"hooks":{"PreToolUse":{}}}', guard(), 'hook-edit-unsafe'],
    ['container path crosses a string', '{"hooks":"text"}', guard(), 'hook-edit-unsafe'],
    ['duplicate keys', '{"hooks":{"PreToolUse":[]},"hooks":{}}', guard(), 'duplicate-json-key']
  ];
  for (const [name, text, policy, reason] of cases) {
    const s = sandbox();
    try {
      s.write(SETTINGS, text);
      const prepared = await prep(s, policy);
      assert.equal(prepared.status, 'blocked', name);
      assert.equal(prepared.review.conflicts[0].reason, reason, name);
      assert.equal(s.read(SETTINGS), text, name);
    } finally { s.dispose(); }
  }
});
