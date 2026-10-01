import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { readFileSync, mkdtempSync, writeFileSync, rmSync, linkSync, symlinkSync, renameSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import * as core from '../dist/core/index.js';
import { certificateFixture, organizationFixture, encode, expectedScanId } from './evidence-fixtures.mjs';

test('optional evidence is skipped before any acquisition is requested', async () => {
  assert.equal(typeof core.associateEvidence, 'function');
  assert.deepEqual(await core.associateEvidence({}), { status: 'skipped', reason: 'not-supplied' });
  assert.deepEqual(await core.associateEvidence({ association: {
    schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: `scan:sha256:${'0'.repeat(64)}`,
    location: { kind: 'https', url: 'https://unavailable.example.invalid/evidence.json' }
  } }), { scanId: `scan:sha256:${'0'.repeat(64)}`, status: 'skipped', reason: 'not-requested' });
});

test('organization Ed25519 evidence authenticates opaque reports and preserves original DSSE payload order', async () => {
  const f = organizationFixture();
  const expected = { scanId: f.expectedScanId, status: 'authenticated', producerIdentity: 'TEST-ONLY-organization',
    keyId: f.trust.keys[0].keyId, reportRead: 'not-requested' };
  const input = { bytes: f.bytes, expectedScanId: f.expectedScanId, trust: f.trust };
  assert.deepEqual(await core.authenticateEvidence(input), expected);
  assert.deepEqual(await core.authenticateEvidence(input), expected);
  f.artifact.attestation.dsseEnvelope.payload = encode(f.statement).toString('base64');
  assert.equal((await core.authenticateEvidence({ ...input, bytes: encode(f.artifact) })).reason, 'invalid-signature');
});

test('both independent certificate profiles authenticate after leaf expiry without network access', async t => {
  const blocked = () => { throw new Error('offline verification attempted network'); };
  const guards = [[globalThis, 'fetch'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect'],
    [dns, 'lookup'], [dns, 'resolve'], [dns.promises, 'lookup'], [dns.promises, 'resolve']].map(([object, name]) => t.mock.method(object, name, blocked));
  syncBuiltinESMExports();
  try {
    for (const version of ['0.0.1', '0.0.2']) {
      const f = certificateFixture(version);
      assert.deepEqual(await core.authenticateEvidence({ bytes: f.bytes, expectedScanId, trust: f.trust }), {
        scanId: expectedScanId, status: 'authenticated', producerIdentity: 'TEST-ONLY-local-publisher', reportRead: 'not-requested'
      });
    }
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const [name, mutate, reason] of [
  ['changed report digest', a => { a.report.sha256 = '0'.repeat(64); }, 'byte-mismatch'],
  ['changed report length', a => { a.report.byteLength++; }, 'byte-mismatch'],
  ['changed report bytes', a => { a.report.bytesBase64 = Buffer.from('changed').toString('base64'); }, 'byte-mismatch'],
  ['changed annex bytes', a => { a.annexes[0].bytesBase64 = Buffer.from('changed').toString('base64'); }, 'byte-mismatch'],
  ['changed annex descriptor', a => { a.annexes[0].mediaType = 'text/changed'; }, 'byte-mismatch'],
  ['omitted annex', a => { a.annexes = []; }, 'byte-mismatch'],
  ['extra annex', a => { a.annexes.push({ ...a.annexes[0], id: 'annex.zzz' }); }, 'byte-mismatch'],
  ['duplicate annex', a => { a.annexes.push(a.annexes[0]); }, 'malformed'],
  ['traversal annex ID', a => { a.annexes[0].id = 'annex.../escape'; }, 'malformed'],
  ['unsigned evidence', a => { delete a.attestation; }, 'unsigned'],
  ['unsupported artifact generation', a => { a.schema = 'urn:aihq:scan:artifact:9.0.0'; }, 'unsupported-artifact'],
  ['unsupported bundle generation', a => { a.attestation.mediaType = 'application/vnd.dev.sigstore.bundle.v0.2+json'; }, 'unsupported-artifact'],
  ['message signature union', a => { a.attestation.messageSignature = {}; }, 'unsupported-artifact'],
  ['certificate and key union', a => { a.attestation.verificationMaterial.publicKey = { hint: 'unused' }; }, 'malformed'],
  ['multiple DSSE signatures', a => { a.attestation.dsseEnvelope.signatures.push(a.attestation.dsseEnvelope.signatures[0]); }, 'malformed'],
  ['wrong DSSE payload type', a => { a.attestation.dsseEnvelope.payloadType = 'application/json'; }, 'malformed'],
  ['unknown bundle field', a => { a.attestation.algorithm = 'ed25519'; }, 'malformed'],
  ['nonempty certificate keyid', a => { a.attestation.dsseEnvelope.signatures[0].keyid = 'any-key'; }, 'malformed'],
  ['missing inclusion proof', a => { delete a.attestation.verificationMaterial.tlogEntries[0].inclusionProof; }, 'malformed'],
  ['missing inclusion promise', a => { delete a.attestation.verificationMaterial.tlogEntries[0].inclusionPromise; }, 'malformed'],
  ['unsupported log body', a => { a.attestation.verificationMaterial.tlogEntries[0].kindVersion.version = '99.0.0'; }, 'unsupported-artifact'],
  ['invalid log uint64', a => { a.attestation.verificationMaterial.tlogEntries[0].logIndex = '18446744073709551616'; }, 'malformed'],
  ['unsafe signing time', a => { a.attestation.verificationMaterial.tlogEntries[0].integratedTime = '9007199254740993'; }, 'malformed'],
  ['corrupted inclusion promise', a => { a.attestation.verificationMaterial.tlogEntries[0].inclusionPromise.signedEntryTimestamp = Buffer.alloc(72).toString('base64'); }, 'invalid-signature'],
  ['corrupted proof checkpoint', a => { a.attestation.verificationMaterial.tlogEntries[0].inclusionProof.checkpoint.envelope = a.attestation.verificationMaterial.tlogEntries[0].inclusionProof.checkpoint.envelope.replace('\n1\n', '\n2\n'); }, 'invalid-signature'],
  ['corrupted DSSE signature', a => { a.attestation.dsseEnvelope.signatures[0].sig = Buffer.alloc(72).toString('base64'); }, 'invalid-signature'],
  ['oversized report', a => { a.report.byteLength = 16 * 1024 * 1024 + 1; }, 'resource-limit'],
  ['oversized annex', a => { a.annexes[0].byteLength = 16 * 1024 * 1024 + 1; }, 'resource-limit'],
  ['oversized statement', a => { a.attestation.dsseEnvelope.payload = Buffer.alloc(128 * 1024 + 1).toString('base64'); }, 'resource-limit'],
  ['oversized leaf', a => { a.attestation.verificationMaterial.certificate.rawBytes = Buffer.alloc(32 * 1024 + 1).toString('base64'); }, 'resource-limit'],
  ['oversized signature', a => { a.attestation.dsseEnvelope.signatures[0].sig = Buffer.alloc(1025).toString('base64'); }, 'resource-limit'],
  ['too many log witnesses', a => { a.attestation.verificationMaterial.tlogEntries = Array(5).fill(a.attestation.verificationMaterial.tlogEntries[0]); }, 'resource-limit'],
  ['too many proof hashes', a => { a.attestation.verificationMaterial.tlogEntries[0].inclusionProof.hashes = Array(65).fill(Buffer.alloc(32).toString('base64')); }, 'resource-limit'],
  ['wrong proof hash size', a => { a.attestation.verificationMaterial.tlogEntries[0].inclusionProof.hashes = ['AA==']; }, 'malformed'],
]) test(`evidence refuses ${name} with a finite reason`, async () => {
  const f = certificateFixture(); mutate(f.artifact);
  const result = await core.authenticateEvidence({ bytes: encode(f.artifact), expectedScanId, trust: f.trust });
  assert.equal(result.status, 'unverifiable'); assert.equal(result.reason, reason);
});

for (const [name, mutate, reason] of [
  ['removed independent trust', trust => { trust.publishers = []; }, 'unknown-producer'],
  ['literal SAN mismatch', trust => { trust.publishers[0].policy.subjectAlternativeName = trust.publishers[0].policy.subjectAlternativeName.replace('+literal', '.literal'); }, 'unknown-producer'],
  ['literal issuer mismatch', trust => { trust.publishers[0].policy.issuer += '/changed'; }, 'unknown-producer'],
  ['exact OID value mismatch', trust => { trust.publishers[0].policy.requiredCertificateExtensions[0].valueDerBase64 = 'DAF4'; }, 'unknown-producer'],
  ['absent required OID', trust => { trust.publishers[0].policy.requiredCertificateExtensions[0].oid = [1, 3, 6, 1, 4, 1, 57264, 1, 17]; }, 'unknown-producer'],
  ['missing independent CA', trust => { trust.publishers[0].trustedRoot.certificateAuthorities = []; }, 'invalid-signature'],
  ['missing independent CT', trust => { trust.publishers[0].trustedRoot.ctlogs = []; }, 'invalid-signature'],
  ['missing independent Rekor', trust => { trust.publishers[0].trustedRoot.tlogs = []; }, 'invalid-signature'],
  ['duplicate OID constraints', trust => { trust.publishers[0].policy.requiredCertificateExtensions.push(trust.publishers[0].policy.requiredCertificateExtensions[0]); }, 'malformed'],
  ['invalid OID arcs', trust => { trust.publishers[0].policy.requiredCertificateExtensions[0].oid = [1, 40]; }, 'malformed'],
  ['oversized OID constraint value', trust => { trust.publishers[0].policy.requiredCertificateExtensions[0].valueDerBase64 = Buffer.alloc(4097).toString('base64'); }, 'resource-limit'],
  ['too many publishers', trust => { trust.publishers = Array(33).fill(trust.publishers[0]); }, 'resource-limit'],
  ['too many selected keys', trust => { trust.keys = Array(129).fill({}); }, 'resource-limit'],
  ['unsupported publisher purpose', trust => { trust.publishers[0].purposes = ['unrelated']; }, 'malformed'],
]) test(`independent selected trust refuses ${name}`, async () => {
  const f = certificateFixture(); mutate(f.trust);
  const result = await core.authenticateEvidence({ bytes: f.bytes, expectedScanId, trust: f.trust });
  assert.equal(result.status, 'unverifiable'); assert.equal(result.reason, reason);
});

test('historical policies consolidate one identity and refuse different successful identities', async () => {
  const f = certificateFixture();
  const historical = structuredClone(f.trust.publishers[0]); historical.policy.requiredCertificateExtensions = [];
  const stale = structuredClone(f.trust.publishers[0]); stale.trustedRoot.ctlogs = [];
  for (const publishers of [[stale, historical, f.trust.publishers[0]], [f.trust.publishers[0], historical, stale]]) {
    assert.equal((await core.authenticateEvidence({ bytes: f.bytes, expectedScanId, trust: { keys: [], publishers } })).status, 'authenticated');
  }
  historical.identity = 'TEST-ONLY-other-identity';
  for (const publishers of [[historical, f.trust.publishers[0]], [f.trust.publishers[0], historical]]) {
    assert.equal((await core.authenticateEvidence({ bytes: f.bytes, expectedScanId, trust: { keys: [], publishers } })).reason, 'unknown-producer');
  }
});

test('organization profile never borrows certificate trust or tolerates key-hint and fingerprint changes', async () => {
  const f = organizationFixture();
  assert.equal((await core.authenticateEvidence({ bytes: f.bytes, expectedScanId: f.expectedScanId, trust: { keys: [], publishers: certificateFixture().trust.publishers } })).reason, 'untrusted-key');
  for (const mutate of [
    a => { a.attestation.verificationMaterial.publicKey.hint = `ed25519:${'0'.repeat(64)}`; },
    a => { a.attestation.dsseEnvelope.signatures[0].keyid = `ed25519:${'0'.repeat(64)}`; },
    a => { a.attestation.dsseEnvelope.signatures[0].sig = 'AA=='; },
    a => { a.attestation.verificationMaterial.tlogEntries = [{}]; },
    a => { a.attestation.verificationMaterial.timestampVerificationData = { rfc3161Timestamps: [{ signedTimestamp: 'AA==' }] }; },
  ]) {
    const artifact = structuredClone(f.artifact); mutate(artifact);
    assert.equal((await core.authenticateEvidence({ bytes: encode(artifact), expectedScanId: f.expectedScanId, trust: f.trust })).reason, 'malformed');
  }
  for (const keys of [[f.trust.keys[0], f.trust.keys[0]], [{ ...f.trust.keys[0], keyId: `ed25519:${'0'.repeat(64)}` }]]) {
    assert.equal((await core.authenticateEvidence({ bytes: f.bytes, expectedScanId: f.expectedScanId, trust: { keys, publishers: [] } })).reason, 'malformed');
  }
});

test('strict artifact admission rejects duplicate keys, noncanonical transport, invalid Unicode and lossy numbers', async () => {
  const f = certificateFixture();
  for (const bytes of [
    Buffer.from(f.bytes.toString().replace('"schema":', '"schema":"duplicate","schema":')),
    Buffer.from(JSON.stringify(f.artifact, null, 2)),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from('{"x":"\\ud800"}'),
    Buffer.from('{"x":"e\\u0301"}'),
    Buffer.from('{"x":9007199254740993}'),
    Buffer.from('{"x":9007199254740992}'),
    Buffer.from('{"x":-0}'),
    Buffer.from('{"x":1.0000000000000001}'),
  ]) assert.equal((await core.authenticateEvidence({ bytes, expectedScanId, trust: f.trust })).reason, 'malformed');
  f.artifact.annexes[0].bytesBase64 = 'AB==';
  assert.equal((await core.authenticateEvidence({ bytes: encode(f.artifact), expectedScanId, trust: f.trust })).reason, 'malformed');
});

test('DSSE 0.0.2 requires independently trusted signature-bound RFC3161 time', async () => {
  const f = certificateFixture('0.0.2');
  const artifact = structuredClone(f.artifact); delete artifact.attestation.verificationMaterial.timestampVerificationData;
  assert.equal((await core.authenticateEvidence({ bytes: encode(artifact), expectedScanId, trust: f.trust })).reason, 'malformed');
  const trust = structuredClone(f.trust); trust.publishers[0].trustedRoot.timestampAuthorities = [];
  assert.equal((await core.authenticateEvidence({ bytes: f.bytes, expectedScanId, trust })).reason, 'invalid-signature');
  const token = Buffer.from(f.artifact.attestation.verificationMaterial.timestampVerificationData.rfc3161Timestamps[0].signedTimestamp, 'base64');
  token[token.length - 1] ^= 1;
  f.artifact.attestation.verificationMaterial.timestampVerificationData.rfc3161Timestamps[0].signedTimestamp = token.toString('base64');
  assert.equal((await core.authenticateEvidence({ bytes: encode(f.artifact), expectedScanId, trust: f.trust })).reason, 'invalid-signature');
});

test('caller trust is captured before asynchronous byte hashing', async () => {
  const f = certificateFixture();
  const pending = core.authenticateEvidence({ bytes: f.bytes, expectedScanId, trust: f.trust });
  f.trust.publishers[0].identity = 'changed-during-read';
  assert.equal((await pending).producerIdentity, 'TEST-ONLY-local-publisher');
});

test('expected association ID is checked independently of verified artifact identity', async () => {
  const f = certificateFixture();
  assert.equal((await core.authenticateEvidence({ bytes: f.bytes, expectedScanId: `scan:sha256:${'0'.repeat(64)}`, trust: f.trust })).reason, 'id-mismatch');
});

test('HTTPS acquisition forwards explicit bearer credentials only to the original origin', async t => {
  const f = certificateFixture();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: url.href, ...options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://second.example.invalid/report' } }) : new Response(f.bytes);
  });
  const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: expectedScanId,
    location: { kind: 'https', url: 'https://first.example.invalid/report' } };
  assert.equal((await core.associateEvidence({ association, acquire: true, trust: f.trust }, { authentication: { kind: 'bearer', token: 'TEST-ONLY-token' } })).status, 'authenticated');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Bearer TEST-ONLY-token');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].credentials, 'omit');
});

test('HTTPS acquisition refuses insecure redirects and bounded overlarge streams safely', async t => {
  const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: expectedScanId,
    location: { kind: 'https', url: 'https://first.example.invalid/report' } };
  let response = new Response(null, { status: 302, headers: { location: 'http://insecure.example.invalid/report' } });
  t.mock.method(globalThis, 'fetch', async () => response);
  assert.equal((await core.associateEvidence({ association, acquire: true })).reason, 'malformed');
  response = new Response('small', { headers: { 'content-length': String(96 * 1024 * 1024 + 1) } });
  assert.equal((await core.associateEvidence({ association, acquire: true })).reason, 'resource-limit');
  response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(96 * 1024 * 1024 + 1)); } }));
  assert.equal((await core.associateEvidence({ association, acquire: true })).reason, 'resource-limit');
});

test('omitted acquisition and pre-aborted controls make no request; failed HTTP is unavailable', async t => {
  const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: expectedScanId,
    location: { kind: 'https', url: 'https://first.example.invalid/report' } };
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('TEST-ONLY-secret-response', { status: 403 }));
  assert.equal((await core.associateEvidence({ association })).reason, 'not-requested');
  assert.equal((await core.associateEvidence({ association, acquire: true }, { signal: AbortSignal.abort() })).reason, 'unavailable');
  assert.equal(fetch.mock.callCount(), 0);
  const result = await core.associateEvidence({ association, acquire: true });
  assert.deepEqual(result, { scanId: expectedScanId, status: 'unverifiable', reason: 'unavailable' });
});

test('artifact file acquisition refuses directories, hardlinks and ancestor links', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aih-evidence-links-'));
  try {
    const f = certificateFixture();
    const source = join(directory, 'source.json'); writeFileSync(source, f.bytes);
    const hard = join(directory, 'hard.json'); linkSync(source, hard);
    const linkedDirectory = join(directory, 'linked-directory'); symlinkSync(directory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of [directory, source, hard, join(linkedDirectory, 'source.json')]) {
      const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: expectedScanId, location: { kind: 'file', path } };
      assert.equal((await core.associateEvidence({ association, acquire: true, trust: f.trust })).reason, 'unavailable');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file substitution during acquisition cannot authenticate the original descriptor', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aih-evidence-replacement-'));
  const originalRead = fs.readSync;
  try {
    const f = certificateFixture();
    const path = join(directory, 'evidence.json'); writeFileSync(path, f.bytes);
    const substitute = join(directory, 'substitute.json'); writeFileSync(substitute, f.bytes);
    let attempted = false;
    t.mock.method(fs, 'readSync', (...args) => {
      const count = originalRead(...args);
      // Windows may refuse replacing the already-open input. That refusal is
      // also an unavailable acquisition; on hosts permitting replacement the
      // adapter must catch its changed path identity after the read.
      if (!attempted) { attempted = true; renameSync(substitute, path); }
      return count;
    });
    syncBuiltinESMExports();
    const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: expectedScanId, location: { kind: 'file', path } };
    assert.equal((await core.associateEvidence({ association, acquire: true, trust: f.trust })).reason, 'unavailable');
    assert.equal(attempted, true);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('overlarge regular files are refused before any file-byte read', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aih-evidence-file-bound-'));
  try {
    const path = join(directory, 'evidence.json'); writeFileSync(path, ''); truncateSync(path, 96 * 1024 * 1024 + 1);
    const guard = t.mock.method(fs, 'readSync', () => { throw new Error('Unexpected file read'); }); syncBuiltinESMExports();
    const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: expectedScanId, location: { kind: 'file', path } };
    assert.equal((await core.associateEvidence({ association, acquire: true })).reason, 'resource-limit');
    assert.equal(guard.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); }
});

test('HTTPS acquisition stops after the redirect budget', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
  const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: expectedScanId,
    location: { kind: 'https', url: 'https://first.example.invalid/report' } };
  assert.equal((await core.associateEvidence({ association, acquire: true })).reason, 'unavailable');
  assert.equal(request.mock.callCount(), 6);
});

test('HTTPS acquisition applies one total time budget without exposing request credentials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('TEST-ONLY-token')), { once: true });
  }));
  const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: expectedScanId,
    location: { kind: 'https', url: 'https://first.example.invalid/report' } };
  const pending = core.associateEvidence({ association, acquire: true }, { authentication: { kind: 'bearer', token: 'TEST-ONLY-token' } });
  t.mock.timers.tick(60_001);
  assert.deepEqual(await pending, { scanId: expectedScanId, status: 'unverifiable', reason: 'unavailable' });
});

test('selected trust limits are enforced before parsing any DER key or certificate', async () => {
  const f = certificateFixture();
  const ca = { ...f.trust.publishers[0].trustedRoot.certificateAuthorities[0],
    certChain: { certificates: Array(8).fill({ rawBytes: Buffer.alloc(32 * 1024).toString('base64') }) } };
  f.trust.publishers[0].trustedRoot.certificateAuthorities = Array(4).fill(ca);
  assert.equal((await core.authenticateEvidence({ bytes: f.bytes, expectedScanId, trust: f.trust })).reason, 'resource-limit');
  const org = organizationFixture(); org.trust.keys[0].publicKeySpkiBase64 = Buffer.alloc(4097).toString('base64');
  assert.equal((await core.authenticateEvidence({ bytes: org.bytes, expectedScanId: org.expectedScanId, trust: org.trust })).reason, 'resource-limit');
});

test('acquisition reports malformed and overlarge selected trust without contacting the locator', async t => {
  const f = organizationFixture();
  const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: f.expectedScanId,
    location: { kind: 'https', url: 'https://first.example.invalid/report' } };
  const request = t.mock.method(globalThis, 'fetch', () => { throw new Error('No request permitted'); });
  f.trust.keys[0].identity = 'e\u0301';
  assert.equal((await core.associateEvidence({ association, acquire: true, trust: f.trust })).reason, 'malformed');
  f.trust.keys[0].identity = 'TEST-ONLY-organization';
  f.trust.keys[0].publicKeySpkiBase64 = Buffer.alloc(4097).toString('base64');
  assert.equal((await core.associateEvidence({ association, acquire: true, trust: f.trust })).reason, 'resource-limit');
  assert.equal(request.mock.callCount(), 0);
});

test('untrusted proxy input is refused without invoking caller traps', async () => {
  let traps = 0;
  const input = new Proxy({}, { getPrototypeOf() { traps++; throw new Error('caller trap'); } });
  assert.deepEqual(await core.authenticateEvidence(input), { status: 'unverifiable', reason: 'malformed' });
  assert.equal(traps, 0);
});

test('the evidence nesting ceiling produces a resource-limit refusal', async () => {
  const bytes = Buffer.from('['.repeat(513) + '0' + ']'.repeat(513));
  assert.deepEqual(await core.authenticateEvidence({ bytes, expectedScanId, trust: { keys: [], publishers: [] } }), {
    status: 'unverifiable', reason: 'resource-limit'
  });
});

test('an explicitly acquired regular file authenticates using only supplied trust', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aih-evidence-'));
  try {
    const path = join(directory, 'evidence.json');
    writeFileSync(path, readFileSync(new URL('./fixtures/evidence/test-dsse-0.0.1.artifact.json', import.meta.url)));
    const trust = JSON.parse(readFileSync(new URL('./fixtures/evidence/test-dsse-0.0.1.trust.json', import.meta.url)));
    const association = { schema: 'urn:aihq:scan:evidence-association:1.0.0',
      scanId: 'scan:sha256:fe5d3d1ff13efd5260b5d0aafdf502bc3824d41763d7c0795f0b7423e7924407', location: { kind: 'file', path } };
    assert.equal((await core.associateEvidence({ association, acquire: true, trust })).status, 'authenticated');
    assert.deepEqual(await core.associateEvidence({ association, acquire: true }), {
      scanId: association.scanId, status: 'unverifiable', reason: 'unknown-producer'
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Core authenticates an expired certificate and partial report with a nonempty annex offline', async () => {
  const bytes = readFileSync(new URL('./fixtures/evidence/test-dsse-0.0.1.artifact.json', import.meta.url));
  const trust = JSON.parse(readFileSync(new URL('./fixtures/evidence/test-dsse-0.0.1.trust.json', import.meta.url)));
  const expectedScanId = 'scan:sha256:fe5d3d1ff13efd5260b5d0aafdf502bc3824d41763d7c0795f0b7423e7924407';
  assert.deepEqual(await core.authenticateEvidence({ bytes, expectedScanId, trust }), {
    scanId: expectedScanId, status: 'authenticated', producerIdentity: 'TEST-ONLY-local-publisher', reportRead: 'not-requested'
  });
});
