// Finite per-case observations of one installed Core package's certificate-export helpers.
// Each installed profile case is reduced to the serializer, parser and byte observations its
// acceptance run depends on. Running this against two packages compares their exact outputs;
// it never runs Prepare/Apply, a native import or any OS store and creates no acceptance evidence.
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import tls from 'node:tls';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const exportCaseFixtureNames = Object.freeze(['root-a.pem', 'root-b.pem']);
const privateKeyBlock = '\n-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n';

/** Observe every installed certificate-export profile case, plus a supplementary differential over Node's bundled roots. */
export async function observeExportCases(packageRoot, fixtureDirectory) {
  const load = name => import(pathToFileURL(join(packageRoot, 'dist', 'harness', name)).href);
  const { serializeTrustSet, parseTrustOutput } = await load('trust.mjs');
  const { serializeCertificateSet, parsePemBundle } = await load('trust-encoding.mjs');
  const { trustProfiles } = await load('trust-definitions.mjs');
  const pems = exportCaseFixtureNames.map(name => readFileSync(join(fixtureDirectory, name)));
  const [a, b] = pems.map(bytes => new X509Certificate(bytes).raw);
  const fingerprints = set => set.map(der => sha(der)).sort();
  const serialize = async (format, set, internal) => {
    const result = internal ? await serializeCertificateSet({ format, certificates: set.map(der => ({ der })) }, internal)
      : await serializeTrustSet({ format, certificates: set.map(der => ({ der })) });
    if (result.status !== 'serialized') return { status: result.status, code: result.code, reason: result.reason };
    const bytes = Buffer.from(result.bytes);
    return { status: result.status, bytesSha256: sha(bytes), byteLength: bytes.length, fingerprints: [...result.fingerprints],
      certificateCount: result.certificateCount, consumerProfile: result.consumerProfile, bytes };
  };
  const strip = ({ bytes: _bytes, ...rest }) => rest;
  const parse = (bytes, format) => {
    const parsed = parseTrustOutput(bytes, format);
    return parsed.status === 'parsed' ? { status: parsed.status, fingerprints: parsed.certificates.map(item => item.fingerprint).sort() }
      : { status: parsed.status, reason: parsed.reason };
  };
  const observeFormat = async format => {
    const ab = await serialize(format, [a, b]); const ba = await serialize(format, [b, a]); const single = await serialize(format, [a]);
    const keyed = parsePemBundle(Buffer.concat([pems[0], Buffer.from(privateKeyBlock)]));
    const observers = {
      'deterministic-bytes': () => ({ forward: strip(ab), reverse: strip(ba), forwardEqualsReverse: ab.bytes.equals(ba.bytes) }),
      'independent-parse-set': () => ({ inputSha256: ab.bytesSha256, parsed: parse(ab.bytes, format), expected: fingerprints([a, b]) }),
      'public-api-write': () => ({ written: strip(ab) }),
      'custom-store-import': () => ({ importInput: strip(ab), expectedFingerprints: fingerprints([a, b]) }),
      'reject-key-material': () => ({ source: keyed.status === 'parsed' ? { status: 'parsed' } : { status: keyed.status, reason: keyed.reason },
        preservedOutputSha256: ab.bytesSha256 }),
      'reject-output-extension-mismatch': () => ({ serializerInvoked: false, preservedOutputSha256: ab.bytesSha256 }),
      'reject-unsafe-path': () => ({ serializerInvoked: false, preservedOutputSha256: ab.bytesSha256 }),
      'serializer-failure-unavailable': async () => ({ result: await serialize(format, [a, b], { loadBackend: async () => { throw new Error('fixture unavailable backend'); } }) }),
      'custody-recorded': () => ({ outputSha256: ab.bytesSha256 }),
      'refresh-replace-reviewed': () => ({ replaced: strip(single), parsed: parse(single.bytes, format), expected: fingerprints([a]) }),
      'removal-reconciled': () => ({ serializerInvoked: false, retiredOutputSha256: single.bytesSha256 })
    };
    const profile = format === 'pem' ? trustProfiles['export-pem-parse-v1'] : trustProfiles['export-p7b-parse-v1'];
    const prefix = format === 'pem' ? 'pem-' : 'p7b-';
    const cases = [];
    for (const item of profile.requiredCases) {
      const observer = observers[item.id.slice(prefix.length)];
      if (!item.id.startsWith(prefix) || !observer) throw new Error(`unobserved installed profile case ${item.id}`);
      cases.push({ id: item.id, kind: item.kind, ...(item.os ? { os: item.os } : {}), observation: await observer() });
    }
    return cases;
  };
  const roots = tls.rootCertificates.map(pem => new X509Certificate(pem).raw);
  const supplementary = [];
  for (const [set, certificates] of [['root-a', [a]], ['root-b', [b]], ['root-a+root-b', [a, b]], ['node-bundled-roots', roots]])
    for (const format of ['pem', 'pkcs7-der']) supplementary.push({ set, format, certificates: certificates.length, ...strip(await serialize(format, certificates)) });
  return {
    fixtures: exportCaseFixtureNames.map((name, index) => ({ name, sha256: sha(pems[index]), fingerprint: sha([a, b][index]) })),
    profiles: { 'export-pem-parse-v1': await observeFormat('pem'), 'export-p7b-parse-v1': await observeFormat('pkcs7-der') },
    supplementary: { node: process.version, nodeBundledRootsSha256: sha(Buffer.from(tls.rootCertificates.join('\n'))), results: supplementary }
  };
}
