import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, apply } from '../dist/core/index.js';
import { COMMIT, COMMIT2, TOKEN, enterprisePolicy, failingRoutes, fakeFetch, orgDocument, orgRoutes, orgSource,
  recipeIdentity } from './fixtures/github-org.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-enterprise-'));
const home = join(scratch, 'home');
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const originalFetch = globalThis.fetch;
before(() => { mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  for (const [key, value] of Object.entries(previousHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true });
});

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = value => Buffer.from(JSON.stringify(value));
const project = () => mkdtempSync(join(scratch, 'project-'));
const stub = (routes, calls = []) => { globalThis.fetch = fakeFetch(routes, calls); return calls; };
const request = (target, policy = enterprisePolicy(), source = orgSource(), extras = {}) =>
  ({ useCase: 'policy', policy, target: { project: target }, organizationSource: source, ...extras });
const authorize = (prepared, extras = {}) => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest, ...extras });
function filesContaining(root, text) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesContaining(path, text));
    else if (statSync(path).size < 5_000_000 && readFileSync(path).includes(text)) found.push(path);
  }
  return found;
}
const noToken = (value, target) => {
  assert.equal(JSON.stringify(value).includes(TOKEN), false, 'result leaks the token');
  assert.deepEqual(filesContaining(home, TOKEN), [], 'state or history leaks the token');
  assert.deepEqual(filesContaining(target, TOKEN), [], 'project leaks the token');
};

test('admitted Enterprise selection prepares ready, binds the organization and re-reads it at Apply', async () => {
  const target = project(); const calls = stub(orgRoutes());
  const prepared = await prepare(request(target), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(calls.length, 4);
  assert.equal(prepared.review.mode, 'enterprise');
  const binding = prepared.review.inputs.organization;
  assert.deepEqual(binding.source, { provider: 'github', repository: { owner: 'example-org', name: 'org-policy' },
    path: 'policy/org.json', revision: { kind: 'commit', value: COMMIT } });
  assert.equal(binding.resolvedCommit, COMMIT);
  assert.match(binding.blobId, /^[a-f0-9]{40}$/);
  assert.equal(binding.contentDigest, `sha256:${sha(bytesOf(orgDocument()))}`);
  assert.equal(binding.policyId, 'example-org-policy');
  assert.equal(binding.helper.id, 'github-policy-reader');
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(calls.length, 8, 'Apply must read the organization again');
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  assert.deepEqual(result.inputs.organization, binding);
  assert.deepEqual(result.operations[0].verification, { status: 'unverified', reason: 'no-supplied-check' });
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), "Read the project's contribution guide.\n");
});

test('the organization binding is covered by the review digest', async () => {
  const target = project(); stub(orgRoutes());
  const first = await prepare(request(target), { logging: 'off' });
  stub(orgRoutes({ commit: COMMIT2 }));
  const second = await prepare(request(target, enterprisePolicy(), orgSource({ kind: 'commit', value: COMMIT2 })), { logging: 'off' });
  assert.notEqual(first.review.inputs.organization.resolvedCommit, second.review.inputs.organization.resolvedCommit);
  assert.notEqual(first.review.reviewDigest, second.review.reviewDigest);
});

test('Vibe reviews keep their shape without an organization input', async () => {
  const target = project(); const calls = stub(orgRoutes());
  const policy = enterprisePolicy(document => { document.mode = 'vibe'; delete document.selections[0].organizationSelectionId; });
  const prepared = await prepare({ useCase: 'policy', policy, target: { project: target } }, { logging: 'off' });
  assert.equal(prepared.review.mode, 'vibe');
  assert.deepEqual(Object.keys(prepared.review.inputs).sort(), ['package', 'policySha256']);
  assert.equal(calls.length, 0);
});

test('a moved branch with identical bytes is REVIEW_STALE at Apply and writes nothing', async () => {
  const target = project(); const routes = orgRoutes({ branch: 'main' }); const calls = stub(routes);
  const prepared = await prepare(request(target, enterprisePolicy(), orgSource({ kind: 'branch', value: 'main' })), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(calls.length, 5);
  Object.assign(routes, orgRoutes({ commit: COMMIT2, branch: 'main' }));
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'rejected');
  assert.equal(result.diagnostics.at(-1).code, 'REVIEW_STALE');
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
});

test('changed organization bytes at the same revision are REVIEW_STALE', async () => {
  const target = project(); const routes = orgRoutes(); stub(routes);
  const prepared = await prepare(request(target), { logging: 'off' });
  const changed = orgDocument(); changed.id = 'changed-policy';
  Object.assign(routes, orgRoutes({ bytes: bytesOf(changed) }));
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'rejected');
  assert.equal(result.diagnostics.at(-1).code, 'REVIEW_STALE');
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
});

test('Apply without the credential after authenticated Prepare is rejected with no effects', async () => {
  const target = project(); const routes = orgRoutes(); const calls = [];
  const inner = fakeFetch(routes, calls);
  globalThis.fetch = (url, init) => init?.headers?.authorization === `Bearer ${TOKEN}` ? inner(url, init) :
    Promise.resolve(new Response('{}', { status: 404 }));
  const authentication = { kind: 'bearer', token: TOKEN };
  const prepared = await prepare(request(target), { authentication });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const rejected = await apply(prepared.prepared, authorize(prepared), {});
  assert.equal(rejected.completion, 'rejected');
  assert.equal(rejected.diagnostics.at(-1).code, 'AUTHORITY_UNAVAILABLE');
  assert.equal(rejected.diagnostics.at(-1).reason, 'source-missing-or-inaccessible');
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
  assert.ok(calls.every(call => call.authorization === `Bearer ${TOKEN}`));
  const applied = await apply(prepared.prepared, authorize(prepared), { authentication });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied));
  noToken([prepared, rejected, applied], target);
});

test('access failures at Prepare block with the precise reason and never leak the credential', async () => {
  const cases = [
    ['401', failingRoutes(401), 'authentication-required-or-denied'],
    ['403', failingRoutes(403), 'authentication-required-or-denied'],
    ['rate limit', failingRoutes(403, { 'x-ratelimit-remaining': '0', 'retry-after': '30' }), 'rate-limited'],
    ['404', failingRoutes(404), 'source-missing-or-inaccessible'],
    ['network', { [`/repos/example-org/org-policy/git/commits/${COMMIT}`]: 'network-error' }, 'network-failed']
  ];
  for (const [label, routes, reason] of cases) {
    const target = project(); stub(routes);
    const result = await prepare(request(target), { authentication: { kind: 'bearer', token: TOKEN } });
    assert.equal(result.status, 'blocked', label);
    assert.equal(result.prepared, undefined, label);
    assert.equal(result.review, undefined, label);
    assert.equal(result.diagnostics[0].code, 'AUTHORITY_UNAVAILABLE', label);
    assert.equal(result.diagnostics[0].reason, reason, label);
    if (reason === 'rate-limited') assert.match(result.diagnostics[0].guidance, /30 seconds/);
    assert.equal(result.record.status, 'written', label);
    noToken(result, target);
  }
});

test('altered recipe, forbidden input, forbidden scope and missing entries are denied without a handle', async () => {
  const baseline = enterprisePolicy();
  const cases = [
    ['recipe-identity', enterprisePolicy(document => { document.selections[0].recipe.inline.description = 'Altered under the same name'; }),
      orgDocument(baseline)],
    ['input-not-permitted', baseline, orgDocument(baseline, { inputs: {} })],
    ['scope', baseline, orgDocument(baseline, { scopes: ['user'] })],
    ['selection-not-admitted', baseline, { ...orgDocument(baseline), selections: [{ ...orgDocument(baseline).selections[0], selectionId: 'another-entry' }] }]
  ];
  for (const [reason, policy, document] of cases) {
    const target = project(); stub(orgRoutes({ bytes: bytesOf(document) }));
    const result = await prepare(request(target, policy), { logging: 'off' });
    assert.equal(result.status, 'blocked', reason);
    assert.equal(result.prepared, undefined, reason);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.every(item => item.code === 'AUTHORITY_DENIED'), reason);
    assert.ok(result.diagnostics.some(item => item.reason === reason), `${reason}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(existsSync(join(target, 'TEAM.md')), false);
  }
});

test('unrelated organization entry changes still admit the selection', async () => {
  const policy = enterprisePolicy(); const document = orgDocument(policy);
  document.selections.push({ selectionId: 'unrelated', recipeIdentity: `sha256:${'1'.repeat(64)}`, scopes: ['user'], inputs: {} });
  document.metadata = { note: 'unrelated change' };
  stub(orgRoutes({ bytes: bytesOf(document) }));
  const result = await prepare(request(project(), policy), { logging: 'off' });
  assert.equal(result.status, 'ready', JSON.stringify(result.diagnostics));
});

test('invalid organization bytes are INPUT_INVALID with no handle', async () => {
  const cases = [Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('{'), bytesOf({ schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'no-selections' })];
  for (const bytes of cases) {
    stub(orgRoutes({ bytes }));
    const result = await prepare(request(project()), { logging: 'off' });
    assert.equal(result.status, 'invalid');
    assert.equal(result.prepared, undefined);
    assert.equal(result.diagnostics[0].code, 'INPUT_INVALID');
  }
});

test('organization source is required for Enterprise, rejected for Vibe, and validated', async () => {
  const calls = stub(orgRoutes());
  const missing = await prepare({ useCase: 'policy', policy: enterprisePolicy(), target: { project: project() } }, { logging: 'off' });
  assert.equal(missing.status, 'invalid');
  assert.deepEqual([missing.diagnostics[0].code, missing.diagnostics[0].reason], ['INPUT_INVALID', 'organization-source-required']);
  const vibe = enterprisePolicy(document => { document.mode = 'vibe'; delete document.selections[0].organizationSelectionId; });
  const rejected = await prepare(request(project(), vibe), { logging: 'off' });
  assert.equal(rejected.status, 'invalid');
  assert.deepEqual([rejected.diagnostics[0].code, rejected.diagnostics[0].reason], ['INPUT_INVALID', 'organization-source-vibe']);
  const malformed = await prepare(request(project(), enterprisePolicy(), { provider: 'github' }), { logging: 'off' });
  assert.equal(malformed.status, 'invalid');
  assert.equal(malformed.diagnostics[0].reason, 'source-invalid');
  for (const authentication of [{ kind: 'bearer', token: '' }, { kind: 'bearer', token: 'a\nb' }, { kind: 'basic' }, { kind: 'none', token: 'x' }]) {
    const bad = await prepare(request(project()), { authentication });
    assert.equal(bad.status, 'invalid');
  }
  assert.equal(calls.length, 0);
});

test('a cancelled organization read cancels Prepare and Apply before effects', async () => {
  const target = project(); stub(orgRoutes());
  const controller = new AbortController(); controller.abort();
  assert.equal((await prepare(request(target), { signal: controller.signal })).status, 'cancelled');
  const prepared = await prepare(request(target), { logging: 'off' });
  const live = new AbortController();
  globalThis.fetch = async () => { live.abort(); throw new TypeError('aborted'); };
  const result = await apply(prepared.prepared, authorize(prepared), { signal: live.signal, logging: 'off' });
  assert.equal(result.completion, 'cancelled');
  assert.equal(result.diagnostics.at(-1).code, 'CANCELLED');
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
});

test('Harness repair never consults the organization and rejects an organization source', async () => {
  const calls = stub({ [`/repos/example-org/org-policy/git/commits/${COMMIT}`]: 'network-error' });
  const failing = await prepare(request(project()), { logging: 'off' });
  assert.equal(failing.status, 'blocked');
  assert.equal(failing.diagnostics[0].reason, 'network-failed');
  const before = calls.length;
  const caFile = fileURLToPath(new URL('./fixtures/root-a.pem', import.meta.url));
  const repairRequest = { useCase: 'repair', repairs: [{ id: 'node-npm-ca', targets: ['node'], inputs: { caFile } }] };
  const repair = await prepare(repairRequest, { logging: 'off' });
  assert.ok(['ready', 'partial'].includes(repair.status), JSON.stringify(repair.diagnostics));
  assert.ok(repair.prepared);
  const smuggled = await prepare({ ...repairRequest, organizationSource: orgSource() }, { logging: 'off' });
  assert.equal(smuggled.status, 'invalid');
  assert.equal(smuggled.prepared, undefined);
  assert.equal(calls.length, before, 'repair must not read any organization source');
});

test('an inline recipe labeled Harness gets no exemption from Enterprise admission', async () => {
  const policy = enterprisePolicy(document => {
    const recipe = document.selections[0].recipe.inline;
    recipe.id = 'harness-node-npm-ca'; recipe.description = 'Harness repair of the Node trust store';
    document.metadata = { harness: true, origin: '@aihq/core/harness' };
  });
  const document = orgDocument(policy); document.selections[0].selectionId = 'unrelated';
  stub(orgRoutes({ bytes: bytesOf(document) }));
  const result = await prepare(request(project(), policy), { logging: 'off' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.prepared, undefined);
  assert.equal(result.diagnostics[0].code, 'AUTHORITY_DENIED');
  assert.equal(result.diagnostics[0].reason, 'selection-not-admitted');
});

test('explicit replace needs the organization lifecycle grant', async () => {
  const policy = enterprisePolicy(); const old = Buffer.from('previous team guidance\n');
  const resolutions = target => [{ selectionId: 'guidance', operationId: 'write', choice: 'replace', observedSha256: sha(old) }];
  for (const [granted, expected] of [[false, 'blocked'], [true, 'ready']]) {
    const target = project(); writeFileSync(join(target, 'TEAM.md'), old);
    stub(orgRoutes({ bytes: bytesOf(orgDocument(policy, { lifecycle: { replace: granted } })) }));
    const result = await prepare(request(target, policy, orgSource(), { resolutions: resolutions(target) }), { logging: 'off' });
    assert.equal(result.status, expected, JSON.stringify(result.diagnostics));
    if (!granted) {
      assert.equal(result.prepared, undefined);
      assert.deepEqual([result.diagnostics[0].code, result.diagnostics[0].reason, result.diagnostics[0].path],
        ['AUTHORITY_DENIED', 'lifecycle-replace', '/selections/0']);
    } else {
      const applied = await apply(result.prepared, authorize(result), { logging: 'off' });
      assert.equal(applied.completion, 'complete', JSON.stringify(applied));
      assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), "Read the project's contribution guide.\n");
    }
  }
});

test('managed removal needs an organization entry with lifecycle.remove', async () => {
  const policy = enterprisePolicy(); const identity = recipeIdentity(policy.selections[0].recipe.inline);
  const target = project();
  stub(orgRoutes());
  const first = await prepare(request(target, policy), { logging: 'off' });
  assert.equal((await apply(first.prepared, authorize(first), { logging: 'off' })).completion, 'complete');
  const removal = { schema: policy.schema, mode: 'enterprise', selections: [], removals: [{ managementId: 'team-guidance', scope: 'project' }] };
  const denied = await prepare(request(target, removal), { logging: 'off' });
  assert.equal(denied.status, 'blocked', JSON.stringify(denied.diagnostics));
  assert.equal(denied.prepared, undefined);
  assert.deepEqual([denied.diagnostics[0].code, denied.diagnostics[0].reason, denied.diagnostics[0].path],
    ['AUTHORITY_DENIED', 'lifecycle-remove', '/removals/0']);
  assert.equal(existsSync(join(target, 'TEAM.md')), true);
  const document = orgDocument(policy, { lifecycle: { remove: true } }); assert.equal(document.selections[0].recipeIdentity, identity);
  stub(orgRoutes({ bytes: bytesOf(document) }));
  const permitted = await prepare(request(target, removal), { logging: 'off' });
  assert.equal(permitted.status, 'ready', JSON.stringify(permitted.diagnostics));
  const removed = await apply(permitted.prepared, authorize(permitted), { logging: 'off' });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
});
