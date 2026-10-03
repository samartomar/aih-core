// Test-only fake GitHub REST responses for the organization-policy reader.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../dist/core/internal/canonical.js';
import { policy } from '../fixture.mjs';

export const COMMIT = 'a'.repeat(40);
export const COMMIT2 = 'b'.repeat(40);
export const TOKEN = 'ghp_fixture-secret-token-0123456789';
export const SELECTION_ID = 'project-guidance';
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const gitBlobSha = bytes => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)])).digest('hex');
const treeSha = index => String(index).padStart(40, '0');

export const orgSource = (revision = { kind: 'commit', value: COMMIT }) => ({
  provider: 'github', repository: { owner: 'Example-Org', name: 'Org-Policy' }, path: 'policy/org.json', revision });

/** Same rule the engine applies to a captured recipe. */
export function recipeIdentity(recipe) {
  const materials = recipe.materials.map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); // code-unit order, as Core
  return `sha256:${digest({ schema: 'urn:aihq:core:recipe-identity:1.0.0', recipeSha256: digest(recipe), materials })}`;
}

export function enterprisePolicy(mutate) {
  const document = policy(); document.mode = 'enterprise';
  document.selections[0].organizationSelectionId = SELECTION_ID;
  mutate?.(document);
  return document;
}

export function orgDocument(document = enterprisePolicy(), overrides = {}) {
  const selection = document.selections[0];
  return { schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'example-org-policy', selections: [{
    selectionId: SELECTION_ID, recipeIdentity: recipeIdentity(selection.recipe.inline), scopes: ['project'],
    inputs: { text: { allowDeclared: true } }, ...overrides }] };
}

/** JSON-serializable route table: pathname -> { status, body, headers }. */
export function orgRoutes({ bytes = Buffer.from(JSON.stringify(orgDocument())), commit = COMMIT, branch } = {}) {
  const blob = gitBlobSha(bytes); const base = '/repos/example-org/org-policy/git';
  const routes = {
    [`${base}/commits/${commit}`]: { status: 200, body: { sha: commit, tree: { sha: treeSha(1) } } },
    [`${base}/trees/${treeSha(1)}`]: { status: 200, body: { sha: treeSha(1), truncated: false,
      tree: [{ path: 'policy', mode: '040000', type: 'tree', sha: treeSha(2) }] } },
    [`${base}/trees/${treeSha(2)}`]: { status: 200, body: { sha: treeSha(2), truncated: false,
      tree: [{ path: 'org.json', mode: '100644', type: 'blob', sha: blob, size: bytes.length }] } },
    [`${base}/blobs/${blob}`]: { status: 200, body: { sha: blob, size: bytes.length, encoding: 'base64',
      content: Buffer.from(bytes).toString('base64') } }
  };
  if (branch) routes[`${base}/ref/heads/${branch}`] = { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: commit, type: 'commit' } } };
  return routes;
}

/** The first request (the commit read) fails as a private/public access error would. */
export function failingRoutes(status, headers = {}) {
  return { [`/repos/example-org/org-policy/git/commits/${COMMIT}`]: { status, body: { message: 'denied' }, headers } };
}

export function respond(route) {
  if (route === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  return new Response(JSON.stringify(route.body), { status: route.status,
    headers: { 'content-type': 'application/json', ...(route.headers ?? {}) } });
}

/** Fake fetch over a mutable route table; `calls` records path and authorization header. */
export function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    calls.push({ pathname, authorization: init.headers?.authorization });
    const route = routes[pathname];
    if (route === 'network-error') throw new TypeError('fetch failed');
    return respond(route);
  };
}
