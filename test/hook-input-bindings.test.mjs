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
