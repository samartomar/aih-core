import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepare, apply, prepareManagedRemoval } from '../dist/core/index.js';
import { validatePreparedWork12, validateRunResult12, validateTrustCustody } from '../dist/core/contracts.js';

// Public repair API over the shared trust source for existing non-Node families.
// Fixture executables only prove discovery/launch wiring, never native TLS behavior.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'aih-trust-user-jvm-')));
const home = join(scratch, 'home');
const bin = join(scratch, 'bin');
const rootA = readFileSync(new URL('./fixtures/root-a.pem', import.meta.url));
const rootB = readFileSync(new URL('./harness/fixtures/root-b.pem', import.meta.url));
const appData = join(home, 'AppData', 'Roaming');
const envKeys = ['HOME', 'USERPROFILE', 'PATH', 'APPDATA', 'GIT_CONFIG_GLOBAL', 'GIT_SSL_NO_VERIFY', 'GIT_SSL_CAINFO', 'PIP_CERT',
  'PIP_TRUSTED_HOST', 'PIP_CONFIG_FILE', 'CONDARC', 'CONDA_SSL_VERIFY', 'CARGO_HOME', 'CARGO_HTTP_CAINFO', 'CARGO_HTTP_SSL_VERIFY',
  'XDG_CONFIG_HOME', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'WIN_PD_OVERRIDE_APPDATA', 'GRADLE_USER_HOME', 'MAVEN_SKIP_RC',
  'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS'];
const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
before(() => {
  mkdirSync(home); mkdirSync(bin);
  for (const key of envKeys.slice(3)) delete process.env[key];
  process.env.HOME = home; process.env.USERPROFILE = home;
  if (process.platform === 'win32') process.env.APPDATA = appData;
});
beforeEach(() => {
  for (const path of [home, bin]) {
    assert.equal(dirname(realpathSync(path)), scratch);
    rmSync(path, { recursive: true }); mkdirSync(path);
  }
  if (process.platform === 'win32') mkdirSync(appData, { recursive: true });
});
after(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true });
});

const withPath = async fn => { process.env.PATH = bin; try { return await fn(); } finally { process.env.PATH = saved.PATH; } };
const fixtureTool = (name, marker = '') => {
  if (process.platform === 'win32') { copyFileSync(process.execPath, join(bin, `${name}.exe`)); if (marker) writeFileSync(join(bin, `${name}.exe`), marker, { flag: 'a' }); return; }
  writeFileSync(join(bin, name), `#!/bin/sh\n# ${marker}\nexit 0\n`, { mode: 0o755 });
};
const source = (name, bytes = rootA) => { const path = join(scratch, name); writeFileSync(path, bytes); return path; };
const approve = p => ({ approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest });
const repair = (id, targets, extra = {}) => ({ schema: 'urn:aihq:core:repair-request:1.0.0', useCase: 'repair', route: 'file',
  network: 'off', repairs: [{ id, targets, inputs: {} }], ...extra });
const pipConfig = () => process.platform === 'win32' ? join(appData, 'pip', 'pip.ini') : join(home, '.config', 'pip', 'pip.conf');
const custody = () => JSON.parse(readFileSync(join(home, '.aih', 'core', 'trust-custody.json')));
const valid = (validator, value) => { const checked = validator(value); assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics)); };

test('supplied-only pip repair writes the original pip transform with paired custody and refreshes from retained custody', () => withPath(async () => {
  fixtureTool('pip');
  const file = source('team.pem');
  const p = await prepare(repair('user-tools-ca', ['pip'], { sources: { os: false, supplied: [{ id: 'team', file }] } }), { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  valid(validatePreparedWork12, p.review);
  const trust = p.review.inputs.trust;
  assert.ok(trust.sources.some(s => s.id === 'supplied:team' && s.completeness === 'complete'));
  assert.deepEqual(trust.targets.map(t => [t.id, t.admission, t.verification.status]), [['pip', 'admitted', 'skipped']]);
  assert.equal(p.review.operations.find(o => o.id === 'trust/pip-config').effects, 'create-file');
  assert.equal(p.review.operations.find(o => o.id === 'trust/pip-config').details.content, '[REDACTED]');
  assert.equal(trust.outputs.length, 1); assert.equal(trust.outputs[0].managementId, 'user-tools-trust');
  assert.equal(existsSync(pipConfig()), false); assert.equal(existsSync(trust.outputs[0].path), false);

  const r = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.equal(r.completion, 'complete', JSON.stringify(r.diagnostics));
  valid(validateRunResult12, r);
  assert.deepEqual(r.trust.targets.map(t => [t.id, t.configuration, t.verification]), [['pip', 'applied', 'skipped']]);
  const output = r.trust.outputs[0];
  assert.equal(output.path, trust.outputs[0].path); assert.equal(output.status, 'written');
  const team = trust.sources.find(s => s.id === 'supplied:team').fingerprints;
  assert.ok(team.length && team.every(f => trust.certificates.some(c => c.fingerprint === f && c.afterSources.includes('supplied:team'))));
  assert.match(readFileSync(pipConfig(), 'utf8'), new RegExp(`cert=${output.path.replace(/[\\.]/g, '\\$&')}`));
  const recorded = custody(); valid(validateTrustCustody, recorded);
  assert.deepEqual(recorded.entries.map(e => [e.managementId, e.format, e.outputSha256]), [['user-tools-trust', 'pem', output.sha256]]);
  assert.equal(recorded.entries[0].sources.find(s => s.id === 'supplied:team').privateFile, file);

  const retained = await prepare(repair('user-tools-ca', ['pip'], { sources: { os: false, supplied: [] } }), { logging: 'off' });
  assert.equal(retained.status, 'ready', JSON.stringify(retained.diagnostics));
  assert.equal(retained.review.operations.find(o => o.id === 'trust/pip-config').effects, 'already-satisfied');
  const again = await apply(retained.prepared, approve(retained), { logging: 'off' });
  assert.equal(again.completion, 'complete', JSON.stringify(again.diagnostics));
  assert.equal(again.trust.outputs[0].status, 'unchanged');
}));

test('multiple selected user tools complete and refresh after their own configuration writes', () => withPath(async () => {
  fixtureTool('pip'); fixtureTool('git');
  const request = repair('user-tools-ca', ['pip', 'git'], { sources: { os: false, supplied: [{ id: 'team', file: source('multiple.pem') }] } });
  const p = await prepare(request, { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  const r = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.equal(r.completion, 'complete', JSON.stringify(r.diagnostics));
  assert.deepEqual(r.trust.targets.map(t => [t.id, t.configuration]), [['pip', 'applied'], ['git', 'applied']]);
  const retained = await prepare({ ...request, sources: { os: false, supplied: [] } }, { logging: 'off' });
  assert.equal(retained.status, 'ready', JSON.stringify(retained.diagnostics));
  assert.equal((await apply(retained.prepared, approve(retained), { logging: 'off' })).completion, 'complete');
}));

test('a configuration change after review rejects as trust-binding-changed before any effect', () => withPath(async () => {
  fixtureTool('pip');
  const p = await prepare(repair('user-tools-ca', ['pip'], { sources: { os: false, supplied: [{ id: 'team', file: source('stale.pem') }] } }), { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  mkdirSync(dirname(pipConfig()), { recursive: true }); writeFileSync(pipConfig(), '[global]\nindex-url=https://r.example/simple\n');
  const r = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.equal(r.completion, 'rejected', JSON.stringify(r.diagnostics));
  assert.ok(r.diagnostics.some(d => d.code === 'REVIEW_STALE' && d.reason === 'trust-binding-changed'), JSON.stringify(r.diagnostics));
  valid(validateRunResult12, r); assert.deepEqual(r.trust.outputs, []);
  assert.equal(readFileSync(pipConfig(), 'utf8'), '[global]\nindex-url=https://r.example/simple\n');
  assert.equal(existsSync(p.review.inputs.trust.outputs[0].path), false);
}));

test('a changed executable after review rejects as trust-binding-changed', () => withPath(async () => {
  fixtureTool('pip');
  const p = await prepare(repair('user-tools-ca', ['pip'], { network: 'declared', sources: { os: false, supplied: [{ id: 'team', file: source('exe.pem') }] } }), { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  assert.equal(p.review.inputs.trust.targets[0].verification.status, 'planned');
  fixtureTool('pip', 'replaced after review');
  const r = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.equal(r.completion, 'rejected', JSON.stringify(r.diagnostics));
  assert.ok(r.diagnostics.some(d => d.code === 'REVIEW_STALE' && d.reason === 'trust-binding-changed'));
  assert.equal(existsSync(pipConfig()), false);
}));

for (const [label, extra, reason] of [
  ['os:true file repair has no admitted client cell', { os: true }, 'file-route-unsupported'],
  ['native repair has no admitted cell', { route: 'native' }, 'native-route-unsupported']])
  test(`user-tools ${label}: every target unavailable, no partial bundle`, () => withPath(async () => {
    fixtureTool('pip'); fixtureTool('git');
    const request = extra.route ? { ...repair('user-tools-ca', ['git', 'pip']), route: 'native' } :
      repair('user-tools-ca', ['git', 'pip'], { sources: { os: true, supplied: [{ id: 'team', file: source('os.pem') }] } });
    const p = await prepare(request, { logging: 'off' });
    assert.equal(p.status, 'blocked', JSON.stringify(p.diagnostics)); assert.equal(p.prepared, undefined);
    valid(validatePreparedWork12, p.review);
    assert.deepEqual(p.review.inputs.trust.targets.map(t => [t.id, t.admission, t.reason]), [['pip', 'unavailable', reason], ['git', 'unavailable', reason]]);
    // OS discovery may itself block first on hosts without a complete projection; either way nothing is admitted.
    if (extra.route) assert.ok(p.diagnostics.some(d => d.reason === reason));
    assert.deepEqual(p.review.inputs.trust.outputs, []); assert.equal(existsSync(join(home, '.aih', 'core', 'content')), false);
  }));

test('the variant required absence blocks Cargo before review', () => withPath(async () => {
  fixtureTool('cargo'); fixtureTool('git');
  mkdirSync(join(home, '.cargo')); writeFileSync(join(home, '.cargo', 'config'), '[http]\n');
  const p = await prepare(repair('user-tools-ca', ['cargo'], { sources: { os: false, supplied: [{ id: 'team', file: source('cargo.pem') }] } }), { logging: 'off' });
  assert.equal(p.status, 'blocked', JSON.stringify(p.diagnostics)); assert.equal(p.prepared, undefined);
  assert.ok(p.diagnostics.some(d => d.code === 'PREREQUISITE_UNAVAILABLE' && d.reason === 'cargo-legacy-config'), JSON.stringify(p.diagnostics));
}));

test('a redirected tool configuration location blocks like the legacy repair', () => withPath(async () => {
  fixtureTool('pip'); process.env.PIP_CONFIG_FILE = join(scratch, 'elsewhere.ini');
  try {
    const p = await prepare(repair('user-tools-ca', ['pip'], { sources: { os: false, supplied: [{ id: 'team', file: source('redirect.pem') }] } }), { logging: 'off' });
    assert.equal(p.status, 'blocked', JSON.stringify(p.diagnostics)); assert.equal(p.prepared, undefined);
    assert.ok(p.diagnostics.some(d => d.reason === 'user-config-location-unsupported'), JSON.stringify(p.diagnostics));
  } finally { delete process.env.PIP_CONFIG_FILE; }
}));

test('new custody refuses legacy user-tools requests and is retired by managed removal', () => withPath(async () => {
  fixtureTool('pip');
  const file = source('legacy.pem');
  const p = await prepare(repair('user-tools-ca', ['pip'], { sources: { os: false, supplied: [{ id: 'team', file }] } }), { logging: 'off' });
  assert.equal((await apply(p.prepared, approve(p), { logging: 'off' })).completion, 'complete');
  const legacy = await prepare({ useCase: 'repair', network: 'off', repairs: [{ id: 'user-tools-ca', targets: ['pip'], inputs: { caFile: file } }] }, { logging: 'off' });
  assert.equal(legacy.status, 'blocked'); assert.ok(legacy.diagnostics.some(d => d.code === 'STATE_CONFLICT' && d.reason === 'new-custody-legacy-request'));
  const removal = await prepareManagedRemoval({ target: { project: home }, managementId: 'user-tools-trust', scope: 'user', mode: 'vibe' }, { logging: 'off' });
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal.diagnostics));
  const removed = await apply(removal.preparation.prepared, approve(removal.preparation), { logging: 'off' });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed.diagnostics));
  assert.equal(existsSync(p.review.inputs.trust.outputs[0].path), false); assert.deepEqual(custody().entries, []);
}));

// A genuine JKS trust-only fixture generated with keytool from root-a.pem (shared with test/jvm-trust.test.mjs).
// It is a public boundary input; it does not stand in for native manager proof.
const baseline = Buffer.from(
  '/u3+7QAAAAIAAAABAAAAAgAPYmFzZWxpbmUtcm9vdC1hAAABoPLogl0ABVguNTA5AAADMTCCAy0wggIVoAMCAQICFEi7M8kS+N38nmm2iz+lQMtOlUePMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNVBAMME0V4YW1wbGUgVGVzdCBSb290IEEwHhcNMjYwNzI0MDcyNzU2WhcNMzYwNzIxMDcyNzU2WjAeMRwwGgYDVQQDDBNFeGFtcGxlIFRlc3QgUm9vdCBBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv8D1jVEvkjh9hwYkFNySnXeTNeBo1iDDijikL9fQOSFDC/GoLDf+W3D51mb7ipDQlWgQiQI05mPIlz1AYwrgXgqZfGY77TjvLUJM/MWrLCvn59TG9DlDVhEQw+KpABU9bMsFs27G1fM4oNhFEwG4MEwlSLh+K7MFtNRuXG1tHeBE6nca9KzzrCxn2derb4rcFxNzsTt7Z4JCeqFLkHgyoRR35WtosnAXsUrtgAeWisQ3EsZiahc0QfCOI4Em7q0TAB/VdmOULw2cTTX+2issQ8skB9MfV5WwiwNj5TSPK3fmu0i+4YxF/IGwHBtnIEt6K/R6oHybWUZYwwHlY7nMSwIDAQABo2MwYTAfBgNVHSMEGDAWgBQv63NxNudIy1i4UlJbtq7gMfz4LjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUL+tzcTbnSMtYuFJSW7au4DH8+C4wDQYJKoZIhvcNAQELBQADggEBAAEkgMB4u4Y56em6wDuFv8kcoTt5B20mNS1j9JbI3/Ehi4PEKgYI/t+ZN14t3WdPKTX4GrjJ9xqPJM5KlXM6iEQb1mhyAbXoX+Wdwnv9JLn5drTq5SkUhAQOb4kwyuFVRcnZeS8+lyxG8+4uEfiGktrL+1rp1u4qBFz/bsdPa5ffzCnowt/RCAfWaPcOTOlldX0zADQB8DthbvXKobgf3fOkqAskXD7wkpgc6inyDXrmreCyTKFpIIrVb8GYyw4JYykyB/iP+r/sqjY+JpfOa8tI/LmYRkSZuyWksmxSjCaDTiwX3aLvnkxRplkIEmaWMPDxMauGpTgMm/fEwRzlobXZHf6eY8RFn+7LUGHvSordF5g69g==',
  'base64');
const jvm = baselineStore => ({ ...repair('jvm-ca', ['gradle'], { sources: { os: false, supplied: [{ id: 'team', file: source('jvm.pem', rootB) }] } }),
  repairs: [{ id: 'jvm-ca', targets: ['gradle'], inputs: { baselineStore } }] });

// Replace the one certificate in the genuine keytool fixture, preserving its entry header.
const baselineWithRootB = () => {
  const original = new X509Certificate(rootA).raw;
  const replacement = new X509Certificate(rootB).raw;
  const offset = baseline.indexOf(original); assert.ok(offset > 4);
  const length = Buffer.alloc(4); length.writeUInt32BE(replacement.length);
  const body = Buffer.concat([baseline.subarray(0, offset - 4), length, replacement,
    baseline.subarray(offset + original.length, baseline.length - 20)]);
  const password = Buffer.from('006300680061006e0067006500690074', 'hex');
  return Buffer.concat([body, createHash('sha1').update(password).update('Mighty Aphrodite', 'latin1').update(body).digest()]);
};

// Launch boundary only: this fixture reports selected fingerprints without doing TLS.
const keytoolBoundary = (t, fingerprints = []) => {
  if (process.platform !== 'win32') {
    writeFileSync(join(bin, 'keytool'), '#!/bin/sh\nif [ "$1" = "-help" ]; then exit 0; fi\n' +
      (fingerprints.length ? `if [ "$1" = "-list" ]; then printf '%s\\n' ${fingerprints.map(f => `'SHA256: ${f}'`).join(' ')}; exit 0; fi\n` : '') +
      'exit 7\n', { mode: 0o755 });
    return true;
  }
  const compiler = ['Framework64', 'Framework'].map(architecture => join(process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET', architecture, 'v4.0.30319', 'csc.exe')).find(existsSync);
  if (!compiler) { t.skip('Windows launch boundary requires the system C# compiler'); return false; }
  const program = source('shared-keytool-boundary.cs', 'class KeytoolBoundary { static int Main(string[] args) {' +
    'if (args.Length == 1 && args[0] == "-help") return 0;' +
    (fingerprints.length ? 'if (args.Length > 0 && args[0] == "-list") {' + fingerprints.map(f =>
      `System.Console.WriteLine("SHA256: ${f}");`).join('') + 'return 0;}' : '') + 'return 7;} }');
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${join(bin, 'keytool.exe')}`, program],
    { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  return true;
};
const certificateFingerprint = pem => createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');

test('JVM launch boundary: Apply commits both outputs and custody before configuration, retains sources and removes the pair', t => withPath(async () => {
  if (!keytoolBoundary(t, [rootA, rootB].map(certificateFingerprint))) return;
  const baselineStore = source('apply-baseline.jks', baseline);
  const request = { ...jvm(baselineStore), repairs: [{ id: 'jvm-ca', targets: ['gradle', 'maven'], inputs: { baselineStore } }] };
  const p = await prepare(request, { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  const r = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.equal(r.completion, 'complete', JSON.stringify(r.diagnostics)); valid(validateRunResult12, r);
  assert.deepEqual(r.trust.outputs.map(o => [o.format, o.status]).sort(), [['jks', 'written'], ['pem', 'written']]);
  const recorded = custody(); valid(validateTrustCustody, recorded);
  assert.equal(recorded.entries.length, 2);
  for (const output of r.trust.outputs) {
    assert.equal(recorded.entries.find(e => e.format === output.format)?.outputSha256, output.sha256);
    assert.equal(createHash('sha256').update(readFileSync(output.path)).digest('hex'), output.sha256);
  }
  const jks = r.trust.outputs.find(o => o.format === 'jks');
  assert.ok(readFileSync(join(home, '.gradle', 'gradle.properties'), 'utf8').includes(jks.path.replaceAll('\\', '/')));
  assert.ok(existsSync(join(home, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc')));
  const retained = await prepare({ ...request, sources: { os: false, supplied: [] } }, { logging: 'off' });
  assert.equal(retained.status, 'ready', JSON.stringify(retained.diagnostics));
  assert.ok(retained.review.inputs.trust.sources.some(s => s.id === 'supplied:team'));
  const again = await apply(retained.prepared, approve(retained), { logging: 'off' });
  assert.equal(again.completion, 'complete', JSON.stringify(again.diagnostics));
  assert.ok(again.trust.outputs.every(o => o.status === 'unchanged'));
  const removal = await prepareManagedRemoval({ target: { project: home }, managementId: 'jvm-trust', scope: 'user', mode: 'vibe' }, { logging: 'off' });
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal.diagnostics));
  assert.equal((await apply(removal.preparation.prepared, approve(removal.preparation), { logging: 'off' })).completion, 'complete');
  assert.ok(r.trust.outputs.every(o => !existsSync(o.path))); assert.deepEqual(custody().entries, []);
}));

test('JVM launch boundary: failed store verification never releases dependent configuration', t => withPath(async () => {
  if (!keytoolBoundary(t)) return;
  const p = await prepare(jvm(source('failed-baseline.jks', baseline)), { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  const r = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.notEqual(r.completion, 'complete'); valid(validateRunResult12, r);
  assert.equal(existsSync(join(home, '.gradle', 'gradle.properties')), false);
  assert.ok(r.trust.targets.every(target => target.configuration !== 'applied'));
}));

test('JVM baseline replacement reviews the removed truststore-only certificate and its provenance', t => withPath(async () => {
  if (!keytoolBoundary(t, [rootA, rootB].map(certificateFingerprint))) return;
  const baselineStore = source('review-baseline.jks', baseline);
  const p = await prepare(jvm(baselineStore), { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  assert.equal((await apply(p.prepared, approve(p), { logging: 'off' })).completion, 'complete');
  writeFileSync(baselineStore, baselineWithRootB());
  const replacement = await prepare(jvm(baselineStore), { logging: 'off' });
  assert.equal(replacement.status, 'ready', JSON.stringify(replacement.diagnostics));
  const removed = replacement.review.inputs.trust.certificates.find(c => c.fingerprint === certificateFingerprint(rootA));
  assert.ok(removed, 'old JKS-only root must be visible in the complete certificate review');
  assert.equal(removed.disposition, 'removed'); assert.deepEqual(removed.beforeSources, ['jvm-baseline']);
  assert.deepEqual(removed.afterSources, []); assert.ok(removed.subject.length > 0);
  const retained = replacement.review.inputs.trust.certificates.find(c => c.fingerprint === certificateFingerprint(rootB));
  assert.deepEqual(retained.afterSources, ['jvm-baseline', 'supplied:team']);
}));

test('JVM file repair binds the explicit baseline separately and reviews a precomputed JKS as managed output', () => withPath(async () => {
  for (const name of ['keytool', 'java']) fixtureTool(name);
  const baselineStore = source('baseline.jks', baseline);
  const p = await prepare(jvm(baselineStore), { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  valid(validatePreparedWork12, p.review);
  const trust = p.review.inputs.trust;
  const row = trust.sources.find(s => s.kind === 'jvm-baseline');
  assert.equal(row.scope, 'selected-jvm-baseline'); assert.equal(row.completeness, 'complete'); assert.ok(row.fingerprints.length >= 1);
  assert.ok(trust.sources.some(s => s.id === 'supplied:team'));
  assert.deepEqual(trust.outputs.map(o => [o.managementId, o.format]).sort(), [['jvm-trust', 'jks'], ['jvm-trust', 'pem']]);
  // The truststore is reviewed bytes written by the engine (a file effect), never produced by a side-effecting process.
  const jks = trust.outputs.find(o => o.format === 'jks');
  assert.equal(jks.path, join(dirname(trust.outputs.find(o => o.format === 'pem').path), 'trust.jks'));
  assert.equal(p.review.operations.find(o => o.id === `trust/${jks.operationId}`).effects, 'create-file');
  assert.equal(jks.afterSha256.length, 64); assert.ok(jks.certificateCount >= 2, 'baseline entries plus the selected CA');
  assert.equal(JSON.stringify(p.review).includes(baselineStore), false, 'private baseline path stays out of public review');

  writeFileSync(baselineStore, Buffer.concat([baseline, Buffer.from('changed')]));
  const r = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.equal(r.completion, 'rejected', JSON.stringify(r.diagnostics));
  assert.ok(r.diagnostics.some(d => d.code === 'REVIEW_STALE' && d.reason === 'trust-binding-changed'));
  assert.equal(existsSync(jks.path), false); assert.equal(existsSync(join(home, '.gradle', 'gradle.properties')), false);
}));

test('JVM native route stays unavailable and the file route never discovers a missing baseline', () => withPath(async () => {
  const native = await prepare({ ...repair('jvm-ca', ['gradle', 'maven']), route: 'native' }, { logging: 'off' });
  assert.equal(native.status, 'blocked');
  assert.deepEqual(native.review.inputs.trust.targets.map(t => t.reason), ['native-route-unsupported', 'native-route-unsupported']);
  const missing = await prepare(jvm(join(scratch, 'absent.jks')), { logging: 'off' });
  assert.equal(missing.status, 'invalid', JSON.stringify(missing.diagnostics)); assert.equal(missing.prepared, undefined);
  assert.equal(existsSync(join(home, '.aih', 'core', 'content')), false);
}));
