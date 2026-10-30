import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { symlinked } from './symlink-fixture.mjs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepare, apply, prepareManagedRemoval, listManagedSelections } from '../dist/core/index.js';
import { enterprisePolicy, orgDocument, orgSource, recipeIdentity, SELECTION_ID } from './fixtures/github-org.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-org12-'));
const home = join(scratch, 'home');
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const originalFetch = globalThis.fetch;
before(() => {
  mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home;
});
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  for (const [key, value] of Object.entries(previousHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true });
});

// Every Core schema by $id, so the produced review and run result are checked against their published formats.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemas = new URL('../dist/core/schemas/', import.meta.url);
for (const entry of readdirSync(schemas, { recursive: true }))
  if (String(entry).endsWith('.json')) ajv.addSchema(JSON.parse(readFileSync(new URL(String(entry), schemas), 'utf8')));
const conforms = (document, id) => {
  const check = ajv.getSchema(id);
  assert.equal(check(document), true, JSON.stringify(check.errors));
};
const SET = { framework: 'acme', setId: 'starter', setSha256: 'c'.repeat(64) };
const offline = () => { globalThis.fetch = () => { throw new Error('network used'); }; };
const project = () => mkdtempSync(join(scratch, 'project-'));
const policy14 = () => enterprisePolicy(document => {
  document.schema = 'urn:aihq:core:execution-policy:1.4.0';
  Object.assign(document.selections[0], { item: { framework: 'acme', itemId: 'lint', contentSha256: 'd'.repeat(64), behaviourSha256: 'e'.repeat(64) },
    tool: 'claude', name: 'Lint guidance', kind: 'skill', origins: [{ reasonIncluded: 'in-set', set: SET }] });
});
const recipeEntry = (overrides = {}) => ({ selectionId: SELECTION_ID, recipeIdentity: recipeIdentity(policy14().selections[0].recipe.inline),
  scopes: ['project'], inputs: { text: { allowDeclared: true } }, obligation: 'permitted', ...overrides });
const org12 = (...entries) => ({ schema: 'urn:aihq:core:organization-policy:1.2.0', id: 'example-org-policy', selections: entries });
const localSource = document => {
  const folder = mkdtempSync(join(scratch, 'org-'));
  const path = join(folder, 'org.json');
  writeFileSync(path, JSON.stringify(document));
  return { provider: 'local', path };
};
const request = (target, source, extras = {}, policy = policy14()) =>
  ({ useCase: 'policy', policy, target: { project: target }, organizationSource: source, ...extras });
const authorize = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
const reasons = result => result.diagnostics.map(item => item.reason);

test('a local organization source prepares and applies offline, and the review names the file a person can read', async () => {
  offline();
  const document = org12(recipeEntry());
  const source = localSource(document); const target = project();
  const prepared = await prepare(request(target, source), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.review.schema, 'urn:aihq:core:prepared-work:1.6.0');
  assert.equal(prepared.review.mode, 'enterprise');
  const { helper, ...organization } = prepared.review.inputs.organization;
  assert.deepEqual(organization, { source: { provider: 'local', fileName: 'org.json' }, policyId: 'example-org-policy',
    contentDigest: `sha256:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}` });
  assert.equal(helper.id, 'local-policy-reader');
  assert.equal(JSON.stringify(prepared.review).includes(source.path), false, 'the review names the file, not its folder');
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  assert.deepEqual(result.inputs.organization, prepared.review.inputs.organization);
  conforms(prepared.review, 'urn:aihq:core:prepared-work:1.6.0');
  conforms(result, 'urn:aihq:core:run-result:1.4.0');
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), "Read the project's contribution guide.\n");
});

test('a local organization document changed between Prepare and Apply is REVIEW_STALE for policy and writes nothing', async () => {
  offline();
  const source = localSource(org12(recipeEntry())); const target = project();
  const prepared = await prepare(request(target, source), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  writeFileSync(source.path, JSON.stringify(org12(recipeEntry({ obligation: 'recommended' }))));
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.deepEqual([result.diagnostics.at(-1).code, result.diagnostics.at(-1).changed], ['REVIEW_STALE', 'policy']);
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
});

test('a local source is caller-selected, bounded and fails closed', async t => {
  offline();
  const target = project();
  const missing = await prepare(request(target, { provider: 'local', path: join(scratch, 'absent.json') }), { logging: 'off' });
  assert.deepEqual([missing.status, missing.diagnostics[0].code, missing.diagnostics[0].reason],
    ['blocked', 'AUTHORITY_UNAVAILABLE', 'source-missing-or-inaccessible']);
  const relative = await prepare(request(target, { provider: 'local', path: 'org.json' }), { logging: 'off' });
  assert.deepEqual([relative.status, relative.diagnostics[0].reason], ['invalid', 'source-invalid']);
  const source = localSource(org12(recipeEntry()));
  const link = join(scratch, 'link.json');
  if (symlinked(source.path, link, t)) {
    const linked = await prepare(request(target, { provider: 'local', path: link }), { logging: 'off' });
    assert.deepEqual([linked.status, linked.diagnostics[0].reason], ['blocked', 'source-not-regular-file']);
  }
  // Older review formats name only a GitHub source.
  const older = await prepare(request(target, source, {}, enterprisePolicy()), { logging: 'off' });
  assert.deepEqual([older.status, reasons(older)], ['invalid', ['organization-source-local-review']]);
});

test('content prohibitions and supplied set membership govern Enterprise Prepare', async () => {
  offline();
  const target = project();
  const run = async (document, extras = {}) => prepare(request(target, localSource(document), extras), { logging: 'off' });
  const prohibitedKind = await run(org12(recipeEntry(), { selectionId: 'no-skills', scopes: ['project'], obligation: 'prohibited', content: { kind: 'skill' } }));
  assert.deepEqual([prohibitedKind.status, reasons(prohibitedKind)], ['blocked', ['prohibited']]);
  const setDocument = org12(recipeEntry(), { selectionId: 'no-starter', scopes: ['project'], obligation: 'prohibited', content: { set: SET } });
  const unavailable = await run(setDocument);
  assert.deepEqual([unavailable.status, reasons(unavailable)], ['blocked', ['set-membership-unavailable']]);
  const member = await run(setDocument, { organizationSetMembers: [{ set: SET, members: [{ framework: 'acme', itemId: 'lint' }] }] });
  assert.deepEqual([member.status, reasons(member)], ['blocked', ['prohibited']]);
  const outside = await run(setDocument, { organizationSetMembers: [{ set: SET, members: [{ framework: 'acme', itemId: 'format' }] }] });
  assert.equal(outside.status, 'ready', JSON.stringify(outside.diagnostics));
  const contradiction = await run(org12(recipeEntry(), { selectionId: 'need-lint', scopes: ['project'], obligation: 'required',
    content: { item: { framework: 'acme', itemId: 'lint' } } }, { selectionId: 'no-starter', scopes: ['project'], obligation: 'prohibited', content: { set: SET } }),
  { organizationSetMembers: [{ set: SET, members: [{ framework: 'acme', itemId: 'lint' }] }] });
  assert.deepEqual([contradiction.status, reasons(contradiction)], ['invalid', ['obligation-contradiction']]);
  const malformed = await run(setDocument, { organizationSetMembers: [{ set: SET }] });
  assert.deepEqual([malformed.status, reasons(malformed)], ['invalid', ['set-members']]);
});

test('a declared target reviews recipe and content obligations in prepared work 1.6.0', async () => {
  offline();
  const target = project();
  const prepared = await prepare(request(target, localSource(org12(recipeEntry({ obligation: 'required' }),
    { selectionId: 'need-hooks', scopes: ['project'], obligation: 'required', content: { kind: 'hook' } },
    { selectionId: 'need-starter', scopes: ['project'], obligation: 'required', content: { set: SET } },
    { selectionId: 'try-skills', scopes: ['project'], obligation: 'recommended', content: { kind: 'skill' } })),
  { organizationTarget: { schema: 'urn:aihq:core:organization-target:1.0.0', client: 'claude' } }), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const { fulfillment, advisory } = prepared.review.organizationObligations;
  assert.deepEqual(fulfillment.map(item => [item.selectionId, item.status]),
    [[SELECTION_ID, 'fulfilled'], ['need-hooks', 'not-fulfilled'], ['need-starter', 'unavailable']]);
  assert.deepEqual(fulfillment[1].content, { kind: 'hook' });
  assert.equal(fulfillment[1].recipeIdentity, undefined);
  assert.deepEqual(advisory.map(item => [item.selectionId, item.status, item.selections]), [['try-skills', 'taken', ['guidance']]]);
  conforms(prepared.review, 'urn:aihq:core:prepared-work:1.6.0');
});

test('Vibe and Harness repair never receive organization policy or its set membership', async () => {
  offline();
  const target = project();
  const vibe = enterprisePolicy(document => { document.mode = 'vibe'; delete document.selections[0].organizationSelectionId; });
  const local = localSource(org12(recipeEntry()));
  for (const extras of [{ organizationSource: local }, { organizationSetMembers: [] }]) {
    const result = await prepare({ useCase: 'policy', policy: vibe, target: { project: target }, ...extras }, { logging: 'off' });
    assert.equal(result.status, 'invalid', JSON.stringify(extras));
  }
  const ok = await prepare({ useCase: 'policy', policy: vibe, target: { project: target } }, { logging: 'off' });
  assert.equal(ok.status, 'ready', JSON.stringify(ok.diagnostics));
  assert.equal(ok.review.mode, 'vibe');
  assert.equal(ok.review.inputs.organization, undefined);
  for (const extras of [{ organizationSource: local }, { organizationSetMembers: [] }]) {
    const repair = await prepare({ useCase: 'repair', ...extras }, { logging: 'off' });
    assert.deepEqual([repair.status, repair.diagnostics[0].reason], ['invalid', 'request-field'], 'refused for the organization field');
  }
});

test('the GitHub source is unchanged and a source description never selects authority', async () => {
  offline();
  const target = project();
  const description = { schema: 'urn:aihq:catalog:source-description:1.0.0', id: 'org-sources', label: 'Org sources',
    locator: { kind: 'git', repository: 'https://github.com/example-org/org-policy' } };
  for (const source of [description, { ...description, locator: { kind: 'local', label: 'org' } }]) {
    const result = await prepare(request(target, source), { logging: 'off' });
    assert.deepEqual([result.status, result.diagnostics[0].reason], ['invalid', 'source-invalid']);
  }
  const github = await prepare(request(target, orgSource()), { logging: 'off' });
  assert.deepEqual([github.status, github.diagnostics[0].reason], ['blocked', 'network-failed'], 'GitHub stays online-only');
});

test('both Enterprise removal forms accept a local organization source', async () => {
  offline();
  const target = project();
  const vibe = enterprisePolicy(document => { document.mode = 'vibe'; delete document.selections[0].organizationSelectionId; });
  const installed = await prepare({ useCase: 'policy', policy: vibe, target: { project: target } }, { logging: 'off' });
  assert.equal((await apply(installed.prepared, authorize(installed), { logging: 'off' })).completion, 'complete');
  const source = localSource(orgDocument(enterprisePolicy(), { lifecycle: { remove: true } }));
  const removal = await prepareManagedRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: 'team-guidance' }],
    mode: 'enterprise', organizationSource: source }, { logging: 'off' });
  assert.equal(removal.preparation.status, 'ready', JSON.stringify(removal));
  assert.deepEqual(removal.preparation.review.inputs.organization.source, { provider: 'local', fileName: 'org.json' });
  const run = await apply(removal.preparation.prepared, authorize(removal.preparation), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
  const single = await prepareManagedRemoval({ target: { project: target }, managementId: 'team-guidance', scope: 'project',
    mode: 'enterprise', organizationSource: source }, { logging: 'off' });
  assert.deepEqual([single.schema, single.disposition, single.diagnostics],
    ['urn:aihq:core:managed-removal-preparation:1.0.0', 'absent', []]);
});

test('the CLI selects a local organization file offline and refuses mixing it with GitHub flags or Vibe', async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
  const target = project();
  const policyFile = join(mkdtempSync(join(scratch, 'cli-')), 'policy.json');
  writeFileSync(policyFile, JSON.stringify(policy14()));
  const source = localSource(org12(recipeEntry()));
  const run = (args, file = policyFile) => spawnSync(process.execPath, [cli, 'policy', file, '--project', target, '--json', ...args],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home, USERPROFILE: home } });
  const preview = run(['--org-file', source.path]);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).review.inputs.organization.source, { provider: 'local', fileName: 'org.json' });
  const applied = run(['--org-file', source.path, '--apply', '--yes']);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(existsSync(join(target, 'TEAM.md')), true);
  const vibeFile = join(dirname(policyFile), 'vibe.json');
  writeFileSync(vibeFile, JSON.stringify(enterprisePolicy(document => { document.mode = 'vibe'; delete document.selections[0].organizationSelectionId; })));
  for (const result of [run(['--org-file', source.path, '--org-repository', 'a/b']), run(['--org-file', source.path, '--org-token-env', 'X']),
    run(['--org-file', source.path], vibeFile), run(['--org-file', ''])]) assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('inventory policyState accounts for organization 1.2 content entries', async () => {
  offline();
  const target = project();
  const vibe = policy14(); vibe.mode = 'vibe'; delete vibe.selections[0].organizationSelectionId;
  const installed = await prepare({ useCase: 'policy', policy: vibe, target: { project: target } }, { logging: 'off' });
  assert.equal((await apply(installed.prepared, authorize(installed), { logging: 'off' })).completion, 'complete');
  const state = async (document, extra = {}) => {
    const result = await listManagedSelections({ target: { project: target }, scope: 'project', format: 'urn:aihq:core:managed-inventory-result:1.1.0',
      organization: { document, ...extra } });
    assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
    return result.selections[0].policyState;
  };
  const content = (selector, overrides = {}) => ({ selectionId: 'by-content', scopes: ['project'], obligation: 'prohibited', content: selector, ...overrides });
  assert.equal(await state(org12(recipeEntry())), 'permitted');
  assert.equal(await state(org12(recipeEntry(), content({ kind: 'skill' }))), 'prohibited');
  assert.equal(await state(org12(recipeEntry(), content({ kind: 'hook' }))), 'permitted');
  assert.equal(await state(org12(recipeEntry(), content({ framework: 'acme' }, { obligation: 'required' }))), 'required');
  assert.equal(await state(org12(recipeEntry(), content({ set: SET }))), 'unknown', 'a set without members is unavailable');
  assert.equal(await state(org12(recipeEntry(), content({ set: SET })), { setMembers: [{ set: SET, members: [{ framework: 'acme', itemId: 'lint' }] }] }), 'prohibited');
  assert.equal(await state(org12(recipeEntry(), content({ kind: 'skill' }, { clients: ['claude'] }))), 'unknown');
  // A content entry narrowing another recipe never governs this row.
  assert.equal(await state(org12(recipeEntry(), { ...recipeEntry({ selectionId: 'other', recipeIdentity: `sha256:${'f'.repeat(64)}` }),
    content: { set: SET } })), 'permitted');
});
