import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstalledRelease } from '@aihq/catalog/node';
import { contractSupport as coreSupport } from '@aihq/core/contracts';
import { authorPolicy, catalogItems, exportPolicy, openRelease, policyOrigins, reopenPolicy, requiredItems } from '../src/authoring.js';
import { createHost } from '../src/host.js';
import { verifyAdministrator } from './admin-walkthrough.mjs';
import { verifyReports } from './reports.mjs';

const variant = process.argv[2];
assert.ok(['baseline', 'current'].includes(variant));
const installed = await readInstalledRelease({
  root: dirname(fileURLToPath(import.meta.resolve('@aihq/catalog/package.json'))), sourceInput: 'catalog',
});
assert.equal(installed.valid, true, JSON.stringify(installed.diagnostics));
const { release, source, materialRoots } = installed;
const items = catalogItems(release);
const rootItem = 'mattpocock.grill-me';
const closure = requiredItems(release, rootItem);
assert.equal(closure.valid, true);
assert.ok(closure.itemIds.includes('mattpocock.grilling'));
const selections = closure.itemIds.map(itemId => ({
  id: itemId === rootItem ? 'chosen' : 'required', managementId: `consumer-${itemId}`,
  scope: 'project', itemId, configuration: itemId === rootItem ? { agentDirectory: '.consumer-agent' } : {},
}));
const authored = authorPolicy({ release, mode: 'vibe', materialSource: source, selections });
assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));
const text = exportPolicy(authored.policy);
writeFileSync('authored-policy.json', text);
const reopened = reopenPolicy(readFileSync('authored-policy.json', 'utf8'));
assert.equal(reopened.valid, true, JSON.stringify(reopened.diagnostics));
assert.deepEqual(reopened.document, authored.policy);
assert.deepEqual(reopened.document.selections.find(selection => selection.id === 'chosen').requires, ['required']);
assert.equal(reopened.document.selections.find(selection => selection.id === 'chosen').configuration.agentDirectory, '.consumer-agent');
assert.equal(Object.hasOwn(reopened.document.selections.find(selection => selection.id === 'required').configuration, 'agentDirectory'), false);
const origins = policyOrigins(release, reopened.document);
assert.equal(origins.bySelectionId.chosen.agentDirectory, 'explicit');
assert.equal(origins.bySelectionId.required.agentDirectory, 'default');
const unsupported = reopenPolicy(JSON.stringify({ ...authored.policy, schema: 'urn:aihq:core:execution-policy:99.0.0' }));
assert.equal(unsupported.valid, false);
const diagnostic = unsupported.diagnostics.find(entry => entry.code === 'SCHEMA_UNSUPPORTED');
assert.equal(diagnostic.encountered, 'urn:aihq:core:execution-policy:99.0.0');
assert.deepEqual(diagnostic.supported, coreSupport.contracts
  .filter(contract => contract.id.startsWith('urn:aihq:core:execution-policy:') && contract.role !== 'produces')
  .map(contract => contract.id));

// Operations added after the baseline Catalog artifact are checked in the current install only.
const operations = variant === 'current' ? await import('./operations.mjs') : undefined;

async function execute(policyText, name) {
  const projectRoot = join(process.cwd(), name);
  mkdirSync(projectRoot);
  const host = createHost({ projectRoot, materialRoots });
  const before = operations && await host.checkFiles({ policyText });
  const prepared = await host.prepareSession({ policyText });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(Object.hasOwn(prepared, 'prepared'), false);
  const roundTripReview = JSON.parse(JSON.stringify(prepared.review));
  assert.equal(roundTripReview.reviewDigest, prepared.review.reviewDigest);
  const wrong = await host.applyApproved({ sessionId: prepared.sessionId, reviewDigest: '0'.repeat(64), origin: 'interactive' });
  assert.equal(wrong.status, 'rejected');
  assert.equal(wrong.reason, 'digest-mismatch');
  const applied = await host.applyApproved({ sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest, origin: 'interactive' });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied));
  assert.ok(applied.checks.length > 0);
  assert.ok(applied.checks.every(check => check.status === 'passed'));
  const files = prepared.review.operations.filter(operation => operation.kind === 'file.write').map(operation => {
    const bytes = readFileSync(operation.details.target);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, operation.details.materialSha256);
    return { path: operation.details.target, bytes: bytes.length, sha256 };
  });
  assert.ok(files.length > 0);
  const replay = await host.applyApproved({ sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest, origin: 'interactive' });
  assert.equal(replay.status, 'lost');
  const restarted = createHost({ projectRoot, materialRoots });
  assert.equal((await restarted.applyApproved({ sessionId: prepared.sessionId, reviewDigest: roundTripReview.reviewDigest, origin: 'interactive' })).status, 'lost');
  const result = { completion: applied.completion, origins: prepared.review.effectiveOptions.inputs,
    files, wrongDigestRejected: true, replayRequiresPrepare: true, reviewJsonCannotRestoreHandle: true };
  if (operations) {
    const policy = JSON.parse(policyText);
    result.operationSelections = operations.verifyOperationSelections(policy, prepared);
    // A fresh Prepare after Apply establishes observable effects as already satisfied.
    const again = await restarted.prepareSession({ policyText });
    assert.equal(again.status, 'ready', JSON.stringify(again.diagnostics));
    const observable = again.review.operations.filter(operation =>
      Object.values(operations.recipeOperationKinds).flat().some(record => record.kind === operation.kind && record.effects === 'observable'));
    assert.ok(observable.length > 0 && observable.every(operation => operation.effects === 'already-satisfied'));
    result.freshPrepare = operations.verifyOperationSelections(policy, again);
    result.fileState = {
      before: operations.verifyFileState(before, prepared.operationSelections, 'changed'),
      after: operations.verifyFileState(await host.checkFiles({ policyText }), prepared.operationSelections, 'match'),
    };
    result.guidance = operations.verifyGuidance({ prepared, applied, expectReview: prepared.review.schema });
  }
  return result;
}
const common = await execute(text, 'target-skills');
assert.equal(common.origins['chosen/agentDirectory'].origin, 'explicit');
assert.equal(common.origins['required/agentDirectory'].origin, 'default');

// The content-only upgrade pair: the selected baseline artifact predates content the
// current artifact adds to this release document. Identical content fails the gate.
const UPGRADE_RELEASE = '@aihq/catalog/release-ecc.json';
const ADDED_ITEM = 'ecc.codex.mcp.context7';
const upgradeExport = fileURLToPath(import.meta.resolve(UPGRADE_RELEASE));
const upgradeBytes = readFileSync(upgradeExport);
const upgradeRead = openRelease(upgradeBytes, createHash('sha256').update(upgradeBytes).digest('hex'));
assert.equal(upgradeRead.valid, true, JSON.stringify(upgradeRead.diagnostics));
const upgradeIds = catalogItems(upgradeRead.release).map(item => item.id);
assert.equal(upgradeIds.includes(ADDED_ITEM), variant === 'current', `${variant} ${ADDED_ITEM}`);
const result = { variant, itemCount: items.length, releaseSha256: release.sha256, common,
  unsupported: { encountered: diagnostic.encountered, supported: diagnostic.supported },
  upgrade: { release: UPGRADE_RELEASE, sha256: upgradeRead.release.sha256, itemCount: upgradeIds.length,
    addedItem: ADDED_ITEM, addedItemPresent: upgradeIds.includes(ADDED_ITEM), export: upgradeExport } };
if (variant === 'current') {
  assert.ok(items.some(item => item.id === 'aihq.project-context'));
  // The baseline artifact's upgrade release, read by this install's reader.
  const baseline = operations.openReleaseBytes(readFileSync(process.env.BASELINE_RELEASE));
  const releaseBytes = readFileSync(fileURLToPath(import.meta.resolve('@aihq/catalog/release.json')));
  const ecc = operations.openReleaseBytes(readFileSync(fileURLToPath(import.meta.resolve('@aihq/catalog/release-ecc.json'))));
  const crossReleaseItem = ecc.items.find(item => item.dependencies.requires.some(ref => 'release' in ref));
  assert.ok(crossReleaseItem, 'the shipped ECC release carries a cross-release requirement');
  result.core = {
    operationKinds: operations.verifyOperationKinds(release),
    targetExecutables: operations.verifyTargetExecutables(),
    claimSetPaths: operations.verifyClaimSetPaths(),
  };
  result.catalog = {
    inventory: operations.verifyReleaseInventory(),
    compare: operations.verifyCompareReleases(baseline, ecc),
    resolve: operations.verifyResolveSelections({ release, rootItem,
      crossRelease: { release: ecc, itemId: crossReleaseItem.id },
      conflict: { bytes: releaseBytes, with: 'aihq.project-context' } }),
  };
  assert.deepEqual([...result.catalog.resolve.closure].sort(), [...closure.itemIds].sort());
  const added = authorPolicy({ release, mode: 'vibe', materialSource: source, selections: [
    { id: 'new-content', managementId: 'consumer-project-context', scope: 'project', itemId: 'aihq.project-context', configuration: {} },
  ] });
  assert.equal(added.valid, true, JSON.stringify(added.diagnostics));
  result.addedContent = await execute(exportPolicy(added.policy), 'target-context');
  assert.ok(result.addedContent.files.some(file => file.path.endsWith('RULE_ROUTER.md')));
  // Every other policy family a plain Prepare produces without native setup:
  // policy 1.1 gives prepared-work 1.1.0, policy 1.2/1.3 give 1.4.0 (runs 1.1.0).
  result.policyFamilies = {};
  for (const schema of ['urn:aihq:core:execution-policy:1.1.0', 'urn:aihq:core:execution-policy:1.2.0', 'urn:aihq:core:execution-policy:1.3.0']) {
    const family = await execute(JSON.stringify({ ...authored.policy, schema }), `target-policy-${schema.slice(-5)}`);
    result.policyFamilies[schema] = family.guidance;
  }
  result.reports = await verifyReports();
  result.scan = {
    contentCoverage: await operations.verifyContentCoverage(['production.scan.json', 'display.scan.json']),
    supportGroups: operations.verifyScanSupportGroups(),
  };
  result.administrator = await verifyAdministrator({ release, source, materialRoots, operations });
}
console.log(JSON.stringify(result));
