import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parsePolicy, validateOrganizationPolicy } from '@aihq/core/contracts';
import { listItems } from '@aihq/catalog/reader';
import { installedRelease } from './helpers.mjs';
import { authorOrganizationPolicy, deriveExecutionPolicy, recipeIdentity, reviewReport } from '../src/admin.js';

const FIXTURE = process.env.SCAN_ARTIFACT_FIXTURE;
const SCAN_ID = 'scan:sha256:fd5e886dc290901110d82ec45e2f444b8fa1b2c05f1bbe7028cbbb4e880bc4dd';
const EVIDENCE_SCHEMA = 'urn:aihq:scan:evidence-association:1.0.0';

// Independent sorted-key canonical JSON, mirroring Core's encoding rule.
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256hex = value => createHash('sha256').update(value).digest('hex');

// The documented Core recipe-identity rule, recomputed independently of the
// module under test: sha256 of the canonical identity descriptor naming the
// pinned recipe bytes and the recipe's materials sorted by id.
function expectedRecipeIdentity(item) {
  const materials = item.materials
    .map(({ id, sha256, byteLength }) => ({ id, sha256, byteLength }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return `sha256:${sha256hex(canonicalJson({
    schema: 'urn:aihq:core:recipe-identity:1.0.0', recipeSha256: item.recipe.sha256, materials
  }))}`;
}

const hasDefaultedInput = item => Object.values(item.inputs).some(spec => spec.default !== undefined);

async function setup() {
  const { release, source } = await installedRelease();
  const items = listItems(release);
  const standalone = items.find(item => hasDefaultedInput(item) && item.dependencies.requires.length === 0);
  const other = items.find(item => item.id !== standalone?.id && item.dependencies.requires.length === 0);
  assert.ok(standalone, 'catalog supplies an item with a defaulted input and no required items');
  assert.ok(other, 'catalog supplies a second item with no required items');
  const [inputName, spec] = Object.entries(standalone.inputs).find(([, entry]) => entry.default !== undefined);
  return { release, source, standalone, other, inputName, spec };
}

// An organization policy permitting the standalone item three ways: a fixed
// value, a choices list and declared-input admission.
function permittedEntries(item, inputName, spec) {
  return [
    { selectionId: 'entry-fixed', itemId: item.id, scopes: [...item.scopes],
      inputs: { [inputName]: { fixed: '.org-fixed' } } },
    { selectionId: 'entry-choices', itemId: item.id, scopes: [...item.scopes],
      inputs: { [inputName]: { choices: [spec.default, '.org-other'] } }, lifecycle: { replace: true } },
    { selectionId: 'entry-declared', itemId: item.id, scopes: [...item.scopes],
      inputs: { [inputName]: { allowDeclared: true } } }
  ];
}

function evidenceAssociations() {
  return [
    { schema: EVIDENCE_SCHEMA, scanId: `scan:sha256:${'a'.repeat(64)}`,
      location: { kind: 'file', path: 'evidence/display.scan.json' } },
    { schema: EVIDENCE_SCHEMA, scanId: `scan:sha256:${'b'.repeat(64)}`,
      location: { kind: 'https', url: 'https://example.invalid/scan.json' } }
  ];
}

test('reviewReport presents a readable report with its scan id and unchecked authenticity, never authenticated', async t => {
  if (!FIXTURE) return t.skip('SCAN_ARTIFACT_FIXTURE not supplied');
  const review = await reviewReport(new Uint8Array(readFileSync(FIXTURE)));
  assert.equal(review.kind, 'supported', JSON.stringify(review.diagnostics));
  assert.equal(review.scanId, SCAN_ID);
  assert.equal(review.authenticity, 'unchecked');
  assert.notEqual(review.authenticity, 'authenticated');
});

test('reviewReport turns malformed bytes into invalid diagnostics instead of throwing', async () => {
  const review = await reviewReport(new TextEncoder().encode('{not json'));
  assert.equal(review.kind, 'invalid');
  assert.ok(review.diagnostics.length > 0);
  assert.notEqual(review.authenticity, 'authenticated');
});

test('reviewReport surfaces an unsupported report generation with encountered and supported contract ids', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ schema: 'urn:aihq:scan:report:2.0.0' }));
  const review = await reviewReport(bytes);
  assert.equal(review.kind, 'unsupported');
  assert.equal(review.encountered, 'urn:aihq:scan:report:2.0.0');
  assert.deepEqual(review.supported, ['urn:aihq:scan:report:1.0.0']);
  assert.notEqual(review.authenticity, 'authenticated');
});

test('authorOrganizationPolicy builds a Core-valid document for fixed, choices and allowDeclared permissions', async () => {
  const { release, standalone, inputName, spec } = await setup();
  const authored = await authorOrganizationPolicy({
    release, id: 'example-org-policy', permitted: permittedEntries(standalone, inputName, spec)
  });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));
  const { document } = authored;
  assert.equal(document.schema, 'urn:aihq:core:organization-policy:1.0.0');
  assert.equal(document.id, 'example-org-policy');
  assert.equal(document.selections.length, 3);
  assert.deepEqual(document.selections.map(entry => entry.selectionId),
    ['entry-fixed', 'entry-choices', 'entry-declared']);
  assert.equal(document.selections[0].inputs[inputName].fixed, '.org-fixed');
  assert.deepEqual(document.selections[1].inputs[inputName].choices, [spec.default, '.org-other']);
  assert.equal(document.selections[2].inputs[inputName].allowDeclared, true);
  for (const entry of document.selections) assert.deepEqual([...entry.scopes], [...standalone.scopes]);

  const validated = validateOrganizationPolicy(document);
  assert.equal(validated.valid, true, JSON.stringify(validated.diagnostics));
});

test('authorOrganizationPolicy computes each recipeIdentity with the documented Core rule', async () => {
  const { release, standalone, inputName, spec } = await setup();
  const authored = await authorOrganizationPolicy({
    release, id: 'example-org-policy', permitted: permittedEntries(standalone, inputName, spec)
  });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));
  const expected = expectedRecipeIdentity(standalone);
  assert.match(expected, /^sha256:[a-f0-9]{64}$/);
  for (const entry of authored.document.selections) assert.equal(entry.recipeIdentity, expected);
});

test('authorOrganizationPolicy adds no evidence field to the organization policy', async () => {
  const { release, standalone, inputName, spec } = await setup();
  const authored = await authorOrganizationPolicy({
    release, id: 'example-org-policy', permitted: permittedEntries(standalone, inputName, spec)
  });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));
  assert.equal(Object.hasOwn(authored.document, 'evidence'), false);
  for (const entry of authored.document.selections) assert.equal(Object.hasOwn(entry, 'evidence'), false);
});

test('authorOrganizationPolicy rejects invalid permission shapes with Core diagnostics', async () => {
  const { release, standalone, inputName } = await setup();
  const cases = [
    { allowDeclared: true, fixed: '.org-fixed' },
    { choices: [] },
    { unknownForm: true }
  ];
  for (const permission of cases) {
    const authored = await authorOrganizationPolicy({
      release, id: 'example-org-policy',
      permitted: [{ selectionId: 'entry-bad', itemId: standalone.id, scopes: [...standalone.scopes],
        inputs: { [inputName]: permission } }]
    });
    assert.equal(authored.valid, false, JSON.stringify(permission));
    assert.ok(authored.diagnostics.length > 0, JSON.stringify(permission));
  }
});

test('deriveExecutionPolicy builds an Enterprise policy that reopens through Core parsePolicy', async () => {
  const { release, source, standalone, inputName, spec } = await setup();
  const authored = await authorOrganizationPolicy({
    release, id: 'example-org-policy', permitted: permittedEntries(standalone, inputName, spec)
  });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));
  const evidence = evidenceAssociations();
  const derived = await deriveExecutionPolicy({
    release, organization: authored.document, evidence, materialSource: source,
    choices: [{ id: 'main', managementId: 'main-management', itemId: standalone.id,
      organizationSelectionId: 'entry-choices', scope: standalone.scopes[0],
      configuration: { [inputName]: spec.default } }]
  });
  assert.equal(derived.valid, true, JSON.stringify(derived.diagnostics));
  assert.equal(derived.policy.schema, 'urn:aihq:core:execution-policy:1.0.0');
  assert.equal(derived.policy.mode, 'enterprise');
  assert.ok(derived.policy.selections.length > 0);
  for (const selection of derived.policy.selections)
    assert.equal(selection.organizationSelectionId, 'entry-choices');
  assert.deepEqual(derived.policy.evidence, evidence);

  const parsed = parsePolicy(JSON.stringify(derived.policy));
  assert.equal(parsed.valid, true, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.document.evidence, evidence);
});

test('deriveExecutionPolicy rejects out-of-policy choices locally with explicit diagnostics and no policy', async () => {
  const { release, source, standalone, other, inputName, spec } = await setup();
  const authored = await authorOrganizationPolicy({
    release, id: 'example-org-policy', permitted: permittedEntries(standalone, inputName, spec)
  });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));
  const base = { id: 'main', managementId: 'main-management', itemId: standalone.id, scope: standalone.scopes[0] };
  const cases = [
    ['a value outside the permitted choices',
      { ...base, organizationSelectionId: 'entry-choices', configuration: { [inputName]: '.org-outside' } }],
    ['a fixed value changed by the choice',
      { ...base, organizationSelectionId: 'entry-fixed', configuration: { [inputName]: '.org-changed' } }],
    ['a scope the entry does not permit',
      { ...base, organizationSelectionId: 'entry-declared', scope: 'user', configuration: {} }],
    ['an item the organization policy does not permit',
      { ...base, itemId: other.id, organizationSelectionId: 'entry-declared', configuration: {} }]
  ];
  for (const [name, choice] of cases) {
    const derived = await deriveExecutionPolicy({
      release, organization: authored.document, evidence: evidenceAssociations(),
      materialSource: source, choices: [choice]
    });
    assert.equal(derived.valid, false, name);
    assert.equal(derived.policy, undefined, name);
    assert.ok(derived.diagnostics.length > 0, name);
    assert.ok(derived.diagnostics.every(diagnostic => diagnostic.reason !== 'invalid-source'),
      `${name}: rejection must come from the organization precheck, not material setup`);
  }
});

test('deriveExecutionPolicy rejects unsupported evidence associations with diagnostics and no policy', async () => {
  const { release, source, standalone, inputName, spec } = await setup();
  const authored = await authorOrganizationPolicy({
    release, id: 'example-org-policy', permitted: permittedEntries(standalone, inputName, spec)
  });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));
  const choice = { id: 'main', managementId: 'main-management', itemId: standalone.id,
    organizationSelectionId: 'entry-choices', scope: standalone.scopes[0],
    configuration: { [inputName]: spec.default } };
  const cases = [
    ['an unsupported association schema id',
      [{ schema: 'urn:aihq:scan:evidence-association:2.0.0', scanId: `scan:sha256:${'a'.repeat(64)}`,
        location: { kind: 'file', path: 'evidence/display.scan.json' } }]],
    ['a malformed scan id',
      [{ schema: EVIDENCE_SCHEMA, scanId: 'scan:sha256:not-a-digest',
        location: { kind: 'file', path: 'evidence/display.scan.json' } }]]
  ];
  for (const [name, evidence] of cases) {
    const derived = await deriveExecutionPolicy({
      release, organization: authored.document, evidence, materialSource: source, choices: [choice]
    });
    assert.equal(derived.valid, false, name);
    assert.equal(derived.policy, undefined, name);
    assert.ok(derived.diagnostics.length > 0, name);
  }
});

test('admin.js imports only browser-safe public entries', () => {
  const text = readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
  const specifiers = [
    ...text.matchAll(/(?:from|import)\s*'([^']+)'/g),
    ...text.matchAll(/import\(\s*'([^']+)'\s*\)/g)
  ].map(match => match[1]);
  const allowed = new Set([
    '@aihq/core/contracts', '@aihq/catalog/reader', '@aihq/scan/read', '@aihq/scan/contracts',
    './authoring.js', './report-view.js'
  ]);
  for (const specifier of specifiers) {
    assert.ok(!specifier.startsWith('node:'), `node built-in import: ${specifier}`);
    assert.ok(allowed.has(specifier), `non-portable import: ${specifier}`);
  }
  assert.ok(!/(?:from|import)\s*'@aihq\/core'/.test(text), 'bare @aihq/core Node entry import');
  assert.ok(!text.includes('harness/runtime'), 'harness/runtime import');
  assert.ok(!text.includes('artifact/host'), 'artifact/host import');
});

test('authorOrganizationPolicy rejects fixed values and choices the recipe input would not accept', async () => {
  const { release, standalone, inputName } = await setup();
  const entry = permission => ({ selectionId: 'entry', itemId: standalone.id, scopes: [...standalone.scopes],
    inputs: { [inputName]: permission } });
  for (const permission of [{ fixed: 42 }, { fixed: 'x'.repeat(10_000) }, { choices: ['.ok', 42] }]) {
    const authored = await authorOrganizationPolicy({ release, id: 'org', permitted: [entry(permission)] });
    assert.equal(authored.valid, false, JSON.stringify(permission));
    assert.ok(authored.diagnostics.some(item => item.reason === 'organization-input-spec'), JSON.stringify(authored.diagnostics));
  }
  const ok = await authorOrganizationPolicy({ release, id: 'org', permitted: [entry({ fixed: '.ok' })] });
  assert.equal(ok.valid, true, JSON.stringify(ok.diagnostics));
});

// Fixed inputs and identities recorded from a packed run in which Core itself admitted
// these items (Catalog q1/rel-license f2b51599); independent of whichever Catalog is installed.
const KNOWN_IDENTITIES = [
  { recipeSha256: '3c5d4c15ec80b6747d8dc3a0ae4e94807b712b7c1158d5f9ee320914c94cc35b',
    materials: [{ id: 'skill', sha256: 'caaf8b8de1684f96e26b28f3c29189db5c89cce4b73e1c93d86164f66ef88637', byteLength: 157 },
      { id: 'license', sha256: '0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5', byteLength: 1068 }],
    identity: 'sha256:4c750b521072244bd16dbcf24d912ccbadc7f021e9a37b1074e4c502f94563f6' },
  { recipeSha256: '28e96f904cd0fd13a992a6e0289013072fa413fea705edcd46f555156152c336',
    materials: [{ id: 'license', sha256: '0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5', byteLength: 1068 },
      { id: 'skill', sha256: '10ff989e7498b23b5acb49d5048f11dcd906757d2f79c5cdf8a00001381296f2', byteLength: 1987 }],
    identity: 'sha256:030f93d25ef92482f72051093bd2e36199bb4fc7f9312f95a12b45b79d8b0c07' }
];

test('recipeIdentity reproduces identities Core admitted for fixed recipe and material digests', async () => {
  for (const { recipeSha256, materials, identity } of KNOWN_IDENTITIES)
    assert.equal(await recipeIdentity({ recipeSha256, materials }), identity);
});

test('deriveExecutionPolicy rejects an imported organization entry whose unused choice breaks the input definition', async () => {
  const { release, source } = await installedRelease();
  const item = listItems(release).find(candidate => candidate.dependencies.requires.length === 0 &&
    Object.values(candidate.inputs).some(spec => spec.type === 'string' && !spec.sensitive));
  assert.ok(item, 'a standalone item with a string input');
  const name = Object.entries(item.inputs).find(([, spec]) => spec.type === 'string' && !spec.sensitive)[0];
  const organization = { schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'imported', selections: [{
    selectionId: 'entry', recipeIdentity: await recipeIdentity({ recipeSha256: item.recipe.sha256, materials: item.materials }),
    scopes: [item.scopes[0]], inputs: { [name]: { choices: ['ok-value', 42] } } }] };
  const derived = await deriveExecutionPolicy({ release, organization, materialSource: source, evidence: [], choices: [{
    id: 'chosen', organizationSelectionId: 'entry', managementId: 'consumer-imported', scope: item.scopes[0],
    itemId: item.id, configuration: { [name]: 'ok-value' } }] });
  assert.equal(derived.valid, false);
  assert.equal(derived.policy, undefined);
  assert.ok(derived.diagnostics.some(entry => entry.reason === 'organization-input-spec'), JSON.stringify(derived.diagnostics));
});
