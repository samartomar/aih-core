import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { encodePem, parsePemBundle, parsePkcs7, serializeCertificateSet, orderByFingerprint, sha256Hex }
  from '../../src/harness/trust-encoding.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}.pem`, import.meta.url));
const der = name => Buffer.from(new X509Certificate(fixture(name)).raw);
const rootA = der('root-a'); const rootB = der('root-b');

// Test-only DER builder, independent of the production reader.
const len = n => n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const node = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const oid = bytes => node(0x06, Buffer.from(bytes));
const SIGNED = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
const DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01];
function p7b(certs, { version = 1, crls = false, signer = false, order = true } = {}) {
  const sorted = order ? [...certs].sort(Buffer.compare) : certs;
  const signed = node(0x30, node(0x02, Buffer.from([version])), node(0x31), node(0x30, oid(DATA)),
    node(0xa0, ...sorted), ...(crls ? [node(0xa1)] : []), node(0x31, ...(signer ? [node(0x30)] : [])));
  return node(0x30, oid(SIGNED), node(0xa0, signed));
}

test('PEM is sorted by fingerprint, 64-column, LF-only, one LF after each footer, and deduplicated', () => {
  const text = encodePem([{ der: rootB }, { der: rootA }, { der: rootA }]).toString('utf8');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----\n[\s\S]*?-----END CERTIFICATE-----\n/g);
  assert.equal(blocks.length, 2); assert.equal(blocks.join(''), text);
  assert.equal(text.includes('\r'), false);
  for (const block of blocks) for (const line of block.split('\n').slice(1, -2)) assert.ok(line.length <= 64);
  const prints = parsePemBundle(Buffer.from(text)).certificates.map(item => item.fingerprint);
  assert.deepEqual(prints, [...prints].sort());
  assert.equal(encodePem([{ der: rootA }, { der: rootB }]).equals(encodePem([{ der: rootB }, { der: rootA }])), true);
});

test('PEM serialization round-trips the exact fingerprint set through the independent parser', async () => {
  const result = await serializeCertificateSet({ format: 'pem', certificates: [{ der: rootA }, { der: rootB }] });
  assert.equal(result.status, 'serialized');
  assert.equal(result.consumerProfile, 'pem-server-ca-v1');
  assert.deepEqual(result.fingerprints, orderByFingerprint([{ der: rootA }, { der: rootB }]).map(item => item.fingerprint));
  assert.equal(result.sha256, sha256Hex(result.bytes));
});

test('PEM parser rejects prose, bad base64, keys and empty input', () => {
  assert.equal(parsePemBundle(Buffer.from('hello')).status, 'invalid');
  assert.equal(parsePemBundle(Buffer.from('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n')).status, 'invalid');
  assert.equal(parsePemBundle(Buffer.from('-----BEGIN CERTIFICATE-----\n@@@@\n-----END CERTIFICATE-----\n')).reason, 'base64-invalid');
  assert.equal(parsePemBundle(Buffer.alloc(0)).reason, 'source-empty');
});

test('PKCS#7 parser accepts only the certificates-only DER shape in DER set order', () => {
  const good = parsePkcs7(p7b([rootA, rootB]));
  assert.equal(good.status, 'parsed');
  assert.deepEqual(good.certificates.map(item => item.fingerprint).sort(), [sha256Hex(rootA), sha256Hex(rootB)].sort());
  const unsorted = Buffer.compare(rootA, rootB) < 0 ? [rootB, rootA] : [rootA, rootB];
  assert.equal(parsePkcs7(p7b(unsorted, { order: false })).reason, 'pkcs7-order');
  assert.equal(parsePkcs7(p7b([rootA], { version: 3 })).reason, 'pkcs7-structure');
  assert.equal(parsePkcs7(p7b([rootA], { crls: true })).reason, 'pkcs7-structure');
  assert.equal(parsePkcs7(p7b([rootA], { signer: true })).reason, 'pkcs7-structure');
  assert.equal(parsePkcs7(Buffer.concat([p7b([rootA]), Buffer.from([0])])).status, 'invalid');
  assert.equal(parsePkcs7(p7b([rootA]).subarray(0, 40)).status, 'invalid');
  assert.equal(parsePkcs7(Buffer.from([0x30, 0x80, 0, 0])).reason, 'der-indefinite');
  assert.equal(parsePkcs7(p7b([Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01])])).reason, 'x509-invalid');
});

test('P7B serialization verifies a backend result and is deterministic across input order', async () => {
  const loadBackend = async () => { throw new Error('missing'); };
  const absent = await serializeCertificateSet({ format: 'pkcs7-der', certificates: [{ der: rootA }] }, { loadBackend });
  assert.deepEqual(absent, { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'trust-format-unavailable' });
  // A backend that drops a certificate must be rejected by the independent parser, never accepted.
  const fake = parts => ({ pkijs: parts, asn1js: {} });
  const lossy = { Certificate: class {}, SignedData: class {}, EncapsulatedContentInfo: class {}, ContentInfo: class {} };
  const dropped = await serializeCertificateSet({ format: 'pkcs7-der', certificates: [{ der: rootA }, { der: rootB }] },
    { loadBackend: async () => fake(lossy) });
  assert.equal(dropped.reason, 'trust-format-unavailable');
});

test('unknown formats and empty sets fail precisely, never substituting another format', async () => {
  assert.equal((await serializeCertificateSet({ format: 'jks', certificates: [{ der: rootA }] })).reason, 'trust-format-unavailable');
  assert.equal((await serializeCertificateSet({ format: 'pem', certificates: [] })).reason, 'trust-output-empty');
  assert.equal((await serializeCertificateSet({ format: 'pem', certificates: [{ der: Buffer.alloc(12582912) }] })).status, 'unavailable');
});

test('maintained P7B serializer round-trips when installed (skipped when the dependency is absent)', async t => {
  let installed = true;
  try { await import('pkijs'); await import('asn1js'); } catch { installed = false; }
  if (!installed) return t.skip('pkijs/asn1js not installed: host dependency decision pending');
  const first = await serializeCertificateSet({ format: 'pkcs7-der', certificates: [{ der: rootA }, { der: rootB }] });
  const second = await serializeCertificateSet({ format: 'pkcs7-der', certificates: [{ der: rootB }, { der: rootA }] });
  assert.equal(first.status, 'serialized');
  assert.equal(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)), true);
  assert.equal(parsePkcs7(first.bytes).certificates.length, 2);
});
