// Independent author: public package imports only. All targets belong to this proof.
// GitHub REST is a deterministic transport fixture, not real organization acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prepare, apply } from '@aihq/core';
import { deriveRecipeIdentity, previewOrganizationAdmission, previewOrganizationObligations, validateOrganizationTarget, contractSupport } from '@aihq/core/contracts';
import organizationSchema11 from '@aihq/core/schemas/organization-policy/1.1.0.json' with { type: 'json' };
import organizationTargetSchema from '@aihq/core/schemas/organization-target/1.0.0.json' with { type: 'json' };
import preparedSchema15 from '@aihq/core/schemas/prepared-work/1.5.0.json' with { type: 'json' };

const organizationTargetContract = 'urn:aihq:core:organization-target:1.0.0';
const preparedContract15 = 'urn:aihq:core:prepared-work:1.5.0';
assert.equal(organizationTargetSchema.$id, organizationTargetContract);
assert.equal(preparedSchema15.$id, preparedContract15);
assert.ok(contractSupport.contracts.some(contract => contract.id === organizationTargetContract && contract.role === 'accepts'));
assert.ok(contractSupport.contracts.some(contract => contract.id === preparedContract15 && contract.role === 'produces'));
assert.equal(validateOrganizationTarget({ schema: organizationTargetContract, client: 'unknown-client' }).valid, false);
assert.equal(validateOrganizationTarget({ schema: organizationTargetContract, client: 'codex', repository: 'Not A Repository' }).valid, false);

const organizationContract11 = 'urn:aihq:core:organization-policy:1.1.0';
assert.equal(organizationSchema11.$id, organizationContract11);
assert.ok(contractSupport.contracts.some(contract => contract.id === organizationContract11 && contract.role === 'accepts'));

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
let obligations, target;
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
    if (index === 0) {
      const entry = (selectionId, obligation, extra = {}) => ({ selectionId, obligation,
        recipeIdentity: identity.value.recipeIdentity, scopes: ['project'],
        inputs: organization.selections[0].inputs, ...extra });
      const prohibitedIdentity = `sha256:${sha('prohibited recipe')}`;
      const organization11 = { schema: organizationContract11, id: 'obligations', selections: [
        entry(name, 'permitted'), entry('recommended-note', 'recommended'), entry('required-note', 'required'),
        entry('prohibited-note', 'prohibited', { recipeIdentity: prohibitedIdentity }),
        entry('other-client', 'required', { clients: ['claude'] }),
        entry('repository-note', 'required', { repositories: ['github.com/example-org/app'] })
      ] };
      const previewTarget = { scope: 'project', client: 'codex' };
      const evaluate = selections => {
        const result = previewOrganizationObligations({ organization: organization11, selections, lifecycle: [], target: previewTarget });
        assert.equal(result.status, 'ok', JSON.stringify(result));
        assert.deepEqual(result.value.target, previewTarget);
        return result.value;
      };
      const missing = evaluate([previewSelection]);
      assert.deepEqual(missing.enforced, { admitted: true, diagnostics: [] });
      assert.deepEqual(missing.advisory, [{ selectionId: 'recommended-note',
        recipeIdentity: identity.value.recipeIdentity, applicability: 'applies', unknown: [],
        status: 'not-taken', selections: [] }]);
      assert.deepEqual(missing.fulfillment.map(({ selectionId, applicability, unknown, status, selections }) =>
        ({ selectionId, applicability, unknown, status, selections })), [
        { selectionId: 'required-note', applicability: 'applies', unknown: [], status: 'not-fulfilled', selections: [] },
        { selectionId: 'other-client', applicability: 'not-applicable', unknown: [], status: 'not-applicable', selections: [] },
        { selectionId: 'repository-note', applicability: 'unknown', unknown: ['repository'], status: 'unknown', selections: [] }
      ]);
      const requiredSelection = { ...previewSelection, id: 'required-choice', organizationSelectionId: 'required-note' };
      const present = evaluate([previewSelection, requiredSelection]);
      assert.deepEqual(present.enforced, { admitted: true, diagnostics: [] });
      assert.equal(present.fulfillment[0].status, 'fulfilled');
      assert.deepEqual(present.fulfillment[0].selections, ['required-choice']);
      assert.equal(present.fulfillment[2].status, 'unknown');
      assert.notEqual(present.fulfillment[2].status, 'fulfilled');
      const unknown = evaluate([previewSelection, requiredSelection,
        { ...previewSelection, id: 'repository-choice', organizationSelectionId: 'repository-note' }]);
      assert.equal(unknown.enforced.admitted, false);
      assert.ok(unknown.enforced.diagnostics.some(d => d.code === 'AUTHORITY_DENIED' && d.reason === 'target-unknown'));
      assert.equal(unknown.fulfillment[2].status, 'unknown');
      assert.deepEqual(unknown.fulfillment[2].unknown, ['repository']);
      assert.deepEqual(unknown.fulfillment[2].selections, []);
      const prohibited = evaluate([{ ...previewSelection, organizationSelectionId: 'prohibited-note',
        recipeIdentity: prohibitedIdentity }]);
      assert.equal(prohibited.enforced.admitted, false);
      assert.ok(prohibited.enforced.diagnostics.some(d => d.code === 'AUTHORITY_DENIED' && d.reason === 'prohibited'));

      const obligationProject = join(process.cwd(), 'obligations-target');
      mkdirSync(obligationProject);
      const obligationRequest = { ...request, target: { project: obligationProject } };
      const admittedOrganization11 = { ...organization11, selections: [entry(name, 'permitted')] };
      currentOrganization = admittedOrganization11;
      const admitted11 = await prepare(obligationRequest, controls);
      assert.equal(admitted11.status, 'ready', JSON.stringify(admitted11.diagnostics));
      assert.deepEqual(readdirSync(obligationProject), []);
      currentOrganization = { ...admittedOrganization11, selections: [entry(name, 'prohibited')] };
      const blocked11 = await prepare(obligationRequest, controls);
      assert.equal(blocked11.status, 'blocked');
      const prohibition = blocked11.diagnostics.find(d => d.code === 'AUTHORITY_DENIED' && d.reason === 'prohibited');
      assert.ok(prohibition, JSON.stringify(blocked11.diagnostics));
      assert.deepEqual(readdirSync(obligationProject), []);
      const targetProject = join(process.cwd(), 'declared-target');
      mkdirSync(targetProject);
      currentOrganization = { schema: organizationContract11, id: 'declared-target', selections: [
        entry(name, 'permitted'), entry('required-codex', 'required', { clients: ['codex'] }),
        entry('repository-note', 'required', { repositories: ['github.com/example-org/app'] }),
        entry('other-client', 'required', { clients: ['claude'] })
      ] };
      const targetRequest = { ...request, target: { project: targetProject },
        policy: { ...policy, selections: [selection, { ...selection, id: 'required-choice',
          managementId: 'required-choice', organizationSelectionId: 'required-codex' }] },
        organizationTarget: { schema: organizationTargetContract, client: 'codex' } };
      const targeted = await prepare(targetRequest, controls);
      assert.equal(targeted.status, 'ready', JSON.stringify(targeted.diagnostics));
      assert.equal(targeted.review.schema, preparedContract15);
      const declared = targeted.review.organizationObligations;
      assert.deepEqual(declared.target, { basis: 'declared', client: 'codex' });
      assert.deepEqual(declared.fulfillment.map(({ scope, selectionId, status, unknown, selections }) =>
        ({ scope, selectionId, status, unknown, selections })), [
        { scope: 'project', selectionId: 'required-codex', status: 'fulfilled', unknown: [], selections: ['required-choice'] },
        { scope: 'project', selectionId: 'repository-note', status: 'unknown', unknown: ['repository'], selections: [] }
      ]);
      assert.deepEqual(declared.advisory, []);
      const { organizationTarget, ...withoutTarget } = targetRequest;
      const unknownTarget = await prepare(withoutTarget, controls);
      assert.equal(unknownTarget.status, 'blocked');
      assert.ok(unknownTarget.diagnostics.some(d => d.code === 'AUTHORITY_DENIED' && d.reason === 'target-unknown'));
      assert.equal(unknownTarget.review, undefined);
      // Without declared facts, only the unrestricted permitted choice is admitted.
      const untargeted = await prepare({ ...withoutTarget, policy }, controls);
      assert.equal(untargeted.status, 'ready', JSON.stringify(untargeted.diagnostics));
      assert.equal(untargeted.review.schema, admitted11.review.schema);
      assert.equal(Object.hasOwn(untargeted.review, 'organizationObligations'), false);
      targetRequest.organizationTarget.repository = 'github.com/example-org/app';
      const changedTarget = await apply(targeted.prepared, approve(targeted), controls);
      assert.equal(changedTarget.completion, 'rejected');
      assert.ok(changedTarget.diagnostics.some(d => d.code === 'REVIEW_STALE'));
      assert.deepEqual(readdirSync(targetProject), []);
      target = { contract: organizationTargetSchema.$id, review: targeted.review.schema,
        basis: declared.target.basis, required: declared.fulfillment[0].status,
        selections: declared.fulfillment[0].selections, repository: declared.fulfillment[1].status,
        unknown: declared.fulfillment[1].unknown, otherClientAbsent: true,
        withoutTarget: untargeted.review.schema, undeclaredSelectorRefused: true, changedTargetRefused: true, wroteNothing: true };
      obligations = { contract: organizationSchema11.$id, enforced: missing.enforced.admitted,
        advisory: missing.advisory[0].status,
        required: [missing.fulfillment[0].status, present.fulfillment[0].status],
        client: missing.fulfillment[1].status, repository: unknown.fulfillment[2].status,
        prohibited: prohibited.enforced.diagnostics.find(d => d.reason === 'prohibited').reason,
        prepare: [admitted11.status, blocked11.status], prepareReason: prohibition.reason, wroteNothing: true };
    }
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
    const previewHandle = await apply(preview(organization), approve(prepared), controls);
    assert.equal(previewHandle.completion, 'rejected');
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
      admitted: true, denied: true, changedAuthorityRefused: true, previewHandleRefused: true, serializedReviewRefused: true, applied: true });
  }
} finally { globalThis.fetch = originalFetch; }
process.stdout.write(JSON.stringify({ package: contractSupport.package, transport: 'fixture-github-rest', cases, obligations, target }) + '\n');
