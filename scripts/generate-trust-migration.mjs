// Reproduce the reviewed asn1js/pkijs 4 and exact export-host transition. Run after npm run build.
// This creates equivalence evidence only; it never creates native execution results.
//
//   node scripts/generate-trust-migration.mjs
//     Regenerates the v2 policy, the eight v2 envelopes and the admission table from the recorded predecessor.
//   node scripts/generate-trust-migration.mjs --record-predecessor <installed package> --commit <sha> --core-source <trust.ts> --tgz <file>
//     Records the predecessor (its helper bytes, serializer closure and per-case outputs) from its own packed artifact.
// The historical asn1js/pkijs 3 transition (method core81-...) is frozen: its policy and envelopes stay byte-exact.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { canonicalTrustJson } from '../src/harness/trust-source.mjs';
import { hashTrustLibraries, trustCellSubjectSha256, trustHelperFiles } from '../src/harness/trust.mjs';
import { trustMigrationPolicy as v1Policy } from '../src/harness/trust-migration-policy.mjs';
import { migrationV2Method, migrationV2Schema, migrationV2Limitation, predecessorTransitions, projectPredecessorHelper,
  projectPredecessorCoreSource, serializeMigrationV2Policy } from '../src/harness/trust-migration-v2.mjs';
import { buildTrustCapabilities, trustProfiles } from '../src/harness/trust-definitions.mjs';
import { exactExportHosts } from '../src/harness/trust-export-platform.mjs';
import { observeExportCases } from './trust-export-cases.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src/harness'); const dist = join(root, 'dist/harness');
const fixtureFile = fileURLToPath(new URL('./fixtures/trust-migration-v2-predecessor.json', import.meta.url));
const certificates = join(root, 'test/harness/fixtures');
const sha = b => createHash('sha256').update(b).digest('hex');
const digest = value => sha(Buffer.from(canonicalTrustJson(value)));
const { values: options } = parseArgs({ options: { 'record-predecessor': { type: 'string' }, commit: { type: 'string' },
  'core-source': { type: 'string' }, tgz: { type: 'string' } } });

if (options['record-predecessor']) {
  const installed = options['record-predecessor'];
  assert.match(options.commit ?? '', /^[a-f0-9]{40}$/, '--commit is the predecessor source commit');
  const load = name => import(pathToFileURL(join(installed, 'dist/harness', name)).href);
  const { trustHelperFiles: names, hashTrustLibraries: hashLibraries } = await load('trust.mjs');
  const { trustCellRecords: cells } = await load('trust-capabilities.mjs');
  const libraries = hashLibraries({ packageRoot: installed }); assert.equal(libraries.status, 'hashed');
  const core = readFileSync(options['core-source']); const tgz = readFileSync(options.tgz);
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
  const record = { schema: 'aih.trust.migration-v2-predecessor.v1', commit: options.commit,
    package: { name: manifest.name, version: manifest.version, tgzSha256: sha(tgz), tgzSize: tgz.length },
    files: names.map(name => { const bytes = readFileSync(join(installed, name));
      return { name, sha256: sha(bytes), ...(Object.hasOwn(predecessorTransitions, name) ? { bytesBase64: bytes.toString('base64') } : {}) }; }),
    coreSource: { name: 'src/core/trust.ts', sha256: sha(core), bytesBase64: core.toString('base64') },
    libraries: { sha256: libraries.sha256, packages: libraries.packages }, cells,
    observations: await observeExportCases(installed, certificates) };
  writeFileSync(fixtureFile, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ recorded: fixtureFile, commit: record.commit, files: record.files.length, librariesSha256: libraries.sha256 }));
  process.exit(0);
}

const input = JSON.parse(readFileSync(fixtureFile));
assert.equal(input.schema, 'aih.trust.migration-v2-predecessor.v1');
// 1. Implementation: every predecessor helper is unchanged or reaches the current bytes through its listed finite steps.
const files = input.files.map(item => ({ ...item, bytes: item.bytesBase64 === undefined ? null : Buffer.from(item.bytesBase64, 'base64') }));
assert.deepEqual(files.filter(item => item.bytes).map(item => item.name).sort(), Object.keys(predecessorTransitions).sort(), 'exactly the transitioned helpers are embedded');
for (const file of files) {
  const current = readFileSync(join(root, file.name));
  if (!file.bytes) { assert.equal(sha(current), file.sha256, `unchanged predecessor helper: ${file.name}`); continue; }
  assert.equal(sha(file.bytes), file.sha256);
  const expected = projectPredecessorHelper(file.name, file.bytes);
  assert.ok(expected.equals(current), `finite installed transition: ${file.name}`);
  if (file.name.startsWith('dist/harness/')) assert.ok(expected.equals(readFileSync(join(source, file.name.slice('dist/harness/'.length)))), `finite source transition: ${file.name}`);
}
const oldCore = Buffer.from(input.coreSource.bytesBase64, 'base64'); assert.equal(sha(oldCore), input.coreSource.sha256);
assert.equal(projectPredecessorCoreSource(oldCore.toString('utf8')), readFileSync(join(root, 'src/core/trust.ts'), 'utf8'), 'only the reviewed exact-host Core recheck changed');
const added = trustHelperFiles.filter(name => !files.some(item => item.name === name));
assert.deepEqual(added, ['dist/harness/trust-migration-v2.mjs', 'dist/harness/trust-migration-v2-policy.mjs'], 'only the v2 verifier and its policy are new helpers');
// 2. Serializer closure: the predecessor is the historical closure; the current one is hashed as installed.
assert.equal(input.libraries.sha256, v1Policy.originalLibrariesSha256, 'predecessor serializer closure is the historical one');
const libraries = hashTrustLibraries({ packageRoot: root }); assert.equal(libraries.status, 'hashed');
// 3. Finite outputs: every installed profile case observes identical bytes and fingerprints under both closures.
const current = await observeExportCases(root, certificates);
for (const id of ['export-pem-parse-v1', 'export-p7b-parse-v1']) {
  assert.deepEqual(current.profiles[id].map(item => item.id), trustProfiles[id].requiredCases.map(item => item.id), `${id}: every installed case`);
  assert.ok(isDeepStrictEqual(current.profiles[id], input.observations.profiles[id]), `${id}: predecessor and current case outputs are identical`);
}
assert.deepEqual([current.profiles['export-pem-parse-v1'].length, current.profiles['export-p7b-parse-v1'].length], [9, 11]);
assert.deepEqual(current.fixtures, input.observations.fixtures);
const supplementary = input.observations.supplementary;
// The proof states the supplementary sets were compared, so regeneration refuses rather than silently skipping them.
const supplementaryMatched = supplementary.nodeBundledRootsSha256 === current.supplementary.nodeBundledRootsSha256;
assert.ok(supplementaryMatched, `supplementary comparison requires the recorded Node bundled roots (${supplementary.node}); this runtime is ${current.supplementary.node}`);
assert.ok(isDeepStrictEqual(current.supplementary.results, supplementary.results), 'supplementary differential is identical');
// 4. Predecessor records: shipped bytes are unchanged and still bind their recorded predecessor subjects.
const predecessorFiles = files.map(({ name, sha256 }) => ({ name, sha256 }));
const subjectFiles = [...predecessorFiles].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
assert.equal(input.cells.length, 8, 'four historical migrations and four native records');
const v1Fixture = JSON.parse(readFileSync(new URL('./fixtures/trust-migration-predecessor.json', import.meta.url)));
const records = input.cells.map(cell => {
  const bytes = readFileSync(join(source, cell.evidence.reference.replace(/^dist\/harness\//, '')));
  assert.equal(sha(bytes), cell.evidence.sha256, `historical record stays byte-for-byte: ${cell.id}`);
  const record = JSON.parse(bytes); const { evidence, ...tested } = cell;
  const serialized = trustProfiles[cell.probeProfile].libraries;
  assert.equal(digest({ cell: tested, files: subjectFiles, libraries: serialized ? input.libraries.sha256 : null }), evidence.subjectSha256, `predecessor subject: ${cell.id}`);
  assert.equal(record.subjectSha256, evidence.subjectSha256); assert.equal(record.cellId, cell.id);
  if (record.schema === 'aih.trust.acceptance-migration.v1') {
    const original = v1Fixture.records.find(item => item.id === cell.id);
    assert.equal(record.originalRecordBytes, original.recordBytesBase64, 'v1 envelope wraps the original historical record');
  } else assert.equal(record.schema, 'aih.trust.acceptance.v1');
  return { cell, bytes, record };
});
// 5. Policy and proof: bind every current helper byte, both closures and the compared outputs.
const currentFiles = trustHelperFiles.filter(name => name !== 'dist/harness/trust-migration-v2-policy.mjs')
  .map(name => ({ name, sha256: sha(readFileSync(join(root, name))) }));
for (const item of currentFiles.filter(item => item.name.startsWith('dist/harness/')))
  assert.ok(readFileSync(join(root, item.name)).equals(readFileSync(join(source, item.name.slice('dist/harness/'.length)))), `build is current: ${item.name}`);
const proof = { method: migrationV2Method, predecessorCommit: input.commit, predecessorPackage: input.package,
  predecessorFiles, currentFiles,
  transitions: Object.keys(predecessorTransitions).sort().map(name => ({ name, steps: predecessorTransitions[name].length })),
  coreTransition: { predecessorSourceSha256: input.coreSource.sha256, currentSourceSha256: sha(readFileSync(join(root, 'src/core/trust.ts'))) },
  libraries: { predecessor: input.libraries, current: { sha256: libraries.sha256, packages: libraries.packages } },
  caseComparison: { fixtures: current.fixtures, profiles: Object.fromEntries(Object.entries(current.profiles).map(([id, cases]) =>
    [id, cases.map(item => ({ id: item.id, kind: item.kind, predecessorSha256: digest(input.observations.profiles[id].find(old => old.id === item.id)),
      currentSha256: digest(item), identical: true }))])) },
  supplementaryComparison: { recordedNode: supplementary.node, nodeBundledRootsSha256: supplementary.nodeBundledRootsSha256,
    resultsSha256: digest(supplementary.results), sets: supplementary.results.map(({ set, format, certificates: count, bytesSha256 }) => ({ set, format, certificates: count, bytesSha256 })) },
  scope: ['asn1js 3.0.10 to 4.1.0 and pkijs 3.4.1 to 4.0.1 with the hashed closure following the installed one',
    'hashed closure fails closed on an unhashed dependency', 'explicit versioned v2 migration verification and v1 predecessor reader',
    'exact Windows 11 Dev build 29695.1001 export-host classification, matrix row and Apply recheck'],
  limits: ['equal outputs are proved only for the recorded finite fixture cases and supplementary sets, not for every possible certificate set',
    'library equivalence is output equivalence; asn1js and pkijs source is not compared',
    'no native, Windows store, Prepare or Apply execution was performed for this proof',
    'historical platforms are not re-executed; their original limitations are retained'],
  evidenceKind: 'equivalence-migration', newNativeExecutionCreated: false };
const policy = { method: migrationV2Method, predecessorFiles, currentFiles,
  predecessorLibrariesSha256: input.libraries.sha256, currentLibrariesSha256: libraries.sha256,
  predecessors: records.map(({ cell, bytes, record }) => ({ id: cell.id, schema: record.schema, recordSha256: sha(bytes), subjectSha256: cell.evidence.subjectSha256 })),
  proof, proofSha256: digest(proof) };
writeFileSync(join(source, 'trust-migration-v2-policy.mjs'), serializeMigrationV2Policy(policy));
copyFileSync(join(source, 'trust-migration-v2-policy.mjs'), join(dist, 'trust-migration-v2-policy.mjs'));
// 6. Envelopes: the exact predecessor record plus the changed predecessor helpers; the same tuple, newly bound subject.
const embedded = files.filter(item => item.bytes);
const migratedCells = records.map(({ cell, bytes, record }) => {
  const { evidence, ...tested } = cell;
  const migrated = { ...tested, evidence: { reference: `dist/harness/acceptance/migration-v2-${cell.id}.json`, sha256: '', subjectSha256: '' } };
  const subject = trustCellSubjectSha256(migrated, root); assert.match(subject, /^[a-f0-9]{64}$/);
  const envelope = { schema: migrationV2Schema, kind: 'equivalence-migration', cellId: cell.id, subjectSha256: subject,
    method: migrationV2Method, proofSha256: policy.proofSha256, predecessorRecordBytes: bytes.toString('base64'),
    predecessorFiles: embedded.map(({ name, bytesBase64 }) => ({ name, bytesBase64 })),
    limitations: [...record.limitations, migrationV2Limitation] };
  const out = Buffer.from(JSON.stringify(envelope, null, 2) + '\n'); assert.ok(out.length <= 1048576);
  writeFileSync(join(source, 'acceptance', `migration-v2-${cell.id}.json`), out);
  copyFileSync(join(source, 'acceptance', `migration-v2-${cell.id}.json`), join(dist, 'acceptance', `migration-v2-${cell.id}.json`));
  migrated.evidence.sha256 = sha(out); migrated.evidence.subjectSha256 = subject;
  return migrated;
});
// 7. Exact-host native cells: only a complete, freshly captured four-cell table for the new host is retained.
const nativeHost = exactExportHosts.at(-1);
const nativeSuffix = `win32-${nativeHost.currentBuild}-${nativeHost.ubr}-`;
const existingText = readFileSync(join(source, 'trust-capabilities.mjs'), 'utf8');
const existingCells = JSON.parse(/export const trustCellRecords = Object\.freeze\(([\s\S]*)\);\s*$/.exec(existingText)[1]);
const predecessorIds = new Set(records.map(item => item.cell.id));
const existingNative = existingCells.filter(cell => !predecessorIds.has(cell.id));
assert.ok(existingNative.length === 0 || existingNative.length === 4, 'retain only a complete separately captured new-host table');
const expectedNative = records.filter(({ cell }) => cell.platform.release === 'Windows 11 25H2').map(({ cell: { evidence, ...cell } }) =>
  ({ ...cell, id: cell.id.replace('win32-', nativeSuffix), platform: { ...cell.platform, release: nativeHost.release } }));
assert.equal(expectedNative.length, 4);
if (existingNative.length) {
  assert.deepEqual(existingNative.map(cell => cell.id).sort(), expectedNative.map(cell => cell.id).sort(), 'exact unique four native cell IDs required');
  for (const { evidence, ...cell } of existingNative) {
    assert.deepEqual(cell, expectedNative.find(item => item.id === cell.id), 'native format/network/platform tuple must match');
    assert.equal(evidence.reference, `dist/harness/acceptance/${cell.id}.json`, 'fixed native evidence path required');
  }
}
for (const cell of existingNative) {
  const subject = trustCellSubjectSha256(cell, root); assert.equal(subject, cell.evidence.subjectSha256, 'changed native subject requires a fresh run');
  const bytes = readFileSync(join(root, cell.evidence.reference.replace(/^dist\//, 'src/')));
  assert.equal(sha(bytes), cell.evidence.sha256); const record = JSON.parse(bytes);
  assert.equal(record.schema, 'aih.trust.acceptance.v1'); assert.equal(record.subjectSha256, subject);
  const { evidence, ...tested } = cell;
  assert.equal(record.cellId, cell.id, 'native record ID must match');
  assert.deepEqual(record.cell, tested, 'native record cell must match');
  assert.ok(!record.limitations.some(value => /synthetic|controlled-platform-selection|no-new-native-os-evidence/.test(value)));
  const required = trustProfiles[cell.probeProfile].requiredCases;
  assert.deepEqual(record.cases.map(item => [item.id,item.kind]).sort(), required.map(item => [item.id,item.kind]).sort());
  assert.ok(record.cases.every(item => item.outcome === 'passed' && !/synthetic/i.test(item.summary)));
}
const cells = [...migratedCells, ...existingNative];
const moduleBytes = '// Static admission data: excluded from helper/evidence subject hashing.\nexport const trustCellRecords = Object.freeze(' + JSON.stringify(cells, null, 2) + ');\n';
writeFileSync(join(source, 'trust-capabilities.mjs'), moduleBytes); copyFileSync(join(source, 'trust-capabilities.mjs'), join(dist, 'trust-capabilities.mjs'));
const acceptFile = 'fixtures/harness/trust-capabilities/1.0.0/accept.json';
const fixtureBytes = JSON.stringify(buildTrustCapabilities(JSON.parse(readFileSync(join(root, 'src', acceptFile))).package, cells), null, 2) + '\n';
writeFileSync(join(root, 'src', acceptFile), fixtureBytes); writeFileSync(join(root, 'dist', acceptFile), fixtureBytes);
console.log(JSON.stringify({ kind: 'equivalence-migration', method: migrationV2Method, predecessorRecordsVerified: records.length,
  migratedCells: migratedCells.length, retainedNativeCells: existingNative.length, casesCompared: { pem: 9, p7b: 11 },
  supplementaryCompared: supplementaryMatched, proofSha256: policy.proofSha256, nativeExecutionsCreated: 0 }));
