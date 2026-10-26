import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { trustCapabilities } from '../../dist/harness/contracts.mjs';
import { trustHelperFiles, trustCellSubjectSha256, verifyTrustAdmissionEvidence } from '../../src/harness/trust.mjs';
import { classifyCertificateExportPlatform, exactExportRelease } from '../../src/harness/trust-export-platform.mjs';
import { buildTrustDefinitions, selectTrustCell } from '../../src/harness/trust-definitions.mjs';
const source = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(run) {
  mkdirSync(join(source, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(source, '.scratch', 'migration-'));
  try {
    for (const name of trustHelperFiles) { mkdirSync(dirname(join(root, name)), { recursive: true }); cpSync(join(source, name), join(root, name)); }
    for (const cell of trustCapabilities.cells) cpSync(join(source, cell.evidence.reference), join(root, cell.evidence.reference));
    const capabilities = structuredClone(trustCapabilities);
    const verify = () => verifyTrustAdmissionEvidence({ packageRoot: root, capabilities });
    const change = (edit, index = 0) => {
      const cell = capabilities.cells[index]; const path = join(root, cell.evidence.reference);
      const record = JSON.parse(readFileSync(path)); edit(record);
      record.subjectSha256 = trustCellSubjectSha256(cell, root); cell.evidence.subjectSha256 = record.subjectSha256;
      const bytes = Buffer.from(JSON.stringify(record)); writeFileSync(path, bytes); cell.evidence.sha256 = sha(bytes);
    };
    return run({ root, capabilities, verify, change });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('migration validates exact current bytes while retaining original record bytes and limitations', () => fixture(({ verify }) => assert.deepEqual(verify(), { valid: true, diagnostics: [] })));
test('a null evidence document is refused without throwing', () => fixture(({ root, capabilities, verify }) => {
  const bytes = Buffer.from('null'); const cell = capabilities.cells[0];
  writeFileSync(join(root, cell.evidence.reference), bytes); cell.evidence.sha256 = sha(bytes);
  assert.equal(verify().valid, false);
}));
for (const [name, edit] of [
  ['changed old outcome', r => { const old = JSON.parse(Buffer.from(r.originalRecordBytes, 'base64')); old.cases[0].outcome = 'failed'; r.originalRecordBytes = Buffer.from(JSON.stringify(old)).toString('base64'); }],
  ['unrecognized method', r => { r.method = 'caller-says-equivalent'; }],
  ['unrecognized proof digest', r => { r.proofSha256 = '0'.repeat(64); }],
  ['removed limitations', r => { r.limitations = []; }],
  ['unrecognized old preimage', r => { r.originalFiles[0].bytesBase64 = Buffer.from('untrusted').toString('base64'); }],
  ['duplicate preimage name', r => { r.originalFiles[0].name = r.originalFiles[1].name; }],
  ['missing preimage', r => { r.originalFiles.pop(); }],
  ['noncanonical base64', r => { r.originalRecordBytes += '\n'; }],
  ['extra asserted outcome', r => { r.cases = [{ outcome: 'passed' }]; }],
  ['new execution claim', r => { r.kind = 'native-execution'; }]
]) test(`migration refuses ${name} even after the outer record is rehashed`, () => fixture(({ change, verify }) => { change(edit); assert.equal(verify().valid, false); }));
for (const file of ['dist/harness/trust.mjs', 'dist/harness/trust-export-platform.mjs', 'dist/harness/trust-migration-policy.mjs', 'dist/core/trust.js'])
  test(`migration refuses changed current ${file} even with a recomputed current subject`, () => fixture(({ root, capabilities, change, verify }) => {
    writeFileSync(join(root, file), Buffer.concat([readFileSync(join(root, file)), Buffer.from('\n// changed\n')]));
    for (let i = 0; i < capabilities.cells.length; i++) change(() => {}, i);
    assert.equal(verify().valid, false);
  }));
test('migration rejects changed serializer library bytes rather than migrating their new digest', () => fixture(({ root, capabilities, change, verify }) => {
  for (const name of ['pkijs','asn1js','pvtsutils','pvutils','bytestreamjs','tslib','@noble/hashes']) {
    mkdirSync(dirname(join(root, 'node_modules', name)), { recursive: true });
    cpSync(join(source, 'node_modules', name), join(root, 'node_modules', name), { recursive: true });
  }
  const file = join(root, 'node_modules/pvutils/package.json'); writeFileSync(file, readFileSync(file, 'utf8') + '\n');
  for (let i = 0; i < capabilities.cells.length; i++) change(() => {}, i);
  assert.equal(verify().valid, false);
}));
test('exact additional platform leaves recognized legacy classifications and absent admission unchanged', () => {
  const old = { os: 'win32', architecture: 'x64', release: 'Windows 11 25H2', projection: 'windows-effective-server-auth-v1' };
  assert.equal(classifyCertificateExportPlatform(old, null), old);
  const unknown = { ...old, release: null, projection: null };
  const facts = { nodeRelease: '10.0.26340', cimVersion: '10.0.26340', currentBuild: '26340', ubr: 9767,
    displayVersion: '26H2', architecture: 'AMD64', caption: 'Microsoft Windows 11 Pro Insider Preview' };
  assert.equal(classifyCertificateExportPlatform(unknown, facts).release, exactExportRelease);
  for (const [field, value] of [['nodeRelease','10.0.26341'],['ubr',9766],['ubr',9768],['ubr','9767'],['displayVersion','25H2'],['architecture','ARM64']])
    assert.equal(classifyCertificateExportPlatform(unknown, { ...facts, [field]: value }), unknown);
  assert.equal(selectTrustCell({ definitionId: 'certificate-export', route: 'export', target: null, network: 'declared', format: 'pem',
    platform: { os: 'win32', architecture: 'x64', release: exactExportRelease } }, trustCapabilities, buildTrustDefinitions(trustCapabilities.cells)).status, 'unavailable');
});
