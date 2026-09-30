import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepare, apply } from '@aihq/core';
import { repairIndex } from '@aihq/core/harness';
import { getRepairRecipe } from '@aihq/core/harness/runtime';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'aih-jvm-trust-')));
const home = join(scratch, 'home');
const bin = join(scratch, 'bin');
const root = readFileSync(new URL('./fixtures/root-a.pem', import.meta.url));
const rootB = readFileSync(new URL('./harness/fixtures/root-b.pem', import.meta.url));
// A genuine JKS trust-only fixture generated once with keytool from root-a.pem.
// It is a public boundary input; it does not stand in for native manager proof.
const baseline = Buffer.from(
  '/u3+7QAAAAIAAAABAAAAAgAPYmFzZWxpbmUtcm9vdC1hAAABoPLogl0ABVguNTA5AAADMTCCAy0wggIVoAMCAQICFEi7M8kS+N38nmm2iz+lQMtOlUePMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNVBAMME0V4YW1wbGUgVGVzdCBSb290IEEwHhcNMjYwNzI0MDcyNzU2WhcNMzYwNzIxMDcyNzU2WjAeMRwwGgYDVQQDDBNFeGFtcGxlIFRlc3QgUm9vdCBBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv8D1jVEvkjh9hwYkFNySnXeTNeBo1iDDijikL9fQOSFDC/GoLDf+W3D51mb7ipDQlWgQiQI05mPIlz1AYwrgXgqZfGY77TjvLUJM/MWrLCvn59TG9DlDVhEQw+KpABU9bMsFs27G1fM4oNhFEwG4MEwlSLh+K7MFtNRuXG1tHeBE6nca9KzzrCxn2derb4rcFxNzsTt7Z4JCeqFLkHgyoRR35WtosnAXsUrtgAeWisQ3EsZiahc0QfCOI4Em7q0TAB/VdmOULw2cTTX+2issQ8skB9MfV5WwiwNj5TSPK3fmu0i+4YxF/IGwHBtnIEt6K/R6oHybWUZYwwHlY7nMSwIDAQABo2MwYTAfBgNVHSMEGDAWgBQv63NxNudIy1i4UlJbtq7gMfz4LjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUL+tzcTbnSMtYuFJSW7au4DH8+C4wDQYJKoZIhvcNAQELBQADggEBAAEkgMB4u4Y56em6wDuFv8kcoTt5B20mNS1j9JbI3/Ehi4PEKgYI/t+ZN14t3WdPKTX4GrjJ9xqPJM5KlXM6iEQb1mhyAbXoX+Wdwnv9JLn5drTq5SkUhAQOb4kwyuFVRcnZeS8+lyxG8+4uEfiGktrL+1rp1u4qBFz/bsdPa5ffzCnowt/RCAfWaPcOTOlldX0zADQB8DthbvXKobgf3fOkqAskXD7wkpgc6inyDXrmreCyTKFpIIrVb8GYyw4JYykyB/iP+r/sqjY+JpfOa8tI/LmYRkSZuyWksmxSjCaDTiwX3aLvnkxRplkIEmaWMPDxMauGpTgMm/fEwRzlobXZHf6eY8RFn+7LUGHvSordF5g69g==',
  'base64');
const baselineFile = join(scratch, 'baseline.jks');
const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'PATH', 'JAVA_HOME', 'GRADLE_USER_HOME',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'MAVEN_OPTS', 'MAVEN_SKIP_RC',
  'GRADLE_OPTS', 'JAVA_OPTS'].map(key => [key, process.env[key]]));
before(() => {
  mkdirSync(home); mkdirSync(bin);
  process.env.HOME = home; process.env.USERPROFILE = home;
  for (const key of Object.keys(saved).filter(key => !['HOME', 'USERPROFILE', 'PATH'].includes(key))) delete process.env[key];
});
beforeEach(() => {
  writeFileSync(baselineFile, baseline);
  for (const path of [home, bin]) {
    assert.equal(dirname(realpathSync(path)), scratch);
    rmSync(path, { recursive: true }); mkdirSync(path);
  }
});
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
const request = (file, targets = ['gradle', 'maven']) => ({ useCase: 'repair',
  repairs: [{ id: 'jvm-ca', targets, inputs: { caFile: file, baselineStore: baselineFile } }], network: 'off' });
const source = (name, bytes = root) => { const file = join(scratch, name); writeFileSync(file, bytes); return file; };
const authorize = (result, extra = {}) => ({ approved: true, origin: 'automation',
  reviewDigest: result.review.reviewDigest, ...extra });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const withPath = async fn => {
  process.env.PATH = bin;
  try { return await fn(); } finally { process.env.PATH = saved.PATH; }
};
// These executable/launcher boundary fixtures are never native JVM evidence.
const fixtureExecutable = name => {
  const file = join(bin, process.platform === 'win32' ? `${name}.exe` : name);
  if (process.platform === 'win32') copyFileSync(process.execPath, file);
  else writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
};
const fixtureLauncher = name => {
  const suffix = process.platform === 'win32' ? name === 'gradle' ? '.bat' : '.cmd' : '';
  const file = join(bin, name + suffix);
  writeFileSync(file, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  return file;
};
const boundaryKeytool = (t, listedFingerprint) => {
  if (process.platform !== 'win32') {
    const file = join(bin, 'keytool');
    writeFileSync(file, '#!/bin/sh\nif [ "$1" = "-help" ]; then exit 0; fi\n' +
      (listedFingerprint ? `if [ "$1" = "-list" ]; then echo 'SHA256: ${listedFingerprint}'; exit 0; fi\n` : '') +
      'exit 7\n', { mode: 0o755 });
    return file;
  }
  const compiler = ['Framework64', 'Framework'].map(architecture => join(process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET', architecture, 'v4.0.30319', 'csc.exe')).find(existsSync);
  if (!compiler) { t.skip('The Windows boundary fixture requires the system .NET C# compiler'); return undefined; }
  const file = join(bin, 'keytool.exe');
  const program = join(scratch, 'keytool-boundary.cs');
  writeFileSync(program, 'class KeytoolBoundary { static int Main(string[] args) {' +
    'if (args.Length == 1 && args[0] == "-help") return 0;' +
    (listedFingerprint ? `if (args.Length > 0 && args[0] == "-list") { System.Console.WriteLine("SHA256: ${listedFingerprint}"); return 0; }` : '') +
    'return 7; } }');
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${file}`, program],
    { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  return file;
};

for (const change of ['ca source', 'baseline source', 'Gradle config', 'Maven config', 'keytool bytes']) {
  test(`boundary fixture: changed ${change} rejects before any JVM effect`, () => withPath(async () => {
    const keytool = fixtureExecutable('keytool');
    const input = source('stale.pem');
    const prepared = await prepare(request(input), { logging: 'off' });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    if (change === 'ca source') writeFileSync(input, rootB);
    if (change === 'baseline source') writeFileSync(baselineFile, Buffer.concat([baseline, Buffer.from('changed')]));
    if (change === 'keytool bytes') writeFileSync(keytool, Buffer.concat([readFileSync(keytool), Buffer.from('changed')]));
    const config = change === 'Gradle config' ? join(home, '.gradle', 'gradle.properties') :
      change === 'Maven config' ? join(home, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc') : undefined;
    if (config) { mkdirSync(dirname(config), { recursive: true }); writeFileSync(config, '# user content added after review\n'); }
    const applied = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
    assert.equal(applied.completion, 'rejected', JSON.stringify(applied.diagnostics));
    assert.ok(applied.diagnostics.some(item => item.code === 'REVIEW_STALE'));
    assert.equal(existsSync(join(home, '.aih')), false);
    if (config) assert.equal(readFileSync(config, 'utf8'), '# user content added after review\n');
  }));
}

test('boundary fixture: previously missing keytool appearing after review rejects before effects', () => withPath(async () => {
  const prepared = await prepare(request(source('missing-stale.pem')), { logging: 'off' });
  assert.equal(prepared.status, 'partial');
  fixtureExecutable('keytool');
  const applied = await apply(prepared.prepared, authorize(prepared, { allowPartial: true }), { logging: 'off' });
  assert.equal(applied.completion, 'rejected', JSON.stringify(applied.diagnostics));
  assert.ok(applied.diagnostics.some(item => item.code === 'REVIEW_STALE'));
  assert.equal(existsSync(join(home, '.aih')), false);
}));

test('boundary fixture: changed reviewed Maven launcher rejects before effects', () => withPath(async () => {
  fixtureExecutable('keytool'); fixtureExecutable('java');
  const launcher = fixtureLauncher('mvn');
  const prepared = await prepare({ ...request(source('maven-stale.pem'), ['maven']), network: 'declared' }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const check = prepared.review.operations.find(item => item.id === 'trust/maven-config').checks
    .find(item => item.id === 'trust/maven-behavior');
  assert.ok(check.details.args.includes(JSON.stringify(launcher)), 'the review binds mvn, the actual Maven launcher');
  writeFileSync(launcher, '# changed launcher');
  const applied = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(applied.completion, 'rejected', JSON.stringify(applied.diagnostics));
  assert.ok(applied.diagnostics.some(item => item.code === 'REVIEW_STALE'));
  assert.equal(existsSync(join(home, '.aih')), false);
}));

test('boundary fixture: changed installed JVM helper bytes reject before effects', () => withPath(async () => {
  fixtureExecutable('keytool');
  // Isolate the installed distribution so this test cannot stale another test's
  // review or race a native run. Ancestor node_modules supplies unchanged dependencies.
  const modules = realpathSync(fileURLToPath(new URL('../node_modules/', import.meta.url)));
  const installed = mkdtempSync(join(modules, '.aih-jvm-helper-'));
  assert.equal(dirname(realpathSync(installed)), modules);
  try {
    cpSync(new URL('../dist/', import.meta.url), join(installed, 'dist'), { recursive: true });
    copyFileSync(new URL('../package.json', import.meta.url), join(installed, 'package.json'));
    const api = await import(pathToFileURL(join(installed, 'dist', 'core', 'index.js')).href);
    const prepared = await api.prepare(request(source('helper-stale.pem')), { logging: 'off' });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    const helper = join(installed, 'dist', 'harness', 'jvm-trust.mjs');
    const bytes = readFileSync(helper);
    try {
      writeFileSync(helper, Buffer.concat([bytes, Buffer.from('\n// changed after review\n')]));
      const applied = await api.apply(prepared.prepared, authorize(prepared), { logging: 'off' });
      assert.equal(applied.completion, 'rejected', JSON.stringify(applied.diagnostics));
      assert.ok(applied.diagnostics.some(item => item.code === 'REVIEW_STALE'));
      assert.equal(existsSync(join(home, '.aih')), false);
    } finally { writeFileSync(helper, bytes); }
  } finally { rmSync(installed, { recursive: true }); }
}));

for (const { absent, targets } of [
  { absent: ['gradle'], targets: ['gradle'] },
  { absent: ['mvn'], targets: ['maven'] },
  { absent: ['java'], targets: ['gradle', 'maven'] },
  { absent: ['java', 'gradle', 'mvn'], targets: ['gradle', 'maven'] }
]) test(`boundary fixture: missing declared ${absent.join('+')} is unavailable before dependent configuration effects`, t => withPath(async () => {
  if (!boundaryKeytool(t, new X509Certificate(root).fingerprint256)) return;
  if (!absent.includes('java')) fixtureExecutable('java');
  if (!absent.includes('gradle')) fixtureLauncher('gradle');
  if (!absent.includes('mvn')) fixtureLauncher('mvn');
  const variant = repairIndex.find(item => item.id === 'jvm-ca').variants.find(item =>
    item.os === process.platform && item.network === 'declared' && item.targets.join(',') === targets.join(','));
  const fixedRecipe = getRepairRecipe(variant.recipeRef);
  const before = structuredClone(fixedRecipe);
  const prepared = await prepare({ ...request(source('missing-declared.pem'), targets), network: 'declared' }, { logging: 'off' });
  assert.equal(prepared.status, 'partial', JSON.stringify(prepared.diagnostics));
  assert.ok(prepared.diagnostics.some(item => item.code === 'PREREQUISITE_UNAVAILABLE' && item.reason === 'check-executable-missing'));
  assert.deepEqual(fixedRecipe, before, 'preparation must not mutate the shipped public recipe');
  assert.deepEqual(getRepairRecipe(variant.recipeRef), before);
  for (const target of targets) assert.equal(prepared.review.operations.find(item => item.id === `trust/${target}-config`).effects, 'unavailable');
  for (const target of targets) {
    const check = prepared.review.operations.find(item => item.id === `trust/${target}-config`).checks
      .find(item => item.id === `trust/${target}-behavior`);
    assert.equal(check.details.executable, process.execPath, 'review preserves the fixed helper wrapper');
    assert.match(check.details.reason, /^executable-missing:/);
  }
  assert.equal(new Set(prepared.review.operations.map(item => item.id)).size, prepared.review.operations.length);
  const applied = await apply(prepared.prepared, authorize(prepared, { allowPartial: true }), { logging: 'off' });
  assert.equal(applied.completion, 'incomplete', JSON.stringify(applied));
  for (const target of targets) {
    const config = applied.operations.find(item => item.id === `trust/${target}-config`);
    assert.equal(config.application, 'not-attempted');
    assert.equal(config.reason, 'unavailable');
    const check = applied.checks.find(item => item.id === `trust/${target}-behavior`);
    assert.equal(check.status, 'skipped'); assert.equal(check.reason, 'unavailable');
  }
  assert.equal(existsSync(join(home, '.gradle', 'gradle.properties')), false);
  assert.equal(existsSync(join(home, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc')), false);
  assert.equal(applied.operations.find(item => item.id === 'trust/material').application, 'applied');
  assert.equal(applied.operations.find(item => item.id === 'trust/jks-materialize').application, 'applied');
}));

test('boundary fixture: a missing declared launcher appearing after review requires a fresh review', () => withPath(async () => {
  fixtureExecutable('keytool'); fixtureExecutable('java');
  const prepared = await prepare({ ...request(source('missing-launcher-stale.pem'), ['gradle']), network: 'declared' }, { logging: 'off' });
  assert.equal(prepared.status, 'partial', JSON.stringify(prepared.diagnostics));
  fixtureLauncher('gradle');
  const applied = await apply(prepared.prepared, authorize(prepared, { allowPartial: true }), { logging: 'off' });
  assert.equal(applied.completion, 'rejected', JSON.stringify(applied.diagnostics));
  assert.ok(applied.diagnostics.some(item => item.code === 'REVIEW_STALE'));
  assert.equal(existsSync(join(home, '.aih')), false);
}));

test('boundary fixture: all declared executable bindings missing remain explicit unavailable prerequisites', () => withPath(async () => {
  const prepared = await prepare({ ...request(source('all-bindings-missing.pem')), network: 'declared' }, { logging: 'off' });
  assert.equal(prepared.status, 'partial', JSON.stringify(prepared.diagnostics));
  for (const id of ['keytool-ready', 'jks-materialize', 'gradle-config', 'maven-config'])
    assert.equal(prepared.review.operations.find(item => item.id === `trust/${id}`).effects, 'unavailable');
  const applied = await apply(prepared.prepared, authorize(prepared, { allowPartial: true }), { logging: 'off' });
  assert.equal(applied.completion, 'incomplete');
  assert.equal(applied.operations.find(item => item.id === 'trust/material').application, 'applied');
  assert.equal(applied.operations.find(item => item.id === 'trust/baseline-material').application, 'applied');
  for (const id of ['keytool-ready', 'jks-materialize', 'gradle-config', 'maven-config'])
    assert.equal(applied.operations.find(item => item.id === `trust/${id}`).application, 'not-attempted');
  assert.equal(applied.checks.some(item => item.status === 'failed'), false);
  assert.ok(applied.diagnostics.some(item => item.code === 'PREREQUISITE_UNAVAILABLE'));
  assert.equal(existsSync(join(home, '.gradle', 'gradle.properties')), false);
  assert.equal(existsSync(join(home, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc')), false);
  assert.equal(existsSync(join(bin, process.platform === 'win32' ? 'keytool.exe' : 'keytool')), false);
}));

test('boundary fixture: a launcher rejected by capture limits cannot be re-admitted as a direct executable', t => withPath(async () => {
  const keytool = boundaryKeytool(t, new X509Certificate(root).fingerprint256);
  if (!keytool) return;
  fixtureExecutable('java');
  const launcher = join(bin, process.platform === 'win32' ? 'gradle.exe' : 'gradle');
  // Deliberately between launcher and direct-executable byte bounds. Keep a
  // real PE on Windows (or executable shell fixture on POSIX), without running it.
  writeFileSync(launcher, Buffer.concat([readFileSync(keytool), Buffer.alloc(17 * 1024 * 1024)]), { mode: 0o755 });
  const prepared = await prepare({ ...request(source('oversized-launcher.pem'), ['gradle']), network: 'declared' }, { logging: 'off' });
  assert.equal(prepared.status, 'partial', JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.review.operations.find(item => item.id === 'trust/gradle-config').effects, 'unavailable');
  const check = prepared.review.operations.find(item => item.id === 'trust/gradle-config').checks
    .find(item => item.id === 'trust/gradle-behavior');
  assert.equal(check.details.executable, process.execPath);
  assert.equal(check.details.reason, 'executable-missing:gradle');
  const applied = await apply(prepared.prepared, authorize(prepared, { allowPartial: true }), { logging: 'off' });
  assert.equal(applied.completion, 'incomplete');
  assert.equal(applied.operations.find(item => item.id === 'trust/gradle-config').application, 'not-attempted');
  assert.equal(existsSync(join(home, '.gradle', 'gradle.properties')), false);
}));

test('JVM repair rejects the complete mixed-validity input before touching user trust or config', async () => {
  const input = source('mixed.pem', Buffer.concat([root,
    Buffer.from('-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----')]));
  mkdirSync(join(home, '.gradle'));
  const config = join(home, '.gradle', 'gradle.properties');
  writeFileSync(config, '# user setting\norg.gradle.parallel=true\n');
  const result = await prepare(request(input), { logging: 'off' });
  assert.equal(result.status, 'invalid');
  assert.equal(result.prepared, undefined);
  assert.ok(result.diagnostics.some(item => item.reason === 'block-label'), JSON.stringify(result.diagnostics));
  assert.equal(readFileSync(config, 'utf8'), '# user setting\norg.gradle.parallel=true\n');
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('boundary fixture: a changed reviewed Gradle launcher rejects before any JVM repair effect', () => withPath(async () => {
  fixtureExecutable('keytool'); fixtureExecutable('java');
  const launcher = fixtureLauncher('gradle');
  const prepared = await prepare({ ...request(source('launcher.pem'), ['gradle']), network: 'declared' }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const check = prepared.review.operations.find(item => item.id === 'trust/gradle-config').checks
    .find(item => item.id === 'trust/gradle-behavior');
  assert.ok(check.details.args.includes(JSON.stringify(launcher)), 'the review must bind the actual manager launcher');
  writeFileSync(launcher, process.platform === 'win32' ? '@exit /b 0\r\nREM changed\r\n' : '#!/bin/sh\nexit 0\n# changed\n');
  const applied = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(applied.completion, 'rejected', JSON.stringify(applied.diagnostics));
  assert.ok(applied.diagnostics.some(item => item.code === 'REVIEW_STALE'));
  assert.equal(existsSync(join(home, '.aih')), false);
  assert.equal(existsSync(join(home, '.gradle', 'gradle.properties')), false);
}));

test('boundary fixture: missing keytool never installs and gates both manager configurations', () => withPath(async () => {
  const prepared = await prepare(request(source('missing.pem')), { logging: 'off' });
  assert.equal(prepared.status, 'partial', JSON.stringify(prepared.diagnostics));
  assert.ok(prepared.diagnostics.some(item => item.reason === 'executable-missing'));
  assert.ok(prepared.review.operations.every(item => !/install/i.test(item.purpose)));
  const applied = await apply(prepared.prepared, authorize(prepared, { allowPartial: true }), { logging: 'off' });
  assert.equal(applied.completion, 'incomplete', JSON.stringify(applied));
  for (const id of ['gradle-config', 'maven-config']) {
    const operation = applied.operations.find(item => item.id === `trust/${id}`);
    assert.equal(operation.application, 'not-attempted', JSON.stringify(operation));
    assert.equal(operation.reason, 'dependency-not-satisfied');
  }
  assert.equal(existsSync(join(home, '.gradle', 'gradle.properties')), false);
  assert.equal(existsSync(join(home, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc')), false);
  assert.equal(existsSync(join(bin, process.platform === 'win32' ? 'keytool.exe' : 'keytool')), false);
}));

test('boundary fixture: failed keytool import retains prior material effects and recovery while gating config', t => withPath(async () => {
  if (!boundaryKeytool(t)) return;
  const prepared = await prepare(request(source('new-root.pem', rootB)), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const applied = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(applied.completion, 'incomplete', JSON.stringify(applied));
  assert.equal(applied.operations.find(item => item.id === 'trust/keytool-ready').verification.status, 'passed');
  const failed = applied.operations.find(item => item.id === 'trust/jks-materialize');
  assert.equal(failed.application, 'failed', JSON.stringify(failed));
  assert.equal(failed.effectsUncertain, true);
  assert.ok(applied.recovery, 'earlier material writes retain recovery information');
  for (const id of ['material', 'baseline-material']) {
    const operation = applied.operations.find(item => item.id === `trust/${id}`);
    assert.equal(operation.application, 'applied', JSON.stringify(operation));
    assert.equal(operation.verification.status, 'passed');
    const path = prepared.review.operations.find(item => item.id === `trust/${id}`).details.target;
    assert.ok(existsSync(path), 'earlier writes remain after the process failure');
  }
  for (const id of ['gradle-config', 'maven-config']) {
    const operation = applied.operations.find(item => item.id === `trust/${id}`);
    assert.equal(operation.application, 'not-attempted', JSON.stringify(operation));
    assert.equal(operation.reason, 'dependency-not-satisfied');
    assert.notEqual(operation.verification.status, 'passed');
  }
  assert.equal(existsSync(join(home, '.gradle', 'gradle.properties')), false);
  assert.equal(existsSync(join(home, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc')), false);
}));

test('boundary fixture: offline configuration preserves reviewed neighbors and remains incomplete', t => withPath(async () => {
  // The fixture only reports the known baseline root to the list check. The fixed
  // materializer independently validates the genuine JKS bytes; no native behavior is claimed.
  if (!boundaryKeytool(t, new X509Certificate(root).fingerprint256)) return;
  const gradleFile = join(home, '.gradle', 'gradle.properties');
  const mavenFile = join(home, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc');
  mkdirSync(dirname(gradleFile), { recursive: true });
  const gradleText = '# keep this comment\norg.gradle.parallel=true\n';
  const mavenText = process.platform === 'win32' ? '@REM keep this comment\r\nset "MAVEN_OPTS=-Xmx256m"\r\n' :
    '# keep this comment\nexport MAVEN_OPTS="-Xmx256m"\n';
  writeFileSync(gradleFile, gradleText); writeFileSync(mavenFile, mavenText);
  const input = source('offline.pem');
  const unresolved = await prepare(request(input), { logging: 'off' });
  assert.equal(unresolved.status, 'partial', JSON.stringify(unresolved.diagnostics));
  assert.ok(unresolved.review.conflicts.some(item => item.path === '.gradle/gradle.properties'));
  assert.ok(unresolved.review.conflicts.some(item => item.path === (process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc')));
  assert.equal(readFileSync(gradleFile, 'utf8'), gradleText);
  assert.equal(readFileSync(mavenFile, 'utf8'), mavenText);
  const prepared = await prepare({ ...request(input), resolutions: [
    { selectionId: 'trust', operationId: 'gradle-config', choice: 'replace', observedSha256: sha256(gradleText) },
    { selectionId: 'trust', operationId: 'maven-config', choice: 'replace', observedSha256: sha256(mavenText) }
  ] }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const applied = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(applied.completion, 'incomplete', JSON.stringify(applied));
  for (const target of ['gradle', 'maven']) {
    const operation = applied.operations.find(item => item.id === `trust/${target}-config`);
    assert.equal(operation.application, 'applied');
    assert.equal(operation.verification.status, 'unavailable');
    assert.equal(operation.verification.reason, 'offline');
    const check = applied.checks.find(item => item.id === `trust/${target}-behavior`);
    assert.equal(check.status, 'skipped'); assert.equal(check.reason, 'offline');
  }
  assert.ok(readFileSync(gradleFile, 'utf8').includes(gradleText.trim()));
  assert.match(readFileSync(mavenFile, 'utf8'), /keep this comment/);
  assert.match(readFileSync(mavenFile, 'utf8'), /-Xmx256m/);
  assert.ok(applied.diagnostics.some(item => item.code === 'VERIFICATION_UNAVAILABLE' && item.reason === 'offline'));
}));
