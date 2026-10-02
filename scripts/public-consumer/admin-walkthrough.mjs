// Enterprise administrator walkthrough over the example's public-package seams.
// The organization source is an acceptance-only stub (org-source.mjs): the example
// never publishes an organization document; the administrator does, out of band.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectVerificationKeys, selectVerificationPublishers } from '@aihq/core/harness';
import { parseOrganizationPolicy } from '@aihq/core/contracts';
import { authorOrganizationPolicy, deriveExecutionPolicy, reviewReport } from '../src/admin.js';
import { requiredItems } from '../src/authoring.js';
import { createHost } from '../src/host.js';
import { serveOrganization } from './org-source.mjs';

const ASSOCIATION = 'urn:aihq:scan:evidence-association:1.0.0';
const rootItem = 'mattpocock.grill-me';
const association = (scanId, file) => ({ schema: ASSOCIATION, scanId, location: { kind: 'file', path: resolve(file) } });
const reasons = diagnostics => diagnostics.map(entry => entry.reason);

export async function verifyAdministrator({ release, source, materialRoots }) {
  // 1. Review reports. Reading never authenticates.
  const production = await reviewReport(readFileSync('production.scan.json'));
  const display = await reviewReport(readFileSync('display.scan.json'));
  for (const view of [production, display]) {
    assert.equal(view.kind, 'supported');
    assert.equal(view.authenticity, 'unchecked');
  }
  assert.equal((await reviewReport(readFileSync('tampered.scan.json'))).kind, 'invalid');
  assert.equal((await reviewReport(readFileSync('unsupported.report.json'))).kind, 'unsupported');

  // 2. Author the organization policy for the root item and its required item.
  const closure = requiredItems(release, rootItem);
  assert.equal(closure.valid, true);
  const requiredId = closure.itemIds.find(itemId => itemId !== rootItem);
  const organization = await authorOrganizationPolicy({ release, id: 'consumer-org-policy', permitted: [
    { selectionId: 'chosen', itemId: rootItem, scopes: ['project'],
      inputs: { agentDirectory: { choices: ['.claude', '.consumer-agent'] } } },
    { selectionId: 'required', itemId: requiredId, scopes: ['project'],
      inputs: { agentDirectory: { allowDeclared: true } } },
  ] });
  assert.equal(organization.valid, true, JSON.stringify(organization.diagnostics));
  assert.equal(parseOrganizationPolicy(JSON.stringify(organization.document)).valid, true);
  assert.equal(JSON.stringify(organization.document).includes('evidence'), false);
  const rejectedOrganization = await authorOrganizationPolicy({ release, id: 'bad', permitted: [
    { selectionId: 'chosen', itemId: rootItem, scopes: ['user'], inputs: { unknown: { allowDeclared: true } } }] });
  assert.equal(rejectedOrganization.valid, false);

  // 3. Derive the Enterprise execution policy with the selected evidence.
  const productionEvidence = association(production.scanId, 'production.scan.json');
  const choice = (id, itemId, configuration) =>
    ({ id, organizationSelectionId: id, managementId: `consumer-admin-${id}`, scope: 'project', itemId, configuration });
  const choices = [choice('chosen', rootItem, { agentDirectory: '.consumer-agent' }), choice('required', requiredId, {})];
  const derive = (overrides = {}) => deriveExecutionPolicy({
    release, organization: organization.document, materialSource: source, choices,
    evidence: [productionEvidence], ...overrides });
  const derived = await derive();
  assert.equal(derived.valid, true, JSON.stringify(derived.diagnostics));
  assert.equal(derived.policy.mode, 'enterprise');
  assert.deepEqual(derived.policy.selections.map(selection => selection.organizationSelectionId), ['chosen', 'required']);
  assert.deepEqual(derived.policy.evidence, [productionEvidence]);

  // 4. Rejections: out of policy (before export) and unsupported evidence.
  const outOfPolicy = await derive({ choices: [choice('chosen', rootItem, { agentDirectory: '.elsewhere' }), choices[1]] });
  assert.equal(outOfPolicy.valid, false);
  assert.equal(Object.hasOwn(outOfPolicy, 'policy'), false);
  assert.deepEqual(reasons(outOfPolicy.diagnostics), ['input-value']);
  const unsupportedSchema = await derive({ evidence: [{ ...productionEvidence, schema: 'urn:aihq:scan:evidence-association:99.0.0' }] });
  const malformedScanId = await derive({ evidence: [{ ...productionEvidence, scanId: 'scan:sha256:not-a-digest' }] });
  for (const rejected of [unsupportedSchema, malformedScanId]) {
    assert.equal(rejected.valid, false);
    assert.ok(rejected.diagnostics.length > 0);
  }

  // 5. Core admission against the independently selected organization source.
  const keys = await selectVerificationKeys('scan-report');
  const publishers = selectVerificationPublishers('scan-report');
  assert.equal(keys.status, 'selected');
  assert.equal(publishers.status, 'selected');
  const controls = { evidence: { acquire: true, trust: { keys: keys.keys, publishers: publishers.publishers } } };
  const served = serveOrganization(organization.document);
  try {
    const hostFor = projectRoot => createHost({ projectRoot, materialRoots, organizationSource: served.source, controls });
    const target = join(process.cwd(), 'target-enterprise');
    mkdirSync(target);
    const host = hostFor(target);
    const prepared = await host.prepareSession({ policyText: JSON.stringify(derived.policy) });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    assert.equal(prepared.review.mode, 'enterprise');
    assert.equal(prepared.review.inputs.organization.policyId, 'consumer-org-policy');
    const [associated] = prepared.review.evidence;
    assert.equal(associated.status, 'authenticated');
    assert.equal(associated.scanId, production.scanId);
    const readsAtPrepare = served.calls.length;
    // The prepared handle is lost with its host: approval needs a fresh preparation.
    const restarted = hostFor(target);
    const lost = await restarted.applyApproved({ sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest });
    assert.equal(lost.status, 'lost');
    const fresh = await restarted.prepareSession({ policyText: JSON.stringify(derived.policy) });
    assert.equal(fresh.status, 'ready', JSON.stringify(fresh.diagnostics));
    assert.notEqual(fresh.sessionId, prepared.sessionId);
    const readsBeforeApply = served.calls.length;
    const applied = await restarted.applyApproved({ sessionId: fresh.sessionId, reviewDigest: fresh.review.reviewDigest });
    assert.equal(applied.completion, 'complete', JSON.stringify(applied));
    assert.ok(served.calls.length > readsBeforeApply, 'Apply must read the organization source again');
    assert.ok(fresh.review.operations.some(operation => existsSync(operation.details.target)));

    // Out-of-policy value forced past the local check: Core still denies it.
    const forced = structuredClone(derived.policy);
    forced.selections[0].configuration.agentDirectory = '.elsewhere';
    const forcedTarget = join(process.cwd(), 'target-enterprise-denied');
    mkdirSync(forcedTarget);
    const denied = await hostFor(forcedTarget).prepareSession({ policyText: JSON.stringify(forced) });
    assert.equal(denied.sessionId, undefined);
    assert.ok(denied.diagnostics.some(entry => entry.code === 'AUTHORITY_DENIED' && entry.reason === 'input-value'),
      JSON.stringify(denied.diagnostics));

    // An authentic-looking but unsigned display report is shown, never a gate.
    const unsignedPolicy = await derive({ evidence: [association(display.scanId, 'display.scan.json')] });
    assert.equal(unsignedPolicy.valid, true, JSON.stringify(unsignedPolicy.diagnostics));
    const unsignedTarget = join(process.cwd(), 'target-enterprise-unsigned');
    mkdirSync(unsignedTarget);
    const unsigned = await hostFor(unsignedTarget).prepareSession({ policyText: JSON.stringify(unsignedPolicy.policy) });
    assert.equal(unsigned.status, 'ready', JSON.stringify(unsigned.diagnostics));
    assert.equal(unsigned.review.evidence[0].status, 'unverifiable');

    return {
      organizationPolicyId: organization.document.id,
      recipeIdentities: organization.document.selections.map(selection => selection.recipeIdentity),
      evidence: { scanId: production.scanId, reviewAuthenticity: production.authenticity, coreStatus: associated.status,
        unsignedDisplay: unsigned.review.evidence[0].status },
      admitted: { completion: applied.completion, organizationReads: { prepare: readsAtPrepare, total: served.calls.length } },
      lostHandleRequiresFreshApproval: true,
      rejected: {
        outOfPolicyLocal: reasons(outOfPolicy.diagnostics),
        outOfPolicyCore: denied.diagnostics.map(entry => `${entry.code}:${entry.reason}`),
        unsupportedEvidenceSchema: unsupportedSchema.diagnostics[0].code,
        malformedScanId: malformedScanId.diagnostics[0].code,
      },
    };
  } finally {
    served.restore();
  }
}
