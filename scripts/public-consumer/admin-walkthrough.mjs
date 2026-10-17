// Enterprise administrator walkthrough over the example's public-package seams.
// The organization source is an acceptance-only stub (org-source.mjs): the example
// never publishes an organization document; the administrator does, out of band.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { selectVerificationKeys, selectVerificationPublishers } from '@aihq/core/harness';
import { getGuidance } from '@aihq/core/support';
import { parseOrganizationPolicy, validateOrganizationTarget } from '@aihq/core/contracts';
import { authorOrganizationPolicy, deriveExecutionPolicy, reviewReport } from '../src/admin.js';
import { requiredItems } from '../src/authoring.js';
import { createHost } from '../src/host.js';
import { serveOrganization } from './org-source.mjs';

const ASSOCIATION = 'urn:aihq:scan:evidence-association:1.0.0';
const rootItem = 'mattpocock.grill-me';
const association = (scanId, file) => ({ schema: ASSOCIATION, scanId, location: { kind: 'file', path: resolve(file) } });
const reasons = diagnostics => diagnostics.map(entry => entry.reason);

export async function verifyAdministrator({ release, source, materialRoots, operations }) {
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
    const hostFor = (projectRoot, organizationTarget) =>
      createHost({ projectRoot, materialRoots, organizationSource: served.source, organizationTarget, controls });
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

    // A declared organization target: Core evaluates obligations and emits prepared-work 1.5.0.
    const organizationTarget = { schema: 'urn:aihq:core:organization-target:1.0.0', client: 'codex' };
    assert.equal(validateOrganizationTarget(organizationTarget).valid, true);
    const declaredTarget = join(process.cwd(), 'target-enterprise-declared');
    mkdirSync(declaredTarget);
    const targeted = hostFor(declaredTarget, organizationTarget);
    const declared = await targeted.prepareSession({ policyText: JSON.stringify(derived.policy) });
    assert.equal(declared.status, 'ready', JSON.stringify(declared.diagnostics));
    assert.equal(declared.review.schema, 'urn:aihq:core:prepared-work:1.5.0');
    assert.deepEqual(declared.review.organizationObligations.target, { basis: 'declared', client: 'codex' });
    const declaredRun = await targeted.applyApproved({ sessionId: declared.sessionId, reviewDigest: declared.review.reviewDigest });
    assert.equal(declaredRun.completion, 'complete', JSON.stringify(declaredRun));
    // Retained serializable results for the gate's portable-context guidance check.
    writeFileSync('organization-prepared.json', JSON.stringify(declared));
    writeFileSync('organization-run.json', JSON.stringify(declaredRun));
    // The same declared-target Prepare over edited unowned content: a 1.5.0 review
    // with conflicts, for which support guidance derives actions.
    const editedTarget = join(process.cwd(), 'target-enterprise-edited');
    const [edited] = declared.review.operations.filter(operation => operation.kind === 'file.write');
    const editedFile = join(editedTarget, relative(declaredTarget, edited.details.target));
    mkdirSync(dirname(editedFile), { recursive: true });
    writeFileSync(editedFile, 'Locally edited content the review must not overwrite.\n');
    const conflicted = await hostFor(editedTarget, organizationTarget).prepareSession({ policyText: JSON.stringify(derived.policy) });
    assert.equal(conflicted.review.schema, 'urn:aihq:core:prepared-work:1.5.0');
    assert.notEqual(conflicted.status, 'ready', 'a conflict is not a clean preparation');
    assert.ok(conflicted.review.operations.some(operation => operation.effects === 'conflict'));
    const conflictGuidance = getGuidance({ kind: 'prepare', result: conflicted }, { platform: 'unknown' });
    assert.equal(conflictGuidance.status, 'complete');
    const conflictIndex = conflicted.review.operations.findIndex(operation => operation.effects === 'conflict');
    const derivedItems = conflictGuidance.items.map(item => ({ id: item.id, reason: item.reason, evidenceIds: item.evidenceIds }));
    assert.deepEqual(derivedItems[0], { id: 'result-status', reason: conflicted.status, evidenceIds: ['/status'] });
    assert.ok(derivedItems.some(item => item.id === 'diagnostic-review' && item.reason === 'conflict' &&
      item.evidenceIds.length === 1 && item.evidenceIds[0] === `/review/operations/${conflictIndex}`), JSON.stringify(derivedItems));
    // Core's own existing-content conflict gets specific guidance: a developer
    // content-conflict item and, for an Enterprise review, an administrator decision.
    assert.equal(derivedItems.some(item => item.reason === 'unrecognized-diagnostic'), false, JSON.stringify(derivedItems));
    const existing = [...conflicted.diagnostics.map((entry, index) => [entry, `/diagnostics/${index}`]),
      ...conflicted.review.conflicts.map((entry, index) => [entry, `/review/conflicts/${index}`])]
      .filter(([entry]) => entry.code === 'STATE_CONFLICT' && entry.reason === 'existing-content').map(([, pointer]) => pointer).sort();
    assert.ok(existing.length > 0);
    const evidenceOf = (id, audience) => conflictGuidance.items.filter(item => item.id === id).map(item => {
      assert.equal(item.audience, audience, id);
      assert.equal(item.reason, 'existing-content', id);
      assert.ok(item.steps.length > 0, id);
      return item.evidenceIds;
    }).flat().sort();
    assert.deepEqual(evidenceOf('content-conflict', 'developer'), existing);
    assert.deepEqual(evidenceOf('managed-content-decision', 'administrator'), existing);
    const audiences = conflictGuidance.items.map(item => item.audience);
    assert.deepEqual(audiences, [...audiences].sort((a, b) => (a === b ? 0 : a === 'developer' ? -1 : 1)), 'developer actions precede administrator actions');
    const organizationFamily = {
      operationSelections: operations.verifyOperationSelections(derived.policy, declared),
      guidance: operations.verifyGuidance({ prepared: declared, applied: declaredRun, expectReview: 'urn:aihq:core:prepared-work:1.5.0' }),
      conflicted: { status: conflicted.status, review: conflicted.review.schema,
        operationSelections: operations.verifyOperationSelections(derived.policy, conflicted),
        guidance: conflictGuidance.items.map(item => ({ id: item.id, reason: item.reason, audience: item.audience, evidenceIds: item.evidenceIds })) },
      obligations: declared.review.organizationObligations,
    };

    return {
      organizationFamily,
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
