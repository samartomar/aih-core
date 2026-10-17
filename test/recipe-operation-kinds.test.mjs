// Public-seam acceptance for `recipeOperationKinds`: the operation kinds of each supported
// recipe format and whether a fresh Prepare can establish their effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../dist/core/index.js';
import { contractSupport, recipeOperationKinds, validateRecipe } from '@aihq/core/contracts';
import { hookOp, policy11, request, sandbox } from './hook-group-fixture.mjs';

const RECIPES = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'].map(version => `urn:aihq:core:recipe:${version}`);
const schemaOf = async id => (await import(`@aihq/core/schemas/recipe/${id.split(':').at(-1)}.json`, { with: { type: 'json' } })).default;

test('each accepted recipe format lists exactly the operation kinds its schema admits', async () => {
  const accepted = contractSupport.contracts.filter(entry => entry.id.startsWith('urn:aihq:core:recipe:') && entry.role === 'accepts')
    .map(entry => entry.id);
  assert.deepEqual(Object.keys(recipeOperationKinds).sort(), [...accepted].sort());
  assert.deepEqual(Object.keys(recipeOperationKinds), RECIPES);
  assert.ok(Object.isFrozen(recipeOperationKinds));
  for (const id of RECIPES) {
    const schema = await schemaOf(id);
    const declared = schema.properties.operations.items.oneOf.map(({ $ref }) => schema.$defs[$ref.split('/').at(-1)].properties.kind.const);
    assert.deepEqual(recipeOperationKinds[id].map(item => item.kind), declared, id);
    assert.ok(Object.isFrozen(recipeOperationKinds[id]) && recipeOperationKinds[id].every(Object.isFrozen), id);
  }
  const effects = id => Object.fromEntries(recipeOperationKinds[id].map(item => [item.kind, item.effects]));
  assert.deepEqual(effects('urn:aihq:core:recipe:1.0.0'), { 'file.write': 'observable', 'config.entries': 'observable',
    'text.block': 'observable', 'file.remove': 'observable', 'process.run': 'opaque' });
  for (const id of RECIPES.slice(1)) assert.deepEqual(effects(id), { ...effects('urn:aihq:core:recipe:1.0.0'), 'hook.group': 'observable' }, id);
});

test('a fresh Prepare reviews exactly the opaque kinds as opaque processes', async () => {
  const s = sandbox('aih-operation-kinds-');
  try {
    const target = name => ({ root: 'project', segments: [{ literal: name }] });
    const base = { scope: 'project', requires: [], checks: [] };
    const operations = {
      'file.write': { ...base, id: 'write', purpose: 'Write', kind: 'file.write', target: target('A.md'), content: { literal: 'A\n' } },
      'config.entries': { ...base, id: 'config', purpose: 'Config', kind: 'config.entries', target: target('c.json'), format: 'json',
        entries: [{ path: ['key'], action: 'set', value: { literal: 'value' } }] },
      'text.block': { ...base, id: 'block', purpose: 'Block', kind: 'text.block', target: target('B.md'), blockId: 'b',
        startMarker: '<!-- b -->', endMarker: '<!-- /b -->', action: 'set', content: { literal: 'B\n' } },
      'file.remove': { ...base, id: 'remove', purpose: 'Remove', kind: 'file.remove', target: target('GONE.md') },
      'hook.group': hookOp('hook', 'kinds'),
      'process.run': { ...base, id: 'run', purpose: 'Run', kind: 'process.run', executable: { name: 'node' }, args: [],
        cwd: { root: 'project', segments: [] }, env: {}, acceptedExitCodes: [0], effects: ['nothing'] }
    };
    const kinds = recipeOperationKinds['urn:aihq:core:recipe:1.1.0'];
    assert.deepEqual(kinds.map(item => item.kind).sort(), Object.keys(operations).sort());
    const recipe = { schema: 'urn:aihq:core:recipe:1.1.0', id: 'kinds', description: 'Every operation kind', inputs: {}, materials: [],
      targets: ['project'], prerequisites: [], checks: [], operations: kinds.map(item => operations[item.kind]) };
    assert.equal(validateRecipe(recipe).valid, true, JSON.stringify(validateRecipe(recipe).diagnostics));
    const prepared = await prepare(request(s.project, policy11([{ id: 'kinds', managementId: 'kinds', scope: 'project',
      configuration: {}, requires: [], recipe: { inline: recipe } }])), { logging: 'off' });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    for (const { kind, effects } of kinds) {
      const reviewed = prepared.review.operations.find(op => op.id === `kinds/${operations[kind].id}`);
      if (effects === 'opaque') assert.equal(reviewed.effects, 'opaque-process', kind);
      else assert.ok(['create-file', 'replace-file', 'remove-file', 'already-satisfied'].includes(reviewed.effects), `${kind}: ${reviewed.effects}`);
    }
  } finally { s.dispose(); }
});
