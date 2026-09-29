import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { validateSuppliedCa, composeExistingTrust, prepareRepairDefinition, getRepairRecipe } from '../runtime.mjs';
import { repairIndex } from '../contracts.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}.pem`, import.meta.url));
const root = fixture('root-a');
const rootB = fixture('root-b');
const now = Date.UTC(2026, 8, 29);
const check = value => validateSuppliedCa(Buffer.isBuffer(value) ? value : Buffer.from(value), { now });

test('complete valid input normalizes and deduplicates in first occurrence order', () => {
  const value = Buffer.from('\ufeff  ' + root.toString().replaceAll('\n', '\r\n') + '\r\n' + rootB + root);
  const result = check(value);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.assessedBlocks, 3);
  assert.equal(result.duplicates, 1);
  assert.equal(result.certificates[0].fingerprint,
    new X509Certificate(root).fingerprint256.replaceAll(':', '').toLowerCase());
  assert.equal(result.certificates.length, 2);
});

test('an invalid last certificate rejects the whole input, including a valid prefix', () => {
  const result = check(Buffer.concat([root, fixture('not-ca')]));
  assert.equal(result.valid, false);
  assert.equal(result.assessedBlocks, 2);
  assert.ok(result.diagnostics.some(item => item.reason === 'not-ca' && item.block === 2));
  assert.equal(result.material, undefined);
});

test('private keys, garbage suffix, bad base64 and DER suffix reject', () => {
  const key = '-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----';
  assert.equal(check(root + key).diagnostics.at(-1).reason, 'block-label');
  assert.equal(check(root + 'trailing').diagnostics.at(-1).reason, 'pem-envelope');
  assert.equal(check('-----BEGIN CERTIFICATE-----\nYWJ=\n-----END CERTIFICATE-----').valid, false);
  const der = Buffer.concat([new X509Certificate(root).raw, Buffer.from([0])]);
  assert.equal(check(`-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----`).diagnostics[0].reason, 'x509-extra-data');
});

test('bounds reject before subset acceptance and existing trust composition retains prior bytes', () => {
  assert.equal(check(Buffer.alloc(1_048_577, 32)).assessmentLimit, 'source-byte-limit');
  assert.equal(check(root.toString().repeat(257)).diagnostics[0].reason, 'block-count-limit');
  const prior = root.toString();
  assert.equal(composeExistingTrust(Buffer.from(prior), rootB.toString()), prior + rootB);
  assert.equal(composeExistingTrust(Buffer.from(prior), root.toString()), prior);
  assert.equal(composeExistingTrust(Buffer.from(prior + '  \n'), root.toString()), prior + '  \n');
  assert.equal(composeExistingTrust(Buffer.from('opaque'), rootB.toString()), undefined);
});

test('inclusive byte, block and count limits are enforced before deduplication', () => {
  const one = root.toString().trimEnd();
  const padded = one.replace('-----END CERTIFICATE-----', ' '.repeat(65_536 - Buffer.byteLength(one)) + '-----END CERTIFICATE-----');
  assert.equal(Buffer.byteLength(padded), 65_536);
  assert.equal(check(padded).valid, true);
  assert.equal(check(padded.replace('-----END CERTIFICATE-----', ' -----END CERTIFICATE-----')).diagnostics[0].reason, 'block-byte-limit');
  const exact = one + ' '.repeat(1_048_576 - Buffer.byteLength(one));
  assert.equal(check(exact).valid, true);
  assert.equal(check(exact + ' ').assessmentLimit, 'source-byte-limit');
  const many = one.repeat(256);
  const accepted = check(many);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.assessedBlocks, 256);
  assert.equal(accepted.duplicates, 255);
  const excess = check(many + one);
  assert.equal(excess.diagnostics[0].reason, 'block-count-limit');
  assert.equal(excess.assessedBlocks, 256);
  assert.equal(excess.assessmentLimit, 'block-count-limit');
});

test('validity interval endpoints are inclusive and malformed text never becomes a subset', () => {
  const cert = new X509Certificate(root);
  const from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo);
  assert.equal(validateSuppliedCa(root, { now: from }).valid, true);
  assert.equal(validateSuppliedCa(root, { now: to }).valid, true);
  assert.equal(validateSuppliedCa(root, { now: from - 1 }).diagnostics[0].reason, 'not-yet-valid');
  assert.equal(validateSuppliedCa(root, { now: to + 1 }).diagnostics[0].reason, 'expired');
  assert.equal(check(Buffer.from([0xef, 0xbb, 0xbf, ...root])).valid, true);
  assert.equal(check(Buffer.from([0xc3, 0x28])).diagnostics[0].reason, 'utf8-invalid');
  assert.equal(check(root + '-----BEGIN CERTIFICATE-----\nYWJj').assessmentLimit, 'structure');
  const bomTrailing = check(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), root, Buffer.from('unexpected')]));
  assert.equal(bomTrailing.diagnostics.at(-1).offset, 3 + root.length);
});

test('npm bundle retains Node default roots alongside the supplied CA', () => {
  const bundle = composeExistingTrust(undefined, root.toString(), { includeNodeDefaults: true });
  assert.ok(bundle.startsWith(root.toString().trimEnd()));
  assert.ok(bundle.includes(tls.rootCertificates[0].trimEnd()));
  assert.equal(composeExistingTrust(Buffer.from(bundle), root.toString(), { includeNodeDefaults: true }), bundle);
});

test('published platform variant selects fixed repair and declares skipped offline Node TLS', () => {
  const definition = repairIndex[0];
  const variant = definition.variants.find(item => item.os === process.platform && item.architectures.includes(process.arch) &&
    item.targets.length === 1 && item.targets[0] === 'node' && item.network === 'off');
  assert.ok(variant);
  const rendered = prepareRepairDefinition({ id: definition.id, variantRef: variant.recipeRef,
    targets: ['node'], files: { caFile: root }, managedPath: 'C:/fixture/trust.pem', offline: true });
  assert.equal(rendered.status, 'completed');
  const recipe = getRepairRecipe(variant.recipeRef);
  assert.deepEqual(recipe.operations.find(item => item.id === 'node-config').checks, ['node-behavior']);
  assert.deepEqual(Object.keys(rendered.bindings).sort(), Object.keys(recipe.inputs).filter(key => key !== 'bundle').sort());
  assert.deepEqual(definition.offlineVerification.find(item => item.target === 'node'),
    { target: 'node', operationId: 'node-config', checkId: 'node-tls' });
  assert.equal(prepareRepairDefinition({ id: definition.id, variantRef: 'unpublished',
    targets: ['node'], files: { caFile: root }, validateOnly: true }).status, 'invalid');
});

test('POSIX shipped variants contain only their fixed user profile graphs', () => {
  for (const [os, profile] of [['linux', '.profile'], ['darwin', '.zprofile']]) {
    const variant = repairIndex[0].variants.find(item => item.os === os &&
      item.targets.length === 1 && item.targets[0] === 'node' && item.network === 'off');
    assert.ok(variant);
    const recipe = getRepairRecipe(variant.recipeRef);
    assert.deepEqual(recipe.operations.map(item => item.id), ['material', 'node-config']);
    assert.equal(recipe.operations[1].target.segments[0].literal, profile);
    assert.deepEqual(recipe.operations[1].requires, ['material']);
  }
});
