import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { verifyTrustAdmissionEvidence, trustCellSubjectSha256, hashTrustLibraries, trustHelperFiles, serializeTrustSet, parseTrustOutput,
  acceptanceRecordSchema } from '../../src/harness/trust.mjs';
import { buildTrustCapabilities, buildTrustDefinitions, exportAdmissionTemplate, trustProfiles } from '../../src/harness/trust-definitions.mjs';
import { trustCellRecords } from '../../src/harness/trust-capabilities.mjs';
import { sha256Hex } from '../../src/harness/trust-encoding.mjs';

const worktree = fileURLToPath(new URL('../../', import.meta.url));
const pkg = { name: '@aihq/core', version: '1.0.0-test' };
const der = name => Buffer.from(new X509Certificate(readFileSync(new URL(`./fixtures/${name}.pem`, import.meta.url))).raw);

// The temporary installed tree sits under the ignored scratch area so pnpm-style library resolution finds node_modules.
function installedRoot() {
  const parent = join(worktree, '.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'trust-admission-'));
  mkdirSync(join(root, 'dist', 'harness'), { recursive: true });
  for (const name of trustHelperFiles) cpSync(join(worktree, 'src', 'harness', name.split('/').pop()), join(root, name));
  return root;
}
function fixtureRecord(template, cell, subject, mutate = value => value) {
  return mutate({ schema: acceptanceRecordSchema, cellId: cell.id, subjectSha256: subject, cell: template.cell,
    cases: template.requiredCases.map(item => ({ id: item.id, kind: item.kind, outcome: 'passed', summary: 'synthetic fixture outcome' })),
    limitations: [...template.requiredLimitations] });
}
// Builds an admitted-looking cell around a synthetic record; used only against a temporary tree.
function stage(root, format, mutate, name = 'a.json') {
  const template = exportAdmissionTemplate(format);
  const draft = { ...template.cell, evidence: { reference: `evidence/${name}`, sha256: '0'.repeat(64), subjectSha256: '0'.repeat(64) } };
  const subject = trustCellSubjectSha256(draft, root);
  mkdirSync(join(root, 'evidence'), { recursive: true });
  const text = JSON.stringify(fixtureRecord(template, draft, subject, mutate));
  writeFileSync(join(root, 'evidence', name), text);
  const cell = { ...template.cell, evidence: { reference: `evidence/${name}`, sha256: sha256Hex(Buffer.from(text)), subjectSha256: subject } };
  return { cell, subject, text, capabilities: buildTrustCapabilities(pkg, [cell]) };
}
const verify = (root, capabilities) => verifyTrustAdmissionEvidence({ packageRoot: root, capabilities, definitions: buildTrustDefinitions(capabilities.cells) });
const reason = (root, capabilities) => verify(root, capabilities).diagnostics[0]?.reason;
const withRoot = fn => { const root = installedRoot(); try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); } };

test('shipped cells have actual passed records and claim only certificate transport', () => {
  assert.ok(trustCellRecords.every(cell => cell.route === 'export' && cell.client === null));
  assert.equal(verifyTrustAdmissionEvidence({ packageRoot: worktree, capabilities: buildTrustCapabilities(pkg, trustCellRecords) }).valid, true);
  for (const cell of trustCellRecords) {
    const record = JSON.parse(readFileSync(join(worktree, cell.evidence.reference), 'utf8'));
    assert.ok(record.cases.every(item => item.outcome === 'passed' && !item.summary.includes('Synthetic fixture')));
    assert.ok(record.limitations.includes('no-os-fullset-claim') && record.limitations.includes('no-native-client-claim'));
    assert.equal(record.limitations.includes('synthetic-fixture-only'), false);
  }
});

test('a complete acceptance record verifies for PEM and P7B; subject excludes admission data and evidence fields', () => withRoot(root => {
  for (const format of ['pem', 'pkcs7-der']) {
    const { cell, capabilities, subject } = stage(root, format, undefined, `${format}.json`);
    assert.equal(verify(root, capabilities).valid, true, JSON.stringify(verify(root, capabilities)));
    assert.equal(trustCellSubjectSha256({ ...cell, evidence: { ...cell.evidence, sha256: 'f'.repeat(64) } }, root), subject);
  }
}));

test('bytes and hashes alone are not claimed outcomes: every record deficiency is rejected precisely', () => withRoot(root => {
  const stagedWith = (mutate, name) => stage(root, 'pem', mutate, name);
  const cases = [
    ['record-subject', value => ({ ...value, subjectSha256: '1'.repeat(64) })],
    ['record-cell', value => ({ ...value, cell: { ...value.cell, network: 'off' } })],
    ['record-shape', value => ({ ...value, extra: true })],
    ['record-shape', value => ({ ...value, schema: 'other' })],
    ['case-missing', value => ({ ...value, cases: value.cases.slice(1) })],
    ['case-not-passed', value => ({ ...value, cases: value.cases.map((item, i) => i === 0 ? { ...item, outcome: 'unavailable' } : item) })],
    ['case-not-passed', value => ({ ...value, cases: value.cases.map(item => item.kind === 'persistence' ? { ...item, outcome: 'skipped' } : item) })],
    ['case-kind', value => ({ ...value, cases: value.cases.map((item, i) => i === 0 ? { ...item, kind: 'negative' } : item) })],
    ['case-unrecognized', value => ({ ...value, cases: [...value.cases, { id: 'extra-case', kind: 'positive', outcome: 'passed', summary: 'x' }] })],
    ['record-case', value => ({ ...value, cases: [...value.cases, value.cases[0]] })],
    ['record-case', value => ({ ...value, cases: value.cases.map((item, i) => i === 0 ? { id: item.id, kind: item.kind, outcome: 'passed' } : item) })],
    ['limitation-missing', value => ({ ...value, limitations: ['no-os-fullset-claim'] })],
    ['limitation-missing', value => ({ ...value, limitations: [] })]
  ];
  cases.forEach(([expected, mutate], index) => {
    const { capabilities } = stagedWith(mutate, `m${index}.json`);
    assert.equal(reason(root, capabilities), expected, `case ${index}`);
  });
}));

test('record transport failures: duplicate keys, trailing text, bad digest, subject drift, helper and library changes', () => withRoot(root => {
  const good = stage(root, 'pem', undefined, 'good.json');
  const swap = (text, name) => {
    writeFileSync(join(root, 'evidence', name), text);
    return buildTrustCapabilities(pkg, [{ ...good.cell, evidence: { ...good.cell.evidence, reference: `evidence/${name}`, sha256: sha256Hex(Buffer.from(text)) } }]);
  };
  assert.equal(reason(root, swap(good.text.replace('"cellId"', '"cellId":"x","cellId"'), 'dup.json')), 'record-invalid');
  assert.equal(reason(root, swap(good.text + ' junk', 'trail.json')), 'record-invalid');
  assert.equal(reason(root, swap('[1]', 'array.json')), 'record-shape');
  assert.equal(reason(root, buildTrustCapabilities(pkg, [{ ...good.cell, evidence: { ...good.cell.evidence, sha256: '2'.repeat(64) } }])), 'evidence-digest');
  assert.equal(reason(root, buildTrustCapabilities(pkg, [{ ...good.cell, evidence: { ...good.cell.evidence, subjectSha256: '3'.repeat(64) } }])), 'evidence-subject');
  assert.equal(reason(root, buildTrustCapabilities(pkg, [{ ...good.cell, evidence: { ...good.cell.evidence, reference: 'evidence/none.json' } }])), 'evidence-unavailable');
  appendFileSync(join(root, 'dist', 'harness', 'trust-os.mjs'), '// changed\n');
  assert.equal(reason(root, good.capabilities), 'evidence-subject');
}));

test('the subject binds profile files and serializer library bytes only where a profile uses them', () => withRoot(root => {
  const pem = exportAdmissionTemplate('pem').cell; const p7b = exportAdmissionTemplate('pkcs7-der').cell;
  const before = { pem: trustCellSubjectSha256(pem, root), p7b: trustCellSubjectSha256(p7b, root) };
  assert.match(before.pem, /^[a-f0-9]{64}$/); assert.match(before.p7b, /^[a-f0-9]{64}$/);
  assert.notEqual(before.pem, before.p7b);
  appendFileSync(join(root, 'dist', 'harness', 'trust-encoding.mjs'), '// changed\n');
  assert.notEqual(trustCellSubjectSha256(pem, root), before.pem);
  assert.equal(trustCellSubjectSha256({ ...pem, probeProfile: 'unknown' }, root), null);
  assert.deepEqual(Object.keys(trustProfiles).sort(), ['export-p7b-parse-v1', 'export-pem-parse-v1', 'pem-server-ca-v1', 'pkcs7-certificate-import-v1']);
  assert.equal(hashTrustLibraries({ packageRoot: root }).status, 'hashed');
  // A library absent from the installed tree makes serializer-backed subjects unverifiable rather than silently weaker.
  const lonely = mkdtempSync(join(tmpdir(), 'aih-trust-lonely-'));
  try {
    mkdirSync(join(lonely, 'dist', 'harness'), { recursive: true });
    for (const name of trustHelperFiles) cpSync(join(worktree, 'src', 'harness', name.split('/').pop()), join(lonely, name));
    writeFileSync(join(lonely, 'package.json'), '{}');
    assert.match(trustCellSubjectSha256(pem, lonely), /^[a-f0-9]{64}$/);
    assert.equal(trustCellSubjectSha256(p7b, lonely), null);
  } finally { rmSync(lonely, { recursive: true, force: true }); }
}));

test('installed serializer libraries are hashed byte-for-byte and a missing one is unavailable', () => {
  const hashed = hashTrustLibraries({ packageRoot: worktree });
  assert.equal(hashed.status, 'hashed', JSON.stringify(hashed));
  assert.deepEqual(hashed.packages.map(item => item.name).slice(0, 2), ['pkijs', 'asn1js']);
  assert.ok(hashed.packages.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(hashTrustLibraries({ packageRoot: worktree }).sha256, hashed.sha256);
  const root = mkdtempSync(join(tmpdir(), 'aih-trust-lib-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    assert.deepEqual(hashTrustLibraries({ packageRoot: root }), { status: 'unavailable', reason: 'trust-library-unavailable', name: 'pkijs' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the installed maintained serializer yields deterministic certificates-only P7B with the exact fingerprint set', async () => {
  const a = der('root-a'); const b = der('root-b');
  const first = await serializeTrustSet({ format: 'pkcs7-der', certificates: [{ der: a }, { der: b }] });
  const second = await serializeTrustSet({ format: 'pkcs7-der', certificates: [{ der: b }, { der: a }, { der: a }] });
  assert.equal(first.status, 'serialized', JSON.stringify(first));
  assert.equal(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)), true);
  assert.equal(first.consumerProfile, 'pkcs7-certificate-import-v1');
  const parsed = parseTrustOutput(first.bytes, 'pkcs7-der');
  assert.deepEqual(parsed.certificates.map(item => item.fingerprint).sort(), [sha256Hex(a), sha256Hex(b)].sort());
});
