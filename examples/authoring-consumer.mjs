// Independent author: public package imports only. All targets belong to this proof.
// GitHub REST is a deterministic transport fixture, not real organization acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepare, apply } from '@aihq/core';
import { deriveRecipeIdentity, previewOrganizationAdmission, contractSupport } from '@aihq/core/contracts';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalFetch = globalThis.fetch;
const commit = 'a'.repeat(40), tree = '1'.repeat(40);
const organizationSource = { provider: 'github', repository: { owner: 'Example-Org', name: 'Org-Policy' },
  path: 'org.json', revision: { kind: 'commit', value: commit } };
let currentOrganization;
// Every fresh reader call sees the independently supplied current document.
globalThis.fetch = async url => {
  const bytes = Buffer.from(JSON.stringify(currentOrganization));
  const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  const prefix = '/repos/example-org/org-policy/git';
  const routes = {
    [`${prefix}/commits/${commit}`]: { sha: commit, tree: { sha: tree } },
    [`${prefix}/trees/${tree}`]: { sha: tree, truncated: false,
      tree: [{ path: 'org.json', mode: '100644', type: 'blob', sha: blob, size: bytes.length }] },
    [`${prefix}/blobs/${blob}`]: { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }
  };
  const body = routes[new URL(String(url)).pathname];
  assert.ok(body, `Unexpected transport request ${url}`);
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const cases = [];
try {
  for (const [index, name] of ['team-note', 'independent-guide'].entries()) {
    const project = join(process.cwd(), `${name}-target`), source = join(process.cwd(), `${name}-source`);
    mkdirSync(project); mkdirSync(source);
    const payload = Buffer.from(`${name}: ordinary supplied material\n`);
    const material = { id: 'note', path: 'note.txt', sha256: sha(payload), byteLength: payload.length };
    writeFileSync(join(source, material.path), payload);
    const recipe = { schema: 'urn:aihq:core:recipe:1.3.0', id: name, description: 'Author supplied content',
      inputs: { enabled: { type: 'boolean', required: true }, title: { type: 'string', required: true } },
      materials: index ? [{ id: material.id, sha256: material.sha256, byteLength: material.byteLength }] :
        [{ ...material, source: { kind: 'local', input: 'content' } }],
      targets: ['project'], prerequisites: [], checks: [], operations: [
        { id: 'write', purpose: 'Install note', kind: 'file.write', scope: 'project',
          target: { root: 'project', segments: [{ literal: 'NOTE.md' }] }, material: 'note', requires: [], checks: [] },
        { id: 'configure', purpose: 'Configure note', kind: 'config.entries', scope: 'project',
          target: { root: 'project', segments: [{ literal: 'settings.json' }] }, format: 'json',
          entries: ['enabled', 'title'].map(input => ({ path: [input], action: 'set', value: { input } })), requires: [], checks: [] }
      ] };
    const recipeBytes = Buffer.from(JSON.stringify(recipe, null, 2));
    writeFileSync(join(source, 'recipe.json'), recipeBytes);
    const reference = { source: { kind: 'local', input: 'content' }, path: 'recipe.json',
      sha256: sha(recipeBytes), byteLength: recipeBytes.length, materials: [material] };
    const identity = await deriveRecipeIdentity(index ? { recipeBytes, reference } : { recipe });
    assert.equal(identity.status, 'ok', JSON.stringify(identity));
    const selection = { id: name, managementId: name, organizationSelectionId: name, scope: 'project',
      configuration: { enabled: false, title: `${name} title` }, requires: [], recipe: index ? { reference } : { inline: recipe } };
    const policy = { schema: 'urn:aihq:core:execution-policy:1.3.0', mode: 'enterprise', selections: [selection],
      metadata: { 'consumer.review': { approved: true, recipeIdentity: identity.value.recipeIdentity } } };
    const organization = { schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'team', selections: [{
      selectionId: name, recipeIdentity: identity.value.recipeIdentity, scopes: ['project'],
      inputs: { enabled: { fixed: false }, title: { allowDeclared: true } }
    }] };
    const previewSelection = { id: name, organizationSelectionId: name, scope: selection.scope,
      recipeIdentity: identity.value.recipeIdentity, inputs: recipe.inputs, configuration: selection.configuration, privateInputs: [] };
    const preview = org => previewOrganizationAdmission({ organization: org, selections: [previewSelection], lifecycle: [] });
    const request = { useCase: 'policy', policy, target: { project }, organizationSource };
    const controls = { logging: 'off', materialRoots: { content: source } };
    const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
    const deniedOrganization = { ...organization, selections: [] };
    assert.equal(preview(deniedOrganization).value.admitted, false);
    currentOrganization = deniedOrganization;
    const denied = await prepare(request, controls);
    assert.equal(denied.status, 'blocked');
    assert.ok(denied.diagnostics.some(d => d.reason === 'selection-not-admitted'));
    assert.equal(existsSync(join(project, 'NOTE.md')), false);
    currentOrganization = organization;
    assert.equal(preview(organization).value.admitted, true);
    const prepared = await prepare(request, controls);
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    const serialized = await apply(JSON.parse(JSON.stringify(prepared.review)), approve(prepared), controls);
    assert.equal(serialized.completion, 'rejected');
    currentOrganization = deniedOrganization;
    const stale = await apply(prepared.prepared, approve(prepared), controls);
    assert.equal(stale.completion, 'rejected');
    assert.ok(stale.diagnostics.some(d => d.code === 'REVIEW_STALE'));
    assert.equal(existsSync(join(project, 'NOTE.md')), false);
    currentOrganization = organization;
    const fresh = await prepare(request, controls);
    assert.equal(fresh.status, 'ready');
    const applied = await apply(fresh.prepared, approve(fresh), controls);
    assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
    assert.deepEqual(readFileSync(join(project, 'NOTE.md')), payload);
    assert.deepEqual(JSON.parse(readFileSync(join(project, 'settings.json'))), selection.configuration);
    cases.push({ name, variant: index ? 'referenced' : 'inline', identity: identity.value,
      admitted: true, denied: true, changedAuthorityRefused: true, serializedReviewRefused: true, applied: true });
  }
} finally { globalThis.fetch = originalFetch; }
process.stdout.write(JSON.stringify({ package: contractSupport.package, transport: 'fixture-github-rest', cases }) + '\n');
