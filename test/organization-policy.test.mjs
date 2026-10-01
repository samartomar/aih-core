import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parsePolicy, parseOrganizationPolicy, validatePolicy, validateOrganizationPolicy, contractSupport } from '../dist/core/contracts.js';
import { admitOrganizationSelections } from '../dist/core/internal/organization-admission.js';
import { canonicalJson } from '../dist/core/internal/canonical.js';
import organizationSchema from '../dist/core/schemas/organization-policy/1.0.0.json' with { type: 'json' };
import { policy } from './fixture.mjs';

const ORG_SCHEMA = 'urn:aihq:core:organization-policy:1.0.0';
const sha256hex = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha256hex(canonicalJson(value));

/** The policy contract's worked example recipe, verbatim. */
function workedRecipe() {
  return {
    schema: 'urn:aihq:core:recipe:1.0.0', id: 'guidance-file',
    description: 'Deliver project guidance',
    inputs: { text: { type: 'string', required: true, maxLength: 65536 } },
    materials: [], targets: ['project'], prerequisites: [],
    operations: [{
      id: 'write', purpose: 'Write shared project guidance', kind: 'file.write',
      scope: 'project', target: { root: 'project', segments: [{ literal: 'TEAM.md' }] },
      content: { input: 'text' }, requires: [], checks: []
    }], checks: []
  };
}

/** Same canonical rule the engine computes: sha256 of the identity descriptor. */
function recipeIdentity(recipe) {
  const materials = recipe.materials
    .map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return `sha256:${digest({ schema: 'urn:aihq:core:recipe-identity:1.0.0', recipeSha256: digest(recipe), materials })}`;
}

const IDENTITY = recipeIdentity(workedRecipe());

function orgEntry(overrides = {}) {
  return { selectionId: 'project-guidance', recipeIdentity: IDENTITY, scopes: ['project'],
    inputs: { text: { allowDeclared: true } }, ...overrides };
}
function organization(overrides = {}) {
  return { schema: ORG_SCHEMA, id: 'org-policy', selections: [orgEntry()], ...overrides };
}
function admission(overrides = {}) {
  return { id: 'guidance', organizationSelectionId: 'project-guidance', scope: 'project',
    recipeIdentity: IDENTITY, inputs: { text: { type: 'string', required: true, maxLength: 65536 } },
    configuration: { text: 'hello' }, privateInputs: [], path: '/selections/0', ...overrides };
}
const reasons = findings => findings.map(finding => finding.reason);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('the worked example is a valid recipe and its identity is reproducible', () => {
  assert.match(IDENTITY, /^sha256:[a-f0-9]{64}$/);
  assert.equal(recipeIdentity(workedRecipe()), IDENTITY);
});

test('the organization document rejects unknown fields, malformed identity and bad permissions', () => {
  assert.equal(validateOrganizationPolicy(organization()).valid, true,
    JSON.stringify(validateOrganizationPolicy(organization()).diagnostics));
  const cases = [
    { ...organization(), extra: true },
    { ...organization(), selections: [{ ...orgEntry(), extra: true }] },
    { ...organization(), selections: [{ ...orgEntry(), inputs: { text: { allowDeclared: true, fixed: 'x' } } }] },
    { ...organization(), selections: [{ ...orgEntry(), inputs: { text: { allowDeclared: false } } }] },
    { ...organization(), selections: [{ ...orgEntry(), inputs: { text: { choices: [] } } }] },
    { ...organization(), selections: [{ ...orgEntry(), inputs: { text: { choices: ['alpha', 'alpha'] } } }] },
    { ...organization(), selections: [{ ...orgEntry(), inputs: { text: { unknownForm: true } } }] },
    { ...organization(), selections: [{ ...orgEntry(), recipeIdentity: 'sha256:not-a-digest' }] },
    { ...organization(), selections: [{ ...orgEntry(), recipeIdentity: `sha256:${'A'.repeat(64)}` }] },
    { ...organization(), selections: [{ ...orgEntry(), scopes: [] }] },
    { ...organization(), selections: [{ ...orgEntry(), scopes: ['project', 'project'] }] },
    { ...organization(), selections: [{ ...orgEntry(), scopes: ['machine'] }] },
    { ...organization(), selections: [{ ...orgEntry(), lifecycle: { replace: true, other: false } }] },
    { ...organization(), selections: [{ ...orgEntry(), lifecycle: { replace: 'yes' } }] },
    { ...organization(), selections: [{ ...orgEntry(), selectionId: 'bad id' }] },
    { ...organization(), id: '' }
  ];
  for (const candidate of cases) {
    assert.equal(validateOrganizationPolicy(candidate).valid, false, JSON.stringify(candidate));
  }
  const duplicated = { ...organization(), selections: [orgEntry(), orgEntry()] };
  const result = validateOrganizationPolicy(duplicated);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, 'INPUT_INVALID');
  assert.equal(result.diagnostics[0].reason, 'duplicate-selection-id');
  assert.equal(result.diagnostics[0].path, '/selections/1/selectionId');
});

test('organization parsing reuses the bounded strict-JSON admission path', () => {
  const text = JSON.stringify(organization());
  const parsed = parseOrganizationPolicy(text);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.document, organization());
  assert.equal(validateOrganizationPolicy({ ...organization(), metadata: { text: 'x'.repeat(1_000_001) } }).valid, false);
  assert.equal(parseOrganizationPolicy(text.padEnd(1_000_002, ' ')).valid, false);
  const unsupported = parseOrganizationPolicy(JSON.stringify({ ...organization(), schema: 'urn:aihq:core:organization-policy:2.0.0' }));
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  const wrongFormat = validateOrganizationPolicy({ schema: 'urn:aihq:core:recipe:1.0.0', id: 'x', selections: [] });
  assert.equal(wrongFormat.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  assert.equal(parseOrganizationPolicy('{not json').diagnostics[0].code, 'INPUT_INVALID');
});

test('the organization schema is an accepted portable contract with no Harness control field', () => {
  const entry = contractSupport.contracts.find(contract => contract.id === ORG_SCHEMA);
  assert.equal(entry.role, 'accepts');
  assert.equal(entry.schemaExport, '@aihq/core/schemas/organization-policy/1.0.0.json');
  assert.equal(contractSupport.contracts.find(contract => contract.id === 'urn:aihq:core:recipe:1.0.0').role, 'accepts');
  assert.equal(contractSupport.contracts.find(contract => contract.id === 'urn:aihq:core:prepared-work:1.0.0').role, 'produces');
  assert.equal(JSON.stringify(organizationSchema).toLowerCase().includes('harness'), false);
  assert.equal(validateOrganizationPolicy({ ...organization(), harnessExemption: true }).valid, false);
});

test('execution policy mode governs organizationSelectionId presence', () => {
  assert.equal(validatePolicy(policy()).valid, true);
  const vibeWithOrg = policy();
  vibeWithOrg.selections[0].organizationSelectionId = 'project-guidance';
  const vibeResult = validatePolicy(vibeWithOrg);
  assert.equal(vibeResult.valid, false);
  assert.equal(vibeResult.diagnostics[0].reason, 'organization-selection-vibe');

  const enterprise = policy();
  enterprise.mode = 'enterprise';
  enterprise.selections[0].organizationSelectionId = 'project-guidance';
  assert.equal(validatePolicy(enterprise).valid, true, JSON.stringify(validatePolicy(enterprise).diagnostics));
  const missing = policy();
  missing.mode = 'enterprise';
  const missingResult = validatePolicy(missing);
  assert.equal(missingResult.valid, false);
  assert.equal(missingResult.diagnostics[0].reason, 'organization-selection-required');
  assert.equal(missingResult.diagnostics[0].path, '/selections/0/organizationSelectionId');
});

test('a selection with no matching organization entry is denied', () => {
  const findings = admitOrganizationSelections({ ...organization(), selections: [] }, [admission()], []);
  assert.deepEqual(reasons(findings), ['selection-not-admitted']);
  assert.equal(findings[0].code, 'AUTHORITY_DENIED');
  assert.equal(findings[0].path, '/selections/0');
});

test('a same-named selection with an altered recipe identity is denied', () => {
  const altered = { ...organization(), selections: [orgEntry({ recipeIdentity: `sha256:${'b'.repeat(64)}` })] };
  const findings = admitOrganizationSelections(altered, [admission()], []);
  assert.deepEqual(reasons(findings), ['recipe-identity']);
  assert.equal(findings[0].code, 'AUTHORITY_DENIED');
  assert.equal(findings[0].path, '/selections/0/recipeIdentity');
});

test('a forbidden scope or an unnamed configured input is denied', () => {
  assert.deepEqual(reasons(admitOrganizationSelections(organization(), [admission({ scope: 'user' })], [])), ['scope']);
  assert.deepEqual(reasons(admitOrganizationSelections(organization(),
    [admission({ configuration: { text: 'hello', other: true } })], [])), ['input-not-permitted']);
  assert.deepEqual(reasons(admitOrganizationSelections(
    { ...organization(), selections: [orgEntry({ inputs: {} })] }, [admission()], [])), ['input-not-permitted']);
});

test('fixed, choices and allowDeclared permissions admit and refuse precisely', () => {
  const fixed = { ...organization(), selections: [orgEntry({ inputs: { text: { fixed: 'hello' } } })] };
  assert.deepEqual(admitOrganizationSelections(fixed, [admission()], []), []);
  assert.deepEqual(reasons(admitOrganizationSelections(fixed, [admission({ configuration: { text: 'bye' } })], [])), ['input-value']);

  const choices = { ...organization(), selections: [orgEntry({ inputs: { text: { choices: ['alpha', 'beta'] } } })] };
  assert.deepEqual(admitOrganizationSelections(choices, [admission({ configuration: { text: 'alpha' } })], []), []);
  assert.deepEqual(reasons(admitOrganizationSelections(choices, [admission({ configuration: { text: 'gamma' } })], [])), ['input-value']);

  const declared = { ...organization(), selections: [orgEntry({ inputs: { text: { allowDeclared: true } } })] };
  assert.deepEqual(admitOrganizationSelections(declared, [admission()], []), []);
  const narrowed = admission({ inputs: { text: { type: 'string', required: true, maxLength: 3 } } });
  assert.deepEqual(reasons(admitOrganizationSelections(declared, [narrowed], [])), ['input-value']);
});

test('an unnamed input may use only its recipe default and needs one', () => {
  const unnamed = { ...organization(), selections: [orgEntry({ inputs: {} })] };
  const withDefault = admission({ configuration: {}, inputs: { text: { type: 'string', required: false, default: 'fallback' } } });
  assert.deepEqual(admitOrganizationSelections(unnamed, [withDefault], []), []);
  const noDefault = admission({ configuration: {}, inputs: { text: { type: 'string', required: true } } });
  const unfinished = admitOrganizationSelections(unnamed, [noDefault], []);
  assert.deepEqual(reasons(unfinished), ['organization-permission-incomplete']);
  assert.equal(unfinished[0].code, 'AUTHORITY_DENIED');
  assert.deepEqual(reasons(admitOrganizationSelections(unnamed,
    [{ ...withDefault, configuration: { text: 'explicit' } }], [])), ['input-not-permitted']);
});

test('sensitive inputs are admitted only through allowDeclared and private supply', () => {
  const spec = { type: 'string', required: true, sensitive: true };
  const allowed = { ...organization(), selections: [orgEntry({ inputs: { text: { allowDeclared: true } } })] };
  const supplied = admission({ inputs: { text: spec }, configuration: {}, privateInputs: ['text'] });
  assert.deepEqual(admitOrganizationSelections(allowed, [supplied], []), []);

  const fixed = { ...organization(), selections: [orgEntry({ inputs: { text: { fixed: 'secret' } } })] };
  assert.deepEqual(reasons(admitOrganizationSelections(fixed, [supplied], [])), ['input-value']);

  const unnamed = { ...organization(), selections: [orgEntry({ inputs: {} })] };
  assert.deepEqual(reasons(admitOrganizationSelections(unnamed, [supplied], [])), ['input-not-permitted']);

  const unsupplied = admission({ inputs: { text: spec }, configuration: {}, privateInputs: [] });
  assert.deepEqual(reasons(admitOrganizationSelections(unnamed, [unsupplied], [])), ['organization-permission-incomplete']);
});

test('an organization permission incompatible with the recipe input is a spec violation', () => {
  const badFixed = { ...organization(), selections: [orgEntry({ inputs: { text: { fixed: 7 } } })] };
  const unused = admission({ configuration: {}, inputs: { text: { type: 'string', required: true } } });
  const fixedFindings = admitOrganizationSelections(badFixed, [unused], []);
  assert.deepEqual(reasons(fixedFindings), ['organization-input-spec']);
  assert.equal(fixedFindings[0].code, 'INPUT_INVALID');
  const badChoice = { ...organization(), selections: [orgEntry({ inputs: { text: { choices: ['ok', 7] } } })] };
  const choiceFindings = admitOrganizationSelections(badChoice, [admission({ configuration: { text: 'ok' } })], []);
  assert.deepEqual(reasons(choiceFindings), ['organization-input-spec']);
  assert.equal(choiceFindings[0].code, 'INPUT_INVALID');
});

test('lifecycle permissions gate replace, adopt and remove', () => {
  const replaceItem = { action: 'replace', scope: 'project', recipeIdentity: IDENTITY,
    organizationSelectionId: 'project-guidance', path: '/lifecycle/0' };
  const replace = { ...organization(), selections: [orgEntry({ lifecycle: { replace: true } })] };
  assert.deepEqual(admitOrganizationSelections(replace, [], [replaceItem]), []);
  const replaceRefused = admitOrganizationSelections(organization(), [], [replaceItem]);
  assert.deepEqual(reasons(replaceRefused), ['lifecycle-replace']);
  assert.equal(replaceRefused[0].code, 'AUTHORITY_DENIED');
  assert.equal(replaceRefused[0].path, '/lifecycle/0');

  const adoptItem = { ...replaceItem, action: 'adopt' };
  assert.deepEqual(reasons(admitOrganizationSelections(replace, [], [adoptItem])), ['lifecycle-adopt']);
  const adopt = { ...organization(), selections: [orgEntry({ lifecycle: { adopt: true } })] };
  assert.deepEqual(admitOrganizationSelections(adopt, [], [adoptItem]), []);

  const removeItem = { action: 'remove', scope: 'project', recipeIdentity: IDENTITY, path: '/lifecycle/1' };
  const remove = { ...organization(), selections: [orgEntry({ lifecycle: { remove: true } })] };
  assert.deepEqual(admitOrganizationSelections(remove, [], [removeItem]), []);
  assert.deepEqual(reasons(admitOrganizationSelections(organization(), [], [removeItem])), ['lifecycle-remove']);
  const otherEntry = orgEntry({ selectionId: 'other', recipeIdentity: `sha256:${'c'.repeat(64)}`, scopes: ['project'], lifecycle: { remove: true } });
  assert.deepEqual(reasons(admitOrganizationSelections({ ...organization(), selections: [otherEntry] }, [], [removeItem])), ['lifecycle-remove']);

  // A retained selection's obsolete members use only its own current entry.
  const retainedRemove = { ...removeItem, organizationSelectionId: 'project-guidance' };
  assert.deepEqual(admitOrganizationSelections(remove, [], [retainedRemove]), []);
  const sameIdentityElsewhere = orgEntry({ selectionId: 'other', scopes: ['project'], lifecycle: { remove: true } });
  assert.deepEqual(reasons(admitOrganizationSelections({ ...organization(), selections: [orgEntry(), sameIdentityElsewhere] }, [],
    [retainedRemove])), ['lifecycle-remove']);
});

test('unrelated organization edits never affect admission', () => {
  const other = orgEntry({ selectionId: 'other', recipeIdentity: `sha256:${'c'.repeat(64)}`, scopes: ['user'], inputs: {} });
  assert.deepEqual(admitOrganizationSelections(organization(), [admission()], []), []);
  assert.deepEqual(admitOrganizationSelections(organization({ metadata: { note: 'revision 2' } }), [admission()], []), []);
  assert.deepEqual(admitOrganizationSelections(organization({ selections: [other, orgEntry()] }), [admission()], []), []);
});

test('findings are complete, deterministically ordered and non-mutating', () => {
  const entry = orgEntry({ recipeIdentity: `sha256:${'d'.repeat(64)}`, scopes: ['user'],
    inputs: { text: { fixed: 'other' } }, lifecycle: { replace: false } });
  const document = organization({ selections: [entry] });
  const selection = admission({ scope: 'project', configuration: { text: 'hello' } });
  const lifecycle = [{ action: 'replace', scope: 'project', recipeIdentity: IDENTITY,
    organizationSelectionId: 'project-guidance', path: '/lifecycle/0' }];
  const reasonsFirst = reasons(admitOrganizationSelections(document, [selection], lifecycle));
  assert.deepEqual(reasonsFirst, ['recipe-identity', 'scope', 'input-value', 'lifecycle-replace']);
  assert.deepEqual(reasons(admitOrganizationSelections(document, [selection], lifecycle)), reasonsFirst);

  const frozenDocument = deepFreeze(structuredClone(document));
  const frozenSelection = deepFreeze(structuredClone(selection));
  const frozenLifecycle = deepFreeze(structuredClone(lifecycle));
  assert.deepEqual(reasons(admitOrganizationSelections(frozenDocument, [frozenSelection], frozenLifecycle)), reasonsFirst);
});

test('parsePolicy still rejects an Enterprise execution policy without an organizationSelectionId', () => {
  const enterprise = policy(); enterprise.mode = 'enterprise';
  const parsed = parsePolicy(JSON.stringify(enterprise));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.diagnostics[0].reason, 'organization-selection-required');
});
