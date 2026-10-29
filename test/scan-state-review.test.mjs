// Execution policy 1.5.0 → prepared work 1.7.0 → run result 1.5.0. Each selection names its framework, layout and a scan
// state Core checked against the selection's own bytes and the artifact's capture; evidence for other bytes is never
// "authenticated"; and the Apply re-check names its change from the owner's closed list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { apply, prepare } from '../dist/core/index.js';
import { validatePolicy } from '../dist/core/contracts.js';
import { renderDelivery, toolBindings } from '../dist/harness/contracts.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-scan-state-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const FRAMEWORK = 'example-framework';
const POLICY_15 = 'urn:aihq:core:execution-policy:1.5.0';
const SKILL = '---\nname: grill-me\ndescription: Ask hard questions\n---\nGrill the plan.\n';
const OTHER = '---\nname: other\ndescription: Something else\n---\nOther bytes.\n';

/** A Catalog release item with one content file and its behaviour file (the consumer fixture's shape). */
function catalogItem(id, files) {
  const content = Object.entries(files).map(([relPath, text], index) => ({ id: `m${index}`, relPath, sourcePath: relPath,
    packagePath: `release/items/${id}/${relPath}`, sha256: sha256(text), byteLength: Buffer.byteLength(text), executable: false,
    sourceId: 'upstream', role: 'content', size: { bytes: Buffer.byteLength(text), chars: text.length, status: 'measured' } }));
  const payload = { dirName: id, invocation: 'model-allowed', invocationBasis: 'authored frontmatter' };
  const dependencies = { requires: [], optional: [], conflicts: [] }, requirements = { inputs: {} };
  const executable = Object.fromEntries(content.map(member => [member.relPath, false]));
  const behaviourText = `${canonical({ kind: 'skill', payload, requirements, dependencies, executable })}\n`;
  const behaviour = { id: 'behaviour', relPath: 'aih-behaviour.json', sourcePath: null, packagePath: `release/items/${id}/aih-behaviour.json`,
    sha256: sha256(behaviourText), byteLength: Buffer.byteLength(behaviourText), executable: false, sourceId: FRAMEWORK, role: 'behaviour' };
  const lines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`).sort().join('');
  return { id, label: id, kind: 'skill', sourceIds: ['upstream'], targets: [], scopes: ['project'], inputs: {},
    recipe: { id, schema: 'urn:aihq:core:recipe:1.0.0', path: `release/recipes/${id}.json`, sha256: sha256(`${id}-recipe`), byteLength: 900 },
    materials: [...content, behaviour], dependencies, requirements, executable, payload,
    contentSha256: sha256(lines(content)), behaviourSha256: sha256(lines([...content, behaviour])) };
}
const grill = catalogItem('grill-me', { 'SKILL.md': SKILL });
const ref = item => ({ framework: FRAMEWORK, itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 });
const claude = toolBindings.find(binding => binding.tool === 'claude');

/** A Scan item record for `item` claiming `files` (relPath → text) were captured. */
const itemRecord = (scanId, item, files, extra = {}) => ({ schema: 'urn:aihq:scan:item-record:1.0.0', scanId, createdAt: '2026-10-28T09:00:00Z',
  evidenceKey: sha256(scanId), subject: { frameworkId: FRAMEWORK, itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 },
  authenticity: 'unchecked', materials: [...Object.entries(files).map(([relPath, text], index) => ({ materialId: `m${index}`, relPath,
    sha256: sha256(text), byteLength: Buffer.byteLength(text), executable: false, captured: true })),
  { materialId: '#payload', relPath: '#payload', sha256: item.behaviourSha256, byteLength: 64, executable: false, captured: true }],
  completion: 'complete', coverage: 'matched', severityProfile: 'aih-default',
  detectors: [{ id: 'secrets', version: '1.0.0', outcome: 'succeeded', coverage: 'matched', exclusions: [],
    findings: { error: 0, warning: 2, note: 1, unavailable: 0 }, suppressed: [{ rule: 'example-token', count: 3, reason: 'Documented example' }] }],
  ...extra });

/** A signed Scan artifact whose report captured `files` (relPath → text). Test-only key; never product trust. */
function scanArtifact(files, { signed = true } = {}) {
  const entries = Object.entries(files).map(([path, text]) => ({ byteLength: Buffer.byteLength(text), kind: 'file', path, sha256: sha256(text) }))
    .sort((a, b) => a.path < b.path ? -1 : 1);
  const capture = { profile: 'aih-source-capture-1', entries };
  capture.captureSha256 = sha256(canonical({ domain: 'aih.scan.capture.v1', profile: capture.profile, entries }));
  const report = Buffer.from(canonical({ schema: 'urn:aihq:scan:report:1.0.0', createdAt: '2026-10-28T09:00:00Z', completion: 'complete',
    source: { kind: 'local', capture }, selection: { paths: entries.map(entry => entry.path), excludedPaths: [] }, results: [] }));
  const scanId = `scan:sha256:${sha256(Buffer.concat([Buffer.from('aih.scan.report.v1\0'), report]))}`;
  const artifact = { schema: 'urn:aihq:scan:artifact:1.0.0', scanId, report: { schema: 'urn:aihq:scan:report:1.0.0', mediaType: 'application/json',
    sha256: sha256(report), byteLength: report.length, bytesBase64: report.toString('base64') }, annexes: [] };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = `ed25519:${sha256(spki)}`;
  if (signed) {
    const statement = { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: 'scan-report', digest: { sha256: sha256(report) } }],
      predicateType: 'urn:aihq:scan:artifact-attestation:1.0.0',
      predicate: { scanId, reportSchema: artifact.report.schema, reportByteLength: report.length, annexManifestSha256: sha256(canonical([])) } };
    const payload = Buffer.from(JSON.stringify(statement));
    const payloadType = 'application/vnd.in-toto+json';
    const signature = sign(null, Buffer.concat([Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `), payload]), privateKey);
    artifact.attestation = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', verificationMaterial: { publicKey: { hint: keyId }, tlogEntries: [] },
      dsseEnvelope: { payloadType, payload: payload.toString('base64'), signatures: [{ keyid: keyId, sig: signature.toString('base64') }] } };
  }
  return { scanId, bytes: Buffer.from(canonical(artifact)),
    trust: { keys: [{ identity: 'TEST-ONLY-scan', keyId, publicKeySpkiBase64: spki.toString('base64') }], publishers: [] } };
}

let count = 0;
function workspace() {
  const work = join(scratch, `w${++count}`), catalog = join(work, 'catalog'), project = join(work, 'project');
  mkdirSync(project, { recursive: true });
  for (const member of grill.materials.filter(entry => entry.role === 'content')) {
    mkdirSync(dirname(join(catalog, member.packagePath)), { recursive: true });
    writeFileSync(join(catalog, member.packagePath), SKILL);
  }
  return { work, catalog, project: realpathSync.native(project) };
}
/** Writes each artifact beside the project and names it as policy evidence. */
function evidenceFor(work, artifacts) {
  return artifacts.map((artifact, index) => {
    const path = join(work, `scan-${index}.json`);
    writeFileSync(path, artifact.bytes);
    return { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: artifact.scanId, location: { kind: 'file', path } };
  });
}
function policy15({ records, evidence, bindingDigest, excludedItems } = {}) {
  const rendered = renderDelivery({ tool: 'claude', item: grill, binding: claude, scope: 'project' });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  return { schema: POLICY_15, mode: 'vibe', selections: [{ id: 'grill', managementId: 'grill-managed', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: rendered.recipe }, item: ref(grill), tool: 'claude', name: 'Grill me', kind: 'skill', origins: [{ reasonIncluded: 'chosen' }],
    ...(records ? { scanRecords: records } : {}), ...(bindingDigest ? { bindingDigest } : {}) }],
    ...(evidence ? { evidence } : {}), ...(excludedItems ? { excludedItems } : {}) };
}
const controls = (catalog, extra = {}) => ({ logging: 'off', materialRoots: { catalog }, ...extra });
const ask = (policy, project, hostControls) => prepare({ useCase: 'policy', policy, target: { project } }, hostControls);
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const id of ['prepared-work/1.4.0', 'prepared-work/1.7.0', 'run-result/1.5.0', 'execution-policy/1.5.0'])
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../dist/core/schemas/${id}.json`, import.meta.url))));
const conforms = (document, id) => {
  const validate = ajv.getSchema(id);
  assert.equal(validate(JSON.parse(JSON.stringify(document))), true, `${id}: ${JSON.stringify(validate.errors)}`);
  return document;
};
const review17 = prepared => conforms(prepared.review, 'urn:aihq:core:prepared-work:1.7.0').selections[0];

test('a checked record names the scan, its coverage and Scan summary; never "verified" without a trust policy', async () => {
  const { work, catalog, project } = workspace();
  const artifact = scanArtifact({ 'SKILL.md': SKILL });
  const policy = policy15({ records: [itemRecord(artifact.scanId, grill, { 'SKILL.md': SKILL })], evidence: evidenceFor(work, [artifact]),
    excludedItems: [{ framework: FRAMEWORK, itemId: 'git-guard' }] });
  assert.equal(validatePolicy(policy).valid, true, JSON.stringify(validatePolicy(policy)));
  const prepared = await ask(policy, project, controls(catalog, { evidence: { acquire: true, trust: artifact.trust } }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const selection = review17(prepared);
  assert.equal(selection.framework, FRAMEWORK);
  assert.deepEqual(selection.layout, { bindingDigest: claude.digest, support: 'native', observed: 'recognised' });
  assert.equal(selection.scanId, artifact.scanId);
  assert.equal(selection.coverage, 'matched');
  assert.deepEqual(selection.scanState, { state: 'not-verified', why: 'unchecked', findings: { error: 0, warning: 2, note: 1, unavailable: 0 },
    suppressed: 3, scannedAt: '2026-10-28T09:00:00Z' });
  assert.deepEqual(prepared.review.excluded, [{ item: { framework: FRAMEWORK, itemId: 'git-guard' }, reason: 'excluded-in-request' }]);
  assert.equal(prepared.review.evidence[0].status, 'authenticated', 'evidence covering the selection keeps its authentication');
  const run = await apply(prepared.prepared, approve(prepared), controls(catalog, { evidence: { acquire: true, trust: artifact.trust } }));
  conforms(run, 'urn:aihq:core:run-result:1.5.0');
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.equal(run.evidence[0].status, 'authenticated');
});

test('a real scan of other bytes, relabelled as this item, is not-covered and its evidence is never "authenticated"', async () => {
  const { work, catalog, project } = workspace();
  // The artifact is genuine and signed, but it captured OTHER.md, not grill-me's SKILL.md.
  const artifact = scanArtifact({ 'SKILL.md': OTHER });
  const relabelled = itemRecord(artifact.scanId, grill, { 'SKILL.md': OTHER });
  // A record that lists grill-me's own bytes while the artifact captured others fails on the artifact side too.
  const misreported = itemRecord(artifact.scanId, grill, { 'SKILL.md': SKILL }, { createdAt: '2026-10-28T10:00:00Z' });
  for (const record of [relabelled, misreported]) {
    const prepared = await ask(policy15({ records: [record], evidence: evidenceFor(work, [artifact]) }), project,
      controls(catalog, { evidence: { acquire: true, trust: artifact.trust } }));
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    const selection = review17(prepared);
    assert.equal(selection.scanState.state, 'not-covered');
    assert.equal(selection.scanId, undefined, 'no record counts, so none is named');
    assert.deepEqual(prepared.review.evidence, [{ scanId: artifact.scanId, status: 'unverifiable', reason: 'not-covered' }]);
    assert.ok(!JSON.stringify(prepared.review).includes('"authenticated"'));
  }
});

test('scan states follow Scan\'s decision table: not-scanned, unreadable, partial, not-covered coverage and not-authenticated', async () => {
  const { work, catalog, project } = workspace();
  const artifact = scanArtifact({ 'SKILL.md': SKILL });
  const evidence = evidenceFor(work, [artifact]);
  const state = async (records, evidenceControls = { acquire: true, trust: artifact.trust }) => {
    const prepared = await ask(policy15({ records, evidence }), project, controls(catalog, { evidence: evidenceControls }));
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    return review17(prepared);
  };
  const record = itemRecord(artifact.scanId, grill, { 'SKILL.md': SKILL });
  assert.equal((await state(undefined)).scanState.state, 'not-scanned');
  // The artifact was not acquired, so the record cannot be checked against it.
  assert.equal((await state([record], {})).scanState.state, 'unreadable');
  assert.equal((await state([itemRecord(`scan:sha256:${'9'.repeat(64)}`, grill, { 'SKILL.md': SKILL })])).scanState.state, 'unreadable');
  const partial = await state([{ ...record, completion: 'partial' }]);
  assert.equal(partial.scanState.state, 'partial'); assert.equal(partial.scanId, artifact.scanId);
  const mismatched = await state([{ ...record, coverage: 'mismatched' }]);
  assert.equal(mismatched.scanState.state, 'not-covered'); assert.equal(mismatched.coverage, 'mismatched');
  // A record about another item's identity never counts, whatever bytes it lists.
  assert.equal((await state([{ ...record, subject: { ...record.subject, behaviourSha256: 'f'.repeat(64) } }])).scanState.state, 'not-covered');
  const untrusted = await state([record], { acquire: true });
  assert.deepEqual([untrusted.scanState.state, untrusted.scanState.why], ['not-verified', 'not-authenticated']);
  // A matched, complete record outranks a newer partial one.
  const picked = await state([{ ...record, completion: 'partial', createdAt: '2026-10-29T09:00:00Z' }, record]);
  assert.equal(picked.scanState.state, 'not-verified');
});

test('every REVIEW_STALE change is named from the owner\'s closed list: policy, index-status, scan-state, binding, target-file', async () => {
  const changed = async (mutate, { bindingDigest, prepareIndex, applyIndex } = {}) => {
    const { work, catalog, project } = workspace();
    const artifact = scanArtifact({ 'SKILL.md': SKILL });
    const evidence = evidenceFor(work, [artifact]);
    const policy = policy15({ records: [itemRecord(artifact.scanId, grill, { 'SKILL.md': SKILL })], evidence, bindingDigest });
    const evidenceControls = { acquire: true, trust: artifact.trust };
    const prepared = await ask(policy, project, controls(catalog, { evidence: evidenceControls, ...(prepareIndex ? { index: prepareIndex } : {}) }));
    assert.ok(prepared.prepared, JSON.stringify(prepared.diagnostics));
    await mutate({ work, catalog, project, policy, evidence });
    const run = await apply(prepared.prepared, approve(prepared), controls(catalog, { evidence: evidenceControls, ...(applyIndex ? { index: applyIndex } : {}) }));
    conforms(run, 'urn:aihq:core:run-result:1.5.0');
    assert.equal(run.completion, 'rejected');
    const stale = run.diagnostics.filter(item => item.code === 'REVIEW_STALE');
    assert.equal(stale.length, 1, JSON.stringify(run.diagnostics));
    return { changed: stale[0].changed, prepared, project };
  };
  const nothing = async () => {};
  assert.equal((await changed(({ policy }) => { policy.selections[0].name = 'Renamed'; })).changed, 'policy');
  const offered = { offered: [ref(grill)] };
  assert.equal((await changed(nothing, { prepareIndex: offered, applyIndex: { ...offered, revoked: [{ framework: FRAMEWORK, itemId: grill.id }] } })).changed,
    'index-status');
  assert.equal((await changed(nothing, { prepareIndex: offered })).changed, 'index-status', 'an index withdrawn at Apply is a change');
  assert.equal((await changed(({ evidence }) => writeFileSync(evidence[0].location.path, scanArtifact({ 'SKILL.md': OTHER }).bytes))).changed, 'scan-state');
  const rebound = await changed(nothing, { bindingDigest: 'e'.repeat(64) });
  assert.equal(rebound.changed, 'binding');
  assert.ok(rebound.prepared.review.conflicts.some(item => item.reason === 'binding-changed'), 'the preview already says the recipe was rendered for another binding');
  assert.equal(review17(rebound.prepared).layout.bindingDigest, 'e'.repeat(64));
  // The captured material changed: how the item is installed changed.
  assert.equal((await changed(({ catalog }) => writeFileSync(join(catalog, grill.materials[0].packagePath), OTHER))).changed, 'binding');
  assert.equal((await changed(({ project }) => {
    mkdirSync(join(project, '.claude', 'skills', 'grill-me'), { recursive: true });
    writeFileSync(join(project, '.claude', 'skills', 'grill-me', 'SKILL.md'), 'Mine.\n');
  })).changed, 'target-file');
});

test('run result 1.5.0 admits only the owner\'s closed list; 1.4.0 keeps its published values', () => {
  const values = id => JSON.parse(readFileSync(new URL(`../dist/core/schemas/run-result/${id}.json`, import.meta.url), 'utf8'),
  ).properties.diagnostics.items.properties.changed.enum;
  assert.deepEqual(values('1.5.0'), ['policy', 'index-status', 'scan-state', 'binding', 'target-file']);
  assert.deepEqual(values('1.4.0'), ['policy', 'recipe', 'target-file', 'ownership', 'input', 'host', 'trust']);
});
