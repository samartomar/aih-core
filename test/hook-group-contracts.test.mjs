import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parsePolicy, validatePolicy, validateRecipe, contractSupport } from '../dist/core/contracts.js';
import { policy } from './fixture.mjs';
import { POLICY_11, RECIPE_11, PREPARED_11, RESULT_11, hookOp, hookSelection, policy11, groupOf } from './hook-group-fixture.mjs';

const baseHashes = {
  'execution-policy': '3dd28436e048396f51fcf101a7939530ce75110e1dae92c7c9d6f7879d9f7117',
  'file-state-result': '48eb9d9c69634cf1be19828e346d35e680e8884829b9b02ee1f60bf33fc7ec04',
  'organization-policy': '92096b530c9db54044aa6bceafb2150a97955868a4ca8733cb7d1fc51c62098b',
  'prepared-work': 'b10ffe8e4beb3bddc79e1cf538659a68397b5587f4329ade7d18593a22eb19d2',
  recipe: '6591079740c0f8192d730142879dd866a3dac8551da17aa0bec0b102490fe6ec',
  'run-result': 'ccd4c52ccaa053aa87f8c3e530a6fcedfd601fa0657642d494bd0e60f615bded'
};
const sourceText = name => readFileSync(new URL(`../src/core/schemas/${name}/1.0.0.json`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const distSchema = name => JSON.parse(readFileSync(new URL(`../dist/core/schemas/${name}/1.0.0.json`, import.meta.url), 'utf8'));

test('1.0.0 schema bytes are immutable while 1.1.0 identities are published beside them', async () => {
  for (const [name, expected] of Object.entries(baseHashes)) {
    assert.equal(createHash('sha256').update(sourceText(name)).digest('hex'), expected, name);
    assert.deepEqual(distSchema(name), JSON.parse(sourceText(name)), `${name} publishes the same document`);
  }
  for (const [name, id] of [['execution-policy', POLICY_11], ['recipe', RECIPE_11], ['prepared-work', PREPARED_11], ['run-result', RESULT_11]]) {
    const schema = (await import(`@aihq/core/schemas/${name}/1.1.0.json`, { with: { type: 'json' } })).default;
    assert.equal(schema.$id, id);
  }
});

test('contract support declares exact 1.1 accepts/produces entries without displacing 1.0', () => {
  const find = id => contractSupport.contracts.find(item => item.id === id);
  assert.deepEqual(find(POLICY_11), { id: POLICY_11, role: 'accepts', schemaExport: '@aihq/core/schemas/execution-policy/1.1.0.json' });
  assert.deepEqual(find(RECIPE_11), { id: RECIPE_11, role: 'accepts', schemaExport: '@aihq/core/schemas/recipe/1.1.0.json' });
  assert.deepEqual(find(PREPARED_11), { id: PREPARED_11, role: 'produces', schemaExport: '@aihq/core/schemas/prepared-work/1.1.0.json' });
  assert.deepEqual(find(RESULT_11), { id: RESULT_11, role: 'produces', schemaExport: '@aihq/core/schemas/run-result/1.1.0.json' });
  assert.deepEqual(find('urn:aihq:core:execution-policy:1.0.0'), { id: 'urn:aihq:core:execution-policy:1.0.0', role: 'accepts',
    schemaExport: '@aihq/core/schemas/execution-policy/1.0.0.json' });
  assert.equal(contractSupport.contracts[0].id, 'urn:aihq:core:execution-policy:1.0.0');
});

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
  const future = valid(); future.schema = 'urn:aihq:core:execution-policy:1.2.0';
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
