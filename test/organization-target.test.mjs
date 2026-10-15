import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { prepare, apply } from '../dist/core/index.js';
import { contractSupport, validateOrganizationTarget } from '../dist/core/contracts.js';
import { nativeClients } from '../dist/core/internal/native-clients.js';
import targetSchema from '../dist/core/schemas/organization-target/1.0.0.json' with { type: 'json' };
import prepared15Schema from '../dist/core/schemas/prepared-work/1.5.0.json' with { type: 'json' };
import prepared14Schema from '../dist/core/schemas/prepared-work/1.4.0.json' with { type: 'json' };
import { enterprisePolicy, fakeFetch, orgDocument, orgRoutes, orgSource } from './fixtures/github-org.mjs';

const TARGET = 'urn:aihq:core:organization-target:1.0.0';
const PREPARED15 = 'urn:aihq:core:prepared-work:1.5.0';
const REPO = 'github.com/example-org/app';
const scratch = mkdtempSync(join(tmpdir(), 'aih-org-target-'));
const home = join(scratch, 'home');
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const originalFetch = globalThis.fetch;
before(() => { mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  for (const [key, value] of Object.entries(previousHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true });
});

const project = () => mkdtempSync(join(scratch, 'project-'));
const declared = (overrides = {}) => ({ schema: TARGET, client: 'codex', ...overrides });
const request = (target, organizationTarget, policy = enterprisePolicy()) =>
  ({ useCase: 'policy', policy, target: { project: target }, organizationSource: orgSource(),
    ...(organizationTarget === undefined ? {} : { organizationTarget }) });
const authorize = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
/** An organization 1.1.0 document: the fixture entry (overridden) followed by any extra entries. */
const org11 = (overrides = {}, ...extra) => {
  const [entry] = orgDocument().selections;
  return Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:organization-policy:1.1.0', id: 'example-org-policy',
    selections: [{ ...entry, obligation: 'permitted', ...overrides }, ...extra] }));
};
const other = (overrides = {}) => ({ selectionId: 'other-guidance', recipeIdentity: `sha256:${'b'.repeat(64)}`,
  scopes: ['project'], inputs: {}, obligation: 'required', ...overrides });
const stubOrg = bytes => { const calls = []; globalThis.fetch = fakeFetch(orgRoutes({ bytes }), calls); return calls; };
const run = async (bytes, organizationTarget) => {
  stubOrg(bytes);
  return prepare(request(project(), organizationTarget), { logging: 'off' });
};
const reasons = result => result.diagnostics.map(item => [item.code, item.reason]);

test('the organization target is an exported, accepted contract over Core\'s client list', () => {
  assert.equal(targetSchema.$id, TARGET);
  assert.deepEqual(contractSupport.contracts.find(item => item.id === TARGET),
    { id: TARGET, role: 'accepts', schemaExport: '@aihq/core/schemas/organization-target/1.0.0.json' });
  assert.deepEqual(contractSupport.contracts.find(item => item.id === PREPARED15),
    { id: PREPARED15, role: 'produces', schemaExport: '@aihq/core/schemas/prepared-work/1.5.0.json' });
  assert.deepEqual(targetSchema.properties.client.enum, [...nativeClients]);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./schemas/organization-target/1.0.0.json'], './dist/core/schemas/organization-target/1.0.0.json');
  assert.equal(manifest.exports['./schemas/prepared-work/1.5.0.json'], './dist/core/schemas/prepared-work/1.5.0.json');
});

test('validation accepts a declared client with an optional repository and rejects anything else', () => {
  for (const value of [declared(), declared({ repository: REPO })])
    assert.equal(validateOrganizationTarget(value).valid, true, JSON.stringify(value));
  const bad = [declared({ client: 'unknown-client' }), declared({ repository: 'Not A Repository' }),
    declared({ repository: 'github.com/example-org' }), { schema: TARGET }, declared({ extra: true }),
    { client: 'codex' }, declared({ schema: 'urn:aihq:core:organization-target:9.9.9' })];
  for (const value of bad) assert.equal(validateOrganizationTarget(value).valid, false, JSON.stringify(value));
});

test('Prepare rejects an invalid target, and any target on a Vibe policy, before any read or handle', async () => {
  const calls = stubOrg(Buffer.from(JSON.stringify(orgDocument())));
  const invalid = await prepare(request(project(), declared({ client: 'unknown-client' })), { logging: 'off' });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.prepared, undefined);
  assert.equal(invalid.diagnostics[0].code, 'INPUT_INVALID');
  const vibe = enterprisePolicy(document => { document.mode = 'vibe'; delete document.selections[0].organizationSelectionId; });
  const result = await prepare({ useCase: 'policy', policy: vibe, target: { project: project() }, organizationTarget: declared() }, { logging: 'off' });
  assert.equal(result.status, 'invalid');
  assert.equal(result.prepared, undefined);
  assert.deepEqual(reasons(result), [['INPUT_INVALID', 'organization-target-vibe']]);
  assert.equal(calls.length, 0, 'no organization read happens for an unusable target');
});

test('without a target the review keeps its schema, keys and values', async () => {
  const bytes = org11({ obligation: 'required' }, other());
  stubOrg(bytes);
  const first = await prepare(request(project()), { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first.diagnostics));
  assert.equal(first.review.schema, 'urn:aihq:core:prepared-work:1.0.0');
  assert.equal(Object.hasOwn(first.review, 'organizationObligations'), false);
  assert.deepEqual(Object.keys(first.review), ['schema', 'useCase', 'mode', 'target', 'inputs', 'operations', 'observations',
    'conflicts', 'omissions', 'evidence', 'effectiveOptions', 'reviewDigest']);
  const fixed = project();
  const strip = ({ reviewDigest, ...rest }) => rest;
  stubOrg(bytes);
  const a = await prepare(request(fixed), { logging: 'off' });
  const b = await prepare(request(fixed), { logging: 'off' });
  assert.deepEqual(strip(a.review), strip(b.review));
  assert.deepEqual(reasons(a), reasons(b));
});

test('a client selector that applies is fulfilled; one that does not blocks a referenced entry', async () => {
  const applies = await run(org11({ obligation: 'required', clients: ['codex'] }), declared());
  assert.equal(applies.status, 'ready', JSON.stringify(applies.diagnostics));
  assert.equal(applies.review.schema, PREPARED15);
  const { target, fulfillment, advisory } = applies.review.organizationObligations;
  assert.deepEqual(target, { basis: 'declared', client: 'codex' });
  assert.deepEqual(fulfillment, [{ scope: 'project', selectionId: 'project-guidance', recipeIdentity: orgDocument().selections[0].recipeIdentity,
    applicability: 'applies', unknown: [], status: 'fulfilled', selections: ['guidance'] }]);
  assert.deepEqual(advisory, []);
  const denied = await run(org11({ obligation: 'required', clients: ['claude'] }), declared());
  assert.equal(denied.status, 'blocked');
  assert.deepEqual(reasons(denied), [['AUTHORITY_DENIED', 'client']]);
  assert.equal(denied.prepared, undefined);
  const filtered = await run(org11({}, other({ clients: ['claude'] })), declared());
  assert.equal(filtered.status, 'ready', JSON.stringify(filtered.diagnostics));
  assert.deepEqual(filtered.review.organizationObligations.fulfillment, []);
});

test('a repository selector uses only the declared identity and never infers one', async () => {
  const bytes = org11({ obligation: 'required', repositories: [REPO] });
  const known = await run(bytes, declared({ repository: REPO }));
  assert.equal(known.status, 'ready', JSON.stringify(known.diagnostics));
  assert.deepEqual(known.review.organizationObligations.target, { basis: 'declared', client: 'codex', repository: REPO });
  assert.deepEqual(known.review.organizationObligations.fulfillment.map(item => [item.applicability, item.status, item.selections]),
    [['applies', 'fulfilled', ['guidance']]]);
  const unknown = await run(bytes, declared());
  assert.equal(unknown.status, 'blocked');
  assert.deepEqual(reasons(unknown), [['AUTHORITY_DENIED', 'target-unknown']]);
  const unreferenced = await run(org11({}, other({ repositories: [REPO] })), declared());
  assert.equal(unreferenced.status, 'ready', JSON.stringify(unreferenced.diagnostics));
  assert.deepEqual(unreferenced.review.organizationObligations.fulfillment.map(item =>
    [item.selectionId, item.applicability, item.unknown, item.status, item.selections]),
    [['other-guidance', 'unknown', ['repository'], 'unknown', []]]);
});

test('an unfulfilled required entry is reported per scope and never blocks', async () => {
  const bytes = org11({}, other({ scopes: ['project', 'user'] }), other({ selectionId: 'advised', obligation: 'recommended' }));
  const target = project(); stubOrg(bytes);
  const prepared = await prepare(request(target, declared()), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const { fulfillment, advisory } = prepared.review.organizationObligations;
  assert.deepEqual(fulfillment.map(item => [item.scope, item.selectionId, item.status, item.selections]),
    [['project', 'other-guidance', 'not-fulfilled', []], ['user', 'other-guidance', 'not-fulfilled', []]]);
  assert.deepEqual(advisory.map(item => [item.scope, item.selectionId, item.status]), [['project', 'advised', 'not-taken']]);
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  assert.equal(result.schema, 'urn:aihq:core:run-result:1.1.0');
  assert.equal(existsSync(join(target, 'TEAM.md')), true);
});

test('Apply rejects a changed declared target with no effects and accepts an unchanged one', async () => {
  const bytes = org11({ obligation: 'required' });
  for (const change of [value => { value.client = 'claude'; }, value => { value.repository = REPO; }]) {
    const target = project(); stubOrg(bytes);
    const live = request(target, declared());
    const prepared = await prepare(live, { logging: 'off' });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    change(live.organizationTarget);
    const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
    assert.equal(result.completion, 'rejected');
    assert.equal(result.diagnostics.at(-1).code, 'REVIEW_STALE');
    assert.equal(existsSync(join(target, 'TEAM.md')), false);
  }
  const target = project(); stubOrg(bytes);
  const prepared = await prepare(request(target, declared()), { logging: 'off' });
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
});

test('the 1.5.0 review satisfies its exported schema and carries the obligations', async () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(prepared14Schema);
  const check = ajv.compile(prepared15Schema);
  const prepared = await run(org11({ obligation: 'required', clients: ['codex'] }, other(), other({ selectionId: 'advised', obligation: 'recommended' })),
    declared({ repository: REPO }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const review = JSON.parse(JSON.stringify(prepared.review));
  assert.equal(check(review), true, JSON.stringify(check.errors));
  assert.ok(review.organizationObligations.fulfillment.length > 0 && review.organizationObligations.advisory.length > 0);
  const { organizationObligations, ...without } = review;
  assert.equal(check(without), false, 'a 1.5.0 review must carry its obligations');
  assert.equal(check({ ...review, organizationObligations: { ...organizationObligations, extra: true } }), false);
  assert.equal(check({ ...review, mode: 'vibe' }), false);
});
