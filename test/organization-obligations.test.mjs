import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateOrganizationPolicy, parseOrganizationPolicy, previewOrganizationAdmission,
  previewOrganizationObligations, contractSupport } from '../dist/core/contracts.js';
import { admitOrganizationSelections } from '../dist/core/internal/organization-admission.js';
import schema11 from '../dist/core/schemas/organization-policy/1.1.0.json' with { type: 'json' };

const SCHEMA10 = 'urn:aihq:core:organization-policy:1.0.0';
const SCHEMA11 = 'urn:aihq:core:organization-policy:1.1.0';
const ID = `sha256:${'a'.repeat(64)}`;
const ID2 = `sha256:${'b'.repeat(64)}`;
const REPO = 'github.com/example-org/app';
const INPUTS = { text: { type: 'string', required: true, maxLength: 65536 } };
const entry = (overrides = {}) => ({ selectionId: 'guidance', recipeIdentity: ID, scopes: ['project'],
  inputs: { text: { allowDeclared: true } }, obligation: 'permitted', ...overrides });
const org = (...entries) => ({ schema: SCHEMA11, id: 'org-policy', selections: entries });
const org10 = (...entries) => ({ schema: SCHEMA10, id: 'org-policy', selections: entries });
const strip = ({ obligation, ...rest }) => rest;
const dev = (overrides = {}) => ({ id: 'guidance', organizationSelectionId: 'guidance', scope: 'project', recipeIdentity: ID,
  inputs: INPUTS, configuration: { text: 'hello' }, privateInputs: [], ...overrides });
const withPath = (selection, index = 0) => ({ ...selection, path: `/selections/${index}` });
const reasons = findings => findings.map(finding => finding.reason);
const request = (organization, selections = [dev()], target = { scope: 'project' }, lifecycle = []) =>
  ({ organization, selections, lifecycle, target });
const deepFreeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

test('1.1.0 is an accepted, exported contract with the published identity', () => {
  assert.equal(schema11.$id, SCHEMA11);
  const found = contractSupport.contracts.find(contract => contract.id === SCHEMA11);
  assert.deepEqual(found, { id: SCHEMA11, role: 'accepts', schemaExport: '@aihq/core/schemas/organization-policy/1.1.0.json' });
  assert.ok(contractSupport.contracts.some(contract => contract.id === SCHEMA10));
  const result = validateOrganizationPolicy(org(entry({ obligation: 'required', clients: ['claude'], repositories: [REPO] })));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.schema, SCHEMA11);
  assert.equal(parseOrganizationPolicy(JSON.stringify(org(entry()))).valid, true);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./schemas/organization-policy/1.1.0.json'], './dist/core/schemas/organization-policy/1.1.0.json');
});

test('the 1.0.0 schema stays byte-identical and still accepts only its own shape', () => {
  const text = readFileSync(new URL('../src/core/schemas/organization-policy/1.0.0.json', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(text).digest('hex'), '92096b530c9db54044aa6bceafb2150a97955868a4ca8733cb7d1fc51c62098b');
  assert.equal(validateOrganizationPolicy(org10(entry())).valid, false, '1.0.0 stays closed to obligation');
  assert.equal(validateOrganizationPolicy(org10(strip(entry()))).valid, true);
});

test('1.1.0 structure: obligation is required and selectors are bounded, closed values', () => {
  const missing = validateOrganizationPolicy(org(strip(entry())));
  assert.equal(missing.valid, false);
  const bad = [
    entry({ obligation: 'optional' }), entry({ clients: [] }), entry({ clients: ['claude', 'claude'] }),
    entry({ clients: [''] }), entry({ clients: ['x'.repeat(129)] }), entry({ clients: [1] }),
    entry({ repositories: [] }), entry({ repositories: [REPO, REPO] }), entry({ repositories: [''] }),
    entry({ repositories: ['x'.repeat(513)] }), entry({ repositories: Array.from({ length: 4097 }, (_, index) => `github.com/o/r${index}`) }),
    { ...entry(), extra: true }
  ];
  for (const candidate of bad) assert.equal(validateOrganizationPolicy(org(candidate)).valid, false, JSON.stringify(candidate).slice(0, 120));
  for (const obligation of ['required', 'recommended', 'permitted', 'prohibited'])
    assert.equal(validateOrganizationPolicy(org(entry({ obligation }))).valid, true, obligation);
});

test('1.1.0 semantic rejections carry stable reasons and paths', () => {
  const unknownClient = validateOrganizationPolicy(org(entry({ clients: ['claude', 'not-a-client'] })));
  assert.equal(unknownClient.valid, false);
  assert.deepEqual([unknownClient.diagnostics[0].code, unknownClient.diagnostics[0].reason, unknownClient.diagnostics[0].path],
    ['INPUT_INVALID', 'unknown-client', '/selections/0/clients/1']);

  for (const repository of ['app', 'github.com/app', 'GitHub.com/example-org/app', 'github.com/example-org/app/extra',
    'github/example-org/app', 'github.com/./app', 'github.com/example-org/..', 'github.com/exam ple/app', '-a.com/o/r']) {
    const result = validateOrganizationPolicy(org(entry({ repositories: [REPO, repository] })));
    assert.equal(result.valid, false, repository);
    assert.deepEqual([result.diagnostics[0].reason, result.diagnostics[0].path], ['repository-identity', '/selections/0/repositories/1'], repository);
  }
  assert.equal(validateOrganizationPolicy(org(entry({ repositories: ['gitlab.example.com/group/my_app.v2'] }))).valid, true);

  const duplicate = validateOrganizationPolicy(org(entry(), entry({ recipeIdentity: ID2 })));
  assert.deepEqual([duplicate.diagnostics[0].reason, duplicate.diagnostics[0].path], ['duplicate-selection-id', '/selections/1/selectionId']);
});

test('required and prohibited entries for one identity contradict only where their targets overlap', () => {
  const required = entry({ selectionId: 'need', obligation: 'required' });
  const prohibited = entry({ selectionId: 'ban', obligation: 'prohibited' });
  const bad = validateOrganizationPolicy(org(required, prohibited));
  assert.equal(bad.valid, false);
  assert.deepEqual([bad.diagnostics[0].code, bad.diagnostics[0].reason, bad.diagnostics[0].path],
    ['INPUT_INVALID', 'obligation-contradiction', '/selections/1/obligation']);
  assert.equal(validateOrganizationPolicy(org(prohibited, required)).diagnostics[0].path, '/selections/1/obligation');

  const accepted = [
    [{ scopes: ['project'] }, { scopes: ['user'] }],
    [{ clients: ['claude'] }, { clients: ['codex'] }],
    [{ repositories: [REPO] }, { repositories: ['github.com/example-org/other'] }],
    [{ scopes: ['project', 'user'], clients: ['claude'] }, { scopes: ['project'], clients: ['codex'] }]
  ];
  for (const [left, right] of accepted) {
    const result = validateOrganizationPolicy(org({ ...required, ...left }, { ...prohibited, ...right }));
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  }
  const overlapping = [
    [{ clients: ['claude'] }, {}],
    [{ clients: ['claude', 'codex'] }, { clients: ['codex'] }],
    [{ repositories: [REPO] }, { repositories: [REPO, 'github.com/example-org/other'] }],
    [{ clients: ['claude'], repositories: [REPO] }, { clients: ['claude'] }]
  ];
  for (const [left, right] of overlapping) {
    const result = validateOrganizationPolicy(org({ ...required, ...left }, { ...prohibited, ...right }));
    assert.equal(result.diagnostics[0]?.reason, 'obligation-contradiction', JSON.stringify([left, right]));
  }
  // Different identities, or other obligation pairs, never contradict.
  assert.equal(validateOrganizationPolicy(org(required, { ...prohibited, recipeIdentity: ID2 })).valid, true);
  assert.equal(validateOrganizationPolicy(org(required, { ...prohibited, obligation: 'recommended' })).valid, true);
  assert.equal(validateOrganizationPolicy(org({ ...required, obligation: 'permitted' }, prohibited)).valid, true);
});

test('a 1.0.0 policy admits identically through the target-aware path', () => {
  const cases = [
    [org10(strip(entry())), [dev()], []],
    [org10(strip(entry({ recipeIdentity: ID2 }))), [dev()], []],
    [org10(strip(entry({ scopes: ['user'] }))), [dev()], []],
    [org10(strip(entry({ inputs: { text: { fixed: 'other' } } }))), [dev()], []],
    [org10(), [dev()], []],
    [org10(strip(entry())), [], [{ action: 'replace', scope: 'project', recipeIdentity: ID, organizationSelectionId: 'guidance', path: '/lifecycle/0' }]],
    [org10(strip(entry({ lifecycle: { remove: true } }))), [], [{ action: 'remove', scope: 'project', recipeIdentity: ID, path: '/lifecycle/0' }]],
    // A stray obligation or selector on an unvalidated 1.0.0 entry has no meaning.
    [org10(entry({ obligation: 'prohibited', clients: ['codex'], repositories: [REPO] })), [dev()], []]
  ];
  for (const [organization, selections, lifecycle] of cases) {
    const base = admitOrganizationSelections(organization, selections.map(withPath), lifecycle);
    for (const target of [{}, { client: 'claude' }, { client: 'claude', repository: REPO }])
      assert.deepEqual(admitOrganizationSelections(organization, selections.map(withPath), lifecycle, target), base);
    const bare = selections.map(({ path, ...rest }) => rest);
    const lifecycleBare = lifecycle.map(({ path, ...rest }) => rest);
    const clean = { ...organization, selections: organization.selections.map(({ obligation, clients, repositories, ...rest }) => rest) };
    const preview = previewOrganizationAdmission({ organization: clean, selections: bare, lifecycle: lifecycleBare });
    const obligations = previewOrganizationObligations(request(clean, bare, { scope: 'project' }, lifecycleBare));
    assert.equal(obligations.status, 'ok', JSON.stringify(obligations));
    assert.deepEqual(obligations.value.enforced, preview.value);
    assert.deepEqual(obligations.value.advisory, []);
    assert.deepEqual(obligations.value.fulfillment, []);
    assert.deepEqual(obligations.value.target, { scope: 'project' });
  }
});

test('prohibited obligation blocks by reference and through a separate applicable prohibition', () => {
  const direct = admitOrganizationSelections(org(entry({ obligation: 'prohibited' })), [withPath(dev())], []);
  assert.deepEqual(direct.map(({ code, reason, path }) => ({ code, reason, path })),
    [{ code: 'AUTHORITY_DENIED', reason: 'prohibited', path: '/selections/0' }]);

  const separate = admitOrganizationSelections(org(entry(), entry({ selectionId: 'ban', obligation: 'prohibited' })), [withPath(dev())], []);
  assert.deepEqual(separate.map(({ code, reason }) => [code, reason]), [['AUTHORITY_DENIED', 'prohibited']]);

  const otherIdentity = org(entry(), entry({ selectionId: 'ban', recipeIdentity: ID2, obligation: 'prohibited' }));
  assert.deepEqual(admitOrganizationSelections(otherIdentity, [withPath(dev())], []), []);
  const otherScope = org(entry({ scopes: ['project', 'user'] }), entry({ selectionId: 'ban', scopes: ['user'], obligation: 'prohibited' }));
  assert.deepEqual(admitOrganizationSelections(otherScope, [withPath(dev())], []), []);

  // A prohibition scoped to another client does not apply; an undeclared client fails closed.
  const scoped = org(entry(), entry({ selectionId: 'ban', obligation: 'prohibited', clients: ['codex'] }));
  assert.deepEqual(admitOrganizationSelections(scoped, [withPath(dev())], [], { client: 'claude' }), []);
  assert.deepEqual(reasons(admitOrganizationSelections(scoped, [withPath(dev())], [], { client: 'codex' })), ['prohibited']);
  const unknown = admitOrganizationSelections(scoped, [withPath(dev())], []);
  assert.deepEqual(unknown.map(({ code, reason }) => [code, reason]), [['AUTHORITY_DENIED', 'target-unknown']]);

  // A prohibited reference skips identity and input checks.
  const skipped = admitOrganizationSelections(org(entry({ obligation: 'prohibited', recipeIdentity: ID2, inputs: {} })), [withPath(dev())], []);
  assert.deepEqual(reasons(skipped), ['prohibited']);
});

test('required, recommended and permitted entries admit exactly like a 1.0.0 entry', () => {
  for (const obligation of ['required', 'recommended', 'permitted']) {
    assert.deepEqual(admitOrganizationSelections(org(entry({ obligation })), [withPath(dev())], []), [], obligation);
    assert.deepEqual(reasons(admitOrganizationSelections(org(entry({ obligation, scopes: ['user'] })), [withPath(dev())], [])), ['scope'], obligation);
    assert.deepEqual(reasons(admitOrganizationSelections(org(entry({ obligation, inputs: {} })), [withPath(dev())], [])), ['input-not-permitted'], obligation);
  }
});

test('referenced selectors deny a declared mismatch and fail closed on an undeclared fact', () => {
  const clientOnly = org(entry({ clients: ['claude'] }));
  assert.deepEqual(admitOrganizationSelections(clientOnly, [withPath(dev())], [], { client: 'claude' }), []);
  assert.deepEqual(reasons(admitOrganizationSelections(clientOnly, [withPath(dev())], [], { client: 'codex' })), ['client']);
  assert.deepEqual(reasons(admitOrganizationSelections(clientOnly, [withPath(dev())], [])), ['target-unknown']);
  // A declared repository does not satisfy a client selector.
  assert.deepEqual(reasons(admitOrganizationSelections(clientOnly, [withPath(dev())], [], { repository: REPO })), ['target-unknown']);

  const repositoryOnly = org(entry({ repositories: [REPO] }));
  assert.deepEqual(admitOrganizationSelections(repositoryOnly, [withPath(dev())], [], { repository: REPO }), []);
  assert.deepEqual(reasons(admitOrganizationSelections(repositoryOnly, [withPath(dev())], [], { repository: 'github.com/example-org/other' })), ['repository']);
  assert.deepEqual(reasons(admitOrganizationSelections(repositoryOnly, [withPath(dev())], [])), ['target-unknown']);

  const both = org(entry({ clients: ['claude'], repositories: [REPO] }));
  assert.deepEqual(reasons(admitOrganizationSelections(both, [withPath(dev())], [], { client: 'codex', repository: 'github.com/example-org/other' })),
    ['client', 'repository']);
  assert.deepEqual(reasons(admitOrganizationSelections(both, [withPath(dev())], [], { client: 'claude' })), ['target-unknown']);
  assert.deepEqual(admitOrganizationSelections(both, [withPath(dev())], [], { client: 'claude', repository: REPO }), []);

  // Findings keep the selection's own path and AUTHORITY_DENIED code.
  const [finding] = admitOrganizationSelections(clientOnly, [withPath(dev(), 3)], []);
  assert.deepEqual([finding.code, finding.path], ['AUTHORITY_DENIED', '/selections/3']);
});

test('admission findings for one selection never repeat a reason', () => {
  const organization = org(entry({ clients: ['claude'] }),
    entry({ selectionId: 'ban-a', obligation: 'prohibited', clients: ['codex'] }),
    entry({ selectionId: 'ban-b', obligation: 'prohibited', repositories: [REPO] }));
  const findings = admitOrganizationSelections(organization, [withPath(dev())], []);
  assert.deepEqual(reasons(findings), ['target-unknown']);
});

test('lifecycle tuples ignore selectors and still need the matching grant', () => {
  const organization = org(entry({ clients: ['claude'], lifecycle: { replace: true } }), entry({ selectionId: 'ban', obligation: 'prohibited', recipeIdentity: ID2 }));
  const tuple = (action, selectionId = 'guidance') => ({ action, scope: 'project', recipeIdentity: ID, organizationSelectionId: selectionId, path: '/lifecycle/0' });
  assert.deepEqual(admitOrganizationSelections(organization, [], [tuple('replace')]), []);
  assert.deepEqual(reasons(admitOrganizationSelections(organization, [], [tuple('adopt')])), ['lifecycle-adopt']);
});

test('preview obligations report taken and not-taken recommendations without blocking admission', () => {
  const organization = org(entry(), entry({ selectionId: 'tips', recipeIdentity: ID2, obligation: 'recommended' }));
  const result = previewOrganizationObligations(request(organization));
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.deepEqual(result.value.enforced, { admitted: true, diagnostics: [] });
  assert.deepEqual(result.value.advisory, [{ selectionId: 'tips', recipeIdentity: ID2, applicability: 'applies', unknown: [],
    status: 'not-taken', selections: [] }]);
  assert.deepEqual(result.value.fulfillment, []);

  const taken = previewOrganizationObligations(request(organization,
    [dev(), dev({ id: 'tips', organizationSelectionId: 'tips', recipeIdentity: ID2 })]));
  assert.equal(taken.value.enforced.admitted, true);
  assert.deepEqual(taken.value.advisory, [{ selectionId: 'tips', recipeIdentity: ID2, applicability: 'applies', unknown: [],
    status: 'taken', selections: ['tips'] }]);

  // A selection denied by admission, or in another scope, never counts as taking an entry.
  const denied = previewOrganizationObligations(request(org(entry({ selectionId: 'tips', recipeIdentity: ID2, obligation: 'recommended', inputs: {} })),
    [dev({ id: 'tips', organizationSelectionId: 'tips', recipeIdentity: ID2 })]));
  assert.equal(denied.value.enforced.admitted, false);
  assert.equal(denied.value.advisory[0].status, 'not-taken');
  const otherScope = previewOrganizationObligations(request(org(entry({ selectionId: 'tips', recipeIdentity: ID2, obligation: 'recommended', scopes: ['project', 'user'] })),
    [dev({ id: 'tips', organizationSelectionId: 'tips', recipeIdentity: ID2, scope: 'user' })]));
  assert.equal(otherScope.value.advisory[0].status, 'not-taken');
});

test('preview obligations resolve required entries as fulfilled, not-fulfilled, not-applicable or unknown', () => {
  const required = entry({ selectionId: 'need', recipeIdentity: ID2, obligation: 'required' });
  const take = dev({ id: 'need', organizationSelectionId: 'need', recipeIdentity: ID2 });
  const result = result => result.value.fulfillment;

  const missing = previewOrganizationObligations(request(org(required), []));
  assert.deepEqual(result(missing), [{ selectionId: 'need', recipeIdentity: ID2, applicability: 'applies', unknown: [],
    status: 'not-fulfilled', selections: [] }]);
  assert.equal(missing.value.enforced.admitted, true, 'a missing required entry is reported, not enforced');

  const present = previewOrganizationObligations(request(org(required), [take]));
  assert.deepEqual(result(present), [{ selectionId: 'need', recipeIdentity: ID2, applicability: 'applies', unknown: [],
    status: 'fulfilled', selections: ['need'] }]);

  const wrongClient = previewOrganizationObligations(request(org({ ...required, clients: ['codex'] }), [],
    { scope: 'project', client: 'claude' }));
  assert.deepEqual(result(wrongClient), [{ selectionId: 'need', recipeIdentity: ID2, applicability: 'not-applicable', unknown: [],
    status: 'not-applicable', selections: [] }]);

  const wrongScope = previewOrganizationObligations(request(org({ ...required, scopes: ['user'] }), []));
  assert.equal(result(wrongScope)[0].status, 'not-applicable');

  const undeclared = previewOrganizationObligations(request(org({ ...required, repositories: [REPO] }), []));
  assert.deepEqual(result(undeclared), [{ selectionId: 'need', recipeIdentity: ID2, applicability: 'unknown', unknown: ['repository'],
    status: 'unknown', selections: [] }]);
  const undeclaredBoth = previewOrganizationObligations(request(org({ ...required, clients: ['claude'], repositories: [REPO] }), []));
  assert.deepEqual(result(undeclaredBoth)[0].unknown, ['client', 'repository']);

  // An unknown fact is never fulfilled, even when the developer selection names the entry.
  const stillUnknown = previewOrganizationObligations(request(org({ ...required, repositories: [REPO] }), [take]));
  assert.equal(result(stillUnknown)[0].status, 'unknown');
  assert.deepEqual(reasons(stillUnknown.value.enforced.diagnostics), ['target-unknown']);
  assert.equal(stillUnknown.value.enforced.admitted, false);

  const declared = previewOrganizationObligations(request(org({ ...required, repositories: [REPO] }), [take],
    { scope: 'project', repository: REPO }));
  assert.equal(result(declared)[0].status, 'fulfilled');
  assert.deepEqual(declared.value.target, { scope: 'project', repository: REPO });
});

test('preview obligations map enforced denials like preview admission and echo the target', () => {
  const organization = org(entry({ clients: ['codex'] }), entry({ selectionId: 'need', recipeIdentity: ID2, obligation: 'required' }));
  const target = { scope: 'project', client: 'claude', repository: REPO };
  const result = previewOrganizationObligations(request(organization, [dev()], target));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.value.target, target);
  assert.deepEqual(result.value.enforced, { admitted: false, diagnostics: [{ code: 'AUTHORITY_DENIED', reason: 'client',
    path: '/selections/0', message: result.value.enforced.diagnostics[0].message }] });
  assert.equal(typeof result.value.enforced.diagnostics[0].message, 'string');
  assert.deepEqual(result.value.fulfillment.map(item => item.status), ['not-fulfilled']);
  const prohibited = previewOrganizationObligations(request(org(entry({ obligation: 'prohibited' }))));
  assert.deepEqual(reasons(prohibited.value.enforced.diagnostics), ['prohibited']);
  assert.equal(prohibited.value.enforced.admitted, false);
});

test('preview admission accepts a 1.1.0 organization with an empty target', () => {
  const organization = org(entry({ clients: ['claude'] }));
  const denied = previewOrganizationAdmission({ organization, selections: [dev()], lifecycle: [] });
  assert.equal(denied.status, 'ok');
  assert.deepEqual(reasons(denied.value.diagnostics), ['target-unknown']);
  assert.equal(previewOrganizationAdmission({ organization: org(entry()), selections: [dev()], lifecycle: [] }).value.admitted, true);
  assert.deepEqual(reasons(previewOrganizationAdmission({ organization: org(entry({ obligation: 'prohibited' })),
    selections: [dev()], lifecycle: [] }).value.diagnostics), ['prohibited']);
});

test('preview obligations refuse invalid targets, organizations and request shapes', () => {
  const base = request(org(entry()));
  const refusals = [
    [{ ...base, target: { scope: 'project', client: 'not-a-client' } }, '/target/client'],
    [{ ...base, target: { scope: 'project', repository: 'GitHub.com/Org/App' } }, '/target/repository'],
    [{ ...base, target: { scope: 'project', repository: 'app' } }, '/target/repository'],
    [{ ...base, target: { scope: 'project', client: 7 } }, '/target/client'],
    [{ ...base, target: { scope: 'machine' } }, '/target/scope'],
    [{ ...base, target: { scope: 'project', extra: true } }, '/target'],
    [{ ...base, target: undefined }, ''],
    [{ organization: base.organization, selections: [], lifecycle: [] }, ''],
    [{ ...base, organization: org(entry({ clients: ['nope'] })) }, '/organization'],
    [{ ...base, organization: { ...org(entry()), schema: 'urn:aihq:core:organization-policy:2.0.0' } }, '/organization'],
    [{ ...base, selections: [dev({ scope: 'machine' })] }, '/selections/0/scope'],
    [{ ...base, selections: [dev(), dev()] }, '/selections/1/id'],
    [{ ...base, extra: true }, '']
  ];
  for (const [candidate, path] of refusals) {
    const result = previewOrganizationObligations(candidate);
    assert.equal(result.status, 'refused', JSON.stringify(candidate).slice(0, 160));
    assert.equal(result.diagnostics[0].code, 'INPUT_INVALID');
    assert.equal(result.diagnostics[0].path, path, JSON.stringify(candidate).slice(0, 160));
  }
  const clientRefusal = previewOrganizationObligations(refusals[0][0]);
  assert.equal(clientRefusal.diagnostics[0].reason, 'input-value');
  assert.equal(previewOrganizationObligations(null).status, 'refused');
  assert.equal(previewOrganizationObligations(undefined).status, 'refused');
});

test('preview helpers are pure: frozen inputs work and are never mutated', () => {
  const organization = org(entry({ clients: ['claude'], repositories: [REPO] }),
    entry({ selectionId: 'need', recipeIdentity: ID2, obligation: 'required' }),
    entry({ selectionId: 'tips', recipeIdentity: `sha256:${'c'.repeat(64)}`, obligation: 'recommended' }));
  const input = deepFreeze(request(organization, [dev()], { scope: 'project', client: 'claude', repository: REPO }));
  const before = JSON.stringify(input);
  const first = previewOrganizationObligations(input);
  const second = previewOrganizationObligations(structuredClone(input));
  assert.equal(first.status, 'ok', JSON.stringify(first));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  first.value.advisory.push('mutated');
  first.value.target.client = 'codex';
  assert.equal(JSON.stringify(input), before);
  assert.equal(previewOrganizationAdmission(deepFreeze({ organization, selections: [dev()], lifecycle: [] })).status, 'ok');
  assert.equal(admitOrganizationSelections(deepFreeze(organization), deepFreeze([withPath(dev())]), deepFreeze([]),
    deepFreeze({ client: 'claude', repository: REPO })).length, 0);
});
