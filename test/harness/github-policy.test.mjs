import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readGitHubPolicy, readGitHubPolicyWith } from '../../dist/harness/github-policy.mjs';
import * as runtimeModule from '../../dist/harness/runtime.mjs';

const TOKEN = 'top-secret-token';
const COMMIT = 'a'.repeat(40);
const COMMIT2 = 'b'.repeat(40);
const content = new TextEncoder().encode('{"schema":"urn:example:policy"}\n');
const gitSha = (kind, bytes) =>
  createHash('sha1').update(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), Buffer.from(bytes)])).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const BLOB = gitSha('blob', content);
const treeSha = index => String(index).padStart(40, '0');
const tagSha = index => String(index).padStart(40, 'f');

const source = revision => ({
  provider: 'github',
  repository: { owner: 'Example-Org', name: 'Policy.Repo' },
  path: 'policies/dev.json',
  revision
});
const commitSource = source({ kind: 'commit', value: COMMIT });
const normalized = revision => ({
  provider: 'github', repository: { owner: 'example-org', name: 'policy.repo' },
  path: 'policies/dev.json', revision
});

const jsonResponse = (body, status = 200, headers = {}) =>
  () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const rawResponse = (body, status = 200, headers = {}) => () => new Response(body, { status, headers });

function commitRoutes({ commit = COMMIT, bytes = content, blob = BLOB, finalEntry, rootEntries, rootSha = treeSha(1) } = {}) {
  const routes = new Map();
  routes.set(`/repos/example-org/policy.repo/git/commits/${commit}`,
    jsonResponse({ sha: commit, tree: { sha: rootSha } }));
  routes.set(`/repos/example-org/policy.repo/git/trees/${rootSha}`, jsonResponse({
    sha: rootSha, truncated: false,
    tree: rootEntries ?? [{ path: 'policies', mode: '040000', type: 'tree', sha: treeSha(2) }]
  }));
  if (rootEntries === undefined) {
    routes.set(`/repos/example-org/policy.repo/git/trees/${treeSha(2)}`, jsonResponse({
      sha: treeSha(2), truncated: false,
      tree: [finalEntry ?? { path: 'dev.json', mode: '100644', type: 'blob', sha: blob, size: bytes.length }]
    }));
    routes.set(`/repos/example-org/policy.repo/git/blobs/${blob}`, jsonResponse({
      sha: blob, size: bytes.length, encoding: 'base64', content: Buffer.from(bytes).toString('base64')
    }));
  }
  return routes;
}

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.get(new URL(String(url)).pathname);
    if (route === undefined) return jsonResponse({ message: 'Not Found' }, 404)();
    return route(String(url), init);
  };
}

const read = (routes, src = commitSource, controls, deps = {}, calls = []) =>
  readGitHubPolicyWith({ fetch: fakeFetch(routes, calls), ...deps }, src, controls);

test('commit revision reads the exact blob with normalized source, digests and accounting', async () => {
  const result = await read(commitRoutes());
  assert.equal(result.status, 'read', JSON.stringify(result));
  assert.deepEqual(result.source, normalized({ kind: 'commit', value: COMMIT }));
  assert.equal(result.resolvedCommit, COMMIT);
  assert.equal(result.blobId, BLOB);
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(content));
  assert.notEqual(result.bytes, content);
  assert.equal(result.contentDigest, `sha256:${sha256(content)}`);
  assert.equal(result.accounting.requests, 4);
  assert.equal(result.accounting.responseBytes > 0, true);
  assert.match(result.retrievedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(result.helper.id, 'github-policy-reader');
  assert.equal(typeof result.helper.package.name, 'string');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.source), true);
  assert.equal(Object.isFrozen(result.source.repository), true);
});

test('injected now drives retrievedAt', async () => {
  const result = await read(commitRoutes(), commitSource, undefined, { now: () => Date.UTC(2026, 8, 30, 12, 30, 0) });
  assert.equal(result.retrievedAt, '2026-09-30T12:30:00.000Z');
});

test('branch revision resolves through the heads ref and encodes ref segments', async () => {
  const calls = [];
  const routes = commitRoutes();
  routes.set('/repos/example-org/policy.repo/git/ref/heads/feature/%40v2',
    jsonResponse({ ref: 'refs/heads/feature/@v2', object: { sha: COMMIT, type: 'commit' } }));
  const result = await read(routes, source({ kind: 'branch', value: 'feature/@v2' }), undefined, {}, calls);
  assert.equal(result.status, 'read', JSON.stringify(result));
  assert.equal(result.resolvedCommit, COMMIT);
  assert.equal(result.accounting.requests, 5);
  assert.equal(new URL(calls[0].url).pathname, '/repos/example-org/policy.repo/git/ref/heads/feature/%40v2');
});

test('a branch ref pointing at a non-commit object is response-invalid', async () => {
  const routes = commitRoutes();
  routes.set('/repos/example-org/policy.repo/git/ref/heads/main',
    jsonResponse({ ref: 'refs/heads/main', object: { sha: tagSha(1), type: 'tag' } }));
  const result = await read(routes, source({ kind: 'branch', value: 'main' }));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'response-invalid');
});

test('lightweight tag resolves directly; annotated tags peel to a commit', async () => {
  const light = commitRoutes();
  light.set('/repos/example-org/policy.repo/git/ref/tags/v1',
    jsonResponse({ ref: 'refs/tags/v1', object: { sha: COMMIT, type: 'commit' } }));
  const lightResult = await read(light, source({ kind: 'tag', value: 'v1' }));
  assert.equal(lightResult.status, 'read', JSON.stringify(lightResult));
  assert.equal(lightResult.accounting.requests, 5);

  const annotated = commitRoutes();
  annotated.set('/repos/example-org/policy.repo/git/ref/tags/v2',
    jsonResponse({ ref: 'refs/tags/v2', object: { sha: tagSha(1), type: 'tag' } }));
  annotated.set(`/repos/example-org/policy.repo/git/tags/${tagSha(1)}`,
    jsonResponse({ sha: tagSha(1), object: { sha: COMMIT, type: 'commit' } }));
  const annotatedResult = await read(annotated, source({ kind: 'tag', value: 'v2' }));
  assert.equal(annotatedResult.status, 'read', JSON.stringify(annotatedResult));
  assert.equal(annotatedResult.resolvedCommit, COMMIT);
  assert.equal(annotatedResult.accounting.requests, 6);
});

test('an annotated-tag peel cycle is response-invalid', async () => {
  const routes = commitRoutes();
  routes.set('/repos/example-org/policy.repo/git/ref/tags/loop',
    jsonResponse({ ref: 'refs/tags/loop', object: { sha: tagSha(1), type: 'tag' } }));
  routes.set(`/repos/example-org/policy.repo/git/tags/${tagSha(1)}`,
    jsonResponse({ sha: tagSha(1), object: { sha: tagSha(2), type: 'tag' } }));
  routes.set(`/repos/example-org/policy.repo/git/tags/${tagSha(2)}`,
    jsonResponse({ sha: tagSha(2), object: { sha: tagSha(1), type: 'tag' } }));
  const result = await read(routes, source({ kind: 'tag', value: 'loop' }));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'response-invalid');
});

test('peeling beyond eight annotated tags is response-invalid', async () => {
  const calls = [];
  const routes = commitRoutes();
  routes.set('/repos/example-org/policy.repo/git/ref/tags/deep',
    jsonResponse({ ref: 'refs/tags/deep', object: { sha: tagSha(1), type: 'tag' } }));
  for (let index = 1; index <= 9; index += 1)
    routes.set(`/repos/example-org/policy.repo/git/tags/${tagSha(index)}`,
      jsonResponse({ sha: tagSha(index), object: { sha: tagSha(index + 1), type: 'tag' } }));
  const result = await read(routes, source({ kind: 'tag', value: 'deep' }), undefined, {}, calls);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'response-invalid');
  assert.equal(result.accounting.requests, 9);
});

test('ref movement with identical bytes changes resolvedCommit but not contentDigest', async () => {
  const first = commitRoutes();
  first.set('/repos/example-org/policy.repo/git/ref/heads/main',
    jsonResponse({ ref: 'refs/heads/main', object: { sha: COMMIT, type: 'commit' } }));
  const second = commitRoutes({ commit: COMMIT2 });
  second.set('/repos/example-org/policy.repo/git/ref/heads/main',
    jsonResponse({ ref: 'refs/heads/main', object: { sha: COMMIT2, type: 'commit' } }));
  const before = await read(first, source({ kind: 'branch', value: 'main' }));
  const after = await read(second, source({ kind: 'branch', value: 'main' }));
  assert.equal(before.status, 'read');
  assert.equal(after.status, 'read');
  assert.equal(before.resolvedCommit, COMMIT);
  assert.equal(after.resolvedCommit, COMMIT2);
  assert.equal(before.contentDigest, after.contentDigest);
});

test('bearer authentication is sent only to the fixed api.github.com origin', async () => {
  const calls = [];
  const result = await read(commitRoutes(), commitSource,
    { authentication: { kind: 'bearer', token: TOKEN } }, {}, calls);
  assert.equal(result.status, 'read', JSON.stringify(result));
  assert.equal(calls.length > 0, true);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://api.github.com');
    assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.init.headers.accept, 'application/vnd.github+json');
    assert.equal(call.init.headers['x-github-api-version'], '2022-11-28');
    assert.equal(typeof call.init.headers['user-agent'], 'string');
    assert.equal(call.init.redirect, 'manual');
  }
});

test('unauthenticated and kind:none reads send no authorization header', async () => {
  for (const controls of [undefined, {}, { authentication: { kind: 'none' } }]) {
    const calls = [];
    const result = await read(commitRoutes(), commitSource, controls, {}, calls);
    assert.equal(result.status, 'read', JSON.stringify(result));
    for (const call of calls) assert.equal('authorization' in call.init.headers, false);
  }
});

test('HTTP status mapping covers 401, 403, rate limits and 404', async () => {
  const fixedNow = () => 1_800_000_000_000;
  const cases = [
    ['401', jsonResponse({ message: 'Bad credentials' }, 401), 'authentication-required-or-denied', undefined],
    ['403 without rate headers', jsonResponse({ message: 'Forbidden' }, 403), 'authentication-required-or-denied', undefined],
    ['403 with exhausted rate limit', jsonResponse({ message: 'API rate limit exceeded' }, 403,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000060' }), 'rate-limited', 60],
    ['429 with retry-after', jsonResponse({ message: 'Too many requests' }, 429, { 'retry-after': '17' }), 'rate-limited', 17],
    ['404', jsonResponse({ message: 'Not Found' }, 404), 'source-missing-or-inaccessible', undefined]
  ];
  for (const [label, denial, reason, retryAfterSeconds] of cases) {
    const routes = commitRoutes();
    routes.set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, denial);
    const result = await read(routes, commitSource, undefined, { now: fixedNow });
    assert.equal(result.status, 'unavailable', label);
    assert.equal(result.code, 'AUTHORITY_UNAVAILABLE', label);
    assert.equal(result.reason, reason, label);
    assert.equal(result.retryAfterSeconds, retryAfterSeconds, label);
    assert.deepEqual(result.source, normalized({ kind: 'commit', value: COMMIT }), label);
  }
});

test('file admission rejects symlink, submodule, directory and non-tree intermediates', async () => {
  const cases = [
    ['symlink', { path: 'dev.json', mode: '120000', type: 'blob', sha: BLOB }],
    ['submodule', { path: 'dev.json', mode: '160000', type: 'commit', sha: BLOB }],
    ['directory', { path: 'dev.json', mode: '040000', type: 'tree', sha: treeSha(3) }],
    ['odd regular mode', { path: 'dev.json', mode: '100664', type: 'blob', sha: BLOB, size: content.length }]
  ];
  for (const [label, finalEntry] of cases) {
    const result = await read(commitRoutes({ finalEntry }));
    assert.equal(result.status, 'unavailable', label);
    assert.equal(result.reason, 'source-not-regular-file', label);
  }
  const intermediate = await read(commitRoutes({
    rootEntries: [{ path: 'policies', mode: '100644', type: 'blob', sha: BLOB, size: content.length }]
  }));
  assert.equal(intermediate.reason, 'source-not-regular-file');
});

test('truncated trees, duplicate names and malformed shapes are response-invalid; missing entries are source-missing', async () => {
  const truncated = await read(commitRoutes({
    rootEntries: undefined,
    rootSha: treeSha(9)
  }).set(`/repos/example-org/policy.repo/git/trees/${treeSha(9)}`,
    jsonResponse({ sha: treeSha(9), truncated: true, tree: [{ path: 'policies', mode: '040000', type: 'tree', sha: treeSha(2) }] })));
  assert.equal(truncated.reason, 'response-invalid');

  const duplicate = await read(commitRoutes({
    finalEntry: undefined,
    rootEntries: [
      { path: 'policies', mode: '040000', type: 'tree', sha: treeSha(2) },
      { path: 'policies', mode: '040000', type: 'tree', sha: treeSha(3) }
    ]
  }));
  assert.equal(duplicate.reason, 'response-invalid');

  const missing = await read(commitRoutes({
    rootEntries: [{ path: 'other', mode: '040000', type: 'tree', sha: treeSha(2) }]
  }));
  assert.equal(missing.reason, 'source-missing-or-inaccessible');

  const malformed = commitRoutes();
  malformed.set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, rawResponse('not json'));
  assert.equal((await read(malformed)).reason, 'response-invalid');

  const wrongShape = commitRoutes();
  wrongShape.set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, jsonResponse({ sha: COMMIT }));
  assert.equal((await read(wrongShape)).reason, 'response-invalid');

  const identity = commitRoutes();
  identity.set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`,
    jsonResponse({ sha: COMMIT2, tree: { sha: treeSha(1) } }));
  assert.equal((await read(identity)).reason, 'response-invalid');
});

test('blob identity, size and encoding mismatches are response-invalid', async () => {
  const withBlob = mutate => {
    const routes = commitRoutes();
    routes.set(`/repos/example-org/policy.repo/git/blobs/${BLOB}`, jsonResponse({
      sha: BLOB, size: content.length, encoding: 'base64',
      content: Buffer.from(content).toString('base64'), ...mutate
    }));
    return routes;
  };
  assert.equal((await read(withBlob({ sha: COMMIT }))).reason, 'response-invalid');
  assert.equal((await read(withBlob({ content: Buffer.from('changed').toString('base64'), size: 7 }))).reason, 'response-invalid');
  assert.equal((await read(withBlob({ encoding: 'utf-8' }))).reason, 'response-invalid');
  assert.equal((await read(withBlob({ content: '!!!not-base64!!!' }))).reason, 'response-invalid');
  assert.equal((await read(withBlob({ size: content.length + 1 }))).reason, 'response-invalid');
});

test('declared file size over 1,000,000 bytes is response-bytes before the blob fetch', async () => {
  const calls = [];
  const result = await read(commitRoutes({
    finalEntry: { path: 'dev.json', mode: '100644', type: 'blob', sha: BLOB, size: 1_000_001 }
  }), commitSource, undefined, {}, calls);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'response-bytes');
  assert.equal(calls.some(call => call.url.includes('/git/blobs/')), false);
});

test('streamed blob bytes over the file limit are response-bytes regardless of declared size', async () => {
  const oversized = new Uint8Array(1_000_001);
  const blob = gitSha('blob', oversized);
  const routes = commitRoutes({ bytes: oversized, blob, finalEntry: { path: 'dev.json', mode: '100644', type: 'blob', sha: blob, size: oversized.length } });
  const result = await read(routes);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'response-bytes');
});

test('metadata responses over 2 MiB and aggregate bytes over 8 MiB are response-bytes', async () => {
  const huge = commitRoutes();
  huge.set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, rawResponse('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.equal((await read(huge)).reason, 'response-bytes');

  // Five metadata responses just under 2 MiB each exceed the 8 MiB aggregate before the blob.
  const padEntries = count => Array.from({ length: count }, (_, index) =>
    ({ path: `pad-${index}`, mode: '100644', type: 'blob', sha: treeSha(7), size: 1 }));
  const routes = new Map();
  const segments = ['a', 'b', 'c'];
  routes.set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, jsonResponse({
    sha: COMMIT, tree: { sha: treeSha(1) }, padding: 'x'.repeat(1_800_000)
  }));
  for (const [index, segment] of segments.entries()) {
    const next = index + 1 < segments.length
      ? { path: segment, mode: '040000', type: 'tree', sha: treeSha(index + 2) }
      : { path: segment, mode: '040000', type: 'tree', sha: treeSha(5) };
    routes.set(`/repos/example-org/policy.repo/git/trees/${treeSha(index + 1)}`,
      jsonResponse({ sha: treeSha(index + 1), truncated: false, tree: [next, ...padEntries(18_500)] }));
  }
  routes.set(`/repos/example-org/policy.repo/git/trees/${treeSha(5)}`, jsonResponse({
    sha: treeSha(5), truncated: false,
    tree: [{ path: 'f.json', mode: '100644', type: 'blob', sha: BLOB, size: content.length }, ...padEntries(18_500)]
  }));
  routes.set(`/repos/example-org/policy.repo/git/blobs/${BLOB}`, jsonResponse({
    sha: BLOB, size: content.length, encoding: 'base64', content: Buffer.from(content).toString('base64')
  }));
  const result = await read(routes, { ...commitSource, path: 'a/b/c/f.json' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'response-bytes');
});

test('the deepest legal read stays within the 32-request bound and reports exact accounting', async () => {
  const routes = new Map();
  const segments = Array.from({ length: 15 }, (_, index) => `d${index}`);
  routes.set('/repos/example-org/policy.repo/git/ref/tags/deep',
    jsonResponse({ ref: 'refs/tags/deep', object: { sha: tagSha(1), type: 'tag' } }));
  for (let index = 1; index <= 7; index += 1)
    routes.set(`/repos/example-org/policy.repo/git/tags/${tagSha(index)}`,
      jsonResponse({ sha: tagSha(index), object: { sha: tagSha(index + 1), type: 'tag' } }));
  routes.set(`/repos/example-org/policy.repo/git/tags/${tagSha(8)}`,
    jsonResponse({ sha: tagSha(8), object: { sha: COMMIT, type: 'commit' } }));
  routes.set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`,
    jsonResponse({ sha: COMMIT, tree: { sha: treeSha(1) } }));
  for (const [index, segment] of segments.entries())
    routes.set(`/repos/example-org/policy.repo/git/trees/${treeSha(index + 1)}`, jsonResponse({
      sha: treeSha(index + 1), truncated: false,
      tree: [{ path: segment, mode: '040000', type: 'tree', sha: treeSha(index + 2) }]
    }));
  routes.set(`/repos/example-org/policy.repo/git/trees/${treeSha(16)}`, jsonResponse({
    sha: treeSha(16), truncated: false,
    tree: [{ path: 'f.json', mode: '100755', type: 'blob', sha: BLOB, size: content.length }]
  }));
  routes.set(`/repos/example-org/policy.repo/git/blobs/${BLOB}`, jsonResponse({
    sha: BLOB, size: content.length, encoding: 'base64', content: Buffer.from(content).toString('base64')
  }));
  const result = await read(routes, { ...commitSource, path: `${segments.join('/')}/f.json`, revision: { kind: 'tag', value: 'deep' } });
  assert.equal(result.status, 'read', JSON.stringify(result));
  assert.equal(result.accounting.requests, 27);
  assert.equal(result.accounting.requests <= 32, true);
});

test('exhausting the aggregate deadline between requests maps to deadline', async () => {
  let tick = 0;
  const monotonic = () => (tick += 1, tick <= 2 ? 0 : 61_000);
  const result = await read(commitRoutes(), commitSource, undefined, { monotonic });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'deadline');
});

test('a stalled request is cut by the per-request timeout clamped to the aggregate remainder', async () => {
  let tick = 0;
  const monotonic = () => (tick += 1, tick === 1 ? 0 : 59_999);
  const result = await readGitHubPolicyWith(
    { fetch: () => new Promise(() => {}), monotonic }, commitSource);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'deadline');
});

test('a network TypeError maps to network-failed', async () => {
  const result = await readGitHubPolicyWith(
    { fetch: () => Promise.reject(new TypeError('fetch failed')) }, commitSource);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'network-failed');
});

test('an already-aborted signal cancels before any request', async () => {
  const calls = [];
  const controller = new AbortController();
  controller.abort();
  const result = await read(commitRoutes(), commitSource, { signal: controller.signal }, {}, calls);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.code, 'CANCELLED');
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.accounting.requests, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(result.source, normalized({ kind: 'commit', value: COMMIT }));
});

test('an abort during a request maps to cancelled', async () => {
  const controller = new AbortController();
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
    queueMicrotask(() => controller.abort());
  });
  const result = await readGitHubPolicyWith({ fetch }, commitSource, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.code, 'CANCELLED');
});

test('redirects are rejected as response-invalid and never followed', async () => {
  const calls = [];
  const routes = commitRoutes();
  routes.set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`,
    () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/steal' } }));
  const result = await read(routes, commitSource, { authentication: { kind: 'bearer', token: TOKEN } }, {}, calls);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'response-invalid');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('invalid sources and controls reject as INPUT_INVALID without any request', async () => {
  const valid = commitSource;
  const sources = [
    ['null', null], ['array', []], ['class instance', new (class {})()],
    ['extra key', { ...valid, extra: 1 }], ['missing path', { provider: 'github', repository: valid.repository, revision: valid.revision }],
    ['wrong provider', { ...valid, provider: 'gitlab' }],
    ['repository extra key', { ...valid, repository: { ...valid.repository, extra: 1 } }],
    ['empty owner', { ...valid, repository: { owner: '', name: 'repo' } }],
    ['leading-dash owner', { ...valid, repository: { owner: '-owner', name: 'repo' } }],
    ['oversized owner', { ...valid, repository: { owner: 'a'.repeat(40), name: 'repo' } }],
    ['dot name', { ...valid, repository: { owner: 'o', name: '.' } }],
    ['dot-dot name', { ...valid, repository: { owner: 'o', name: '..' } }],
    ['spaced name', { ...valid, repository: { owner: 'o', name: 'has space' } }],
    ['unknown kind', { ...valid, revision: { kind: 'pr', value: 'main' } }],
    ['short commit', source({ kind: 'commit', value: 'abc' })],
    ['uppercase commit', source({ kind: 'commit', value: 'A'.repeat(40) })],
    ['empty branch', source({ kind: 'branch', value: '' })],
    ['leading dash ref', source({ kind: 'branch', value: '-x' })],
    ['dot-dot ref', source({ kind: 'branch', value: 'a..b' })],
    ['reflog ref', source({ kind: 'branch', value: 'a@{0}' })],
    ['space ref', source({ kind: 'branch', value: 'a b' })],
    ['tilde ref', source({ kind: 'branch', value: 'a~b' })],
    ['colon ref', source({ kind: 'tag', value: 'a:b' })],
    ['double slash ref', source({ kind: 'branch', value: 'a//b' })],
    ['leading slash ref', source({ kind: 'branch', value: '/a' })],
    ['trailing slash ref', source({ kind: 'branch', value: 'a/' })],
    ['lock segment ref', source({ kind: 'branch', value: 'a.lock/b' })],
    ['empty path', { ...valid, path: '' }],
    ['absolute path', { ...valid, path: '/etc/passwd' }],
    ['empty segment path', { ...valid, path: 'a//b' }],
    ['dot segment path', { ...valid, path: 'a/./b' }],
    ['dot-dot segment path', { ...valid, path: 'a/../b' }],
    ['backslash path', { ...valid, path: 'a\\b' }],
    ['control path', { ...valid, path: 'a\x01b' }],
    ['deep path', { ...valid, path: Array.from({ length: 17 }, (_, i) => `s${i}`).join('/') }],
    ['long path', { ...valid, path: `${'a'.repeat(4097)}` }],
    ['non-NFC path', { ...valid, path: 'é/dev.json' }]
  ];
  for (const [label, bad] of sources) {
    const calls = [];
    const result = await read(commitRoutes(), bad, undefined, {}, calls);
    assert.equal(result.status, 'invalid', label);
    assert.equal(result.code, 'INPUT_INVALID', label);
    assert.equal(result.reason, 'source-invalid', label);
    assert.equal('source' in result, false, label);
    assert.equal(calls.length, 0, label);
  }
  const controlCases = [
    ['unknown authentication', { authentication: { kind: 'basic' } }],
    ['bearer without token', { authentication: { kind: 'bearer' } }],
    ['empty token', { authentication: { kind: 'bearer', token: '' } }],
    ['control-character token', { authentication: { kind: 'bearer', token: 'a\nb' } }],
    ['authentication extra key', { authentication: { kind: 'bearer', token: 'x', extra: 1 } }],
    ['controls extra key', { retries: 1 }],
    ['plain-object signal', { signal: {} }]
  ];
  for (const [label, controls] of controlCases) {
    const calls = [];
    const result = await read(commitRoutes(), commitSource, controls, {}, calls);
    assert.equal(result.status, 'invalid', label);
    assert.equal(result.code, 'INPUT_INVALID', label);
    assert.equal(calls.length, 0, label);
  }
});

test('no result ever contains the bearer token', async () => {
  const controls = { authentication: { kind: 'bearer', token: TOKEN } };
  const scenarios = [
    ['success', commitRoutes()],
    ['401', commitRoutes().set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, jsonResponse({ message: 'no' }, 401))],
    ['404', commitRoutes().set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, jsonResponse({ message: 'no' }, 404))],
    ['429', commitRoutes().set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, jsonResponse({ message: 'no' }, 429, { 'retry-after': '5' }))],
    ['malformed', commitRoutes().set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, rawResponse('garbage'))],
    ['redirect', commitRoutes().set(`/repos/example-org/policy.repo/git/commits/${COMMIT}`, () => new Response(null, { status: 301, headers: { location: 'https://x.example' } }))]
  ];
  for (const [label, routes] of scenarios) {
    const result = await read(routes, commitSource, controls);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, label);
  }
  const network = await readGitHubPolicyWith(
    { fetch: () => Promise.reject(new TypeError('fetch failed')) }, commitSource, controls);
  assert.equal(JSON.stringify(network).includes(TOKEN), false, 'network-failed');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await read(commitRoutes(), commitSource, { ...controls, signal: controller.signal });
  assert.equal(JSON.stringify(cancelled).includes(TOKEN), false, 'cancelled');
});

test('readGitHubPolicy reads globalThis.fetch at call time', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch(commitRoutes());
  try {
    const result = await readGitHubPolicy(commitSource);
    assert.equal(result.status, 'read', JSON.stringify(result));
  } finally {
    globalThis.fetch = original;
  }
});

test('runtime.mjs exports readGitHubPolicy but not the readGitHubPolicyWith seam', () => {
  assert.equal(typeof runtimeModule.readGitHubPolicy, 'function');
  assert.equal('readGitHubPolicyWith' in runtimeModule, false);
});
