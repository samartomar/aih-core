// Enterprise Prepare reads the organization's authority before any material capture, including the Catalog release a
// recipe-less selection is rendered from: a denied or unavailable organization source leaves the policy's archive URL
// unfetched and its local material roots unread. Real Catalog 1.7.0 items, vendored with their published bytes.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../dist/core/index.js';
import { validatePolicy } from '../dist/core/contracts.js';
import { toolBindings } from '../dist/harness/contracts.mjs';
import { failingRoutes, fakeFetch, orgRoutes, orgSource } from './fixtures/github-org.mjs';
import { catalogRoot, itemOf } from './real-catalog-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-recipeless-authority-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const originalFetch = globalThis.fetch;
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ARCHIVE = 'https://catalog.example.test/aihq-catalog-0.1.0.tgz';
const release = (framework, source) => {
  const path = `release-${framework}.content.json`, bytes = readFileSync(join(catalogRoot, path));
  return { framework, source, path, sha256: sha256(bytes), byteLength: bytes.length };
};
const selection = (id, itemId) => {
  const item = itemOf(itemId);
  return { id, managementId: id, scope: 'project', configuration: {}, requires: [], organizationSelectionId: id,
    item: { framework: itemId.split('.')[0], itemId, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 },
    tool: 'claude', name: item.name, kind: item.kind, origins: [{ reasonIncluded: 'chosen' }],
    bindingDigest: toolBindings.find(binding => binding.tool === 'claude').digest };
};
/** One release named only by an archive URL, one by a local material root that must not be read either. */
const policy = () => ({ schema: 'urn:aihq:core:execution-policy:1.6.0', mode: 'enterprise',
  catalogReleases: [release('extensions', { kind: 'local', input: 'catalog' }),
    release('superpowers', { kind: 'archive', url: ARCHIVE, sha256: 'd'.repeat(64), byteLength: 4096 })],
  selections: [selection('skill', 'superpowers.skill.verification-before-completion'), selection('guard', 'extensions.hook.git-guard')] });

test('an unavailable organization source or invalid document is reported before any recipe-less release is fetched or read', async () => {
  assert.equal(validatePolicy(policy()).valid, true, JSON.stringify(validatePolicy(policy()).diagnostics));
  // A local root that does not exist, so any read of it would be reported as unavailable material; and the real one,
  // so a renderer that read it would go on to fetch the archive release.
  const roots = { absent: join(scratch, 'no-catalog-here'), present: catalogRoot };
  const project = () => { const folder = mkdtempSync(join(scratch, 'project-')); return realpathSync(folder); };
  const cases = [
    ['GitHub denies access', orgSource(), failingRoutes(403), 'AUTHORITY_UNAVAILABLE'],
    ['the local file is missing', { provider: 'local', path: join(scratch, 'missing-org.json') }, {}, 'AUTHORITY_UNAVAILABLE'],
    ['the document is invalid', orgSource(), orgRoutes({ bytes: Buffer.from('{"schema":"urn:aihq:core:organization-policy:1.0.0"}') }), 'INPUT_INVALID']
  ];
  for (const [label, organizationSource, routes, code] of cases) for (const [rootLabel, root] of Object.entries(roots).reverse()) {
    const controls = { logging: 'off', materialRoots: { catalog: root } };
    const calls = [];
    const inner = fakeFetch(routes, calls);
    const fetched = [];
    globalThis.fetch = (url, init) => { fetched.push(String(url)); return inner(url, init); };
    const result = await prepare({ useCase: 'policy', policy: policy(), target: { project: project() }, organizationSource }, controls);
    const at = `${label}, ${rootLabel} root`;
    assert.equal(result.prepared, undefined, at);
    assert.deepEqual(fetched.filter(url => !url.startsWith('https://api.github.com/')), [], `${at}: the archive release is never fetched`);
    assert.ok(result.diagnostics.length > 0 && result.diagnostics.every(item => item.code === code),
      `${at}: only the authority failure, no material read: ${JSON.stringify(result.diagnostics)}`);
  }
});
