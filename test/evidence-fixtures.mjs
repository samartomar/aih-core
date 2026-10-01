// Independent test encoding and signing. No fixture key is product trust.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const expectedScanId = 'scan:sha256:fe5d3d1ff13efd5260b5d0aafdf502bc3824d41763d7c0795f0b7423e7924407';
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const encode = value => Buffer.from(canonical(value));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function certificateFixture(version = '0.0.1') {
  const bytes = readFileSync(new URL(`./fixtures/evidence/test-dsse-${version}.artifact.json`, import.meta.url));
  const trust = JSON.parse(readFileSync(new URL(`./fixtures/evidence/test-dsse-${version}.trust.json`, import.meta.url)));
  return { bytes, artifact: JSON.parse(bytes), trust, expectedScanId };
}
export function organizationFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = `ed25519:${sha256(spki)}`;
  const annex = Buffer.from('TEST ONLY opaque report annex\n');
  const descriptors = [{ id: 'annex.opaque', mediaType: 'text/plain', sha256: sha256(annex), byteLength: annex.length }];
  // This unsupported report generation intentionally has no detector schema.
  const report = Buffer.from('{"schema":"urn:example:future-report:9.0.0","value":"opaque"}');
  const reportDigest = sha256(report);
  const scanId = `scan:sha256:${sha256(Buffer.concat([Buffer.from('aih.scan.report.v1\0'), report]))}`;
  const artifact = { schema: 'urn:aihq:scan:artifact:1.0.0', scanId,
    report: { schema: 'urn:example:future-report:9.0.0', mediaType: 'application/json', sha256: reportDigest,
      byteLength: report.length, bytesBase64: report.toString('base64') },
    annexes: [{ ...descriptors[0], bytesBase64: annex.toString('base64') }] };
  const statement = { _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'scan-report', digest: { sha256: reportDigest } }],
    predicateType: 'urn:aihq:scan:artifact-attestation:1.0.0',
    predicate: { scanId, reportSchema: artifact.report.schema, reportByteLength: report.length, annexManifestSha256: sha256(encode(descriptors)) } };
  // Ordinary JSON order and whitespace differ from the outer canonical encoding.
  const payload = Buffer.from(JSON.stringify(statement, null, 2));
  const payloadType = 'application/vnd.in-toto+json';
  const signature = sign(null, Buffer.concat([Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `), payload]), privateKey);
  artifact.attestation = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: { publicKey: { hint: keyId }, tlogEntries: [] },
    dsseEnvelope: { payloadType, payload: payload.toString('base64'), signatures: [{ keyid: keyId, sig: signature.toString('base64') }] } };
  return { artifact, bytes: encode(artifact), expectedScanId: scanId, statement,
    trust: { keys: [{ identity: 'TEST-ONLY-organization', keyId, publicKeySpkiBase64: spki.toString('base64') }], publishers: [] } };
}
