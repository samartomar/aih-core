import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { authenticateEvidence } from '../dist/core/index.js';
import { selectVerificationKeys, selectVerificationPublishers } from '../dist/harness/contracts.mjs';
import { encode } from './evidence-fixtures.mjs';

const bytes = readFileSync(new URL('./fixtures/evidence/production.scan.json', import.meta.url));
const scanId = 'scan:sha256:fd5e886dc290901110d82ec45e2f444b8fa1b2c05f1bbe7028cbbb4e880bc4dd';

test('the protected production artifact authenticates offline after real leaf expiry with maintained Harness trust', async t => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'ce2e1b862eaf763b2b0d593a84c26ad3a0c1a39661af1d5629f00484e5029b0c');
  const artifact = JSON.parse(bytes);
  assert.equal(artifact.annexes[0].byteLength, 246);
  assert.equal(new X509Certificate(Buffer.from(artifact.attestation.verificationMaterial.certificate.rawBytes, 'base64')).validTo,
    'Oct  1 15:07:44 2026 GMT');
  const keys = await selectVerificationKeys('scan-report');
  const publishers = selectVerificationPublishers('scan-report');
  assert.equal(keys.status, 'selected'); assert.equal(publishers.status, 'selected');
  const trust = { keys: keys.keys, publishers: publishers.publishers };
  const blocked = () => { throw new Error('authentication attempted external IO'); };
  const guards = [[globalThis, 'fetch'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [http2, 'connect'], [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'],
    [tls, 'connect'], [dgram, 'createSocket'], [dns, 'lookup'], [dns, 'resolve'],
    [dns.promises, 'lookup'], [dns.promises, 'resolve'], ...['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name => [childProcess, name])]
    .map(([object, name]) => t.mock.method(object, name, blocked));
  syncBuiltinESMExports();
  try {
    const expected = { scanId, status: 'authenticated', producerIdentity: 'aihq-scan-production-candidate', reportRead: 'not-requested' };
    assert.deepEqual(await authenticateEvidence({ bytes, expectedScanId: scanId, trust }), expected);
    assert.deepEqual(await authenticateEvidence({ bytes, expectedScanId: scanId, trust }), expected);
    for (const [name, change, reason] of [
      ['distrust', value => { value.publishers = []; }, 'unknown-producer'],
      ['issuer', value => { value.publishers[0].policy.issuer += '/wrong'; }, 'unknown-producer'],
      ['SAN', value => { value.publishers[0].policy.subjectAlternativeName += '/wrong'; }, 'unknown-producer'],
      ['OID', value => { value.publishers[0].policy.requiredCertificateExtensions[0].valueDerBase64 = 'DAF4'; }, 'unknown-producer'],
      ['CA', value => { value.publishers[0].trustedRoot.certificateAuthorities = []; }, 'invalid-signature'],
      ['CT', value => { value.publishers[0].trustedRoot.ctlogs = []; }, 'invalid-signature'],
      ['Rekor', value => { value.publishers[0].trustedRoot.tlogs = []; }, 'invalid-signature']
    ]) {
      const changed = structuredClone(trust); change(changed);
      assert.equal((await authenticateEvidence({ bytes, expectedScanId: scanId, trust: changed })).reason, reason, name);
    }
    for (const [name, change, reason] of [
      ['annex', value => { value.annexes[0].bytesBase64 = 'eA=='; }, 'byte-mismatch'],
      ['report', value => { value.report.sha256 = '0'.repeat(64); }, 'byte-mismatch'],
      ['signature', value => { value.attestation.dsseEnvelope.signatures[0].sig = Buffer.alloc(72).toString('base64'); }, 'invalid-signature'],
      ['time', value => { value.attestation.verificationMaterial.tlogEntries[0].integratedTime = '1'; }, 'invalid-signature'],
      ['proof', value => { delete value.attestation.verificationMaterial.tlogEntries[0].inclusionProof; }, 'malformed'],
      ['payload bytes', value => { value.attestation.dsseEnvelope.payload = encode(JSON.parse(Buffer.from(value.attestation.dsseEnvelope.payload, 'base64'))).toString('base64'); }, 'invalid-signature']
    ]) {
      const changed = structuredClone(artifact); change(changed);
      assert.equal((await authenticateEvidence({ bytes: encode(changed), expectedScanId: scanId, trust })).reason, reason, name);
    }
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
