// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, prepare } from '@aihq/core';
import { contractSupport, deriveRecipeIdentity, parseOrganizationPolicy, previewOrganizationAdmission, previewOrganizationContent,
  previewOrganizationObligations, validateOrganizationPolicy } from '@aihq/core/contracts';
import { checkCompatibility, toolBindings, validateToolBinding } from '@aihq/core/harness';

const require = createRequire(import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const plain = value => JSON.parse(JSON.stringify(value));
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
globalThis.fetch = () => { throw new Error('this consumer runs offline'); };

const ORG12 = 'urn:aihq:core:organization-policy:1.2.0';
const ORG11 = 'urn:aihq:core:organization-policy:1.1.0';
const REPO = 'github.com/example-org/app';
const SET = { framework: 'acme', setId: 'starter', setSha256: 'c'.repeat(64) };
const members = (...ids) => [{ set: SET, members: ids.map(itemId => ({ framework: 'acme', itemId })) }];
const recipe = { schema: 'urn:aihq:core:recipe:1.0.0', id: 'team-note', description: 'Team note',
  inputs: { text: { type: 'string', required: true, maxLength: 4096 } }, materials: [], targets: ['project'], prerequisites: [], checks: [],
  operations: [{ id: 'write', purpose: 'Write team note', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'TEAM.md' }] }, content: { input: 'text' }, requires: [], checks: [] }] };
const identity = await deriveRecipeIdentity({ recipe });
assert.equal(identity.status, 'ok');
const ID = identity.value.recipeIdentity;
const entry = (overrides = {}) => ({ selectionId: 'team-note', recipeIdentity: ID, scopes: ['project'],
  inputs: { text: { allowDeclared: true } }, obligation: 'permitted', ...overrides });
const content = (selector, overrides = {}) => ({ selectionId: 'by-content', scopes: ['project'], obligation: 'prohibited', content: selector, ...overrides });
const org = (schema, ...selections) => ({ schema, id: 'team', selections });
const choice = (overrides = {}) => ({ id: 'note', organizationSelectionId: 'team-note', scope: 'project', recipeIdentity: ID,
  inputs: recipe.inputs, configuration: { text: 'Read CONTRIBUTING.md' }, privateInputs: [], kind: 'skill',
  item: { framework: 'acme', itemId: 'lint' }, ...overrides });
const admit = (organization, selections = [choice()], extra = {}) => {
  const result = previewOrganizationAdmission({ organization, selections, lifecycle: [], ...extra });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return result.value.diagnostics.map(item => item.reason);
};

await check('organization policy 1.2.0 is published with its schema and fixtures, beside 1.1.0', () => {
  const schema = require('@aihq/core/schemas/organization-policy/1.2.0.json');
  assert.equal(schema.$id, ORG12);
  assert.ok(require('@aihq/core/schemas/organization-policy/1.1.0.json'));
  const declared = contractSupport.contracts.find(item => item.id === ORG12);
  assert.equal(declared.schemaExport, '@aihq/core/schemas/organization-policy/1.2.0.json');
  for (const fixture of declared.fixtures) {
    const result = validateOrganizationPolicy(require(fixture.export));
    assert.equal(result.valid, fixture.expect === 'accept', fixture.export);
  }
  // The organization document carries no content-source list: discovery data never becomes authority.
  assert.equal(validateOrganizationPolicy(org(ORG12, { ...content({ kind: 'hook' }), sources: [] })).valid, false);
  assert.equal(validateOrganizationPolicy({ ...org(ORG12), contentSources: [] }).valid, false);
});

await check('every 1.1 rule is kept in 1.2: exact recipe, inputs, lifecycle, target selectors and contradictions', () => {
  for (const schema of [ORG11, ORG12]) {
    assert.deepEqual(admit(org(schema, entry())), []);
    assert.deepEqual(admit(org(schema, entry({ selectionId: 'other' }))), ['selection-not-admitted']);
    assert.deepEqual(admit(org(schema, entry({ recipeIdentity: `sha256:${'f'.repeat(64)}` }))), ['recipe-identity']);
    assert.deepEqual(admit(org(schema, entry({ scopes: ['user'] }))), ['scope']);
    assert.deepEqual(admit(org(schema, entry({ inputs: { text: { fixed: 'Other' } } }))), ['input-value']);
    const lifecycle = previewOrganizationAdmission({ organization: org(schema, entry()), selections: [choice()],
      lifecycle: [{ action: 'adopt', scope: 'project', recipeIdentity: ID, organizationSelectionId: 'team-note' }] });
    assert.deepEqual(lifecycle.value.diagnostics.map(item => item.reason), ['lifecycle-adopt']);
    assert.deepEqual(admit(org(schema, entry(), entry({ selectionId: 'deny', obligation: 'prohibited' }))), ['prohibited']);
    const targeted = org(schema, entry({ clients: ['claude'], repositories: [REPO] }));
    const facts = target => previewOrganizationObligations({ organization: targeted, selections: [choice()], lifecycle: [], target }).value.enforced;
    assert.deepEqual(facts({ scope: 'project', client: 'claude', repository: REPO }).admitted, true);
    assert.deepEqual(facts({ scope: 'project', client: 'codex', repository: REPO }).diagnostics.map(item => item.reason), ['client']);
    assert.deepEqual(facts({ scope: 'project', client: 'claude' }).diagnostics.map(item => item.reason), ['target-unknown']);
    const contradiction = validateOrganizationPolicy(org(schema, entry({ obligation: 'required' }), entry({ selectionId: 'deny', obligation: 'prohibited' })));
    assert.deepEqual(contradiction.diagnostics.map(item => item.reason), ['obligation-contradiction']);
    assert.equal(validateOrganizationPolicy(org(schema, entry({ obligation: 'required', clients: ['claude'] }),
      entry({ selectionId: 'deny', obligation: 'prohibited', clients: ['codex'] }))).valid, true, 'targets that cannot overlap');
  }
});

await check('content selectors by kind, item, framework and set carry the existing obligations', () => {
  assert.deepEqual(admit(org(ORG12, entry(), content({ kind: 'skill' }))), ['prohibited']);
  assert.deepEqual(admit(org(ORG12, entry(), content({ kind: 'hook' }))), []);
  assert.deepEqual(admit(org(ORG12, entry(), content({ item: { framework: 'acme', itemId: 'lint' } }))), ['prohibited']);
  assert.deepEqual(admit(org(ORG12, entry(), content({ framework: 'other' }))), []);
  assert.deepEqual(admit(org(ORG12, entry(), content({ set: SET }))), ['set-membership-unavailable']);
  assert.deepEqual(admit(org(ORG12, entry(), content({ set: SET })), [choice()], { setMembers: members('lint') }), ['prohibited']);
  assert.deepEqual(admit(org(ORG12, entry({ content: { kind: 'hook' } }))), ['content'], 'a recipe entry narrowed to other content admits nothing');
  assert.deepEqual(admit(org(ORG12, content({ kind: 'skill' }, { selectionId: 'team-note', obligation: 'permitted' }))), ['recipe-identity'],
    'exact recipe admission: a content-only entry admits no selection');
  // An undeclared content fact does not match; prohibition fails closed as an undeclared target fact does.
  const { kind: _kind, item: _item, ...bare } = choice();
  assert.deepEqual(admit(org(ORG12, entry(), content({ kind: 'skill' })), [bare]), ['target-unknown']);
  const obligations = previewOrganizationObligations({ organization: org(ORG12, entry(),
    content({ kind: 'skill' }, { selectionId: 'need-skill', obligation: 'required' }),
    content({ framework: 'acme' }, { selectionId: 'try-acme', obligation: 'recommended' })),
  selections: [choice()], lifecycle: [], target: { scope: 'project' } }).value;
  assert.deepEqual(obligations.fulfillment.map(item => [item.selectionId, item.status]), [['need-skill', 'fulfilled']]);
  assert.deepEqual(obligations.advisory.map(item => [item.selectionId, item.status]), [['try-acme', 'taken']]);
});

await check('set membership is supplied data: without it a set selector is unavailable and never matched', () => {
  const document = org(ORG12, content({ set: SET }, { selectionId: 'need-set', obligation: 'required' }), content({ kind: 'hook' }));
  const without = validateOrganizationPolicy(document);
  assert.deepEqual([without.valid, without.unavailable], [true, [{ reason: 'set-membership-unavailable', path: '/selections/0/content/set', set: SET }]]);
  assert.equal(validateOrganizationPolicy(document, { setMembers: members('lint') }).unavailable, undefined);
  const fulfillment = previewOrganizationObligations({ organization: document, selections: [], lifecycle: [], target: { scope: 'project' } });
  assert.deepEqual(fulfillment.value.fulfillment.map(item => item.status), ['unavailable']);
  const perItem = previewOrganizationContent({ organization: document, target: { scope: 'project' },
    items: [{ framework: 'acme', itemId: 'lint', kind: 'skill' }] }).value.items[0];
  assert.deepEqual([perItem.required, perItem.entries[0].match], [false, 'unavailable']);
});

await check('a document requiring and prohibiting overlapping content is invalid, including a set and its member', () => {
  const pair = org(ORG12, content({ set: SET }, { selectionId: 'need-set', obligation: 'required' }),
    content({ item: { framework: 'acme', itemId: 'lint' } }));
  const invalid = validateOrganizationPolicy(pair, { setMembers: members('lint', 'format') });
  assert.deepEqual(invalid.diagnostics.map(item => [item.reason, item.path]), [['obligation-contradiction', '/selections/1/obligation']]);
  assert.equal(parseOrganizationPolicy(JSON.stringify(pair), { setMembers: members('lint') }).valid, false);
  assert.equal(validateOrganizationPolicy(pair, { setMembers: members('format') }).valid, true, 'not a member: no overlap');
  assert.equal(validateOrganizationPolicy(org(ORG12, content({ kind: 'hook' }, { selectionId: 'need', obligation: 'required' }),
    content({ kind: 'hook' }))).valid, false);
  assert.equal(validateOrganizationPolicy(org(ORG12, content({ kind: 'hook' }, { selectionId: 'need', obligation: 'required', scopes: ['user'] }),
    content({ kind: 'hook' }))).valid, true, 'targets that do not overlap');
});

// An independently built Catalog item and a binding cell observed as not taking it.
const FRAMEWORK = 'acme';
function catalogItem({ id, kind, payload, files, requirements = { inputs: {} } }) {
  const content = Object.entries(files).map(([relPath, text], index) => ({
    id: relPath === 'LICENSE' ? 'license' : `m${index}`, relPath, sourcePath: relPath, packagePath: `release/items/${id}/${relPath}`,
    sha256: sha256(text), byteLength: Buffer.byteLength(text), executable: false, sourceId: 'upstream', role: 'content',
    size: { bytes: Buffer.byteLength(text), chars: [...text].length, status: 'measured' } }));
  const dependencies = { requires: [], optional: [], conflicts: [] };
  const executable = Object.fromEntries(content.map(member => [member.relPath, false]));
  const behaviourText = `${canonical({ kind, payload: payload ?? null, requirements, dependencies, executable })}\n`;
  const behaviour = { id: 'behaviour', relPath: 'aih-behaviour.json', sourcePath: null, packagePath: `release/items/${id}/aih-behaviour.json`,
    sha256: sha256(behaviourText), byteLength: Buffer.byteLength(behaviourText), executable: false, sourceId: FRAMEWORK, role: 'behaviour' };
  const lines = list => list.map(member => `${member.relPath}\t${member.sha256}\n`).sort().join('');
  return { id, label: id, kind, sourceIds: ['upstream'], targets: [], scopes: ['project'], inputs: {},
    recipe: { id, schema: 'urn:aihq:core:recipe:1.0.0', path: `release/recipes/${id}.json`, sha256: sha256(`${id}-recipe`), byteLength: 900 },
    materials: [...content, behaviour].sort((a, b) => a.id < b.id ? -1 : 1), dependencies, requirements, executable,
    contentSha256: sha256(lines(content)), behaviourSha256: sha256(lines([...content, behaviour])), payload };
}

await check('a required item whose binding is none is a named blocker', () => {
  const github = catalogItem({ id: 'github', kind: 'mcp-server', files: { LICENSE: 'MIT\n' },
    requirements: { inputs: { githubToken: { type: 'string', required: true, sensitive: true } } },
    payload: { key: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'github-mcp'], env: { GITHUB_TOKEN: { input: 'githubToken' } } } });
  const { digest: _digest, ...shipped } = plain(toolBindings.find(item => item.tool === 'claude'));
  shipped.layouts['mcp-server'] = { ...shipped.layouts['mcp-server'], support: 'none', reason: 'Not registered.',
    observations: shipped.layouts['mcp-server'].observations.map(item => ({ ...item, registered: 'not-registered', recognised: 'not-run' })) };
  const binding = { ...shipped, digest: sha256(canonical(shipped)) };
  assert.equal(validateToolBinding(binding).valid, true, JSON.stringify(validateToolBinding(binding)));
  const document = org(ORG12, content({ item: { framework: 'acme', itemId: 'github' } }, { selectionId: 'need-github', obligation: 'required' }));
  const preview = previewOrganizationContent({ organization: document, target: { scope: 'project', client: 'claude' },
    items: [{ framework: 'acme', itemId: 'github', kind: 'mcp-server' }] });
  assert.equal(preview.status, 'ok', JSON.stringify(preview));
  const required = preview.value.items[0].required;
  assert.equal(required, true);
  const result = checkCompatibility({ tool: 'claude', platform: { os: 'windows', arch: 'x64' }, items: [{ item: github, required }], binding });
  assert.equal(result.status, 'checked', JSON.stringify(result));
  assert.deepEqual(result.items[0].staticBlockers.map(blocker => blocker.code), ['required-but-unsupported']);
  const optional = previewOrganizationContent({ organization: org(ORG12), target: { scope: 'project' },
    items: [{ framework: 'acme', itemId: 'github', kind: 'mcp-server' }] }).value.items[0].required;
  assert.deepEqual(checkCompatibility({ tool: 'claude', platform: { os: 'windows', arch: 'x64' }, items: [{ item: github, required: optional }], binding })
    .items[0].staticBlockers, [], 'not required by the organization: no blocker');
});

const root = mkdtempSync(join(tmpdir(), 'aih-org12-consumer-'));
const projectRoot = () => { const path = mkdtempSync(join(root, 'project-')); return path; };
const executionPolicy = (mode = 'enterprise') => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode, selections: [{
  id: 'note', managementId: 'team-note', scope: 'project', configuration: { text: 'Read CONTRIBUTING.md' }, requires: [],
  ...(mode === 'enterprise' ? { organizationSelectionId: 'team-note' } : {}), recipe: { inline: recipe },
  item: { framework: 'acme', itemId: 'lint', contentSha256: 'd'.repeat(64), behaviourSha256: 'e'.repeat(64) },
  tool: 'claude', name: 'Team note', kind: 'skill', origins: [{ reasonIncluded: 'chosen' }] }] });
const localFile = document => {
  const folder = mkdtempSync(join(root, 'org-')); mkdirSync(folder, { recursive: true });
  const path = join(folder, 'team-policy.json'); writeFileSync(path, JSON.stringify(document));
  return { provider: 'local', path };
};
const authorize = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });

await check('a local organization source works offline and the review names the file a person can read', async () => {
  const target = projectRoot(); const source = localFile(org(ORG12, entry()));
  const prepared = await prepare({ useCase: 'policy', policy: executionPolicy(), target: { project: target }, organizationSource: source }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.deepEqual(prepared.review.inputs.organization.source, { provider: 'local', fileName: 'team-policy.json' });
  assert.equal(JSON.stringify(prepared.review).includes(source.path), false);
  const run = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), 'Read CONTRIBUTING.md');
  // A changed local document between Prepare and Apply refuses and writes nothing.
  const second = projectRoot(); const changing = localFile(org(ORG12, entry()));
  const held = await prepare({ useCase: 'policy', policy: executionPolicy(), target: { project: second }, organizationSource: changing }, { logging: 'off' });
  writeFileSync(changing.path, JSON.stringify(org(ORG12, entry({ obligation: 'recommended' }))));
  const stale = await apply(held.prepared, authorize(held), { logging: 'off' });
  assert.deepEqual([stale.diagnostics.at(-1).code, stale.diagnostics.at(-1).changed], ['REVIEW_STALE', 'policy']);
  assert.equal(existsSync(join(second, 'TEAM.md')), false);
});

await check('runtime prohibition enforcement and supplied set membership govern Prepare; no new precedence', async () => {
  const run = async (document, extra = {}) => prepare({ useCase: 'policy', policy: executionPolicy(), target: { project: projectRoot() },
    organizationSource: localFile(document), ...extra }, { logging: 'off' });
  const prohibited = await run(org(ORG12, entry(), content({ kind: 'skill' })));
  assert.deepEqual([prohibited.status, prohibited.diagnostics.map(item => item.reason)], ['blocked', ['prohibited']]);
  const recipeProhibited = await run(org(ORG12, entry(), entry({ selectionId: 'deny', obligation: 'prohibited' })));
  assert.deepEqual([recipeProhibited.status, recipeProhibited.diagnostics.map(item => item.reason)], ['blocked', ['prohibited']]);
  const unavailable = await run(org(ORG12, entry(), content({ set: SET })));
  assert.deepEqual(unavailable.diagnostics.map(item => item.reason), ['set-membership-unavailable']);
  const outside = await run(org(ORG12, entry(), content({ set: SET })), { organizationSetMembers: members('format') });
  assert.equal(outside.status, 'ready', JSON.stringify(outside.diagnostics));
  const contradiction = await run(org(ORG12, entry(), content({ set: SET }), content({ item: { framework: 'acme', itemId: 'lint' } },
    { selectionId: 'need', obligation: 'required' })), { organizationSetMembers: members('lint') });
  assert.deepEqual([contradiction.status, contradiction.diagnostics.map(item => item.reason)], ['invalid', ['obligation-contradiction']]);
});

await check('Vibe and standalone Harness repair never receive organization policy', async () => {
  const target = projectRoot(); const source = localFile(org(ORG12, content({ kind: 'skill' })));
  for (const extra of [{ organizationSource: source }, { organizationSetMembers: members('lint') }]) {
    const refused = await prepare({ useCase: 'policy', policy: executionPolicy('vibe'), target: { project: target }, ...extra }, { logging: 'off' });
    assert.equal(refused.status, 'invalid', JSON.stringify(extra));
    const repair = await prepare({ useCase: 'repair', ...extra }, { logging: 'off' });
    assert.equal(repair.status, 'invalid', JSON.stringify(extra));
  }
  const vibe = await prepare({ useCase: 'policy', policy: executionPolicy('vibe'), target: { project: target } }, { logging: 'off' });
  assert.equal(vibe.status, 'ready', 'the same skill a prohibition would deny in Enterprise prepares in Vibe');
  assert.equal(vibe.review.inputs.organization, undefined);
});

await check('a Catalog source description never selects organization authority', async () => {
  const description = { schema: 'urn:aihq:catalog:source-description:1.0.0', id: 'org-sources', label: 'Organization sources',
    locator: { kind: 'local', label: 'org' } };
  const result = await prepare({ useCase: 'policy', policy: executionPolicy(), target: { project: projectRoot() },
    organizationSource: description }, { logging: 'off' });
  assert.deepEqual([result.status, result.diagnostics[0].reason], ['invalid', 'source-invalid']);
});

console.log(JSON.stringify({ status: 'passed', checks }));
