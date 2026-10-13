import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../dist/core/contracts.js';
import { policy } from './fixture.mjs';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('an inline author derives a validated identity without acquiring materials', async () => {
  const recipe = policy().selections[0].recipe.inline;
  const result = await contracts.deriveRecipeIdentity({ recipe });
  assert.equal(result.status, 'ok');
  assert.match(result.value.recipeIdentity, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.value.materials, []);
  assert.deepEqual(await contracts.deriveRecipeIdentity({ recipe: structuredClone(recipe) }), result);
});

test('referenced identity binds exact bytes and refuses unsupported, malformed or incomplete declarations', async () => {
  const recipe = policy().selections[0].recipe.inline;
  const recipeBytes = new TextEncoder().encode(JSON.stringify(recipe, null, 2));
  const reference = { source: { kind: 'local', input: 'content' }, path: 'recipe.json',
    sha256: hash(recipeBytes), byteLength: recipeBytes.length, materials: [] };
  const good = await contracts.deriveRecipeIdentity({ recipeBytes, reference });
  assert.equal(good.status, 'ok');
  assert.equal(good.value.recipeSha256, reference.sha256);
  assert.notEqual(good.value.recipeIdentity, (await contracts.deriveRecipeIdentity({ recipe })).value.recipeIdentity);
  const cases = [
    [{ recipeBytes: recipeBytes.slice(1), reference }, 'recipe-bytes-mismatch', '/recipeBytes'],
    [{ recipeBytes, reference: { ...reference, byteLength: recipeBytes.length + 1 } }, 'recipe-bytes-mismatch', '/recipeBytes'],
    [{ recipeBytes, reference: { ...reference, materials: [{ id: 'extra', path: 'extra', sha256: '0'.repeat(64), byteLength: 0 }] } }, 'material-closure', '/reference/materials'],
    [{ recipe: { ...recipe, schema: 'urn:aihq:core:recipe:99.0.0' } }, 'unsupported-schema', '/recipe'],
    [{ recipe: { ...recipe, inputs: { text: { type: 'string', required: true, minLength: 4, maxLength: 1 } } } }, 'recipe-invalid', '/recipe'],
    [{ recipe, recipeBytes, reference }, 'recipe-invalid', ''],
  ];
  for (const [request, reason, path] of cases) {
    const result = await contracts.deriveRecipeIdentity(request);
    assert.equal(result.status, 'refused');
    assert.equal(result.diagnostics[0].reason, reason);
    assert.equal(result.diagnostics[0].path, path);
  }
  const unsupported = await contracts.deriveRecipeIdentity({ recipe: { ...recipe, schema: 'unknown' } });
  assert.deepEqual(unsupported.diagnostics[0].details, { owner: 'core', diagnostics:
    contracts.validateRecipe({ ...recipe, schema: 'unknown' }).diagnostics });
});

test('preview compares validated selections and returns denials inside a successful advisory result', async () => {
  const recipe = policy().selections[0].recipe.inline;
  const { value: { recipeIdentity } } = await contracts.deriveRecipeIdentity({ recipe });
  const selection = { id: 'guidance', organizationSelectionId: 'team-review', scope: 'project', recipeIdentity,
    inputs: recipe.inputs, configuration: { text: 'hello' }, privateInputs: [] };
  const organization = { schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'team', selections: [{
    selectionId: 'team-review', recipeIdentity, scopes: ['project'], inputs: { text: { allowDeclared: true } }
  }] };
  assert.deepEqual(contracts.previewOrganizationAdmission({ organization, selections: [selection], lifecycle: [] }),
    { status: 'ok', value: { admitted: true, diagnostics: [] }, diagnostics: [] });
  const denied = contracts.previewOrganizationAdmission({ organization: { ...organization, selections: [] }, selections: [selection], lifecycle: [] });
  assert.equal(denied.status, 'ok');
  assert.equal(denied.value.admitted, false);
  assert.equal(denied.value.diagnostics[0].reason, 'selection-not-admitted');
  assert.equal(denied.value.diagnostics[0].path, '/selections/0');
});

test('preview validates every record, preserves owning diagnostics and covers each stable admission reason', async () => {
  const recipe = policy().selections[0].recipe.inline;
  const { value: { recipeIdentity } } = await contracts.deriveRecipeIdentity({ recipe });
  const selection = { id: 'guidance', organizationSelectionId: 'team-review', scope: 'project', recipeIdentity,
    inputs: recipe.inputs, configuration: { text: 'hello' }, privateInputs: [] };
  const entry = { selectionId: 'team-review', recipeIdentity, scopes: ['project'], inputs: { text: { allowDeclared: true } } };
  const organization = { schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'team', selections: [entry] };
  const request = { organization, selections: [selection], lifecycle: [] };
  const cases = [
    [{ ...entry, recipeIdentity: 'sha256:' + '0'.repeat(64) }, selection, 'recipe-identity'],
    [{ ...entry, scopes: ['user'] }, selection, 'scope'],
    [{ ...entry, inputs: {} }, selection, 'input-not-permitted'],
    [{ ...entry, inputs: { text: { fixed: 'other' } } }, selection, 'input-value'],
    [{ ...entry, inputs: {} }, { ...selection, inputs: { text: { type: 'string', required: false } }, configuration: {} }, 'organization-permission-incomplete'],
    [{ ...entry, inputs: { text: { fixed: 7 } } }, selection, 'organization-input-spec'],
  ];
  for (const [candidate, selected, reason] of cases) {
    const result = contracts.previewOrganizationAdmission({ ...request, organization: { ...organization, selections: [candidate] }, selections: [selected] });
    assert.equal(result.status, 'ok');
    assert.equal(result.value.admitted, false);
    assert.ok(result.value.diagnostics.some(d => d.reason === reason), JSON.stringify(result));
  }
  for (const action of ['replace', 'adopt', 'remove']) {
    const lifecycle = [{ action, scope: 'project', recipeIdentity, organizationSelectionId: 'team-review' }];
    const denied = contracts.previewOrganizationAdmission({ ...request, lifecycle });
    assert.equal(denied.value.diagnostics[0].reason, `lifecycle-${action}`);
    assert.equal(denied.value.diagnostics[0].path, '/lifecycle/0');
    assert.equal(contracts.previewOrganizationAdmission({ ...request, lifecycle, organization: { ...organization,
      selections: [{ ...entry, lifecycle: { [action]: true } }] } }).value.admitted, true);
  }
  const malformed = [
    { ...request, selections: [{ ...selection, scope: 'machine' }] },
    { ...request, selections: [selection, selection] },
    { ...request, selections: [{ ...selection, recipeIdentity: 'wrong' }] },
    { ...request, selections: [{ ...selection, inputs: { text: { type: 'string', required: true, minimum: 3 } } }] },
    { ...request, selections: [{ ...selection, configuration: { text: 7 } }] },
    { ...request, selections: [{ ...selection, configuration: { text: 'hello', unknown: true } }] },
    { ...request, selections: [{ ...selection, privateInputs: ['unknown'] }] },
    { ...request, selections: [{ ...selection, inputs: { ...selection.inputs, token: { type: 'string', required: true, sensitive: true } } }] },
    { ...request, selections: [{ ...selection, privateInputs: [{ secret: 'value' }] }] },
    { ...request, lifecycle: [{ action: 'execute', scope: 'project', recipeIdentity }] },
    { ...request, lifecycle: [{ action: 'remove', scope: 'project', recipeIdentity: 'bad' }] },
    { ...request, selections: Array(4097).fill(selection) },
  ];
  for (const candidate of malformed) assert.equal(contracts.previewOrganizationAdmission(candidate).status, 'refused');
  const badOrg = { ...organization, schema: 'urn:aihq:core:organization-policy:2.0.0' };
  const refused = contracts.previewOrganizationAdmission({ ...request, organization: badOrg });
  assert.deepEqual(refused.diagnostics[0].details, { owner: 'core', diagnostics: contracts.validateOrganizationPolicy(badOrg).diagnostics });
  const before = JSON.stringify(request);
  assert.deepEqual(contracts.previewOrganizationAdmission(request), contracts.previewOrganizationAdmission(structuredClone(request)));
  assert.equal(JSON.stringify(request), before);
  let called = false;
  const accessor = { ...request };
  Object.defineProperty(accessor, 'organization', { enumerable: true, get() { called = true; return organization; } });
  assert.equal(contracts.previewOrganizationAdmission(accessor).status, 'refused');
  assert.equal(called, false);
});

test('identity rejects unsafe referenced paths and incomplete inline material declarations', async () => {
  const recipe = policy().selections[0].recipe.inline;
  recipe.materials = [{ id: 'a', sha256: '0'.repeat(64), byteLength: 0 }];
  assert.equal((await contracts.deriveRecipeIdentity({ recipe })).status, 'refused');
  const recipeBytes = new TextEncoder().encode(JSON.stringify(recipe));
  const reference = { source: { kind: 'local', input: 'content' }, path: '../recipe.json',
    sha256: hash(recipeBytes), byteLength: recipeBytes.length, materials: [] };
  const result = await contracts.deriveRecipeIdentity({ recipeBytes, reference });
  assert.equal(result.status, 'refused');
  assert.equal(result.diagnostics[0].details.diagnostics[0].reason, 'unsafe-member-path');
});
