import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { composeTrustSources, reviewTrustDelta, canonicalTrustJson, domainHash, SOURCE_DOMAIN, hashTrustSourceSet }
  from '../../src/harness/trust-source.mjs';
import { sha256Hex, parsePemBundle } from '../../src/harness/trust-encoding.mjs';
import { discoverTrustSources, parseTrustOutput, serializeTrustSet } from '../../src/harness/trust.mjs';

const read = name => readFileSync(new URL(`./fixtures/${name}.pem`, import.meta.url));
const rootA = read('root-a'); const rootB = read('root-b'); const leaf = read('leaf-a');
const derOf = pem => Buffer.from(new X509Certificate(pem).raw);
const fpA = sha256Hex(derOf(rootA)); const fpB = sha256Hex(derOf(rootB));
const now = Date.UTC(2026, 9, 4);
const adapter = { id: 'ubuntu-24.04-system-openssl-v1', version: '1', sha256: 'f'.repeat(64) };
const osObservation = (candidates, extra = {}) => ({ status: 'complete', projection: adapter.id, reason: null, adapter,
  policy: { projection: adapter.id, bundleSha256: 'a'.repeat(64) }, candidates, ...extra });
const supplied = (id, bytes, extra = {}) => ({ id, bytes, origin: 'explicit', ...extra });

test('canonical JSON uses UTF-16 key order and rejects unsafe numbers; hashes use the NUL-separated domain', () => {
  assert.equal(canonicalTrustJson({ b: 1, a: [true, null, 'x'], '￿': 0, '𐀀': 1 }), '{"a":[true,null,"x"],"b":1,"𐀀":1,"￿":0}');
  assert.throws(() => canonicalTrustJson({ a: 1.5 }));
  assert.throws(() => canonicalTrustJson({ a: -0 }));
  assert.equal(domainHash(SOURCE_DOMAIN, { a: 1 }), sha256Hex(Buffer.concat([Buffer.from('aih.trust.sources.v1'), Buffer.from([0]), Buffer.from('{"a":1}')])));
});

test('OS + supplied partitions compose with provenance, stable hashes and no clock in identity', () => {
  const run = at => composeTrustSources({ os: osObservation([{ der: derOf(rootA), provenance: ['system-openssl-bundle'] }]),
    supplied: [supplied('team', rootB)], now: at });
  const first = run(now); const second = run(now + 86_400_000);
  assert.equal(first.status, 'ready', JSON.stringify(first.diagnostics));
  assert.deepEqual(first.sources.map(row => row.id), ['os', 'supplied:team']);
  const os = first.sources[0];
  assert.deepEqual(Object.keys(os), ['id', 'kind', 'adapter', 'scope', 'completeness', 'policySha256', 'sourceSha256', 'runtimeVersion', 'reason', 'fingerprints']);
  assert.equal(os.scope, 'effective-current-user'); assert.equal(first.sources[1].scope, 'explicit-source');
  assert.equal(first.sources[1].sourceSha256, sha256Hex(rootB));
  assert.equal(first.sourceSetSha256, hashTrustSourceSet(first.sources));
  assert.equal(second.sourceSetSha256, first.sourceSetSha256);
  assert.deepEqual(first.suitableFingerprints, [fpA, fpB].sort());
  assert.deepEqual(first.certificates.map(item => item.sources).flat().sort(), ['os', 'supplied:team']);
  assert.equal(first.der.size, 2);
  const changed = composeTrustSources({ os: osObservation([{ der: derOf(rootA), provenance: ['other'] }]), supplied: [supplied('team', rootB)], now });
  assert.notEqual(changed.sources[0].sourceSha256, os.sourceSha256);
});

test('a certificate under two owners keeps both provenance entries and counts twice toward combined admission', () => {
  const result = composeTrustSources({ os: osObservation([{ der: derOf(rootA), provenance: ['s'] }]), supplied: [supplied('dup', rootA)], now });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.certificates[0].sources, ['os', 'supplied:dup']);
  assert.equal(result.suitableFingerprints.length, 1);
});

test('exclusions stay visible: not-CA, distrust, expiry; conditional trust is a policy loss, never silently dropped', () => {
  const candidates = [{ der: derOf(rootA), provenance: ['s'] }, { der: derOf(leaf), provenance: ['s'] },
    { der: derOf(rootB), provenance: ['s'], verdict: 'distrusted' }];
  const result = composeTrustSources({ os: osObservation(candidates), now });
  assert.equal(result.status, 'ready');
  const by = new Map(result.certificates.map(item => [item.fingerprint, item]));
  assert.deepEqual(by.get(sha256Hex(derOf(leaf))).reasons, ['not-ca']);
  assert.deepEqual(by.get(fpB).reasons, ['explicit-distrust']);
  assert.deepEqual(by.get(fpB).excludedFrom, ['os']);
  const expired = composeTrustSources({ os: osObservation([{ der: derOf(rootA), provenance: ['s'] }]), now: Date.UTC(2040, 0, 1) });
  assert.equal(expired.status, 'blocked');
  assert.equal(expired.diagnostics[0].reason, 'trust-source-empty');
  const conditional = composeTrustSources({ os: osObservation([{ der: derOf(rootA), provenance: ['s'], restrictions: ['hostname'] }]), now });
  assert.equal(conditional.status, 'blocked');
  assert.ok(conditional.diagnostics.some(item => item.reason === 'trust-policy-loss' && item.code === 'PREREQUISITE_UNAVAILABLE'));
  assert.equal(conditional.der.size, 0); assert.equal(conditional.suitableFingerprints.length, 0);
  assert.equal(conditional.sourceSetSha256, hashTrustSourceSet(conditional.sources));
  assert.deepEqual(conditional.certificates[0].reasons, ['conditional-trust:hostname']);
});

test('incomplete or unavailable OS discovery blocks and never falls back to supplied-only', () => {
  for (const [status, reason, expected] of [['incomplete', 'trust-discovery-incomplete', 'trust-discovery-incomplete'],
    ['unavailable', 'trust-platform-unsupported', 'trust-platform-unsupported'],
    ['unavailable', 'trust-configuration-unavailable', 'trust-configuration-unavailable']]) {
    const result = composeTrustSources({ os: { status, projection: adapter.id, reason, adapter, policy: null, candidates: [{ der: derOf(rootA), provenance: [] }] },
      supplied: [supplied('team', rootB)], now });
    assert.equal(result.status, 'blocked');
    assert.equal(result.diagnostics[0].reason, expected);
    assert.equal(result.sources[0].completeness, status);
    assert.deepEqual(result.sources[0].fingerprints, []);
    assert.equal(result.sourceSetSha256, hashTrustSourceSet(result.sources));
    assert.equal(result.der.size, 0);
  }
});

test('a complete empty OS set combines with valid supplied material; OS-only empty blocks', () => {
  assert.equal(composeTrustSources({ os: osObservation([]), supplied: [supplied('team', rootB)], now }).status, 'ready');
  const empty = composeTrustSources({ os: osObservation([]), now });
  assert.equal(empty.diagnostics[0].reason, 'trust-source-empty');
});

test('supplied inputs: invalid, retained changed/expired, duplicate IDs and bad IDs', () => {
  const bad = composeTrustSources({ supplied: [supplied('team', Buffer.from('nope'))], now });
  assert.equal(bad.status, 'invalid'); assert.equal(bad.diagnostics[0].code, 'INPUT_INVALID');
  const keep = { origin: 'retained', admittedSha256: sha256Hex(rootB) };
  assert.equal(composeTrustSources({ supplied: [supplied('team', rootB, keep)], now }).status, 'ready');
  const changed = composeTrustSources({ supplied: [supplied('team', rootA, keep)], now });
  assert.equal(changed.diagnostics[0].reason, 'supplied-source-changed');
  assert.equal(changed.diagnostics[0].code, 'PREREQUISITE_UNAVAILABLE');
  const expired = composeTrustSources({ supplied: [supplied('team', rootB, keep)], now: Date.UTC(2040, 0, 1) });
  assert.equal(expired.diagnostics[0].reason, 'supplied-source-expired');
  const unavailable = composeTrustSources({ supplied: [{ id: 'team', origin: 'retained', admittedSha256: fpB }], now });
  assert.equal(unavailable.diagnostics[0].reason, 'supplied-source-unavailable');
  assert.equal(composeTrustSources({ supplied: [supplied('a', rootA), supplied('a', rootB)], now }).diagnostics[0].reason, 'invalid-source-selection');
  assert.equal(composeTrustSources({ supplied: [supplied('-bad', rootA)], now }).diagnostics[0].reason, 'invalid-source-selection');
  assert.equal(composeTrustSources({ osRequested: false, supplied: [], now }).status, 'invalid');
});

test('limits block rather than truncate: 33 sources, candidate incidences, per-certificate bytes', () => {
  const many = Array.from({ length: 33 }, (_, index) => supplied(`s${index}`, rootA));
  assert.equal(composeTrustSources({ supplied: many, now }).diagnostics.some(item => item.code === 'SOURCE_LIMIT'), true);
  const thirtyTwo = composeTrustSources({ supplied: many.slice(0, 32), now });
  assert.equal(thirtyTwo.status, 'ready');
  const incidences = Array.from({ length: 4097 }, () => ({ der: derOf(rootA), provenance: ['s'] }));
  const over = composeTrustSources({ os: osObservation(incidences), now });
  assert.equal(over.status, 'blocked'); assert.equal(over.diagnostics[0].code, 'SOURCE_LIMIT'); assert.equal(over.diagnostics[0].reason, 'source-limit');
  const atLimit = composeTrustSources({ os: osObservation(incidences.slice(0, 4096)), now });
  assert.equal(atLimit.status, 'ready');
  const huge = composeTrustSources({ os: osObservation([{ der: Buffer.alloc(65_537), provenance: ['s'] }]), now });
  assert.equal(huge.diagnostics[0].code, 'SOURCE_LIMIT');
});

test('Node-bundled partition carries runtime version and a digest of its sorted fingerprints', () => {
  const result = composeTrustSources({ supplied: [supplied('team', rootB)], includeNodeBundled: true, now });
  const bundled = result.sources.find(row => row.id === 'node-bundled-default');
  assert.equal(bundled.runtimeVersion, process.version);
  assert.equal(bundled.kind, 'node-bundled'); assert.equal(bundled.scope, 'runtime-bundled');
  assert.equal(bundled.sourceSha256, domainHash(SOURCE_DOMAIN, { fingerprints: bundled.fingerprints, runtimeVersion: process.version }));
  assert.ok(bundled.fingerprints.length >= tls.rootCertificates.length / 2);
  assert.ok(result.suitableFingerprints.includes(fpB));
});

test('JKS baseline is a separate bound row outside the certificate set', () => {
  const result = composeTrustSources({ supplied: [supplied('team', rootB)], baseline: { bytes: Buffer.from('not a jks') }, now });
  assert.equal(result.status, 'invalid');
  assert.ok(['baseline-store-invalid', 'baseline-store-unsupported'].includes(result.diagnostics[0].reason));
});

test('delta review reports added, removed, retained, provenance-changed, excluded and OS removal with legacy provenance unknown', () => {
  const discovery = composeTrustSources({ os: osObservation([{ der: derOf(rootA), provenance: ['s'] }, { der: derOf(leaf), provenance: ['s'] }]),
    supplied: [supplied('team', rootB)], now });
  const prior = parsePemBundle(Buffer.concat([rootA, rootB]));
  const withProvenance = reviewTrustDelta({ discovery, prior: { sources: [{ id: 'os', fingerprints: [fpA, fpB] }], output: prior } });
  const row = fingerprint => withProvenance.find(item => item.fingerprint === fingerprint);
  assert.equal(row(fpA).disposition, 'retained');
  assert.equal(row(fpB).disposition, 'provenance-changed');
  assert.deepEqual(row(fpB).beforeSources, ['os']); assert.deepEqual(row(fpB).afterSources, ['supplied:team']);
  assert.ok(row(fpB).reasons.includes('os-source-removed'));
  assert.equal(row(sha256Hex(derOf(leaf))).disposition, 'excluded');
  const legacy = reviewTrustDelta({ discovery, prior: { output: prior } });
  assert.ok(legacy.find(item => item.fingerprint === fpA).reasons.includes('prior-provenance-unknown'));
  const added = reviewTrustDelta({ discovery, prior: { sources: [], output: parsePemBundle(rootA) } });
  assert.equal(added.find(item => item.fingerprint === fpB).disposition, 'added');
  const removed = reviewTrustDelta({ discovery: composeTrustSources({ supplied: [supplied('team', rootB)], now }), prior: { output: prior } });
  const old = removed.find(item => item.fingerprint === fpA);
  assert.equal(old.disposition, 'removed'); assert.ok(old.subject.length > 0);
  assert.deepEqual(withProvenance.map(item => item.fingerprint), [...withProvenance.map(item => item.fingerprint)].sort());
});

test('discoverTrustSources validates requests, honours cancellation and composes supplied-only without OS observation', async () => {
  assert.equal((await discoverTrustSources({ sources: { os: 'yes', supplied: [] }, network: 'off' })).status, 'invalid');
  const controller = new AbortController(); controller.abort();
  assert.equal((await discoverTrustSources({ sources: { os: true, supplied: [] }, network: 'off' }, { signal: controller.signal })).status, 'cancelled');
  const result = await discoverTrustSources({ sources: { os: false, supplied: [supplied('team', rootB)] }, network: 'off', now });
  assert.equal(result.status, 'ready');
  const serialized = await serializeTrustSet({ format: 'pem', certificates: [...result.der.values()].map(der => ({ der })) });
  assert.equal(serialized.status, 'serialized');
  assert.deepEqual(parseTrustOutput(serialized.bytes, 'pem').certificates.map(item => item.fingerprint), [fpB]);
});
