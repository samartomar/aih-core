import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { trustCapabilities } from '../../dist/harness/contracts.mjs';
import { trustHelperFiles, trustCellSubjectSha256, verifyTrustAdmissionEvidence } from '../../src/harness/trust.mjs';
import { classifyCertificateExportPlatform, exactExportRelease, exactExportReleases } from '../../src/harness/trust-export-platform.mjs';
import { buildTrustDefinitions, selectTrustCell, trustPlatformMatrix } from '../../src/harness/trust-definitions.mjs';
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
const decode = text => JSON.parse(Buffer.from(text, 'base64'));
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
// Index 0 wraps the historical 25H2 v1 migration; index 4 wraps a native 26340.9767 record.
const nested = (r, edit) => { const v1 = decode(r.predecessorRecordBytes); edit(v1); r.predecessorRecordBytes = encode(v1); };
for (const [name, edit, index = 0] of [
  ['changed old outcome', r => nested(r, v1 => { const old = decode(v1.originalRecordBytes); old.cases[0].outcome = 'failed'; v1.originalRecordBytes = encode(old); })],
  ['changed predecessor native outcome', r => { const old = decode(r.predecessorRecordBytes); old.cases[0].outcome = 'failed'; r.predecessorRecordBytes = encode(old); }, 4],
  ['relabelled predecessor native record', r => { const old = decode(r.predecessorRecordBytes); old.schema = 'aih.trust.acceptance-migration.v1'; r.predecessorRecordBytes = encode(old); }, 4],
  ['unrecognized v1 preimage inside the predecessor', r => nested(r, v1 => { v1.originalFiles[0].bytesBase64 = Buffer.from('untrusted').toString('base64'); })],
  ['unrecognized method', r => { r.method = 'caller-says-equivalent'; }],
  ['unrecognized proof digest', r => { r.proofSha256 = '0'.repeat(64); }],
  ['removed limitations', r => { r.limitations = []; }],
  ['dropped v2 limitation', r => { r.limitations = r.limitations.filter(item => item !== 'equivalence-migration-serializer-v4-no-new-execution'); }, 4],
  ['unrecognized predecessor preimage', r => { r.predecessorFiles[0].bytesBase64 = Buffer.from('untrusted').toString('base64'); }],
  ['duplicate preimage name', r => { r.predecessorFiles[0].name = r.predecessorFiles[1].name; }],
  ['missing preimage', r => { r.predecessorFiles.pop(); }],
  ['noncanonical base64', r => { r.predecessorRecordBytes += '\n'; }],
  ['extra asserted outcome', r => { r.cases = [{ outcome: 'passed' }]; }],
  ['new execution claim', r => { r.kind = 'native-execution'; }],
  ['downgraded envelope schema', r => { r.schema = 'aih.trust.acceptance-migration.v1'; }]
])
  test(`migration refuses ${name} even after the outer record is rehashed`, () => fixture(({ change, verify }) => { change(edit, index); assert.equal(verify().valid, false); }));
test('the historical v1 envelope alone no longer verifies against the changed current helpers', () => fixture(({ change, verify }) => {
  change(r => { const old = decode(r.predecessorRecordBytes); Object.keys(r).forEach(key => delete r[key]); Object.assign(r, old); }, 0);
  assert.deepEqual(verify().diagnostics.map(item => item.reason), ['migration-executable-change']);
}));
for (const file of ['dist/harness/trust.mjs', 'dist/harness/trust-export-platform.mjs', 'dist/harness/trust-migration-policy.mjs', 'dist/core/trust.js',
  'dist/harness/trust-migration.mjs', 'dist/harness/trust-migration-v2.mjs', 'dist/harness/trust-migration-v2-policy.mjs', 'dist/harness/trust-definitions.mjs'])
  test(`migration refuses changed current ${file} even with a recomputed current subject`, () => fixture(({ root, capabilities, change, verify }) => {
    writeFileSync(join(root, file), Buffer.concat([readFileSync(join(root, file)), Buffer.from('\n// changed\n')]));
    for (let i = 0; i < capabilities.cells.length; i++) change(() => {}, i);
    assert.equal(verify().valid, false);
  }));
test('migration rejects changed serializer library bytes rather than migrating their new digest', () => fixture(({ root, capabilities, change, verify }) => {
  for (const name of ['pkijs','asn1js','bytestreamjs','@noble/hashes','@peculiar/utils']) {
    mkdirSync(dirname(join(root, 'node_modules', name)), { recursive: true });
    cpSync(join(source, 'node_modules', name), join(root, 'node_modules', name), { recursive: true });
  }
  const file = join(root, 'node_modules/@peculiar/utils/package.json'); writeFileSync(file, readFileSync(file, 'utf8') + '\n');
  for (let i = 0; i < capabilities.cells.length; i++) change(() => {}, i);
  assert.equal(verify().valid, false);
}));
test('exact additional platforms preserve legacy classifications and require matching admission', () => {
  assert.deepEqual(trustPlatformMatrix.map(item => [item.os,item.release,item.architecture]),
    [['win32','Windows 11 25H2','x64'],['darwin','macOS 26','arm64'],['linux','Ubuntu 24.04 LTS','x64'],
      ['win32','Windows 11 26H2 build 26340.9767','x64'],['win32','Windows 11 Dev build 29695.1001','x64']]);
  assert.deepEqual(exactExportReleases, [exactExportRelease, 'Windows 11 Dev build 29695.1001']);
  const old = { os: 'win32', architecture: 'x64', release: 'Windows 11 25H2', projection: 'windows-effective-server-auth-v1' };
  assert.equal(classifyCertificateExportPlatform(old, null), old);
  const unknown = { ...old, release: null, projection: null };
  const facts = { nodeRelease: '10.0.26340', cimVersion: '10.0.26340', currentBuild: '26340', ubr: 9767,
    displayVersion: '26H2', architecture: 'AMD64', caption: 'Microsoft Windows 11 Pro Insider Preview' };
  assert.equal(classifyCertificateExportPlatform(unknown, facts).release, exactExportRelease);
  for (const [field, value] of [['nodeRelease','10.0.26341'],['ubr',9766],['ubr',9768],['ubr','9767'],['displayVersion','25H2'],['architecture','ARM64']])
    assert.equal(classifyCertificateExportPlatform(unknown, { ...facts, [field]: value }), unknown);
  const dev = { nodeRelease: '10.0.29695', cimVersion: '10.0.29695', currentBuild: '29695', ubr: 1001,
    displayVersion: 'Dev', architecture: 'AMD64', caption: 'Microsoft Windows 11 Pro Insider Preview' };
  assert.deepEqual(classifyCertificateExportPlatform(unknown, dev), { ...unknown, release: 'Windows 11 Dev build 29695.1001', projection: 'windows-effective-server-auth-v1' });
  // Exactly one build and update revision: no range, prefix, type coercion or mixing of the two hosts' facts.
  for (const [field, value] of [['nodeRelease','10.0.29696'],['nodeRelease','10.0.26340'],['cimVersion','10.0.29694'],['cimVersion','10.0.26340'],
    ['currentBuild','29696'],['currentBuild','26340'],['currentBuild',29695],['ubr',1000],['ubr',1002],['ubr','1001'],['ubr',9767],
    ['displayVersion','dev'],['displayVersion','26H2'],['displayVersion',''],['architecture','ARM64'],['architecture','x64'],
    ['caption','Microsoft Windows 11 Pro'],['caption','Microsoft Windows 11 Home Insider Preview'],['caption',undefined]])
    assert.equal(classifyCertificateExportPlatform(unknown, { ...dev, [field]: value }), unknown, `${field}=${value}`);
  assert.equal(classifyCertificateExportPlatform({ ...unknown, architecture: 'arm64' }, dev).release, null);
  assert.equal(classifyCertificateExportPlatform({ ...unknown, os: 'linux' }, dev).release, null);
  const request = { definitionId: 'certificate-export', route: 'export', target: null, network: 'declared', format: 'pem',
    platform: { os: 'win32', architecture: 'x64', release: exactExportRelease } };
  assert.equal(selectTrustCell(request, trustCapabilities, buildTrustDefinitions(trustCapabilities.cells)).status, 'admitted');
  const historical = { ...trustCapabilities, cells: trustCapabilities.cells.filter(cell => cell.platform.release === 'Windows 11 25H2') };
  assert.equal(historical.cells.length, 4);
  assert.equal(selectTrustCell(request, historical, buildTrustDefinitions(historical.cells)).status, 'unavailable');
  // The new exact host is classified but stays unadmitted until its own native records exist.
  for (const format of ['pem', 'pkcs7-der']) for (const network of ['declared', 'off'])
    assert.equal(selectTrustCell({ ...request, format, network, platform: { ...request.platform, release: 'Windows 11 Dev build 29695.1001' } },
      trustCapabilities, buildTrustDefinitions(trustCapabilities.cells)).status, 'unavailable', `${format}/${network}`);
  assert.equal(trustCapabilities.cells.some(cell => cell.platform.release === 'Windows 11 Dev build 29695.1001'), false);
});
