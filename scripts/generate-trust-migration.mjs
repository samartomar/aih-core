// Reproduce the single reviewed historical transition. Run after npm run build.
// This creates equivalence evidence only; it never creates native execution results.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalTrustJson } from '../src/harness/trust-source.mjs';
import { hashTrustLibraries, trustCellSubjectSha256, trustHelperFiles } from '../src/harness/trust.mjs';
import { legacyHelperNames, projectLegacyHelper, projectLegacyCore, migrationMethod, serializeMigrationPolicy } from '../src/harness/trust-migration-rules.mjs';
import { buildTrustCapabilities, trustProfiles } from '../src/harness/trust-definitions.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src/harness'); const dist = join(root, 'dist/harness');
const input = JSON.parse(readFileSync(new URL('./fixtures/trust-migration-predecessor.json', import.meta.url)));
const sha = b => createHash('sha256').update(b).digest('hex');
const digest = value => sha(Buffer.from(canonicalTrustJson(value)));
const files = input.files.map(item => ({ ...item, bytes: Buffer.from(item.bytesBase64, 'base64') }));
assert.deepEqual(files.map(item => item.name), [...legacyHelperNames]);
for (const file of files) {
  assert.equal(sha(file.bytes), file.sha256);
  const expected = projectLegacyHelper(file.name, file.bytes);
  assert.ok(expected.equals(readFileSync(join(root, file.name))), `finite installed transition: ${file.name}`);
  assert.ok(expected.equals(readFileSync(join(source, file.name.split('/').at(-1)))), `finite source transition: ${file.name}`);
}
const oldCore = Buffer.from(input.integrationCore.bytesBase64, 'base64');
assert.equal(sha(oldCore), input.integrationCore.sha256);
assert.equal(projectLegacyCore(oldCore.toString('utf8')), readFileSync(join(root, 'src/core/trust.ts'), 'utf8'), 'only the reviewed export-only Core glue changed');
const libraries = hashTrustLibraries({ packageRoot: root });
assert.equal(libraries.status, 'hashed'); assert.equal(libraries.sha256, input.librariesSha256, 'historical serializer closure is unchanged');
const records = input.records.map(item => {
  const bytes = Buffer.from(item.recordBytesBase64, 'base64'); assert.equal(sha(bytes), item.recordSha256);
  const original = JSON.parse(bytes);
  const originalLibraries = original.cell.configurationProfile === 'pkcs7-certificate-import-v1' ? libraries.sha256 : null;
  const subject = digest({ cell: original.cell, files: files.map(({ name, sha256 }) => ({ name, sha256 })), libraries: originalLibraries });
  assert.equal(subject, item.originalSubjectSha256); assert.equal(original.subjectSha256, subject);
  assert.ok(bytes.equals(readFileSync(join(source, 'acceptance', `${item.id}.json`))), 'original record stays byte-for-byte');
  return { ...item, original };
});
const existingText = readFileSync(join(source, 'trust-capabilities.mjs'), 'utf8');
const existingCells = JSON.parse(/export const trustCellRecords = Object\.freeze\(([\s\S]*)\);\s*$/.exec(existingText)[1]);
const predecessorIds = new Set(records.map(item => item.id));
const existingNative = existingCells.filter(cell => !predecessorIds.has(cell.id));
assert.ok(existingNative.length === 0 || existingNative.length === 4, 'retain only a complete separately captured new-host table');
const expectedNative = records.map(({ original }) => {
  const id = original.cell.id.replace('win32-', 'win32-26340-9767-');
  return { ...original.cell, id, platform: { ...original.cell.platform, release: 'Windows 11 26H2 build 26340.9767' } };
});
if (existingNative.length) {
  assert.deepEqual(existingNative.map(cell => cell.id).sort(), expectedNative.map(cell => cell.id).sort(), 'exact unique four native cell IDs required');
  for (const { evidence, ...cell } of existingNative) {
    assert.deepEqual(cell, expectedNative.find(item => item.id === cell.id), 'native format/network/platform tuple must match');
    assert.equal(evidence.reference, `dist/harness/acceptance/${cell.id}.json`, 'fixed native evidence path required');
  }
}
const currentFiles = trustHelperFiles.filter(name => name !== 'dist/harness/trust-migration-policy.mjs')
  .map(name => ({ name, sha256: sha(readFileSync(join(root, name))) }));
for (const item of currentFiles.filter(item => item.name.startsWith('dist/harness/'))) {
  assert.ok(readFileSync(join(root, item.name)).equals(readFileSync(join(source, item.name.split('/').at(-1)))), `build is current: ${item.name}`);
}
const proof = { method: migrationMethod, integrationBase: input.integrationBase,
  originalFiles: files.map(({ name, sha256 }) => ({ name, sha256 })), currentFiles,
  coreTransition: { originalSourceSha256: input.integrationCore.sha256, currentSourceSha256: sha(Buffer.from(projectLegacyCore(oldCore.toString('utf8')))) },
  scope: ['inert declarations and re-export removed', 'disjoint matrix row appended', 'explicit versioned migration verification', 'export-only exact-host classification and Apply recheck'],
  evidenceKind: 'equivalence-migration', oldNativeExecutionCreated: false };
const policy = { method: migrationMethod, originalFiles: proof.originalFiles, currentFiles,
  originalLibrariesSha256: libraries.sha256,
  predecessors: records.map(item => ({ id: item.id, recordSha256: item.recordSha256, subjectSha256: item.originalSubjectSha256 })),
  proof, proofSha256: digest(proof) };
writeFileSync(join(source, 'trust-migration-policy.mjs'), serializeMigrationPolicy(policy));
copyFileSync(join(source, 'trust-migration-policy.mjs'), join(dist, 'trust-migration-policy.mjs'));
const historicalCells = records.map(item => {
  const originalCell = item.original.cell;
  const cell = { ...originalCell, evidence: { reference: `dist/harness/acceptance/migration-${item.id}.json`, sha256: '', subjectSha256: '' } };
  const subject = trustCellSubjectSha256(cell, root); assert.match(subject, /^[a-f0-9]{64}$/);
  const envelope = { schema: 'aih.trust.acceptance-migration.v1', kind: 'equivalence-migration', cellId: cell.id,
    subjectSha256: subject, method: migrationMethod, proofSha256: policy.proofSha256,
    originalRecordBytes: item.recordBytesBase64, originalFiles: files.map(({ name, bytesBase64 }) => ({ name, bytesBase64 })),
    limitations: [...item.original.limitations, 'equivalence-migration-no-new-old-os-execution'] };
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n'); assert.ok(bytes.length <= 1048576);
  writeFileSync(join(source, 'acceptance', `migration-${cell.id}.json`), bytes);
  copyFileSync(join(source, 'acceptance', `migration-${cell.id}.json`), join(dist, 'acceptance', `migration-${cell.id}.json`));
  cell.evidence.sha256 = sha(bytes); cell.evidence.subjectSha256 = subject;
  return cell;
});
// Regeneration must preserve genuine new-host records, never rehash stale native outcomes.
for (const cell of existingNative) {
  assert.match(cell.id, /^export-(pem|p7b)-win32-26340-9767-(declared|off)$/);
  assert.equal(cell.platform.release, 'Windows 11 26H2 build 26340.9767');
  assert.equal(cell.route, 'export'); assert.equal(cell.platform.os, 'win32'); assert.equal(cell.platform.architecture, 'x64');
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
const cells = [...historicalCells, ...existingNative];
const moduleBytes = '// Static admission data: excluded from helper/evidence subject hashing.\nexport const trustCellRecords = Object.freeze(' + JSON.stringify(cells, null, 2) + ');\n';
writeFileSync(join(source, 'trust-capabilities.mjs'), moduleBytes); copyFileSync(join(source, 'trust-capabilities.mjs'), join(dist, 'trust-capabilities.mjs'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
const fixtureBytes = JSON.stringify(buildTrustCapabilities(pkg, cells), null, 2) + '\n';
writeFileSync(join(root, 'src/fixtures/harness/trust-capabilities/1.0.0/accept.json'), fixtureBytes);
writeFileSync(join(root, 'dist/fixtures/harness/trust-capabilities/1.0.0/accept.json'), fixtureBytes);
console.log(JSON.stringify({ kind: 'equivalence-migration', originalSubjectsVerified: historicalCells.length, retainedNativeCells: existingNative.length, proofSha256: policy.proofSha256, nativeExecutionsCreated: 0 }));
