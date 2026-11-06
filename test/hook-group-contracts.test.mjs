import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, validatePolicy, validateRecipe} from '../dist/core/engine-contracts.js';
import { policy } from './fixture.mjs';
import { guard, run, validPrepared, validResult } from './hook-group-harness.mjs';
import { POLICY_11, RECIPE_11, PREPARED_11, RESULT_11, hookOp, hookSelection, policy11, groupOf, sandbox } from './hook-group-fixture.mjs';

const valid = () => policy11([hookSelection('guard', [hookOp('add', 'guard-a')])]);

test('a 1.1 policy admits hook.group and mixed 1.0/1.1 recipes; a 1.0 policy never does', () => {
  const document = valid();
  assert.deepEqual(parsePolicy(JSON.stringify(document)), { valid: true, schema: POLICY_11, document, diagnostics: [] });
  assert.equal(validateRecipe(document.selections[0].recipe.inline).valid, true);
  const mixed = policy11([...document.selections, { ...policy().selections[0] }]);
  assert.equal(validatePolicy(mixed).valid, true, JSON.stringify(validatePolicy(mixed).diagnostics));
  const old = structuredClone(document); old.schema = 'urn:aihq:core:execution-policy:1.0.0';
  const result = validatePolicy(old);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  assert.deepEqual(result.diagnostics[0].supported, ['urn:aihq:core:recipe:1.0.0']);
  const oldRecipe = structuredClone(document.selections[0].recipe.inline); oldRecipe.schema = 'urn:aihq:core:recipe:1.0.0';
  assert.equal(validateRecipe(oldRecipe).valid, false);
  assert.equal(validatePolicy(policy()).valid, true);
  const current = valid(); current.schema = 'urn:aihq:core:execution-policy:1.2.0';
  assert.equal(validatePolicy(current).valid, true);
  const future = valid(); future.schema = 'urn:aihq:core:execution-policy:99.0.0';
  assert.equal(validatePolicy(future).diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
});

test('invalid hook descriptors use input diagnostics', () => {
  const mutations = {
    'set without a group': op => { delete op.group; },
    'remove with a group': op => { op.action = 'remove'; },
    'group not an object': op => { op.group = { literal: ['x'] }; },
    'group missing the selector value': op => { op.group = { literal: groupOf('other') }; },
    'group selector path absent': op => { op.group = { literal: { matcher: 'Bash' } }; },
    'input-bound group': op => { op.group = { input: 'x' }; },
    'empty container': op => { op.container = []; },
    'numeric container index': op => { op.container = ['hooks', 0]; },
    'unsafe container segment': op => { op.container = ['hooks', '']; },
    'toml format': op => { op.format = 'toml'; },
    'empty selector value': op => { op.selector.value = ''; },
    'empty selector path': op => { op.selector.path = []; },
    'negative selector index': op => { op.selector.path = ['hooks', -1, 'command']; },
    'wildcard-like selector path object': op => { op.selector.path = ['hooks', { any: true }]; },
    'extra descriptor field': op => { op.extra = true; },
    'groupId syntax': op => { op.groupId = 'has space'; },
    'too deep group': op => { let node = op.group.literal; for (let i = 0; i < 40; i += 1) { node.n = {}; node = node.n; } }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const document = valid(); mutate(document.selections[0].recipe.inline.operations[0]);
    const result = validatePolicy(document);
    assert.equal(result.valid, false, name);
    assert.ok(result.diagnostics.every(item => item.code === 'INPUT_INVALID'), `${name}: ${JSON.stringify(result.diagnostics)}`);
  }
  const duplicate = policy11([hookSelection('guard', [hookOp('one', 'guard-a'), hookOp('two', 'guard-a', { selector: { path: ['matcher'], value: 'Bash' } })])]);
  assert.equal(validatePolicy(duplicate).valid, false);
  const sibling = policy11([hookSelection('guard', [hookOp('one', 'guard-a'), hookOp('two', 'guard-b')])]);
  assert.equal(validatePolicy(sibling).valid, true, 'distinct group IDs may share a container');
  const otherContainer = policy11([hookSelection('guard', [hookOp('one', 'guard-a'), hookOp('two', 'guard-a', { container: ['hooks', 'PostToolUse'] })])]);
  assert.equal(validatePolicy(otherContainer).valid, true);
});

test('the published 1.1 schemas require hook details on a hook.group operation and keep run results to the policy use case', async () => {
  const s = sandbox();
  try {
    const { prepared, result } = await run(s, guard());
    const review = structuredClone(prepared.review);
    assert.equal(validPrepared(review), true, JSON.stringify(validPrepared.errors));
    delete review.operations[0].details.hookGroup;
    assert.equal(validPrepared(review), false, 'a hook.group operation without details.hookGroup is rejected');
    const fileLike = structuredClone(prepared.review);
    fileLike.operations[0].kind = 'file.write';
    assert.equal(validPrepared(fileLike), false, 'hook details on any other operation kind are rejected');
    const repair = structuredClone(result);
    assert.equal(validResult(repair), true, JSON.stringify(validResult.errors));
    repair.useCase = 'repair';
    assert.equal(validResult(repair), false, 'run-result 1.1 is policy-only, like prepared-work 1.1');
  } finally { s.dispose(); }
});
