// New-contract JVM file repair helper: deterministic CA-only JKS merge + fixed file.write recipe.
// Imports the source module directly so the check does not depend on a shared dist build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildJvmTrustStore, renderJvmTrustFileRepair, validateBaselineStore } from '../../src/harness/jvm-trust.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pemDer = bytes => Buffer.from(bytes.toString('utf8')
  .match(/-----BEGIN CERTIFICATE-----([^]*)-----END CERTIFICATE-----/)[1].replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');

const rootA = fixture('root-a.pem');
const rootB = fixture('root-b.pem');
const leaf = fixture('leaf-a.pem');
const derA = pemDer(rootA);
const derB = pemDer(rootB);
const derLeaf = pemDer(leaf);
const fpA = sha256(derA);
const fpB = sha256(derB);
const fpLeaf = sha256(derLeaf);
const baselineTimestamp = Buffer.from('0000018a2b3c4d5e', 'hex');

/** Independent minimal JKS writer for fixtures (not the module under test). */
function writeJks(entries) {
  const parts = [];
  const u32 = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };
  const u16 = value => { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; };
  parts.push(u32(0xfeedfeed), u32(2), u32(entries.length));
  for (const [alias, der, timestamp] of entries) parts.push(u32(2), u16(alias.length),
    Buffer.from(alias, 'latin1'), timestamp, u16(5), Buffer.from('X.509', 'latin1'), u32(der.length), der);
  const body = Buffer.concat(parts);
  const password = Buffer.alloc('changeit'.length * 2);
  for (let i = 0; i < 'changeit'.length; i++) password.writeUInt16BE('changeit'.charCodeAt(i), i * 2);
  const integrity = createHash('sha1').update(password).update('Mighty Aphrodite', 'latin1').update(body).digest();
  return Buffer.concat([body, integrity]);
}

/** Independent structural reader used to observe actual produced bytes. */
function readJks(bytes) {
  const buffer = Buffer.from(bytes);
  assert.equal(buffer.readUInt32BE(0), 0xfeedfeed);
  assert.equal(buffer.readUInt32BE(4), 2);
  const count = buffer.readUInt32BE(8);
  let offset = 12;
  const entries = [];
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32BE(offset), 2);
    offset += 4;
    const aliasLength = buffer.readUInt16BE(offset); offset += 2;
    const alias = Buffer.from(buffer.subarray(offset, offset + aliasLength)); offset += aliasLength;
    const timestamp = Buffer.from(buffer.subarray(offset, offset + 8)); offset += 8;
    const typeLength = buffer.readUInt16BE(offset); offset += 2;
    const type = buffer.subarray(offset, offset + typeLength).toString('latin1'); offset += typeLength;
    const length = buffer.readUInt32BE(offset); offset += 4;
    const der = Buffer.from(buffer.subarray(offset, offset + length)); offset += length;
    entries.push({ alias, timestamp, type, der });
  }
  assert.equal(offset, buffer.length - 20);
  const password = Buffer.alloc('changeit'.length * 2);
  for (let i = 0; i < 'changeit'.length; i++) password.writeUInt16BE('changeit'.charCodeAt(i), i * 2);
  const integrity = createHash('sha1').update(password).update('Mighty Aphrodite', 'latin1')
    .update(buffer.subarray(0, buffer.length - 20)).digest();
  assert.ok(integrity.equals(buffer.subarray(buffer.length - 20)), 'produced store carries a valid integrity hash');
  return entries;
}

const baseline = writeJks([['jdk-root-b', derB, baselineTimestamp]]);
const bundleA = { bundle: rootA, bundleSha256: sha256(rootA), fingerprints: [fpA], baselineStore: baseline };

test('deterministic merge preserves the baseline entry and adds the selected root', () => {
  const first = buildJvmTrustStore(bundleA);
  assert.equal(first.status, 'completed', JSON.stringify(first.diagnostics));
  assert.equal(first.certificateCount, 2);
  assert.equal(first.baselineEntryCount, 1);
  assert.equal(first.addedEntryCount, 1);
  assert.deepEqual(first.fingerprints, [fpA, fpB].sort());
  assert.deepEqual(first.retainedFingerprints, [fpB]);
  assert.deepEqual(first.addedFingerprints, [fpA]);
  assert.equal(first.baselineSha256, sha256(baseline));
  assert.equal(first.sha256, sha256(first.bytes));
  const entries = readJks(first.bytes);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].alias.toString('latin1'), 'jdk-root-b', 'baseline alias preserved');
  assert.deepEqual(entries[0].timestamp, baselineTimestamp, 'baseline timestamp bytes preserved');
  assert.deepEqual(entries[0].der, derB, 'baseline certificate bytes preserved');
  assert.equal(entries[0].type, 'X.509');
  assert.match(entries[1].alias.toString('latin1'), /^aihq-ca-[a-f0-9]{16}$/);
  assert.deepEqual(entries[1].der, derA, 'selected root added verbatim');
  // Same inputs => byte-identical output (Core re-renders at Apply recheck).
  const second = buildJvmTrustStore(bundleA);
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(second.sha256, first.sha256);
  // The legacy validator accepts the produced store as a CA-only JKS with the public password.
  const legacy = validateBaselineStore(first.bytes);
  assert.equal(legacy.valid, true);
  assert.deepEqual([...legacy.fingerprints].sort(), [fpA, fpB].sort());
});

test('a baseline certificate repeated in the source set is retained exactly once', () => {
  const bundle = Buffer.concat([rootA, Buffer.from('\n'), rootB]);
  const result = buildJvmTrustStore({ bundle, bundleSha256: sha256(bundle), fingerprints: [fpA, fpB].sort(), baselineStore: baseline });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.equal(result.certificateCount, 2);
  assert.equal(result.addedEntryCount, 1);
  assert.deepEqual(result.fingerprints, [fpA, fpB].sort());
});

test('baseline admission rejects malformed, key-bearing, non-CA and oversized stores', () => {
  const cases = [
    ['not a store', Buffer.from('\x30\x82\x01\x01pkcs12-ish'), 'baseline-store-unsupported'],
    ['jks version 1', (() => { const bytes = Buffer.from(baseline); bytes.writeUInt32BE(1, 4); return bytes; })(), 'baseline-store-unsupported'],
    ['oversized', (() => { const bytes = Buffer.alloc(4 * 1024 * 1024 + 1); bytes.writeUInt32BE(0xfeedfeed, 0); bytes.writeUInt32BE(2, 4); bytes.writeUInt32BE(1, 8); return bytes; })(), 'baseline-store-unsupported'],
    ['private key entry', (() => { const bytes = Buffer.from(baseline); bytes.writeUInt32BE(1, 12); return bytes; })(), 'baseline-store-invalid'],
    ['non-CA entry', writeJks([['leaf', derLeaf, Buffer.alloc(8)]]), 'baseline-store-invalid'],
    ['tampered integrity', (() => { const bytes = Buffer.from(baseline); bytes[bytes.length - 1] ^= 0xff; return bytes; })(), 'baseline-store-invalid'],
    ['truncated', baseline.subarray(0, baseline.length - 6), 'baseline-store-invalid'],
    ['duplicate aliases', writeJks([['dup', derB, Buffer.alloc(8)], ['DUP', derA, Buffer.alloc(8)]]), 'baseline-store-invalid']
  ];
  for (const [name, store, reason] of cases) {
    const result = buildJvmTrustStore({ ...bundleA, baselineStore: store });
    assert.equal(result.status, 'invalid', `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.diagnostics[0].reason, reason, name);
    assert.equal(result.bytes, undefined, name);
  }
  assert.equal(buildJvmTrustStore({ ...bundleA, baselineStore: undefined }).diagnostics[0].reason, 'baseline-store-invalid');
});

test('source bindings reject digest, fingerprint and CA mismatches without output bytes', () => {
  const digest = buildJvmTrustStore({ ...bundleA, bundleSha256: '0'.repeat(64) });
  assert.equal(digest.status, 'invalid');
  assert.equal(digest.diagnostics[0].reason, 'pem-digest-mismatch');
  const fingerprints = buildJvmTrustStore({ ...bundleA, fingerprints: [fpB] });
  assert.equal(fingerprints.status, 'invalid');
  assert.equal(fingerprints.diagnostics[0].reason, 'repair-bindings');
  const nonCa = buildJvmTrustStore({ ...bundleA, bundle: leaf, bundleSha256: sha256(leaf), fingerprints: [fpLeaf] });
  assert.equal(nonCa.status, 'invalid');
  assert.equal(nonCa.diagnostics[0].reason, 'jks-not-ca');
  const garbage = buildJvmTrustStore({ ...bundleA, bundle: Buffer.from('not pem'), bundleSha256: sha256(Buffer.from('not pem')) });
  assert.equal(garbage.status, 'invalid');
  assert.equal(garbage.diagnostics[0].reason, 'pem-source-invalid');
});

const variantRef = (targets, offline = true) => `jvm-ca/${process.platform}/${targets.join('+')}/${offline ? 'off' : 'declared'}`;
const absolute = (...segments) => process.platform === 'win32' ? `C:\\${segments.join('\\')}` : `/${segments.join('/')}`;

function request(extra = {}) {
  return {
    id: 'jvm-ca', variantRef: variantRef(['gradle', 'maven']), targets: ['gradle', 'maven'], offline: true,
    bundle: rootA, bundlePath: absolute('state', 'trust.pem'), bundleSha256: sha256(rootA), fingerprints: [fpA],
    baselineStore: baseline,
    configSnapshots: { 'gradle-config': Buffer.from('org.gradle.parallel=true\n'),
      'maven-config': Buffer.from(process.platform === 'win32' ? 'REM user maven rc\n' : '# user maven rc\n') },
    executablePaths: { keytoolExecutable: absolute('tools', 'keytool.exe') },
    ...extra
  };
}

test('renderer returns the fixed file.write JKS recipe and precomputed store bytes', () => {
  const result = renderJvmTrustFileRepair(request());
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.equal(result.outputs.length, 1);
  const output = result.outputs[0];
  assert.equal(output.operationId, 'jks-materialize');
  assert.equal(output.format, 'jks');
  assert.equal(output.sha256, sha256(output.bytes));
  assert.deepEqual(output.fingerprints, [fpA, fpB].sort());
  assert.equal(output.baselineSha256, sha256(baseline));
  assert.equal(result.bindings.jksPath, join(dirname(request().bundlePath), 'trust.jks'));
  assert.equal(result.bindings.jksSha256, output.sha256);
  assert.equal(result.bindings.fingerprintCsv, [fpA, fpB].sort().join(','));
  assert.equal(result.bindings.keytoolExecutable, absolute('tools', 'keytool.exe'));
  // Fixed graph: the JKS is a precomputed material, never a process side effect.
  const operations = Object.fromEntries(result.recipe.operations.map(item => [item.id, item]));
  const jks = operations['jks-materialize'];
  assert.equal(jks.kind, 'file.write');
  assert.equal(jks.material, 'generated-jks');
  assert.equal(jks.mode, 0o600);
  assert.deepEqual(jks.target.segments.map(slot => slot.literal), ['trust.jks']);
  assert.equal(jks.target.root, 'userState');
  assert.deepEqual(jks.requires, ['keytool-ready']);
  assert.deepEqual(jks.checks, ['jks-digest', 'jks-content']);
  assert.ok(!result.recipe.operations.some(item => item.kind === 'process.run' && item.id !== 'keytool-ready'),
    'no process operation may create or modify the truststore');
  assert.equal(operations.material.kind, 'file.write');
  assert.deepEqual(operations.material.target.segments.map(slot => slot.literal), ['trust.pem']);
  assert.deepEqual(operations.material.content, { input: 'bundle' });
  assert.deepEqual(operations['gradle-config'].requires, ['jks-materialize']);
  assert.deepEqual(operations['maven-config'].requires, ['jks-materialize']);
  assert.deepEqual(operations['gradle-config'].checks, []);
  const checkIds = result.recipe.checks.map(item => item.id);
  for (const id of ['material-digest', 'jks-digest', 'keytool-available', 'jks-content']) assert.ok(checkIds.includes(id), id);
  assert.equal(result.recipe.id, 'jvm-ca');
  assert.equal(result.recipe.inputs.bundle.sensitive, true);
  // Public/private binding split matches the declared recipe inputs exactly (bundle excluded).
  const publicNames = Object.keys(result.recipe.inputs).filter(name => !result.recipe.inputs[name].sensitive && name !== 'bundle').sort();
  const sensitiveNames = Object.keys(result.recipe.inputs).filter(name => result.recipe.inputs[name].sensitive && name !== 'bundle').sort();
  assert.deepEqual(Object.keys(result.bindings).sort(), publicNames);
  assert.deepEqual(Object.keys(result.privateBindings).sort(), sensitiveNames);
  // Config rewrites reference the reviewed fixed JKS path and keep neighbors.
  assert.ok(result.privateBindings.gradleConfig.startsWith('org.gradle.parallel=true\n'));
  assert.ok(result.privateBindings.gradleConfig.includes(`systemProp.javax.net.ssl.trustStore=${result.bindings.jksPath.replaceAll('\\', '/')}`));
  assert.ok(result.privateBindings.mavenConfig.includes(`-Djavax.net.ssl.trustStore=${result.bindings.jksPath}`));
  // Deterministic across renders.
  const twice = renderJvmTrustFileRepair(request());
  assert.equal(twice.status, 'completed');
  assert.equal(twice.outputs[0].sha256, output.sha256);
  assert.deepEqual(twice.outputs[0].bytes, output.bytes);
  assert.deepEqual(twice.bindings, result.bindings);
  assert.deepEqual(twice.privateBindings, result.privateBindings);
  // Re-rendering with the previously rewritten config is byte-idempotent.
  const replayed = renderJvmTrustFileRepair(request({ configSnapshots: {
    'gradle-config': Buffer.from(result.privateBindings.gradleConfig),
    'maven-config': Buffer.from(result.privateBindings.mavenConfig) } }));
  assert.equal(replayed.status, 'completed', JSON.stringify(replayed.diagnostics));
  assert.deepEqual(replayed.privateBindings, result.privateBindings);
});

test('renderer keeps the legacy environment and configuration guardrails', () => {
  const saved = Object.fromEntries(['GRADLE_USER_HOME', 'MAVEN_SKIP_RC', 'JAVA_TOOL_OPTIONS']
    .map(key => [key, process.env[key]]));
  try {
    process.env.GRADLE_USER_HOME = absolute('other-gradle');
    let blocked = renderJvmTrustFileRepair(request());
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.diagnostics[0].reason, 'user-config-location-unsupported');
    delete process.env.GRADLE_USER_HOME;

    process.env.MAVEN_SKIP_RC = '1';
    blocked = renderJvmTrustFileRepair(request());
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.diagnostics[0].reason, 'trust-bypass-environment');
    delete process.env.MAVEN_SKIP_RC;

    process.env.JAVA_TOOL_OPTIONS = '-Djavax.net.ssl.trustStore=/inherited.jks';
    blocked = renderJvmTrustFileRepair(request());
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.diagnostics[0].reason, 'trust-override-environment');
    delete process.env.JAVA_TOOL_OPTIONS;

    const ambiguous = renderJvmTrustFileRepair(request({ configSnapshots: {
      'gradle-config': Buffer.from('systemProp.javax.net.ssl.trustStore=/one.jks\nsystemProp.javax.net.ssl.trustStore=/two.jks\n') } }));
    assert.equal(ambiguous.status, 'invalid');
    assert.equal(ambiguous.diagnostics[0].reason, 'config-ambiguous');

    const missingBaseline = renderJvmTrustFileRepair(request({ baselineStore: undefined }));
    assert.equal(missingBaseline.status, 'invalid');
    assert.equal(missingBaseline.diagnostics[0].reason, 'baseline-store-invalid');

    const badDigest = renderJvmTrustFileRepair(request({ bundleSha256: '0'.repeat(64) }));
    assert.equal(badDigest.status, 'invalid');
    assert.equal(badDigest.diagnostics[0].reason, 'pem-digest-mismatch');

    const wrongTargets = renderJvmTrustFileRepair(request({ targets: ['gradle'] }));
    assert.equal(wrongTargets.status, 'invalid');
    assert.equal(wrongTargets.diagnostics[0].reason, 'repair-input');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('renderer blocks a complete distinct JVM set above the portable process argument bound', () => {
  // Structural CA fixtures with distinct serials; this is no signature or native TLS proof.
  const serial = Buffer.from(new X509Certificate(rootB).serialNumber, 'hex');
  const offset = derB.indexOf(serial); assert.ok(offset > 0);
  const entries = Array.from({ length: 400 }, (_, index) => {
    const der = Buffer.from(derB); der.writeUInt16BE(index, offset + serial.length - 2);
    return [`fixture-${index}`, der, baselineTimestamp];
  });
  const result = renderJvmTrustFileRepair(request({ baselineStore: writeJks(entries) }));
  assert.equal(result.status, 'blocked', JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics.map(d => [d.code, d.reason]), [['SOURCE_LIMIT', 'source-limit']]);
  assert.equal(result.recipe, undefined); assert.equal(result.outputs, undefined);
});

// Independent native encoding evidence only: keytool reading the produced store.
// Not an admitted native OS cell; skipped unless a real keytool is supplied.
test('produced JKS is readable by an installed keytool', { skip: !process.env.AIHQ_TEST_JVM_KEYTOOL }, () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-jvm-encoding-'));
  try {
    const result = buildJvmTrustStore(bundleA);
    assert.equal(result.status, 'completed');
    const path = join(root, 'trust.jks');
    writeFileSync(path, result.bytes);
    const run = spawnSync(process.env.AIHQ_TEST_JVM_KEYTOOL,
      ['-list', '-v', '-keystore', path, '-storepass', 'changeit', '-storetype', 'JKS'],
      { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const found = new Set([...String(run.stdout).matchAll(/SHA256:\s*([0-9A-Fa-f:]+)/g)].map(m => m[1].replaceAll(':', '').toLowerCase()));
    for (const fingerprint of [fpA, fpB]) assert.ok(found.has(fingerprint), `keytool reports ${fingerprint}`);
    assert.ok(existsSync(path));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
