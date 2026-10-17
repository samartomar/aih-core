// Acceptance checks for cross-package operations that consumers use instead of
// re-implementing product rules. Copied into the isolated consumer; every product
// import resolves an installed public export.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { recipeOperationKinds } from '@aihq/core/contracts';
import { targets } from '@aihq/core/harness';
import { CLAIMS_SCHEMA, readClaimSet, validateClaimSet } from '@aihq/core/report';
import { getGuidance, renderSupportMarkdown } from '@aihq/core/support';
import { releaseInventory } from '@aihq/catalog/contracts';
import { compareReleases, listItems, readRelease, resolveSelections } from '@aihq/catalog/reader';
// Namespace import: `entrySupport` exists only in Scan builds that moved entry status out of contractSupport.
import * as scanContracts from '@aihq/scan/contracts';
import { readArtifact, readContentCoverage } from '@aihq/scan/read';

export { recipeOperationKinds };

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const codes = diagnostics => diagnostics.map(entry => entry.code);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

/** Reads release bytes through the installed reader with their exact digest. */
export function openReleaseBytes(bytes) {
  const read = readRelease(bytes, { expectedSha256: sha256(bytes) });
  assert.equal(read.valid, true, JSON.stringify(read.diagnostics));
  return read.release;
}

// ---- Core -----------------------------------------------------------------

/** Kinds the release's recipe formats admit, and how a fresh Prepare can see them. */
export function verifyOperationKinds(release) {
  const schemas = [...new Set(listItems(release).map(item => item.recipe.schema))].sort();
  for (const schema of schemas) assert.ok(Object.hasOwn(recipeOperationKinds, schema), `Core lists no kinds for ${schema}`);
  const effects = Object.fromEntries(Object.entries(recipeOperationKinds).map(([schema, kinds]) =>
    [schema, Object.fromEntries(kinds.map(record => [record.kind, record.effects]))]));
  for (const table of Object.values(effects)) {
    assert.equal(table['file.write'], 'observable');
    assert.equal(table['process.run'], 'opaque');
  }
  assert.equal(Object.hasOwn(effects['urn:aihq:core:recipe:1.0.0'], 'hook.group'), false);
  assert.equal(effects['urn:aihq:core:recipe:1.1.0']['hook.group'], 'observable');
  assert.ok(Object.isFrozen(recipeOperationKinds));
  return { catalogRecipeSchemas: schemas, coreRecipeSchemas: Object.keys(recipeOperationKinds), effects };
}

const effectsOf = kind => Object.values(recipeOperationKinds).flat().find(record => record.kind === kind)?.effects ?? 'opaque';

/** Policy Prepare's operationSelections, and the visibility each review operation's kind declares. */
export function verifyOperationSelections(policy, prepared) {
  const { review, operationSelections } = prepared;
  assert.ok(Array.isArray(operationSelections), 'policy Prepare returns operationSelections');
  assert.deepEqual(operationSelections.map(entry => entry.id), review.operations.map(operation => operation.id));
  const selectionIds = new Set(policy.selections.map(selection => selection.id));
  for (const entry of operationSelections) {
    if (entry.selectionId === null) {
      assert.equal(entry.operationId, null);
      continue;
    }
    assert.ok(selectionIds.has(entry.selectionId), entry.id);
    assert.equal(entry.id, `${entry.selectionId}/${entry.operationId}`);
  }
  assert.equal(JSON.stringify(review).includes('operationSelections'), false, 'not part of the review or its digest');
  for (const operation of review.operations) {
    if (operation.effects === 'opaque-process') assert.equal(effectsOf(operation.kind), 'opaque', operation.id);
    if (operation.effects === 'already-satisfied') assert.equal(effectsOf(operation.kind), 'observable', operation.id);
  }
  return {
    operations: operationSelections.length,
    bySelection: Object.fromEntries([...selectionIds].map(id =>
      [id, operationSelections.filter(entry => entry.selectionId === id).map(entry => entry.operationId)])),
    effects: [...new Set(review.operations.map(operation => `${operation.kind}:${operation.effects}`))].sort(),
  };
}

/** file-state-result 1.1.0: every contributing operation names its selection. */
export function verifyFileState(result, operationSelections, expected) {
  assert.equal(result.schema, 'urn:aihq:core:file-state-result:1.1.0');
  assert.equal(result.fileState, expected, JSON.stringify(result));
  const selectionById = new Map(operationSelections.map(entry => [entry.id, entry.selectionId]));
  assert.ok(result.targets.length > 0);
  for (const target of result.targets) {
    assert.equal(target.selectionIds.length, target.operationIds.length, target.id);
    target.operationIds.forEach((operationId, index) =>
      assert.equal(target.selectionIds[index], selectionById.get(operationId), operationId));
  }
  return { schema: result.schema, status: result.status, fileState: result.fileState, authority: result.authority,
    targets: result.targets.map(target => ({ outcome: target.outcome, operationIds: target.operationIds, selectionIds: target.selectionIds })) };
}

/** Support guidance over a serializable Prepare wrapper and a run result. */
export function verifyGuidance({ prepared, applied, expectReview }) {
  const platform = ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'unknown';
  assert.equal(prepared.review.schema, expectReview);
  const prepare = getGuidance({ kind: 'prepare', result: prepared }, { platform });
  assert.equal(prepare.status, 'complete', JSON.stringify(prepare.diagnostics));
  const run = getGuidance({ kind: 'run', result: applied }, { platform });
  assert.equal(run.status, 'complete', JSON.stringify(run.diagnostics));
  // A clean ready Prepare and complete run derive no actions.
  if (prepared.status === 'ready' && prepared.diagnostics.length === 0) assert.deepEqual(prepare.items, []);
  if (applied.completion === 'complete' && applied.diagnostics.length === 0) assert.deepEqual(run.items, []);
  const markdown = renderSupportMarkdown({ kind: 'prepare', result: prepared }, { platform });
  assert.equal(markdown.status, 'rendered');
  assert.match(markdown.markdown, /^# Support report/);
  assert.match(markdown.markdown, /Result: prepare/);
  if (prepared.status === 'ready' && prepared.diagnostics.length === 0) {
    assert.match(markdown.markdown, /Status: ready/);
    assert.match(markdown.markdown, /No actions derived\./);
  }
  // A current-format result that breaks its contract is malformed, not unsupported.
  const { operations: _operations, ...brokenReview } = prepared.review;
  const malformedPrepare = getGuidance({ kind: 'prepare', result: { ...prepared, review: brokenReview } }, { platform });
  assert.equal(malformedPrepare.status, 'invalid');
  assert.deepEqual(codes(malformedPrepare.diagnostics), ['INPUT_INVALID']);
  const { completion: _completion, ...brokenRun } = applied;
  const malformedRun = getGuidance({ kind: 'run', result: brokenRun }, { platform });
  assert.equal(malformedRun.status, 'invalid');
  assert.deepEqual(codes(malformedRun.diagnostics), ['INPUT_INVALID']);
  // An unknown result generation is refused as unsupported, never reinterpreted.
  const future = getGuidance({ kind: 'prepare', result: { ...prepared,
    review: { ...prepared.review, schema: 'urn:aihq:core:prepared-work:99.0.0' } } }, { platform });
  assert.equal(future.status, 'invalid');
  assert.deepEqual(codes(future.diagnostics), ['SCHEMA_UNSUPPORTED']);
  const items = result => result.items.map(item => `${item.audience}:${item.id}:${item.reason}`);
  return { platform, reviewSchema: prepared.review.schema, runSchema: applied.schema,
    prepare: { status: prepare.status, items: items(prepare) }, run: { status: run.status, items: items(run) },
    markdown: markdown.status, futureReview: future.diagnostics[0].code,
    malformed: { prepare: malformedPrepare.diagnostics[0].code, run: malformedRun.diagnostics[0].code } };
}

/** Harness target executables map every covered command to exactly one target. */
export function verifyTargetExecutables() {
  const owner = new Map();
  for (const target of targets) {
    assert.deepEqual(target.executables.slice(0, target.binaries.length), [...target.binaries], target.id);
    for (const name of target.executables) {
      assert.equal(/\.(?:cmd|exe|bat|ps1)$/i.test(name), false, name);
      assert.equal(owner.has(name), false, `${name} belongs to one target`);
      owner.set(name, target.id);
    }
  }
  const lookup = name => targets.find(target => target.executables.includes(name))?.id;
  assert.equal(lookup('npx'), 'npm');
  assert.equal(lookup('npm'), 'npm');
  assert.equal(lookup('pip3'), lookup('pip'));
  assert.equal(targets.find(target => target.id === 'npm').binaries.includes('npx'), false, 'npx is covered, not a detection signal');
  return { targets: targets.length, executables: owner.size, npx: lookup('npx') };
}

/** Portable claim sets refuse machine-local paths by form and pointer, never echoing the value. */
export function verifyClaimSetPaths() {
  const claim = subject => ({
    id: 'check', revision: 'r1', producer: { id: 'consumer-fixture', version: '1.0.0' },
    recordSchema: 'urn:example:record:1.0.0', subject: { kind: 'machine', id: subject },
    scope: { kind: 'machine', targets: ['consumer-host'] }, sources: [{ id: 'record-check', schema: 'urn:example:record:1.0.0' }],
    observation: 'event-check', capturedAt: '2026-10-14T10:00:00Z', measure: 'configuration-check', kind: 'measured',
    value: { amount: 'passed', unit: 'outcome' }, method: { id: 'baseline', version: '1.0.0' },
    coverage: { state: 'complete', reason: 'every target observed' }, authentication: { status: 'not-authenticated' },
    applicability: { state: 'current', reason: 'captured this session', inputs: [] },
  });
  const set = subject => ({ schema: CLAIMS_SCHEMA, claims: [claim(subject)], calculations: [], actions: [] });
  assert.deepEqual(validateClaimSet(set('consumer-host')), { valid: true, errors: [] });
  const refused = {};
  for (const [form, value] of [['windows-drive', 'C:\\consumer\\evidence.json'], ['posix-absolute', '/srv/consumer/evidence.json']]) {
    const result = validateClaimSet(set(value));
    assert.deepEqual(result, { valid: false, errors: [`claimSet.claims[0].subject.id: local-path: ${form} path is not portable`] });
    const text = JSON.stringify(set(value));
    const read = readClaimSet(text);
    assert.equal(read.status, 'rejected');
    assert.equal(read.code, 'INPUT_INVALID');
    assert.equal(read.original, text);
    assert.equal(read.errors.some(error => error.includes(value)), false, 'the refused value is not echoed');
    refused[form] = result.errors[0];
  }
  return { portableAccepted: true, refused };
}

// ---- Catalog --------------------------------------------------------------

/** releaseInventory names exactly the release documents the package exports, each readable as declared. */
export function verifyReleaseInventory() {
  assert.ok(releaseInventory.releases.some(entry => entry.release === releaseInventory.defaultRelease));
  const releases = releaseInventory.releases.map(entry => {
    const bytes = readFileSync(new URL(import.meta.resolve(entry.export)));
    const release = openReleaseBytes(bytes);
    assert.equal(release.schema, entry.schema, entry.release);
    assert.deepEqual(release.package, { ...releaseInventory.package });
    return { release: entry.release, schema: entry.schema, purpose: entry.purpose, support: entry.support,
      sha256: release.sha256, items: release.items.length };
  });
  return { package: { ...releaseInventory.package }, defaultRelease: releaseInventory.defaultRelease, releases };
}

/** Same content slots, identity facts and version order between two installed artifacts' default releases. */
export function verifyCompareReleases(baseline, current) {
  const compared = compareReleases({ first: baseline, second: current });
  assert.equal(compared.status, 'ok', JSON.stringify(compared.diagnostics));
  const facts = compared.value;
  assert.equal(facts.package, 'same-package');
  assert.equal(facts.sameRelease, baseline.sha256 === current.sha256);
  const first = new Map(baseline.items.map(item => [item.id, item]));
  const second = new Map(current.items.map(item => [item.id, item]));
  const ids = [...new Set([...first.keys(), ...second.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(facts.items.map(item => item.itemId), ids);
  const tally = {};
  for (const item of facts.items) {
    const expected = !second.has(item.itemId) ? 'only-in-first' : !first.has(item.itemId) ? 'only-in-second' : 'in-both';
    assert.equal(item.presence, expected, item.itemId);
    if (expected === 'in-both') {
      assert.equal(item.record, first.get(item.itemId).itemSha256 === second.get(item.itemId).itemSha256 ? 'unchanged' : 'changed');
      assert.equal(item.recipe, item.first.recipeSha256 === item.second.recipeSha256 ? 'unchanged' : 'changed');
    }
    const key = expected === 'in-both' ? `in-both/content-${item.content}/record-${item.record}` : expected;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  const reversed = compareReleases({ first: current, second: baseline });
  assert.equal(reversed.status, 'ok');
  assert.equal(reversed.value.items.filter(item => item.presence === 'only-in-first').length, tally['only-in-second'] ?? 0);
  return { first: facts.first, second: facts.second, sameRelease: facts.sameRelease, version: facts.version, items: tally,
    onlyInSecond: facts.items.filter(item => item.presence === 'only-in-second').map(item => item.itemId) };
}

/** resolveSelections accepts one root and returns it in its selections. */
export function verifyResolvedRoot(release, itemId, scope) {
  const resolved = resolveSelections({ releases: { [release.sha256]: release },
    roots: [{ releaseSha256: release.sha256, itemId, scope, configuration: {} }], skips: [] });
  assert.equal(resolved.status, 'ok', JSON.stringify(resolved.diagnostics));
  assert.ok(resolved.value.selections.some(selection => selection.item.itemId === itemId && selection.scope === scope));
  return { status: resolved.status, selections: resolved.value.selections.map(selection => selection.item.itemId) };
}

/** A release whose bytes add one conflict declaration: synthetic acceptance input read by the public reader. */
export function conflictRelease(bytes, itemId, conflictsWith) {
  const document = JSON.parse(new TextDecoder().decode(bytes));
  const item = document.items.find(entry => entry.id === itemId);
  assert.ok(item && document.items.some(entry => entry.id === conflictsWith));
  item.dependencies = { ...item.dependencies, conflicts: [{ itemId: conflictsWith }] };
  return openReleaseBytes(new TextEncoder().encode(`${JSON.stringify(sorted(document))}\n`));
}

/** resolveSelections: required closure, then unavailable and conflict detail with reference/declaredBy. */
export function verifyResolveSelections({ release, rootItem, crossRelease, conflict }) {
  const ref = (rel, itemId) => ({ releaseSha256: rel.sha256, itemId, scope: 'project' });
  const root = (rel, itemId) => ({ ...ref(rel, itemId), configuration: {} });
  const ok = resolveSelections({ releases: { [release.sha256]: release }, roots: [root(release, rootItem)], skips: [] });
  assert.equal(ok.status, 'ok', JSON.stringify(ok.diagnostics));
  const included = ok.value.inclusions.map(inclusion => inclusion.item.itemId);

  const missing = resolveSelections({ releases: { [release.sha256]: release }, roots: [root(release, 'consumer.absent-item')], skips: [] });
  assert.equal(missing.status, 'refused');
  const [absent] = missing.diagnostics;
  assert.equal(absent.code, 'ITEM_UNAVAILABLE');
  assert.equal(absent.path, '/roots/0');
  assert.deepEqual(absent.reference, ref(release, 'consumer.absent-item'));
  assert.equal(Object.hasOwn(absent, 'declaredBy'), false, 'a request entry has no declaring item');

  const { release: dependent, itemId: dependentId } = crossRelease;
  const unsupplied = resolveSelections({ releases: { [dependent.sha256]: dependent }, roots: [root(dependent, dependentId)], skips: [] });
  assert.equal(unsupplied.status, 'refused');
  const unavailable = unsupplied.diagnostics.find(entry => entry.code === 'RELEASE_UNAVAILABLE');
  assert.ok(unavailable, JSON.stringify(unsupplied.diagnostics));
  assert.ok(unavailable.reference.releaseSha256 !== dependent.sha256);
  assert.deepEqual(unavailable.declaredBy, ref(dependent, dependentId));
  assert.ok(unavailable.path.startsWith(`/releases/${dependent.sha256}/items/`));

  const conflicting = conflictRelease(conflict.bytes, rootItem, conflict.with);
  const clashed = resolveSelections({ releases: { [conflicting.sha256]: conflicting },
    roots: [root(conflicting, rootItem), root(conflicting, conflict.with)], skips: [] });
  assert.equal(clashed.status, 'refused');
  const clash = clashed.diagnostics.find(entry => entry.code === 'ITEM_CONFLICT');
  assert.ok(clash, JSON.stringify(clashed.diagnostics));
  assert.deepEqual(clash.reference, ref(conflicting, conflict.with));
  assert.deepEqual(clash.declaredBy, ref(conflicting, rootItem));
  assert.match(clash.path, /\/dependencies\/conflicts\/0$/);
  return {
    closure: included,
    unavailableItem: { code: absent.code, path: absent.path, reference: absent.reference.itemId, declaredBy: null },
    unavailableRelease: { code: unavailable.code, reference: unavailable.reference, declaredBy: unavailable.declaredBy.itemId },
    conflict: { code: clash.code, reference: clash.reference.itemId, declaredBy: clash.declaredBy.itemId,
      syntheticReleaseSha256: conflicting.sha256 },
  };
}

// ---- Scan -----------------------------------------------------------------

/** readContentCoverage on supplied and produced reports: exact descriptors match, altered ones do not. */
export async function verifyContentCoverage(files) {
  const results = {};
  for (const file of files) {
    const read = await readArtifact(readFileSync(file));
    assert.equal(read.status, 'read', file);
    const descriptors = read.report.source.capture.entries.map(({ path, sha256: digest, byteLength }) => ({ path, sha256: digest, byteLength }));
    const matched = await readContentCoverage({ read, descriptors });
    assert.equal(matched.status, 'matched', JSON.stringify(matched));
    assert.equal(matched.scanId, read.scanId);
    assert.equal(matched.authenticity, 'unchecked');
    // Every succeeded observation either covers all descriptors or is counted by its exclusion reason.
    const succeeded = read.report.results.filter(result => result.outcome === 'succeeded').flatMap(result => result.observations).length;
    assert.equal(matched.observations.length + matched.excluded['coverage-incomplete'] + matched.excluded['input-missing-descriptor'], succeeded);
    assert.deepEqual(matched.detectorsWithoutCoverage, [...new Set(read.report.results
      .filter(result => !matched.observations.some(entry => entry.detector.detectorId === result.detectorId)).map(result => result.detectorId))].sort());
    const altered = descriptors.map((entry, index) => index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry);
    const mismatched = await readContentCoverage({ read, descriptors: altered });
    assert.equal(mismatched.status, 'mismatched');
    assert.deepEqual(mismatched.unmatchedPaths, [descriptors[0].path]);
    assert.equal(mismatched.authenticity, 'unchecked');
    const empty = await readContentCoverage({ read, descriptors: [] });
    assert.equal(empty.status, 'invalid');
    results[file] = { scanId: read.scanId, descriptors: descriptors.length,
      matched: { observations: matched.observations.length, excluded: matched.excluded, detectorsWithoutCoverage: matched.detectorsWithoutCoverage },
      mismatched: { unmatchedPaths: mismatched.unmatchedPaths }, empty: empty.status };
  }
  return results;
}

/** The root entry's compatibility groups each carry their own status and replacement entry. */
export function verifyScanSupportGroups() {
  const { contractSupport: scanSupport, entrySupport } = scanContracts;
  // Current shape: a sibling `entrySupport` ({package, entries:[{export, status, groups?}]}).
  // Older shape (allowlisted package-support deviation): status and root `operations`
  // carried on contractSupport entries.
  const source = entrySupport !== undefined ? 'entrySupport' : 'contractSupport';
  const statusEntries = entrySupport !== undefined
    ? entrySupport.entries.map(entry => ({ export: entry.export, status: entry.status, groups: entry.groups }))
    : scanSupport.entries.map(entry => ({ export: entry.export, status: entry.status, groups: entry.operations }));
  if (entrySupport !== undefined) {
    assert.deepEqual({ ...entrySupport.package }, { ...scanSupport.package });
    assert.deepEqual(statusEntries.map(entry => entry.export).sort(), scanSupport.entries.map(entry => entry.export).sort(),
      'entrySupport covers exactly the declared entries');
  }
  const root = statusEntries.find(entry => entry.export === '@aihq/scan');
  assert.ok(root, 'Scan declares its root entry');
  assert.ok(Array.isArray(root.groups) && root.groups.length > 0);
  const declared = new Set(scanSupport.entries.map(entry => entry.export));
  // Scan's published vocabulary: current entries; legacy root groups are compatibility-only or deprecated.
  const ranks = { current: 0, 'compatibility-only': 1, deprecated: 2 };
  for (const entry of statusEntries) assert.ok(Object.hasOwn(ranks, entry.status), `${entry.export}: ${entry.status}`);
  for (const entry of statusEntries.filter(candidate => candidate !== root)) {
    assert.equal(entry.status, 'current', entry.export);
    assert.equal(entry.groups, undefined, `${entry.export} declares no groups`);
  }
  for (const group of root.groups) {
    assert.ok(['compatibility-only', 'deprecated'].includes(group.status), `${group.group}: ${group.status}`);
    assert.ok(group.use === null || (declared.has(group.use) && group.use !== root.export), group.group);
    assert.ok(group.exports.length > 0);
  }
  const rootExports = root.groups.flatMap(group => group.exports);
  assert.equal(new Set(rootExports).size, rootExports.length, 'each root export belongs to one group');
  // The root entry is as current as its least-retired group.
  assert.equal(ranks[root.status], Math.min(...root.groups.map(group => ranks[group.status])));
  return { source, root: { export: root.export, status: root.status },
    groups: root.groups.map(group => ({ group: group.group, status: group.status, use: group.use, exports: group.exports.length })),
    entries: statusEntries.map(entry => ({ export: entry.export, status: entry.status })) };
}
