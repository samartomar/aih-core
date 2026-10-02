// Acceptance-only organization source. It stands in for the administrator's
// published GitHub repository by answering the git REST routes Core's reader
// requests. It is copied only into the acceptance consumer, never the example.
import { createHash } from 'node:crypto';

const COMMIT = 'a'.repeat(40);
const gitBlobSha = bytes => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
const treeSha = index => String(index).padStart(40, '0');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Serves `document` as policy/org.json at one commit of example-org/org-policy
// by replacing globalThis.fetch until restore() runs. `calls` records requests.
export function serveOrganization(document, { commit = COMMIT } = {}) {
  const bytes = Buffer.from(JSON.stringify(document));
  const blob = gitBlobSha(bytes);
  const base = '/repos/example-org/org-policy/git';
  const routes = {
    [`${base}/commits/${commit}`]: { sha: commit, tree: { sha: treeSha(1) } },
    [`${base}/trees/${treeSha(1)}`]: { sha: treeSha(1), truncated: false,
      tree: [{ path: 'policy', mode: '040000', type: 'tree', sha: treeSha(2) }] },
    [`${base}/trees/${treeSha(2)}`]: { sha: treeSha(2), truncated: false,
      tree: [{ path: 'org.json', mode: '100644', type: 'blob', sha: blob, size: bytes.length }] },
    [`${base}/blobs/${blob}`]: { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') },
  };
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    const { origin, pathname } = new URL(String(url));
    if (origin !== 'https://api.github.com') throw new Error(`Unexpected organization source request to ${origin}`);
    calls.push(pathname);
    return Object.hasOwn(routes, pathname) ? json(200, routes[pathname]) : json(404, { message: 'Not Found' });
  };
  return {
    source: { provider: 'github', repository: { owner: 'Example-Org', name: 'Org-Policy' },
      path: 'policy/org.json', revision: { kind: 'commit', value: commit } },
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}
