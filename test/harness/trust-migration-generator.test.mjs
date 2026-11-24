import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { trustCapabilities } from '../../dist/harness/contracts.mjs';
import { trustCellSubjectSha256 } from '../../src/harness/trust.mjs';
import { trustProfiles } from '../../src/harness/trust-definitions.mjs';
import { trustCellRecords } from '../../src/harness/trust-capabilities.mjs';
const source = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const devRelease = 'Windows 11 Dev build 29695.1001';
const generated = ['src/harness/trust-migration-v2-policy.mjs', 'src/harness/trust-capabilities.mjs',
  'src/fixtures/harness/trust-capabilities/1.0.0/accept.json', ...trustCellRecords.map(cell => cell.evidence.reference.replace(/^dist\//, 'src/'))];

function scratchCopy(run) {
  const scratch = join(source, '.scratch'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'migration-generator-'));
  try {
    const copy = name => { mkdirSync(dirname(join(root, name)), { recursive: true }); cpSync(join(source, name), join(root, name), { recursive: true }); };
    for (const name of ['src/harness', 'src/core/trust.ts', 'scripts/generate-trust-migration.mjs', 'scripts/trust-export-cases.mjs',
      'scripts/fixtures', 'package.json', 'test/harness/fixtures', 'dist/harness', 'dist/core/trust.js',
      'src/fixtures/harness/trust-capabilities/1.0.0', 'dist/fixtures/harness/trust-capabilities/1.0.0']) copy(name);
    const generate = () => spawnSync(process.execPath, [join(root, 'scripts/generate-trust-migration.mjs')],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1048576 });
    return run({ root, generate });
  } finally {
    assert.ok(resolve(root).startsWith(resolve(scratch) + sep)); rmSync(root, { recursive: true, force: true });
  }
}

test('generator reproduces the shipped v2 policy, envelopes and admission table byte-for-byte', () => scratchCopy(({ root, generate }) => {
  const result = generate();
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual({ ...summary, proofSha256: undefined }, { kind: 'equivalence-migration', method: 'core417-serializer-v4-and-exact-export-hosts-v1',
    predecessorRecordsVerified: 8, migratedCells: 8, retainedNativeCells: 0, casesCompared: { pem: 9, p7b: 11 },
    supplementaryCompared: summary.supplementaryCompared, proofSha256: undefined, nativeExecutionsCreated: 0 });
  for (const name of generated) assert.ok(readFileSync(join(root, name)).equals(readFileSync(join(source, name))), name);
}));

test('the v2 proof binds every installed case with identical predecessor and current outputs', async () => {
  const { trustMigrationV2Policy: policy } = await import('../../src/harness/trust-migration-v2-policy.mjs');
  for (const [id, count] of [['export-pem-parse-v1', 9], ['export-p7b-parse-v1', 11]]) {
    const cases = policy.proof.caseComparison.profiles[id];
    assert.deepEqual(cases.map(item => item.id), trustProfiles[id].requiredCases.map(item => item.id));
    assert.equal(cases.length, count);
    assert.ok(cases.every(item => item.identical === true && item.predecessorSha256 === item.currentSha256), id);
  }
  assert.equal(policy.proof.newNativeExecutionCreated, false);
  assert.notEqual(policy.predecessorLibrariesSha256, policy.currentLibrariesSha256);
  assert.deepEqual(policy.proof.libraries.current.packages.map(item => [item.name, item.version]).filter(([name]) => ['pkijs', 'asn1js'].includes(name)),
    [['pkijs', '4.0.1'], ['asn1js', '4.1.0']]);
  assert.ok(policy.proof.limits.length >= 3);
});

test('generator refuses duplicate native cells, wrong tuples, mismatched record identities and stale subjects', () => scratchCopy(({ root, generate }) => {
  // These disposable passing-case fixtures test structural refusal only. They
  // are never written to the product tree or represented as native evidence.
  const historical = trustCapabilities.cells.filter(cell => cell.platform.release === 'Windows 11 25H2');
  assert.equal(historical.length, 4);
  const native = historical.map(old => {
    const id = old.id.replace('win32-', 'win32-29695-1001-');
    const cell = { ...old, id, platform: { ...old.platform, release: devRelease },
      evidence: { reference: `dist/harness/acceptance/${id}.json`, sha256: '', subjectSha256: '' } };
    const { evidence, ...tested } = cell;
    const subject = trustCellSubjectSha256(cell, root);
    const record = { schema: 'aih.trust.acceptance.v1', cellId: id, cell: tested, subjectSha256: subject,
      cases: trustProfiles[cell.probeProfile].requiredCases.map(item => ({ id: item.id, kind: item.kind, outcome: 'passed', summary: 'Fixture for structural refusal.' })),
      limitations: ['no-os-fullset-claim', 'no-native-client-claim'] };
    const bytes = Buffer.from(JSON.stringify(record));
    writeFileSync(join(root, 'src/harness/acceptance', `${id}.json`), bytes);
    return { ...tested, evidence: { ...evidence, sha256: sha(bytes), subjectSha256: subject } };
  });
  const run = (cells, expected) => {
    writeFileSync(join(root, 'src/harness/trust-capabilities.mjs'), `export const trustCellRecords = Object.freeze(${JSON.stringify([...trustCellRecords, ...cells])});\n`);
    const result = generate();
    assert.notEqual(result.status, 0, 'malformed native table must refuse');
    assert.match(result.stderr, expected);
  };
  run(Array(4).fill(native[0]), /exact unique four native cell IDs required/);
  run(native.slice(0, 3), /retain only a complete separately captured new-host table/);
  const wrongTuple = structuredClone(native); wrongTuple[0].network = 'off';
  run(wrongTuple, /native format\/network\/platform tuple must match/);
  const oldHost = structuredClone(native).map(cell => ({ ...cell, platform: { ...cell.platform, release: 'Windows 11 26H2 build 26340.9767' } }));
  run(oldHost, /native format\/network\/platform tuple must match/);
  const stale = structuredClone(native); stale[0].evidence.subjectSha256 = '0'.repeat(64);
  run(stale, /changed native subject requires a fresh run/);
  for (const field of ['cellId', 'cell']) {
    const cells = structuredClone(native); const file = join(root, 'src/harness/acceptance', `${cells[0].id}.json`);
    const original = readFileSync(file); const record = JSON.parse(original);
    if (field === 'cellId') record.cellId = cells[1].id; else record.cell.network = 'off';
    const bytes = Buffer.from(JSON.stringify(record)); writeFileSync(file, bytes); cells[0].evidence.sha256 = sha(bytes);
    run(cells, field === 'cellId' ? /native record ID must match/ : /native record cell must match/);
    writeFileSync(file, original);
  }
}));
