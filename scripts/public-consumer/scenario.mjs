import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstalledRelease } from '@aihq/catalog/node';
import { authorPolicy, catalogItems, exportPolicy, policyOrigins, reopenPolicy, requiredItems } from '../src/authoring.js';
import { createHost } from '../src/host.js';
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
assert.deepEqual(diagnostic.supported, ['urn:aihq:core:execution-policy:1.0.0']);

async function execute(policyText, name) {
  const projectRoot = join(process.cwd(), name);
  mkdirSync(projectRoot);
  const host = createHost({ projectRoot, materialRoots });
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
  return { completion: applied.completion, origins: prepared.review.effectiveOptions.inputs,
    files, wrongDigestRejected: true, replayRequiresPrepare: true, reviewJsonCannotRestoreHandle: true };
}
const common = await execute(text, 'target-skills');
assert.equal(common.origins['chosen/agentDirectory'].origin, 'explicit');
assert.equal(common.origins['required/agentDirectory'].origin, 'default');
const result = { variant, itemCount: items.length, releaseSha256: release.sha256, common,
  unsupported: { encountered: diagnostic.encountered, supported: diagnostic.supported } };
if (variant === 'current') {
  assert.ok(items.some(item => item.id === 'aihq.project-context'));
  const added = authorPolicy({ release, mode: 'vibe', materialSource: source, selections: [
    { id: 'new-content', managementId: 'consumer-project-context', scope: 'project', itemId: 'aihq.project-context', configuration: {} },
  ] });
  assert.equal(added.valid, true, JSON.stringify(added.diagnostics));
  result.addedContent = await execute(exportPolicy(added.policy), 'target-context');
  assert.ok(result.addedContent.files.some(file => file.path.endsWith('RULE_ROUTER.md')));
  result.reports = await verifyReports();
} else {
  assert.equal(items.some(item => item.id === 'aihq.project-context'), false);
}
console.log(JSON.stringify(result));
