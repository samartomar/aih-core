import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFileState } from '../dist/core/index.js';
import { SETTINGS, sha, groupOf, hookOp, hookSelection, policy11, sandbox } from './hook-group-fixture.mjs';
import { compact, guard, neighbor, run } from './hook-group-harness.mjs';

const check = (s, policy) => checkFileState({ policy, target: { project: s.project } });
const removal = policy11([hookSelection('guard-a', [hookOp('drop', 'guard-a', { action: 'remove' })])]);
const outcome = result => [result.targets[0].outcome, result.targets[0].reason];

test('file-state set matches an unowned identical group, hypothetically adds or replaces otherwise, and never claims custody', async () => {
  const s = sandbox();
  try {
    const text = compact([neighbor('a'), groupOf('guard-a')]);
    s.write(SETTINGS, text);
    const matching = await check(s, guard());
    assert.deepEqual(outcome(matching), ['match', 'content-match']);
    assert.equal(matching.fileState, 'match');
    assert.equal(matching.authority, 'not-evaluated');
    s.write(SETTINGS, compact([neighbor('a')]));
    assert.deepEqual(outcome(await check(s, guard())), ['changed', 'content-changed'], 'an absent selector hypothetically appends');
    s.write(SETTINGS, compact([neighbor('a'), groupOf('guard-a', { matcher: 'Other' })]));
    assert.deepEqual(outcome(await check(s, guard())), ['changed', 'content-changed'], 'a unique different group hypothetically replaces');
    const edited = s.read(SETTINGS);
    s.write(SETTINGS, edited);
    assert.equal(s.read(SETTINGS), edited, 'read-only');
    assert.equal(existsSync(join(s.home, '.aih')), false, 'no custody, history or state is written');
    s.write(SETTINGS, compact([groupOf('guard-a'), groupOf('guard-a')]));
    const duplicated = await check(s, guard());
    assert.deepEqual(outcome(duplicated), ['unavailable', 'hook-selector-ambiguous']);
    assert.equal(duplicated.fileState, 'unverified');
    assert.equal(existsSync(join(s.home, '.aih')), false);
  } finally { s.dispose(); }
});

test('file-state on a missing target reports absent for a set and a satisfied removal as a match', async () => {
  const s = sandbox();
  try {
    assert.deepEqual(outcome(await check(s, guard())), ['absent', 'target-absent']);
    assert.equal((await check(s, guard())).fileState, 'changed');
    assert.deepEqual(outcome(await check(s, removal)), ['match', 'content-match']);
  } finally { s.dispose(); }
});

test('file-state remove: missing selector matches, a unique present selector changes, duplicates and unsafe edits are unavailable', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    assert.deepEqual(outcome(await check(s, removal)), ['match', 'content-match']);
    s.write(SETTINGS, compact([neighbor('a'), groupOf('guard-a')]));
    assert.deepEqual(outcome(await check(s, removal)), ['changed', 'content-changed']);
    s.write(SETTINGS, compact([groupOf('guard-a'), groupOf('guard-a', { x: 1 })]));
    assert.deepEqual(outcome(await check(s, removal)), ['unavailable', 'hook-selector-ambiguous']);
    const jsonc = policy11([hookSelection('guard-a', [hookOp('drop', 'guard-a', { action: 'remove', format: 'jsonc' })])]);
    s.write(SETTINGS, '{"hooks":{"PreToolUse":[\n  {"matcher":"x"}, // keep\n  {"hooks":[{"command":"hooks/guard-a.sh","type":"command"}],"matcher":"Bash"}\n]}}');
    assert.deepEqual(outcome(await check(s, jsonc)), ['unavailable', 'hook-edit-unsafe']);
    s.write(SETTINGS, '{"hooks":{"PreToolUse":{}}}');
    assert.deepEqual(outcome(await check(s, removal)), ['unavailable', 'hook-edit-unsafe']);
  } finally { s.dispose(); }
});

test('file-state folds an earlier hook operation into a later operation on the same target in order', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    const both = policy11([hookSelection('first', [hookOp('add', 'first')]), hookSelection('second', [hookOp('add', 'second')])]);
    assert.deepEqual(outcome(await check(s, both)), ['changed', 'content-changed']);
    await run(s, both);
    assert.deepEqual(outcome(await check(s, both)), ['match', 'content-match']);
  } finally { s.dispose(); }
});

test('file-state refuses a 1.0 policy that acquires a 1.1 recipe by reference, as Prepare does', async () => {
  const s = sandbox();
  const source = mkdtempSync(join(tmpdir(), 'aih-hook-source-'));
  try {
    const raw = Buffer.from(JSON.stringify(hookSelection('guard-a', [hookOp('add', 'guard-a')]).recipe.inline));
    writeFileSync(join(source, 'recipe.json'), raw);
    const selection = { id: 'guard-a', managementId: 'guard-a', scope: 'project', configuration: {}, requires: [],
      recipe: { reference: { source: { kind: 'local', input: 'source' }, path: 'recipe.json', sha256: sha(raw), byteLength: raw.length, materials: [] } } };
    s.write(SETTINGS, compact([groupOf('guard-a')]));
    const old = await checkFileState({ policy: { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [selection] },
      target: { project: s.project } }, { materialRoots: { source } });
    assert.equal(old.status, 'invalid');
    assert.equal(old.fileState, 'unverified');
    assert.equal(old.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
    assert.equal(old.diagnostics[0].reason, 'recipe-schema');
    const current = await checkFileState({ policy: policy11([selection]), target: { project: s.project } }, { materialRoots: { source } });
    assert.deepEqual(outcome(current), ['match', 'content-match'], 'the same recipe is admitted under a 1.1 policy');
  } finally { s.dispose(); }
});
