import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipe, validatePolicy } from '../dist/core/contracts.js';
import { hookOp, hookSelection, policy11 } from './hook-group-fixture.mjs';

export function boundPolicy(command = 'node "C:/Example Home/hooks/guard.mjs"') {
  const op = hookOp('guard', 'guard');
  op.selector = { path: ['hooks', 0, 'command'], input: 'guardCommand' };
  op.group.literal.hooks[0].command = '';
  op.groupBindings = [{ path: ['hooks', 0, 'command'], value: { input: 'guardCommand' } }];
  const selection = hookSelection('framework', [op]);
  selection.recipe.inline.schema = 'urn:aihq:core:recipe:1.3.0';
  selection.recipe.inline.inputs = { guardCommand: { type: 'string', required: true, minLength: 1, maxLength: 4096 } };
  selection.configuration = { guardCommand: command };
  return { ...policy11([selection]), schema: 'urn:aihq:core:execution-policy:1.3.0' };
}

test('one immutable hook recipe accepts a deployment command as a declared input', () => {
  const policy = boundPolicy();
  assert.deepEqual(validateRecipe(policy.selections[0].recipe.inline).diagnostics, []);
  assert.deepEqual(validatePolicy(policy).diagnostics, []);
  const old = structuredClone(policy);
  old.schema = 'urn:aihq:core:execution-policy:1.2.0';
  assert.equal(validatePolicy(old).valid, false);
  old.selections[0].recipe.inline.schema = 'urn:aihq:core:recipe:1.2.0';
  assert.equal(validateRecipe(old.selections[0].recipe.inline).valid, false);
});

import { prepare, apply, checkFileState } from '../dist/core/index.js';
import { SETTINGS, sandbox, authorize, settingsText } from './hook-group-fixture.mjs';

test('bound hook install, command update and removal preserve neighboring user hooks', async () => {
  const fixture = sandbox();
  const human = { matcher: 'Bash', hooks: [{ type: 'command', command: 'human-hook' }] };
  try {
    fixture.write(SETTINGS, settingsText([human], { humanSetting: true }));
    const policy = boundPolicy('node "C:/Home A/guard.mjs"');
    const recipeBytes = JSON.stringify(policy.selections[0].recipe.inline);
    const run = async document => {
      const prepared = await prepare({ useCase: 'policy', policy: document, target: { project: fixture.project } }, { logging: 'off' });
      assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
      const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
      assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
      return prepared;
    };
    await run(policy);
    policy.selections[0].configuration.guardCommand = 'node "C:/Home B/guard.mjs"';
    const changed = await run(policy);
    assert.equal(JSON.stringify(policy.selections[0].recipe.inline), recipeBytes);
    const settings = JSON.parse(fixture.read(SETTINGS));
    assert.deepEqual(settings.hooks.PreToolUse, [human, { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "C:/Home B/guard.mjs"' }] }]);
    assert.equal(settings.humanSetting, true);
    assert.equal(changed.review.operations[0].details.hookGroup.desiredGroup.hooks[0].command, 'node "C:/Home B/guard.mjs"');
    const observed = await checkFileState({ policy, target: { project: fixture.project } });
    assert.equal(observed.fileState, 'match', JSON.stringify(observed));
    await run({ ...policy, selections: [], removals: [{ managementId: 'framework', scope: 'project' }] });
    assert.deepEqual(JSON.parse(fixture.read(SETTINGS)), { humanSetting: true, hooks: { PreToolUse: [human] } });
  } finally { fixture.dispose(); }
});

test('hook bindings refuse unknown inputs, ambiguous paths, type changes and selector mismatch', () => {
  const mutations = {
    'unknown input': (op, recipe) => { op.groupBindings[0].value.input = 'missing'; },
    'missing leaf': op => { op.groupBindings[0].path = ['hooks', 0, 'absent']; },
    'object leaf': op => { op.groupBindings[0].path = ['hooks', 0]; },
    'prototype path': op => { op.groupBindings[0].path = ['__proto__', 'polluted']; },
    'duplicate path': op => { op.groupBindings.push(structuredClone(op.groupBindings[0])); },
    'changed scalar type': (op, recipe) => { recipe.inputs.guardCommand.type = 'boolean'; delete recipe.inputs.guardCommand.minLength; delete recipe.inputs.guardCommand.maxLength; },
    'selector not bound to same input': (op, recipe) => { recipe.inputs.other = { type: 'string', required: true }; op.selector.input = 'other'; },
    'selector has both alternatives': op => { op.selector.value = 'other'; },
    'binding on removal': op => { op.action = 'remove'; delete op.group; },
    'object value': op => { op.groupBindings[0].value = { literal: { executable: 'bad' } }; }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const recipe = boundPolicy().selections[0].recipe.inline;
    mutate(recipe.operations[0], recipe);
    assert.equal(validateRecipe(recipe).valid, false, name);
  }
});

test('private hook scalar bindings are redacted from review while apply retains their values', async () => {
  const fixture = sandbox();
  try {
    const policy = boundPolicy();
    const recipe = policy.selections[0].recipe.inline;
    const op = recipe.operations[0];
    for (const [name, type, placeholder] of [['secretText', 'string', ''], ['secretNumber', 'integer', 0], ['secretFlag', 'boolean', false]]) {
      recipe.inputs[name] = { type, required: true, sensitive: true };
      op.group.literal[name] = placeholder;
      op.groupBindings.push({ path: [name], value: { input: name } });
    }
    op.group.literal.publicNumber = 8675309;
    op.group.literal.publicFlag = true;
    const values = { secretText: 'private-hook-value', secretNumber: 8675309, secretFlag: true };
    const prepared = await prepare({ useCase: 'policy', policy, target: { project: fixture.project } },
      { logging: 'off', privateInputs: { framework: values } });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    const desired = prepared.review.operations[0].details.hookGroup.desiredGroup;
    for (const name of Object.keys(values)) assert.equal(desired[name], '[REDACTED]', name);
    assert.equal(desired.publicNumber, 8675309);
    assert.equal(desired.publicFlag, true);
    const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
    assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
    const applied = JSON.parse(fixture.read(SETTINGS)).hooks.PreToolUse[0];
    for (const [name, value] of Object.entries(values)) assert.equal(applied[name], value);
  } finally { fixture.dispose(); }
});

test('file-state rejects omitted public hook slots before observation but leaves private omissions unavailable', async () => {
  const fixture = sandbox();
  try {
    for (const slot of ['selector', 'group']) {
      const policy = boundPolicy();
      const selection = policy.selections[0];
      const recipe = selection.recipe.inline;
      let name = 'guardCommand';
      if (slot === 'group') {
        name = 'optionalCount';
        recipe.inputs[name] = { type: 'integer', required: false };
        recipe.operations[0].group.literal.count = 0;
        recipe.operations[0].groupBindings.push({ path: ['count'], value: { input: name } });
      } else {
        recipe.inputs[name].required = false;
        delete selection.configuration[name];
      }
      const request = { policy, target: { project: fixture.project } };
      for (const signal of [undefined, AbortSignal.abort()]) {
        const observed = await checkFileState(request, { signal });
        assert.equal(observed.status, 'invalid', `${slot}: ${JSON.stringify(observed)}`);
        assert.equal(observed.coverage.comparedTargets, 0);
      }
      recipe.inputs[name].sensitive = true;
      const privateOmitted = await checkFileState(request);
      assert.equal(privateOmitted.status, 'incomplete', JSON.stringify(privateOmitted));
      assert.equal(privateOmitted.fileState, 'unverified');
      assert.equal(privateOmitted.targets[0].reason, 'input-unavailable');
    }
    assert.equal(fixture.read(SETTINGS), null);
  } finally { fixture.dispose(); }
});
