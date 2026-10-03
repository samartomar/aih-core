import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, apply } from '../dist/core/index.js';
import { fakeFetch, orgRoutes, orgSource, recipeIdentity, SELECTION_ID, enterprisePolicy } from './fixtures/github-org.mjs';
import { SETTINGS, authorize, groupOf, hookOp, hookSelection, policy11, sandbox } from './hook-group-fixture.mjs';
import { groupsOf, compact, neighbor } from './hook-group-harness.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const HOOK_ORG_ID = 'hook-guidance';
const hookEntry = (selection, extra = {}) => ({ selectionId: HOOK_ORG_ID, recipeIdentity: recipeIdentity(selection.recipe.inline), scopes: ['project'], inputs: {}, ...extra });
const orgDoc = entries => ({ schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'example-org-policy', selections: entries });
const stub = document => { globalThis.fetch = fakeFetch(orgRoutes({ bytes: Buffer.from(JSON.stringify(document)) })); };
const hookSel = (name = 'guard-a') => hookSelection(name, [hookOp('add', name)], { organizationSelectionId: HOOK_ORG_ID });
const enterprise11 = (selections, extras = {}) => ({ ...policy11(selections, extras), mode: 'enterprise' });
const ask = (s, policy) => prepare({ useCase: 'policy', policy, target: { project: s.project }, organizationSource: orgSource() }, { logging: 'off' });

test('an admitted hook recipe prepares under a 1.1 Enterprise policy; any other recipe identity is blocked before a write', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    const selection = hookSel();
    stub(orgDoc([hookEntry(selection)]));
    const prepared = await ask(s, enterprise11([selection]));
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    assert.equal(prepared.review.schema, 'urn:aihq:core:prepared-work:1.1.0');
    assert.equal(prepared.review.mode, 'enterprise');
    const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
    assert.equal(result.schema, 'urn:aihq:core:run-result:1.1.0');
    assert.equal(result.completion, 'complete', JSON.stringify(result));
    assert.deepEqual(groupsOf(s), [neighbor('a'), groupOf('guard-a')]);
    // The same selection with different authored content has a different identity and is not admitted.
    const altered = hookSelection('guard-a', [hookOp('add', 'guard-a', { group: groupOf('guard-a', { matcher: 'Write' }) })], { organizationSelectionId: HOOK_ORG_ID });
    const before = s.read(SETTINGS);
    const denied = await ask(s, enterprise11([altered]));
    assert.equal(denied.status, 'blocked');
    assert.equal(denied.prepared, undefined);
    assert.equal(denied.diagnostics[0].code, 'AUTHORITY_DENIED');
    assert.equal(s.read(SETTINGS), before);
  } finally { s.dispose(); }
});

test('mixed 1.0 and 1.1 recipes need an organization entry each under a 1.1 policy', async () => {
  const s = sandbox();
  try {
    const legacy = enterprisePolicy().selections[0];
    const selection = hookSel();
    const both = enterprise11([legacy, selection]);
    stub(orgDoc([{ selectionId: SELECTION_ID, recipeIdentity: recipeIdentity(legacy.recipe.inline), scopes: ['project'], inputs: { text: { allowDeclared: true } } }, hookEntry(selection)]));
    const ready = await ask(s, both);
    assert.equal(ready.status, 'ready', JSON.stringify(ready.diagnostics));
    assert.equal((await apply(ready.prepared, authorize(ready), { logging: 'off' })).completion, 'complete');
    stub(orgDoc([{ selectionId: SELECTION_ID, recipeIdentity: recipeIdentity(legacy.recipe.inline), scopes: ['project'], inputs: { text: { allowDeclared: true } } }]));
    const denied = await ask(s, both);
    assert.equal(denied.status, 'blocked');
    assert.equal(denied.diagnostics[0].code, 'AUTHORITY_DENIED');
  } finally { s.dispose(); }
});

test('removing hook custody needs the organization lifecycle.remove permission', async () => {
  const s = sandbox();
  try {
    const selection = hookSel();
    stub(orgDoc([hookEntry(selection)]));
    const first = await ask(s, enterprise11([selection]));
    assert.equal((await apply(first.prepared, authorize(first), { logging: 'off' })).completion, 'complete');
    const removal = { schema: 'urn:aihq:core:execution-policy:1.1.0', mode: 'enterprise', selections: [], removals: [{ managementId: 'guard-a', scope: 'project' }] };
    const denied = await ask(s, removal);
    assert.equal(denied.status, 'blocked', JSON.stringify(denied.diagnostics));
    assert.deepEqual([denied.diagnostics[0].code, denied.diagnostics[0].reason], ['AUTHORITY_DENIED', 'lifecycle-remove']);
    assert.equal(groupsOf(s).length, 1);
    stub(orgDoc([hookEntry(selection, { lifecycle: { remove: true } })]));
    const permitted = await ask(s, removal);
    assert.equal(permitted.status, 'ready', JSON.stringify(permitted.diagnostics));
    assert.equal((await apply(permitted.prepared, authorize(permitted), { logging: 'off' })).completion, 'complete');
    assert.deepEqual(groupsOf(s), []);
  } finally { s.dispose(); }
});
