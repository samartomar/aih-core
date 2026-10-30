// Managed update preparation 1.1.0: a replacement in the execution policy version Prepare accepts, up to 1.6.0, gets the
// same checks an install gets. A recipe-less replacement is rendered from the Catalog release the request names, its
// binding digest is checked, and its Scan records are checked against its own bytes; a refused inner preparation is
// never reported as a prepared update. Real Catalog 1.7.0 items vendored with their published bytes.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { apply, prepare, prepareUpdate } from '../dist/core/index.js';
import { toolBindings } from '../dist/harness/contracts.mjs';
import { sandbox } from './hook-group-fixture.mjs';
import { approve, assertVendoredRelease, catalogRoot, controls, itemOf, realSelections } from './real-catalog-fixture.mjs';

const UPDATE_10 = 'urn:aihq:core:managed-update-preparation:1.0.0';
const UPDATE_11 = 'urn:aihq:core:managed-update-preparation:1.1.0';
const POLICY_14 = 'urn:aihq:core:execution-policy:1.4.0';
const POLICY_15 = 'urn:aihq:core:execution-policy:1.5.0';
const POLICY_16 = 'urn:aihq:core:execution-policy:1.6.0';
const SKILL = 'superpowers.skill.verification-before-completion';
const GUARD = 'extensions.hook.git-guard';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const claude = toolBindings.find(binding => binding.tool === 'claude');
const release = framework => {
  const path = `release-${framework}.content.json`, bytes = readFileSync(join(catalogRoot, path));
  return { framework, source: { kind: 'local', input: 'catalog' }, path, sha256: sha256(bytes), byteLength: bytes.length };
};
const reasons = result => result.updates.map(entry => [entry.managementId, entry.disposition, entry.diagnostics.map(item => item.reason)]);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const schemas = new URL('../dist/core/schemas/', import.meta.url);
for (const family of readdirSync(schemas)) for (const file of readdirSync(new URL(`${family}/`, schemas)))
  if (file.endsWith('.json')) ajv.addSchema(JSON.parse(readFileSync(new URL(`${family}/${file}`, schemas), 'utf8')));
/** The result's JSON projection, without the live Apply handle, checked against its own schema. */
const conforms = result => {
  const validate = ajv.getSchema(result.schema);
  assert.ok(validate, `${result.schema} is published`);
  const { prepared: _handle, ...preparation } = result.preparation ?? {};
  const projection = JSON.parse(JSON.stringify(result.preparation ? { ...result, preparation } : result));
  assert.equal(validate(projection), true, JSON.stringify(validate.errors));
  return result;
};

let live = [];
const open = () => { const s = sandbox('aih-update-policy-'); live.push(s); return s; };
afterEach(() => { for (const s of live) s.dispose(); live = []; });

/** Installs the five real selections in execution policy 1.5.0, with `extra` merged into the named selection. */
async function install(s, { extra = {}, evidence } = {}, hostControls = controls()) {
  const selections = realSelections().map(selection => extra[selection.id] ? { ...selection, ...extra[selection.id] } : selection);
  const prepared = await prepare({ useCase: 'policy', policy: { schema: POLICY_15, mode: 'vibe', selections, ...(evidence ? { evidence } : {}) },
    target: { project: s.project } }, hostControls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared.review), hostControls);
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  return selections;
}
/** The installed selection as a replacement: same management id and item; its install-time `requires` stay recorded. */
const replacementOf = (selections, id, change = {}) => ({ ...selections.find(selection => selection.id === id), requires: [], ...change });
const recipeless = ({ recipe: _recipe, ...selection }, bindingDigest = claude.digest) => ({ ...selection, bindingDigest });
const ask = (s, updates, policy, hostControls = controls()) =>
  prepareUpdate({ target: { project: s.project }, scope: 'project', updates, ...(policy ? { policy } : {}) }, hostControls);

/** A Scan item record for the real item: each of its materials captured with the published bytes. */
function itemRecord(scanId, item, { createdAt = '2026-10-28T09:00:00Z', warnings = 0 } = {}) {
  return { schema: 'urn:aihq:scan:item-record:1.0.0', scanId, createdAt, evidenceKey: sha256(scanId),
    subject: { frameworkId: 'superpowers', itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 },
    authenticity: 'unchecked', materials: [...item.materials.map(member => ({ materialId: member.id, relPath: member.relPath,
      sha256: member.sha256, byteLength: member.byteLength, executable: false, captured: true })),
    { materialId: '#payload', relPath: '#payload', sha256: item.behaviourSha256, byteLength: 64, executable: false, captured: true }],
    completion: 'complete', coverage: 'matched', severityProfile: 'aih-default',
    detectors: [{ id: 'secrets', version: '1.0.0', outcome: 'succeeded', coverage: 'matched', exclusions: [],
      findings: { error: 0, warning: warnings, note: 0, unavailable: 0 }, suppressed: [] }] };
}
/** An unsigned Scan artifact whose report captured `files` (package path → bytes digest and length). */
function scanArtifact(files, createdAt = '2026-10-28T09:00:00Z') {
  const entries = Object.entries(files).map(([path, { sha256: digest, byteLength }]) => ({ byteLength, kind: 'file', path, sha256: digest }))
    .sort((a, b) => a.path < b.path ? -1 : 1);
  const capture = { profile: 'aih-source-capture-1', entries };
  capture.captureSha256 = sha256(canonical({ domain: 'aih.scan.capture.v1', profile: capture.profile, entries }));
  const report = Buffer.from(canonical({ schema: 'urn:aihq:scan:report:1.0.0', createdAt, completion: 'complete',
    source: { kind: 'local', capture }, selection: { paths: entries.map(entry => entry.path), excludedPaths: [] }, results: [] }));
  const scanId = `scan:sha256:${sha256(Buffer.concat([Buffer.from('aih.scan.report.v1\0'), report]))}`;
  return { scanId, bytes: Buffer.from(canonical({ schema: 'urn:aihq:scan:artifact:1.0.0', scanId, report: { schema: 'urn:aihq:scan:report:1.0.0',
    mediaType: 'application/json', sha256: sha256(report), byteLength: report.length, bytesBase64: report.toString('base64') }, annexes: [] })) };
}
const capturedBytes = item => Object.fromEntries(item.materials.map(member => [member.packagePath, member]));
/** Writes the artifact beside the project and returns the evidence association naming it. */
const evidenceFile = (s, name, artifact) => {
  const path = join(s.root, name); writeFileSync(path, artifact.bytes);
  return { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: artifact.scanId, location: { kind: 'file', path } };
};
const itemMaterials = item => item.materials.map(member => ({ materialId: member.id, relPath: member.relPath, path: member.packagePath,
  sha256: member.sha256, byteLength: member.byteLength, role: member.role }));

test('a recipe-less replacement with catalogReleases is rendered, reviewed and applied like a recipe-less install', async () => {
  assertVendoredRelease();
  const s = open();
  const selections = await install(s);
  const result = conforms(await ask(s, [{ managementId: GUARD, replacement: recipeless(replacementOf(selections, GUARD)) }],
    { schema: POLICY_16, catalogReleases: [release('extensions')] }));
  assert.equal(result.schema, UPDATE_11);
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.equal(result.preparation.status, 'ready', JSON.stringify(result.preparation.diagnostics));
  assert.equal(result.preparation.review.schema, 'urn:aihq:core:prepared-work:1.7.0');
  assert.deepEqual(reasons(result), [[GUARD, 'prepared', []]]);
  const [entry] = result.updates;
  assert.deepEqual([entry.from.item, entry.to.item], [selections.find(item => item.id === GUARD).item, selections.find(item => item.id === GUARD).item]);
  assert.ok(entry.members.length > 0 && entry.members.every(member => member.action === 'unchanged'), JSON.stringify(entry.members));
  const reviewed = result.preparation.review.selections.find(item => item.selectionId === GUARD);
  assert.equal(reviewed.layout.bindingDigest, claude.digest, 'the review names the binding the replacement was rendered from');
  const run = await apply(result.preparation.prepared, approve(result.preparation.review), controls());
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
});

test('an execution policy 1.4.0 replacement keeps working, with or without the request naming its policy', async () => {
  const s = open();
  const selections = await install(s);
  const { bindingDigest: _digest, ...plain } = replacementOf(selections, SKILL);
  const named = conforms(await ask(s, [{ managementId: SKILL, replacement: plain }], { schema: POLICY_14 }));
  const unnamed = conforms(await ask(s, [{ managementId: SKILL, replacement: plain }]));
  assert.deepEqual([named.schema, unnamed.schema], [UPDATE_11, UPDATE_10]);
  for (const result of [named, unnamed]) {
    assert.deepEqual([result.disposition, result.preparation.status, result.preparation.review.schema],
      ['prepared', 'ready', 'urn:aihq:core:prepared-work:1.6.0']);
  }
});

test('a replacement rendered for a binding Core no longer ships is a binding-changed conflict and REVIEW_STALE at Apply', async () => {
  assertVendoredRelease();
  const s = open();
  const selections = await install(s);
  for (const [replacement, policy] of [
    [recipeless(replacementOf(selections, GUARD), 'e'.repeat(64)), { schema: POLICY_16, catalogReleases: [release('extensions')] }],
    [replacementOf(selections, GUARD, { bindingDigest: 'e'.repeat(64) }), { schema: POLICY_15 }]]) {
    const result = conforms(await ask(s, [{ managementId: GUARD, replacement }], policy));
    assert.equal(result.disposition, 'prepared', JSON.stringify(result));
    assert.equal(result.preparation.status, 'partial');
    assert.ok(result.preparation.diagnostics.some(item => item.reason === 'binding-changed'), JSON.stringify(result.preparation.diagnostics));
    assert.deepEqual(reasons(result), [[GUARD, 'prepared', ['binding-changed']]], 'the entry names the binding it was rendered for');
    const run = await apply(result.preparation.prepared, { ...approve(result.preparation.review), allowPartial: true }, controls());
    assert.equal(run.completion, 'rejected');
    const stale = run.diagnostics.filter(item => item.code === 'REVIEW_STALE');
    assert.deepEqual(stale.map(item => [item.reason, item.changed]), [['binding-changed', 'binding']], JSON.stringify(run.diagnostics));
  }
});

test('an update carries its own Scan records: checked against its bytes in the review and re-checked at Apply', async () => {
  assertVendoredRelease();
  const s = open();
  const item = itemOf(SKILL);
  const installed = scanArtifact(capturedBytes(item));
  const evidenceControls = { ...controls(), evidence: { acquire: true } };
  const selections = await install(s, { extra: { [SKILL]: { scanRecords: [itemRecord(installed.scanId, item)], itemMaterials: itemMaterials(item) } },
    evidence: [evidenceFile(s, 'installed.json', installed)] }, evidenceControls);
  // A later scan of the same bytes, with another finding: the replacement carries it instead of the install's record.
  const rescanned = scanArtifact(capturedBytes(item), '2026-10-29T09:00:00Z');
  const association = evidenceFile(s, 'rescanned.json', rescanned);
  const replacement = replacementOf(selections, SKILL, { scanRecords: [itemRecord(rescanned.scanId, item, { createdAt: '2026-10-29T09:00:00Z', warnings: 1 })] });
  const result = conforms(await ask(s, [{ managementId: SKILL, replacement }], { schema: POLICY_15, evidence: [association] }, evidenceControls));
  assert.equal(result.preparation.status, 'ready', JSON.stringify(result.preparation.diagnostics));
  const reviewed = result.preparation.review.selections.find(entry => entry.selectionId === SKILL);
  assert.deepEqual([reviewed.scanId, reviewed.coverage, reviewed.scanState.state, reviewed.scanState.findings.warning],
    [rescanned.scanId, 'matched', 'not-verified', 1], 'the review names the replacement\'s record, not the install\'s');
  // A record for other bytes never counts for the replacement.
  const other = { ...item.materials[0], sha256: 'a'.repeat(64) };
  const relabelled = scanArtifact({ ...capturedBytes(item), [other.packagePath]: other });
  const misreported = conforms(await ask(s, [{ managementId: SKILL, replacement: replacementOf(selections, SKILL,
    { scanRecords: [itemRecord(relabelled.scanId, item)] }) }], { schema: POLICY_15, evidence: [evidenceFile(s, 'relabelled.json', relabelled)] }, evidenceControls));
  assert.equal(misreported.preparation.review.selections.find(entry => entry.selectionId === SKILL).scanState.state, 'not-covered');
  // The record's artifact changes between the update's review and Apply.
  writeFileSync(association.location.path, relabelled.bytes);
  const run = await apply(result.preparation.prepared, approve(result.preparation.review), evidenceControls);
  assert.equal(run.completion, 'rejected');
  assert.deepEqual(run.diagnostics.filter(entry => entry.code === 'REVIEW_STALE').map(entry => entry.changed), ['scan-state']);
});

test('the update request accepts Scan evidence only when it names its policy', async () => {
  const s = open();
  const selections = await install(s);
  const result = await ask(s, [{ managementId: SKILL, replacement: replacementOf(selections, SKILL) }], undefined, { ...controls(), evidence: { acquire: true } });
  assert.deepEqual([result.schema, result.disposition, result.diagnostics.map(item => item.reason)], [UPDATE_10, 'invalid', ['request-shape']]);
  for (const policy of [{ schema: 'urn:aihq:core:execution-policy:1.3.0' }, { schema: POLICY_16, mode: 'vibe' }, { schema: POLICY_16, selections: [] }, []]) {
    const refused = conforms(await ask(s, [{ managementId: SKILL, replacement: replacementOf(selections, SKILL) }], policy));
    assert.deepEqual([refused.schema, refused.disposition, refused.diagnostics.map(item => item.reason)], [UPDATE_11, 'invalid', ['request-shape']], JSON.stringify(policy));
  }
});

test('a refused inner preparation is not-prepared: each entry it held is invalid with the preparation\'s reasons', async () => {
  assertVendoredRelease();
  const s = open();
  const selections = await install(s);
  // Release bytes other than the ones the request names.
  const wrong = { ...release('extensions'), sha256: 'b'.repeat(64) };
  const refused = conforms(await ask(s, [{ managementId: GUARD, replacement: recipeless(replacementOf(selections, GUARD)) },
    { managementId: 'not-installed', replacement: { ...replacementOf(selections, SKILL), id: 'not-installed', managementId: 'not-installed' } }],
  { schema: POLICY_16, catalogReleases: [wrong] }));
  assert.equal(refused.disposition, 'not-prepared', JSON.stringify(refused));
  assert.deepEqual(reasons(refused), [[GUARD, 'invalid', ['member-identity-mismatch']], ['not-installed', 'absent', ['not-managed']]]);
  assert.deepEqual([Object.hasOwn(refused, 'preparation'), Object.hasOwn(refused, 'reviewDigest'), refused.updates[0].members,
    Object.hasOwn(refused.updates[0], 'selectionId')], [false, false, [], false]);
  // A request in the earlier shape: an invalid replacement policy is refused the same way, in the same 1.0.0 document.
  const broken = replacementOf(selections, SKILL, { requires: ['missing'] });
  const earlier = conforms(await ask(s, [{ managementId: SKILL, replacement: broken }]));
  assert.deepEqual([earlier.schema, earlier.disposition, Object.hasOwn(earlier, 'preparation')], [UPDATE_10, 'not-prepared', false]);
  assert.equal(earlier.updates[0].disposition, 'invalid');
  assert.ok(earlier.updates[0].diagnostics.some(item => item.reason === 'missing-dependency'), JSON.stringify(earlier.updates[0].diagnostics));
});

test('the 1.1.0 schema describes the request, and its fixture is refused', () => {
  const requestSchema = ajv.getSchema(`${UPDATE_11}#/$defs/request`);
  const selection = recipeless(realSelections().find(item => item.id === GUARD));
  const body = { target: { project: '/project' }, scope: 'project', updates: [{ managementId: GUARD, replacement: selection }] };
  assert.equal(requestSchema({ ...body, policy: { schema: POLICY_16, catalogReleases: [release('extensions')] } }), true, JSON.stringify(requestSchema.errors));
  assert.equal(requestSchema({ ...body, policy: { schema: POLICY_15 } }), true, 'a recipe-less selection needs no schema here; Prepare refuses it in 1.5.0');
  assert.equal(requestSchema({ ...body, policy: { schema: POLICY_16, mode: 'vibe' } }), false);
  assert.equal(requestSchema({ ...body, policy: { schema: 'urn:aihq:core:execution-policy:1.3.0' } }), false);
  const validate = ajv.getSchema(UPDATE_11);
  assert.equal(validate(JSON.parse(readFileSync(new URL('../dist/fixtures/core/managed-update-preparation/1.1.0/refuse.json', import.meta.url), 'utf8'))), false);
});
