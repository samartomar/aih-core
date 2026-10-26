import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateOrganizationPolicy, parseOrganizationPolicy, previewOrganizationAdmission,
  previewOrganizationObligations, previewOrganizationContent, contractSupport } from '../dist/core/contracts.js';

const SCHEMA12 = 'urn:aihq:core:organization-policy:1.2.0';
const ID = `sha256:${'a'.repeat(64)}`;
const ID2 = `sha256:${'b'.repeat(64)}`;
const SET_SHA = 'c'.repeat(64);
const REPO = 'github.com/example-org/app';
const INPUTS = { text: { type: 'string', required: true, maxLength: 65536 } };
const SET = { framework: 'acme', setId: 'starter', setSha256: SET_SHA };
const members = (...itemIds) => [{ set: SET, members: itemIds.map(itemId => ({ framework: 'acme', itemId })) }];
const recipeEntry = (overrides = {}) => ({ selectionId: 'guidance', recipeIdentity: ID, scopes: ['project'],
  inputs: { text: { allowDeclared: true } }, obligation: 'permitted', ...overrides });
const contentEntry = (content, overrides = {}) => ({ selectionId: 'by-content', scopes: ['project'], obligation: 'prohibited',
  content, ...overrides });
const org = (...entries) => ({ schema: SCHEMA12, id: 'org-policy', selections: entries });
const dev = (overrides = {}) => ({ id: 'guidance', organizationSelectionId: 'guidance', scope: 'project', recipeIdentity: ID,
  inputs: INPUTS, configuration: { text: 'hello' }, privateInputs: [], kind: 'skill', item: { framework: 'acme', itemId: 'lint' },
  ...overrides });
const omit = (selection, ...names) => Object.fromEntries(Object.entries(selection).filter(([name]) => !names.includes(name)));
const reasons = preview => preview.value.diagnostics.map(diagnostic => diagnostic.reason);

test('1.2.0 is an accepted, exported contract that adds an optional content selector', () => {
  const found = contractSupport.contracts.find(contract => contract.id === SCHEMA12);
  assert.partialDeepStrictEqual(found, { id: SCHEMA12, role: 'accepts', schemaExport: '@aihq/core/schemas/organization-policy/1.2.0.json' });
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./schemas/organization-policy/1.2.0.json'], './dist/core/schemas/organization-policy/1.2.0.json');
  const document = org(recipeEntry({ obligation: 'required', clients: ['claude'], repositories: [REPO] }),
    contentEntry({ kind: 'hook' }), contentEntry({ item: { framework: 'acme', itemId: 'lint' } }, { selectionId: 'item', obligation: 'recommended' }),
    contentEntry({ framework: 'acme' }, { selectionId: 'framework', obligation: 'permitted' }),
    contentEntry({ set: SET }, { selectionId: 'set', obligation: 'required', scopes: ['user'] }),
    recipeEntry({ selectionId: 'narrowed', recipeIdentity: ID2, content: { kind: 'skill', framework: 'acme' } }));
  const result = validateOrganizationPolicy(document);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.schema, SCHEMA12);
  assert.equal(parseOrganizationPolicy(JSON.stringify(document)).valid, true);
});

test('1.2.0 structure: an entry names a recipe, content or both, and content selectors are closed', () => {
  const invalid = [
    { selectionId: 'nothing', scopes: ['project'], obligation: 'required' },
    contentEntry({}), contentEntry({ kind: 'plugin' }), contentEntry({ item: { framework: 'acme' } }),
    contentEntry({ set: { framework: 'acme', setId: 'starter' } }), contentEntry({ set: { ...SET, setSha256: 'x' } }),
    contentEntry({ kind: 'skill', extra: true }),
    contentEntry({ kind: 'skill' }, { inputs: {} }), contentEntry({ kind: 'skill' }, { lifecycle: { remove: true } }),
    { ...recipeEntry(), inputs: undefined },
    contentEntry({ kind: 'skill' }, { sources: [] })
  ].map(entry => JSON.parse(JSON.stringify(entry)));
  for (const entry of invalid) assert.equal(validateOrganizationPolicy(org(entry)).valid, false, JSON.stringify(entry));
});

test('a document that requires and prohibits overlapping content on overlapping targets is invalid', () => {
  const contradiction = (...entries) => {
    const result = validateOrganizationPolicy(org(...entries), { setMembers: members('lint', 'format') });
    return result.diagnostics.filter(item => item.reason === 'obligation-contradiction').map(item => item.path);
  };
  const required = (content, overrides) => contentEntry(content, { selectionId: 'required', obligation: 'required', ...overrides });
  assert.deepEqual(contradiction(required({ kind: 'hook' }), contentEntry({ kind: 'hook' })), ['/selections/1/obligation']);
  assert.deepEqual(contradiction(required({ framework: 'acme' }), contentEntry({ item: { framework: 'acme', itemId: 'lint' } })),
    ['/selections/1/obligation']);
  assert.deepEqual(contradiction(required({ set: SET }), contentEntry({ item: { framework: 'acme', itemId: 'lint' } })),
    ['/selections/1/obligation'], 'a set and one of its members overlap');
  assert.deepEqual(contradiction(contentEntry({ set: SET }), required({ item: { framework: 'acme', itemId: 'format' } })),
    ['/selections/1/obligation'], 'in either order');
  assert.deepEqual(contradiction(recipeEntry({ obligation: 'required' }), recipeEntry({ selectionId: 'no', obligation: 'prohibited' })),
    ['/selections/1/obligation'], '1.1 recipe contradiction is kept');
  // Disjoint content, targets or recipes never contradict.
  for (const pair of [
    [required({ kind: 'hook' }), contentEntry({ kind: 'skill' })],
    [required({ framework: 'acme' }), contentEntry({ framework: 'other' })],
    [required({ set: SET }), contentEntry({ item: { framework: 'acme', itemId: 'absent' } })],
    [required({ kind: 'hook' }), contentEntry({ kind: 'hook' }, { scopes: ['user'] })],
    [required({ kind: 'hook' }, { clients: ['claude'] }), contentEntry({ kind: 'hook' }, { clients: ['codex'] })],
    [required({ kind: 'hook' }, { repositories: [REPO] }), contentEntry({ kind: 'hook' }, { repositories: ['github.com/example-org/other'] })],
    [recipeEntry({ obligation: 'required', content: { kind: 'hook' } }), recipeEntry({ selectionId: 'no', obligation: 'prohibited', content: { kind: 'skill' } })],
    [recipeEntry({ obligation: 'required' }), recipeEntry({ selectionId: 'no', recipeIdentity: ID2, obligation: 'prohibited' })],
    [required({ kind: 'hook' }), contentEntry({ kind: 'hook' }, { obligation: 'recommended' })],
    // An item's kind is not in the document: overlap with a kind is not proven, and runtime enforcement still applies.
    [required({ item: { framework: 'acme', itemId: 'lint' } }), contentEntry({ kind: 'skill' })]
  ]) assert.deepEqual(contradiction(...pair), [], JSON.stringify(pair));
  // Supplied member kinds prove or rule out overlap with a kind.
  const kinds = kind => [{ set: SET, members: [{ framework: 'acme', itemId: 'lint', kind }] }];
  const pair = org(contentEntry({ set: SET }, { selectionId: 'required', obligation: 'required' }), contentEntry({ kind: 'skill' }));
  assert.equal(validateOrganizationPolicy(pair, { setMembers: kinds('skill') }).diagnostics[0]?.reason, 'obligation-contradiction');
  assert.equal(validateOrganizationPolicy(pair, { setMembers: kinds('hook') }).valid, true);
});

test('without supplied membership a set selector is reported unavailable and never matched', () => {
  const document = org(contentEntry({ set: SET }, { selectionId: 'required', obligation: 'required' }),
    contentEntry({ item: { framework: 'acme', itemId: 'lint' } }));
  const without = validateOrganizationPolicy(document);
  assert.equal(without.valid, true, JSON.stringify(without.diagnostics));
  assert.deepEqual(without.unavailable, [{ reason: 'set-membership-unavailable', path: '/selections/0/content/set', set: SET }]);
  const supplied = validateOrganizationPolicy(document, { setMembers: members('lint') });
  assert.equal(supplied.valid, false);
  assert.equal(supplied.unavailable, undefined);
  const elsewhere = validateOrganizationPolicy(document, { setMembers: members('format') });
  assert.equal(elsewhere.valid, true);
  assert.equal(elsewhere.unavailable, undefined);
  // The same set required and prohibited contradicts without its members.
  assert.equal(validateOrganizationPolicy(org(contentEntry({ set: SET }, { selectionId: 'required', obligation: 'required' }),
    contentEntry({ set: SET }))).valid, false);
  for (const setMembers of [{}, [{ set: SET }], [...members('lint'), ...members('lint')], [{ set: SET, members: [{ framework: 'acme' }] }]]) {
    const refused = validateOrganizationPolicy(document, { setMembers });
    assert.equal(refused.valid, false);
    assert.equal(refused.diagnostics[0].reason, 'set-members');
  }
  assert.equal(parseOrganizationPolicy(JSON.stringify(document), { setMembers: members('lint') }).valid, false);
});

test('admission keeps exact recipe admission and enforces content prohibitions on declared facts', () => {
  const admit = (organization, selection = dev(), extra = {}) =>
    previewOrganizationAdmission({ organization, selections: [selection], lifecycle: [], ...extra });
  assert.deepEqual(reasons(admit(org(recipeEntry()))), []);
  assert.deepEqual(reasons(admit(org(recipeEntry(), contentEntry({ kind: 'skill' })))), ['prohibited']);
  assert.deepEqual(reasons(admit(org(recipeEntry(), contentEntry({ kind: 'hook' })))), []);
  assert.deepEqual(reasons(admit(org(recipeEntry(), contentEntry({ framework: 'acme' })))), ['prohibited']);
  assert.deepEqual(reasons(admit(org(recipeEntry(), contentEntry({ item: { framework: 'acme', itemId: 'other' } })))), []);
  // A prohibition needing an undeclared content fact fails closed, as an undeclared target fact does in 1.1.
  assert.deepEqual(reasons(admit(org(recipeEntry(), contentEntry({ kind: 'skill' })), omit(dev(), 'kind', 'item'))),
    ['target-unknown']);
  // A content-only entry admits nothing: exact recipe admission is kept.
  assert.deepEqual(reasons(admit(org(contentEntry({ kind: 'skill' }, { selectionId: 'guidance', obligation: 'permitted' })))),
    ['recipe-identity']);
  // A recipe entry narrowed by content admits only matching content.
  assert.deepEqual(reasons(admit(org(recipeEntry({ content: { kind: 'skill' } })))), []);
  assert.deepEqual(reasons(admit(org(recipeEntry({ content: { kind: 'hook' } })))), ['content']);
  assert.deepEqual(reasons(admit(org(recipeEntry({ content: { kind: 'hook' } })), omit(dev(), 'kind'))), ['target-unknown']);
  // Inputs, recipe identity and scope still decide as in 1.1.
  assert.deepEqual(reasons(admit(org(recipeEntry({ inputs: {} })))), ['input-not-permitted']);
  assert.deepEqual(reasons(admit(org(recipeEntry({ recipeIdentity: ID2 })))), ['recipe-identity']);
  assert.deepEqual(reasons(admit(org(recipeEntry({ scopes: ['user'] })))), ['scope']);
  assert.deepEqual(previewOrganizationAdmission({ organization: org(recipeEntry()), selections: [dev()],
    lifecycle: [{ action: 'replace', scope: 'project', recipeIdentity: ID, organizationSelectionId: 'guidance' }] })
    .value.diagnostics.map(item => item.reason), ['lifecycle-replace']);
});

test('a set selector matches only through supplied membership and is unavailable without it', () => {
  const document = org(recipeEntry(), contentEntry({ set: SET }));
  const admit = extra => previewOrganizationAdmission({ organization: document, selections: [dev()], lifecycle: [], ...extra });
  assert.deepEqual(reasons(admit({})), ['set-membership-unavailable'], 'never matched, and admission fails closed');
  assert.deepEqual(reasons(admit({ setMembers: members('lint') })), ['prohibited']);
  assert.deepEqual(reasons(admit({ setMembers: members('format') })), []);
  // Supplied membership also decides contradictions while comparing.
  const contradictory = org(recipeEntry(), contentEntry({ set: SET }), contentEntry({ item: { framework: 'acme', itemId: 'lint' } },
    { selectionId: 'required', obligation: 'required' }));
  assert.equal(previewOrganizationAdmission({ organization: contradictory, selections: [], lifecycle: [] }).status, 'ok');
  const refused = previewOrganizationAdmission({ organization: contradictory, selections: [], lifecycle: [], setMembers: members('lint') });
  assert.equal(refused.status, 'refused');
  assert.ok(refused.diagnostics[0].details.diagnostics.some(item => item.reason === 'obligation-contradiction'));
});

test('content obligations report fulfilment by matching content, and unavailable sets are never fulfilled', () => {
  const document = org(recipeEntry(),
    contentEntry({ kind: 'skill' }, { selectionId: 'need-skill', obligation: 'required' }),
    contentEntry({ kind: 'hook' }, { selectionId: 'need-hook', obligation: 'required' }),
    contentEntry({ set: SET }, { selectionId: 'need-set', obligation: 'required' }),
    contentEntry({ framework: 'acme' }, { selectionId: 'try-acme', obligation: 'recommended', clients: ['claude'] }));
  const obligations = extra => previewOrganizationObligations({ organization: document, selections: [dev()], lifecycle: [],
    target: { scope: 'project', client: 'claude' }, ...extra }).value;
  const status = (value, list = 'fulfillment') => Object.fromEntries(value[list].map(item => [item.selectionId, item.status]));
  const without = obligations({});
  assert.equal(without.enforced.admitted, true);
  assert.deepEqual(status(without), { 'need-skill': 'fulfilled', 'need-hook': 'not-fulfilled', 'need-set': 'unavailable' });
  assert.deepEqual(status(without, 'advisory'), { 'try-acme': 'taken' });
  assert.deepEqual(without.fulfillment.find(item => item.selectionId === 'need-set'),
    { selectionId: 'need-set', content: { set: SET }, applicability: 'applies', unknown: [], status: 'unavailable', selections: [] });
  assert.deepEqual(status(obligations({ setMembers: members('lint') })), { 'need-skill': 'fulfilled', 'need-hook': 'not-fulfilled', 'need-set': 'fulfilled' });
  // An undeclared target fact leaves the recommendation unknown rather than applicable.
  const unknown = previewOrganizationObligations({ organization: document, selections: [dev()], lifecycle: [], target: { scope: 'project' } }).value;
  assert.deepEqual(unknown.advisory[0].applicability, 'unknown');
});

test('per Catalog item, the organization content preview names required and prohibited items for a declared target', () => {
  const document = org(recipeEntry({ obligation: 'required' }),
    contentEntry({ item: { framework: 'acme', itemId: 'guard' } }, { selectionId: 'need-guard', obligation: 'required' }),
    contentEntry({ kind: 'mcp-server' }, { selectionId: 'no-servers', clients: ['claude'] }),
    contentEntry({ set: SET }, { selectionId: 'starter', obligation: 'recommended', scopes: ['user'] }));
  const items = [{ framework: 'acme', itemId: 'guard', kind: 'hook' }, { framework: 'acme', itemId: 'github', kind: 'mcp-server' },
    { framework: 'acme', itemId: 'lint', kind: 'skill' }];
  const preview = (target, extra = {}) => previewOrganizationContent({ organization: document, target, items, ...extra });
  const project = preview({ scope: 'project', client: 'claude' });
  assert.equal(project.status, 'ok', JSON.stringify(project));
  assert.deepEqual(project.value.items, [
    { item: { framework: 'acme', itemId: 'guard' }, kind: 'hook', required: true, prohibited: false,
      entries: [{ selectionId: 'need-guard', obligation: 'required', applicability: 'applies', match: 'matches', unknown: [] }] },
    { item: { framework: 'acme', itemId: 'github' }, kind: 'mcp-server', required: false, prohibited: true,
      entries: [{ selectionId: 'no-servers', obligation: 'prohibited', applicability: 'applies', match: 'matches', unknown: [] }] },
    { item: { framework: 'acme', itemId: 'lint' }, kind: 'skill', required: false, prohibited: false, entries: [] }]);
  // Undeclared client: the prohibition may apply but is never claimed; recipe entries never name items.
  const undeclared = preview({ scope: 'project' }).value.items[1];
  assert.deepEqual([undeclared.prohibited, undeclared.entries[0].applicability, undeclared.entries[0].unknown], [false, 'unknown', ['client']]);
  // A set selector is unavailable without supplied membership and never makes an item required or prohibited.
  const user = preview({ scope: 'user', client: 'claude' }).value.items[2];
  assert.deepEqual(user.entries, [{ selectionId: 'starter', obligation: 'recommended', applicability: 'applies', match: 'unavailable', unknown: [] }]);
  assert.deepEqual(preview({ scope: 'user', client: 'claude' }, { setMembers: members('lint') }).value.items[2].entries[0].match, 'matches');
  assert.equal(preview({ scope: 'project' }, { items: [{ framework: 'acme', itemId: 'guard' }] }).status, 'refused', 'kind is required');
});
