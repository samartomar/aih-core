import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { prepareRepairDefinition, getRepairRecipe, repairObservationRequests, assessRepairObservations } from '../../dist/harness/runtime.mjs';
import { repairIndex } from '../../dist/harness/contracts.mjs';

const environmentKeys = ['JAVA_HOME', 'GRADLE_USER_HOME', 'GRADLE_OPTS', 'MAVEN_OPTS', 'MAVEN_SKIP_RC',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_OPTS'];
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
before(() => { for (const key of environmentKeys) delete process.env[key]; });
after(() => { for (const [key, value] of Object.entries(savedEnvironment)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} });

const ca = readFileSync(new URL('./fixtures/root-a.pem', import.meta.url));
const caDer = Buffer.from(ca.toString('utf8').match(/-----BEGIN CERTIFICATE-----([^]*)-----END CERTIFICATE-----/)[1]
  .replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Smallest valid JKS writer for baseline fixtures: trusted X.509 entries + changeit integrity. */
function jksFixture(entries) {
  const parts = [];
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
  const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
  parts.push(u32(0xfeedfeed), u32(2), u32(entries.length));
  for (const [alias, der] of entries) {
    parts.push(u32(2), u16(alias.length), Buffer.from(alias, 'latin1'), Buffer.alloc(8),
      u16(5), Buffer.from('X.509', 'latin1'), u32(der.length), der);
  }
  const body = Buffer.concat(parts);
  const password = Buffer.alloc('changeit'.length * 2);
  for (let i = 0; i < 'changeit'.length; i++) password.writeUInt16BE('changeit'.charCodeAt(i), i * 2);
  const integrity = createHash('sha1').update(password).update('Mighty Aphrodite', 'latin1').update(body).digest();
  return Buffer.concat([body, integrity]);
}
const baseline = jksFixture([['jdk-root-b', Buffer.from(readFileSync(new URL('./fixtures/root-b.pem', import.meta.url))
  .toString('utf8').match(/-----BEGIN CERTIFICATE-----([^]*)-----END CERTIFICATE-----/)[1].replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')]]);

const managedPath = process.platform === 'win32' ? 'C:\\x\\trust.pem' : '/x/trust.pem';
const variantRef = (targets, network = 'off') => `jvm-ca/${process.platform}/${targets.join('+')}/${network}`;
const prepare = (targets, configSnapshots = {}, extra = {}) => prepareRepairDefinition({
  id: 'jvm-ca', variantRef: variantRef(targets, extra.offline === false ? 'declared' : 'off'), targets,
  files: { caFile: ca, baselineStore: baseline }, configSnapshots, managedPath,
  offline: true, ...extra
});

test('jvm-ca definition ships fixed variants, baseline input, executable bindings and config snapshots', () => {
  const definition = repairIndex.find(item => item.id === 'jvm-ca');
  assert.equal(definition.managementId, 'jvm-trust');
  assert.equal(definition.materialName, 'trust.pem');
  assert.deepEqual([...definition.targets], ['gradle', 'maven']);
  assert.deepEqual(Object.keys(definition.inputs), ['caFile', 'baselineStore']);
  assert.equal(definition.inputs.caFile.required, true);
  assert.equal(definition.inputs.baselineStore.required, true);
  assert.equal(definition.variants.length, 18);
  for (const variant of definition.variants) {
    assert.ok(variant.executableBindings.some(item => item.name === 'keytool' && item.pathInput === 'keytoolExecutable'),
      `${variant.recipeRef} must always bind keytool for truststore materialization`);
    const managers = [...(variant.targets.includes('gradle') ? ['gradle'] : []),
      ...(variant.targets.includes('maven') ? ['mvn'] : [])];
    const expected = ['keytool', ...(variant.network === 'off' ? [] : ['java', ...managers])];
    assert.deepEqual(variant.executableBindings.map(item => item.name), expected, variant.recipeRef);
    for (const manager of variant.network === 'off' ? [] : managers) {
      const binding = variant.executableBindings.find(item => item.name === manager);
      assert.equal(binding.kind, 'launcher', `${manager} is byte/pin captured read-only, never a direct executable`);
      assert.equal(binding.pathInput, manager === 'gradle' ? 'gradleExecutable' : 'mavenExecutable');
    }
    const files = variant.configFiles.map(item => item.operationId);
    assert.deepEqual(files, [
      ...(variant.targets.includes('gradle') ? ['gradle-config'] : []),
      ...(variant.targets.includes('maven') ? ['maven-config'] : []),
      ...(variant.targets.includes('maven') && variant.os === 'win32' ?
        ['maven-rc-late-pre-bat', 'maven-rc-late-post-cmd', 'maven-rc-late-post-bat'] : [])
    ]);
    assert.equal(variant.recipeRef, `jvm-ca/${variant.os}/${variant.targets.join('+')}/${variant.network}`);
  }
  const winMaven = definition.variants.find(item => item.os === 'win32' && item.targets.includes('maven'));
  assert.deepEqual(winMaven.configFiles.find(item => item.operationId === 'maven-config').target.segments.map(slot => slot.literal),
    ['mavenrc_pre.cmd']);
  const posixMaven = definition.variants.find(item => item.os === 'linux' && item.targets.includes('maven'));
  assert.deepEqual(posixMaven.configFiles.find(item => item.operationId === 'maven-config').target.segments.map(slot => slot.literal),
    ['.mavenrc']);
  assert.deepEqual(definition.offlineVerification.map(item => [item.target, item.operationId, item.checkId]),
    [['gradle', 'gradle-config', 'gradle-behavior'], ['maven', 'maven-config', 'maven-behavior']]);
});

test('fixed JVM graph gates configuration behind baseline bytes and successful keytool materialization', () => {
  const recipe = getRepairRecipe('jvm-ca/win32/gradle+maven/off');
  assert.equal(recipe.id, 'jvm-ca');
  const operations = Object.fromEntries(recipe.operations.map(item => [item.id, item]));
  assert.equal(operations.material.kind, 'file.write');
  assert.equal(operations.material.mode, 0o600);
  assert.deepEqual(operations.material.requires, []);
  assert.ok(operations.material.checks.includes('material-digest'));
  assert.equal(operations['baseline-material'].kind, 'file.write');
  assert.equal(operations['baseline-material'].mode, 0o600);
  assert.deepEqual(operations['baseline-material'].requires, []);
  assert.ok(operations['baseline-material'].checks.includes('baseline-digest'));
  assert.equal(operations['keytool-ready'].kind, 'process.run');
  assert.deepEqual(operations['keytool-ready'].requires, []);
  assert.equal(operations['jks-materialize'].kind, 'process.run');
  for (const dependency of ['material', 'baseline-material', 'keytool-ready'])
    assert.ok(operations['jks-materialize'].requires.includes(dependency), `jks-materialize requires ${dependency}`);
  assert.ok(operations['jks-materialize'].checks.includes('jks-content'));
  for (const id of ['gradle-config', 'maven-config']) {
    assert.equal(operations[id].kind, 'file.write');
    assert.deepEqual(operations[id].requires, ['jks-materialize'],
      `${id} must never persist a reference to a truststore that failed to materialize`);
    assert.deepEqual(operations[id].checks, [], `${id} has no behavior check offline`);
  }
  assert.ok(!recipe.checks.some(item => item.id.endsWith('-behavior')), 'offline variant ships no behavior checks');
  const checks = Object.fromEntries(recipe.checks.map(item => [item.id, item]));
  for (const id of ['material-digest', 'baseline-digest', 'keytool-available', 'jks-content']) assert.ok(checks[id], id);
  for (const name of ['bundle', 'baselineStoreBase64', 'gradleConfig', 'mavenConfig'])
    assert.equal(recipe.inputs[name].sensitive, true, `${name} stays out of public review values`);
  for (const name of ['bundlePath', 'bundleSha256', 'baselineStoreSha256', 'jksPath', 'fingerprintCsv',
    'baselineFilePath', 'keytoolExecutable', 'gradleConfigPath', 'mavenConfigPath'])
    assert.equal(recipe.inputs[name].required, true, name);
  assert.equal(recipe.inputs.javaExecutable, undefined, 'offline variant does not bind java');
  assert.equal(recipe.inputs.gradleExecutable, undefined, 'offline variant does not bind gradle');
});

test('declared JVM graph verifies real managers with byte-bound launchers and java', () => {
  const recipe = getRepairRecipe(`jvm-ca/${process.platform}/gradle+maven/declared`);
  const operations = Object.fromEntries(recipe.operations.map(item => [item.id, item]));
  const checks = Object.fromEntries(recipe.checks.map(item => [item.id, item]));
  assert.deepEqual(operations['gradle-config'].checks, ['gradle-behavior']);
  assert.deepEqual(operations['maven-config'].checks, ['maven-behavior']);
  for (const [id, manager] of [['gradle-behavior', 'gradleExecutable'], ['maven-behavior', 'mavenExecutable']]) {
    assert.equal(checks[id].kind, 'process.exit');
    assert.ok(checks[id].args.some(slot => slot.input === manager), `${id} launches the byte-pinned manager`);
    assert.ok(checks[id].args.some(slot => slot.input === 'javaExecutable'), `${id} uses the byte-bound java`);
    assert.ok(checks[id].args.some(slot => slot.input === `${id.split('-')[0]}ConfigPath`),
      `${id} consumes the repaired manager configuration`);
    assert.equal(checks[id].env.AIH_EXPECTED_FINGERPRINTS.input, 'fingerprintCsv');
    assert.equal(checks[id].env.AIH_EXPECTED_STORE.input, 'jksPath',
      `${id} asserts the manager's effective truststore property, not an injected one`);
    assert.match(checks[id].env.AIH_ENDPOINT.literal, /^https:\/\//);
  }
  assert.match(checks['gradle-behavior'].env.AIH_ENDPOINT.literal, /services\.gradle\.org/);
  assert.match(checks['maven-behavior'].env.AIH_ENDPOINT.literal, /repo\.maven\.apache\.org/);
  for (const name of ['javaExecutable', 'gradleExecutable', 'mavenExecutable'])
    assert.equal(recipe.inputs[name].required, true, name);
});

test('jvm-ca requests no process observations', () => {
  assert.deepEqual(repairObservationRequests({ id: 'jvm-ca', targets: ['gradle', 'maven'], variantRef: variantRef(['gradle', 'maven']) }), []);
  assert.deepEqual(assessRepairObservations({ id: 'jvm-ca', managedPath: '/x/trust.pem', observations: [] }), []);
});

test('Gradle transform retains neighboring settings, normalizes the store path and is byte-idempotent', () => {
  const original = '# keep\r\norg.gradle.parallel=true\r\nsystemProp.http.proxyHost=proxy.example\r\nsystemProp.javax.net.ssl.trustStore=C:/old/store.jks\r\n';
  const first = prepare(['gradle'], { 'gradle-config': Buffer.from(original) });
  assert.equal(first.status, 'completed', JSON.stringify(first.diagnostics));
  const normalized = first.bindings.jksPath.replaceAll('\\', '/');
  assert.equal(first.privateBindings.gradleConfig,
    '# keep\r\norg.gradle.parallel=true\r\nsystemProp.http.proxyHost=proxy.example\r\n' +
    `systemProp.javax.net.ssl.trustStore=${normalized}\r\nsystemProp.javax.net.ssl.trustStorePassword=changeit\r\n`);
  assert.equal(JSON.stringify(first.bindings).includes('proxy.example'), false,
    'neighboring private settings never enter public bindings');
  const twice = prepare(['gradle'], { 'gradle-config': Buffer.from(first.privateBindings.gradleConfig) });
  assert.equal(twice.status, 'completed');
  assert.equal(twice.privateBindings.gradleConfig, first.privateBindings.gradleConfig);
  assert.deepEqual(twice.bindings, first.bindings);
});

test('Gradle comments and unrelated javax keys survive untouched', () => {
  const original = '# systemProp.javax.net.ssl.trustStore=/commented.jks\n! another comment\nsystemProp.javax.net.ssl.keyStore=/keep.jks\n';
  const result = prepare(['gradle'], { 'gradle-config': Buffer.from(original) });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  const normalized = result.bindings.jksPath.replaceAll('\\', '/');
  assert.equal(result.privateBindings.gradleConfig,
    '# systemProp.javax.net.ssl.trustStore=/commented.jks\n! another comment\nsystemProp.javax.net.ssl.keyStore=/keep.jks\n' +
    `systemProp.javax.net.ssl.trustStore=${normalized}\nsystemProp.javax.net.ssl.trustStorePassword=changeit\n`);
});

test('duplicate or non-canonical Gradle trust keys refuse a misleading verified rewrite', () => {
  for (const text of [
    'systemProp.javax.net.ssl.trustStore=/one.jks\nsystemProp.javax.net.ssl.trustStore=/two.jks\n',
    'systemProp.javax.net.ssl.trustStorePassword=a\nsystemProp.javax.net.ssl.trustStorePassword=b\n',
    'systemProp.javax.net.ssl.trustStore: /one.jks\n',
    'systemProp.javax.net.ssl.trustStore /one.jks\n',
    'systemProp.javax.net.ssl.trustStore = /one.jks\n'
  ]) {
    const result = prepare(['gradle'], { 'gradle-config': Buffer.from(text) });
    assert.equal(result.status, 'invalid', JSON.stringify(text));
    assert.equal(result.diagnostics[0].reason, 'config-ambiguous');
    assert.equal(result.privateBindings, undefined);
    assert.equal(result.bindings, undefined);
  }
});

test('Maven rc block preserves neighboring lines and is byte-idempotent', () => {
  const win = process.platform === 'win32';
  const original = win ? 'REM user comment\r\nset "FOO=bar"\r\n' : '# user comment\nFOO=bar\n';
  const first = prepare(['maven'], { 'maven-config': Buffer.from(original) });
  assert.equal(first.status, 'completed', JSON.stringify(first.diagnostics));
  const opts = `-Djavax.net.ssl.trustStore=${first.bindings.jksPath} -Djavax.net.ssl.trustStorePassword=changeit`;
  const block = win ?
    `REM BEGIN AIHQ MAVEN CA\r\nset "MAVEN_OPTS=%MAVEN_OPTS% ${opts}"\r\nREM END AIHQ MAVEN CA\r\n` :
    `# BEGIN AIHQ MAVEN CA\nMAVEN_OPTS="\${MAVEN_OPTS:-} ${opts}"\nexport MAVEN_OPTS\n# END AIHQ MAVEN CA\n`;
  assert.equal(first.privateBindings.mavenConfig, original + block);
  assert.equal(JSON.stringify(first.bindings).includes('FOO=bar'), false,
    'neighboring private settings never enter public bindings');
  const twice = prepare(['maven'], { 'maven-config': Buffer.from(first.privateBindings.mavenConfig) });
  assert.equal(twice.status, 'completed', JSON.stringify(twice.diagnostics));
  assert.equal(twice.privateBindings.mavenConfig, first.privateBindings.mavenConfig);
});

test('Gradle refuses continuations and escaped property keys before a rewrite can change neighboring values', () => {
  for (const text of [
    'org.gradle.jvmargs=-Xmx1g\\\n',
    'org.gradle.jvmargs=-Xmx1g\\\r\n\r\n',
    'org.gradle.jvmargs=-Xmx1g\\\n  -Xms256m\n',
    'systemProp.javax.net.ssl.\\u0074rustStore=/old.jks\n',
    '\\systemProp.javax.net.ssl.trustStore=/old.jks\n',
    'org.gradle.parallel=true\rsystemProp.javax.net.ssl.trustStore=/old.jks\r'
  ]) {
    const result = prepare(['gradle'], { 'gradle-config': Buffer.from(text) });
    assert.equal(result.status, 'invalid', JSON.stringify(text));
    assert.equal(result.diagnostics[0].reason, 'config-ambiguous');
    assert.equal(result.privateBindings, undefined);
  }
  assert.equal(prepare(['gradle'], { 'gradle-config': Buffer.from('# comment\\\norg.gradle.jvmargs=-Xmx1g\\\\\n') }).status,
    'completed', 'comment backslashes and a literal escaped final backslash do not continue a value');
});

test('Maven replaces its earlier managed block instead of stacking a second one', () => {
  const win = process.platform === 'win32';
  const [begin, end] = win ? ['REM BEGIN AIHQ MAVEN CA', 'REM END AIHQ MAVEN CA'] : ['# BEGIN AIHQ MAVEN CA', '# END AIHQ MAVEN CA'];
  const stale = `setx HOME 1\n${begin}\nstale trust options\n${end}\n`;
  const result = prepare(['maven'], { 'maven-config': Buffer.from(stale) });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.equal(result.privateBindings.mavenConfig.split(begin).length - 1, 1);
  assert.ok(!result.privateBindings.mavenConfig.includes('stale trust options'));
  assert.ok(result.privateBindings.mavenConfig.startsWith('setx HOME 1\n'));
});

test('Maven refuses continued lines and uncertain shell block contexts before changing neighboring values', () => {
  const win = process.platform === 'win32';
  const [begin, end] = win ? ['REM BEGIN AIHQ MAVEN CA', 'REM END AIHQ MAVEN CA'] : ['# BEGIN AIHQ MAVEN CA', '# END AIHQ MAVEN CA'];
  const cases = win ? ['set OTHER=keep^\n', 'set "OTHER=unclosed\n'] : [
    'export OTHER=keep\\\n',
    `cat <<'EOF'\n${begin}\nkeep this neighboring text\n${end}\nEOF\n`,
    `OTHER="\n${begin}\nkeep this neighboring text\n${end}\n"\n`
  ];
  for (const text of [...cases, 'OTHER=keep\r']) {
    const result = prepare(['maven'], { 'maven-config': Buffer.from(text) });
    assert.equal(result.status, 'invalid', JSON.stringify(text));
    assert.equal(result.diagnostics[0].reason, 'config-ambiguous');
    assert.equal(result.privateBindings, undefined);
  }
});

test('existing Maven trust options outside the managed block refuse a silent override', () => {
  const win = process.platform === 'win32';
  const [begin, end] = win ? ['REM BEGIN AIHQ MAVEN CA', 'REM END AIHQ MAVEN CA'] : ['# BEGIN AIHQ MAVEN CA', '# END AIHQ MAVEN CA'];
  for (const text of [
    'MAVEN_OPTS="-Djavax.net.ssl.trustStore=/old.jks"\n',
    `${begin}\none\n${end}\n${begin}\ntwo\n${end}\n`,
    `${begin}\nnever closed\n`
  ]) {
    const result = prepare(['maven'], { 'maven-config': Buffer.from(text) });
    assert.equal(result.status, 'invalid', JSON.stringify(text));
    assert.equal(result.diagnostics[0].reason, 'config-ambiguous');
    assert.equal(result.privateBindings, undefined);
  }
});

test('later Windows Maven rc files with trust options refuse a silent override', () => {
  const win = process.platform === 'win32';
  const lateFiles = win ? ['maven-rc-late-pre-bat', 'maven-rc-late-post-cmd', 'maven-rc-late-post-bat'] : [];
  for (const operationId of lateFiles) {
    const result = prepare(['maven'], { [operationId]: Buffer.from('set "MAVEN_OPTS=-Djavax.net.ssl.trustStore=C:/other.jks"\n') });
    assert.equal(result.status, 'invalid', operationId);
    assert.equal(result.diagnostics[0].reason, 'config-ambiguous');
  }
  const benign = Object.fromEntries(lateFiles.map(id => [id, Buffer.from('set "FOO=bar"\n')]));
  assert.equal(prepare(['maven'], benign).status, 'completed');
});

test('baseline truststore admission requires a readable CA-only JKS with the public container password', () => {
  const leafDer = Buffer.from(readFileSync(new URL('./fixtures/leaf-a.pem', import.meta.url)).toString('utf8')
    .match(/-----BEGIN CERTIFICATE-----([^]*)-----END CERTIFICATE-----/)[1].replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  const cases = [
    ['not a store at all', Buffer.from('\x30\x82\x01\x01pkcs12-ish'), 'baseline-store-unsupported'],
    ['JKS version 1', (() => { const b = Buffer.from(baseline); b.writeUInt32BE(1, 4); return b; })(), 'baseline-store-unsupported'],
    ['non-CA trust entry', jksFixture([['leaf', leafDer]]), 'baseline-store-invalid'],
    ['tampered integrity', (() => { const b = Buffer.from(baseline); b[b.length - 1] ^= 0xff; return b; })(), 'baseline-store-invalid'],
    ['private key entry', (() => { const b = Buffer.from(baseline); b.writeUInt32BE(1, 12); return b; })(), 'baseline-store-invalid'],
    ['truncated store', baseline.subarray(0, baseline.length - 25), 'baseline-store-invalid'],
    ['empty input', new Uint8Array(), 'baseline-store-invalid']
  ];
  for (const [name, store, reason] of cases) {
    const result = prepare(['gradle'], {}, { files: { caFile: ca, baselineStore: store } });
    assert.equal(result.status, 'invalid', name);
    assert.equal(result.diagnostics[0].reason, reason, name);
    assert.equal(result.bindings, undefined, name);
  }
  const validateOnly = prepare(['gradle'], {}, { validateOnly: true });
  assert.equal(validateOnly.status, 'completed');
  assert.equal(validateOnly.bindings, undefined);
  assert.equal(validateOnly.count, 1);
  const badBaseline = prepare(['gradle'], {}, { validateOnly: true, files: { caFile: ca, baselineStore: Buffer.from('junk') } });
  assert.equal(badBaseline.status, 'invalid', 'apply-time revalidation rejects a bad baseline too');
});

test('a narrower repair preserves existing managed trust and rejects a complete-input bad suffix', () => {
  const previous = readFileSync(new URL('./fixtures/root-b.pem', import.meta.url));
  const result = prepare(['maven'], {}, { existing: previous });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.ok(result.bundle.startsWith(previous.toString()), 'existing certificate bytes are retained');
  assert.ok(result.bundle.includes('-----END CERTIFICATE-----'));
  const rejected = prepare(['gradle'], {}, { files: { caFile: Buffer.concat([ca, Buffer.from('garbage suffix')]), baselineStore: baseline },
    existing: previous });
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.bundle, undefined);
  assert.equal(rejected.bindings, undefined);
});

test('JVM environment guards block redirected, skipped or overriding manager trust before effects', () => {
  try {
    process.env.GRADLE_USER_HOME = join(homedir(), 'other-gradle');
    let result = prepare(['gradle']);
    assert.equal(result.status, 'blocked');
    assert.equal(result.diagnostics[0].reason, 'user-config-location-unsupported');
    process.env.GRADLE_USER_HOME = join(homedir(), '.gradle');
    assert.equal(prepare(['gradle']).status, 'completed');

    process.env.MAVEN_SKIP_RC = '1';
    result = prepare(['maven']);
    assert.equal(result.status, 'blocked');
    assert.equal(result.diagnostics[0].reason, 'trust-bypass-environment');
    assert.equal(prepare(['gradle']).status, 'completed', 'Maven rc skipping does not block Gradle');
    delete process.env.MAVEN_SKIP_RC;

    for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS']) {
      for (const targets of [['gradle'], ['maven']]) {
        process.env[key] = '-Djavax.net.ssl.trustStore=/inherited.jks';
        result = prepare(targets);
        assert.equal(result.status, 'blocked', `${key} must block ${targets}`);
        assert.equal(result.diagnostics[0].reason, 'trust-override-environment');
        delete process.env[key];
        assert.equal(prepare(targets).status, 'completed', `${key} cleared allows ${targets}`);
      }
    }
    process.env.MAVEN_OPTS = '-Xmx512m';
    assert.equal(prepare(['maven']).status, 'completed', 'unrelated inherited options are preserved');
    delete process.env.MAVEN_OPTS;
  } finally {
    for (const key of ['GRADLE_USER_HOME', 'MAVEN_SKIP_RC', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS',
      '_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS']) delete process.env[key];
  }
});

test('rendered bindings derive the content-addressed store and keep baseline bytes private', () => {
  const result = prepare(['gradle', 'maven']);
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  const expectedName = `trust-${sha256(baseline)}-${sha256(result.bundle)}.jks`;
  assert.equal(result.bindings.jksPath, join(process.platform === 'win32' ? 'C:\\x' : '/x', expectedName));
  assert.equal(result.bindings.baselineFilePath, join(process.platform === 'win32' ? 'C:\\x' : '/x', 'baseline.store.b64'));
  assert.equal(result.bindings.baselineStoreSha256, sha256(baseline));
  assert.equal(result.privateBindings.baselineStoreBase64, baseline.toString('base64'));
  assert.equal(JSON.stringify(result.bindings).includes(baseline.toString('base64').slice(0, 64)), false,
    'baseline bytes never enter public bindings');
  const recipe = getRepairRecipe(variantRef(['gradle', 'maven']));
  const publicNames = Object.keys(recipe.inputs).filter(name => !recipe.inputs[name].sensitive).sort();
  assert.deepEqual(Object.keys(result.bindings).sort(), publicNames);
  const sensitiveNames = Object.keys(recipe.inputs).filter(name => recipe.inputs[name].sensitive && name !== 'bundle').sort();
  assert.deepEqual(Object.keys(result.privateBindings).sort(), sensitiveNames);
});

test('Maven path rules reject spaces, shell and batch metacharacters in the managed store path', () => {
  const spaced = process.platform === 'win32' ? 'C:\\x y\\trust.pem' : '/x y/trust.pem';
  let result = prepare(['maven'], {}, { managedPath: spaced });
  assert.equal(result.status, 'invalid');
  assert.equal(result.diagnostics[0].reason, 'managed-path-unsupported');
  assert.equal(prepare(['gradle'], {}, { managedPath: spaced }).status, 'completed',
    'Gradle properties values tolerate spaces');
  const metachar = process.platform === 'win32' ? 'C:\\x%y%\\trust.pem' : '/x"y/trust.pem';
  result = prepare(['maven'], {}, { managedPath: metachar });
  assert.equal(result.status, 'invalid');
  assert.equal(result.diagnostics[0].reason, 'managed-path-unsupported');
  const unicode = process.platform === 'win32' ? 'C:\\xü\\trust.pem' : '/xü/trust.pem';
  result = prepare(['gradle'], {}, { managedPath: unicode });
  assert.equal(result.status, 'invalid');
  assert.equal(result.diagnostics[0].reason, 'managed-path-unsupported');
});

// Labeled boundary fakes: they speak the keytool/manager process protocol inside a
// spawned Node process and prove custody/dependency behavior only — never native proof.
const jksBoundary = `
  const fs=require('node:fs'),c=require('node:crypto');
  const parse=bytes=>{let offset=12;const count=bytes.readUInt32BE(8);const entries=[];
    for(let i=0;i<count;i++){offset+=4;const al=bytes.readUInt16BE(offset);offset+=2;
    const alias=bytes.subarray(offset,offset+al).toString('latin1');offset+=al+8;
    const tl=bytes.readUInt16BE(offset);offset+=2+tl;const cl=bytes.readUInt32BE(offset);offset+=4;
    entries.push([alias,Buffer.from(bytes.subarray(offset,offset+cl))]);offset+=cl;}
    return entries};
  const u32=v=>{const b=Buffer.alloc(4);b.writeUInt32BE(v);return b},u16=v=>{const b=Buffer.alloc(2);b.writeUInt16BE(v);return b};
  const serialize=entries=>{const parts=[u32(0xfeedfeed),u32(2),u32(entries.length)];
    for(const [alias,der] of entries)parts.push(u32(2),u16(alias.length),Buffer.from(alias,'latin1'),Buffer.alloc(8),u16(5),Buffer.from('X.509'),u32(der.length),der);
    const body=Buffer.concat(parts);const pw=Buffer.alloc(16);
    for(let i=0;i<8;i++)pw.writeUInt16BE('changeit'.charCodeAt(i),i*2);
    return Buffer.concat([body,c.createHash('sha1').update(pw).update('Mighty Aphrodite','latin1').update(body).digest()])};
  require('node:child_process').spawnSync=(file,args,options)=>{
    if(options.shell!==false||file!==process.env.FIXTURE_KEYTOOL)return {status:2,stdout:'',stderr:''};
    if(args.includes('-help'))return {status:0,stdout:'keytool help',stderr:''};
    if(process.env.FIXTURE_TOOL_FAIL)return {status:7,stdout:'',stderr:'simulated tool failure'};
    if(args.includes('-importcert')){
      const work=args[args.indexOf('-keystore')+1];
      const der=Buffer.from(fs.readFileSync(args[args.indexOf('-file')+1],'utf8')
        .match(/-----BEGIN CERTIFICATE-----([^]*)-----END CERTIFICATE-----/)[1].replace(/[^A-Za-z0-9+/=]/g,''),'base64');
      const entries=parse(fs.readFileSync(work));entries.push([args[args.indexOf('-alias')+1],der]);
      fs.writeFileSync(work,serialize(entries));
      return {status:0,stdout:'Certificate was added to keystore',stderr:''};
    }
    if(args.includes('-list')){
      const entries=parse(fs.readFileSync(args[args.indexOf('-keystore')+1]));
      return {status:0,stdout:entries.map(([alias,der])=>'Alias name: '+alias+'\\nSHA256: '+
        c.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':')+'\\n').join(''),stderr:''};
    }
    return {status:2,stdout:'',stderr:''};
  };
`;
const managerBoundary = `
  const fs=require('node:fs');
  require('node:child_process').spawnSync=(file,args,options)=>{
    fs.writeFileSync(process.env.FIXTURE_LAUNCH_MARKER,JSON.stringify({file,args}));
    return {status:Number(process.env.FIXTURE_MANAGER_STATUS||'0'),stdout:'',stderr:''};
  };
`;

function materializeFixture(root, prepared) {
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const bundlePath = join(stateDir, 'trust.pem');
  writeFileSync(bundlePath, prepared.bundle);
  const baselineFilePath = join(stateDir, 'baseline.store.b64');
  writeFileSync(baselineFilePath, prepared.privateBindings.baselineStoreBase64);
  return { stateDir, bundlePath, baselineFilePath,
    jksPath: join(stateDir, prepared.bindings.jksPath.split(/[\\/]/).at(-1)) };
}

test('materialization publishes, reuses and protects the content-addressed store', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-jvm-materialize-'));
  try {
    const prepared = prepare(['gradle', 'maven']);
    assert.equal(prepared.status, 'completed');
    const fixture = materializeFixture(root, prepared);
    const operation = getRepairRecipe(variantRef(['gradle', 'maven'])).operations.find(item => item.id === 'jks-materialize');
    const boundary = join(root, 'boundary.cjs');
    writeFileSync(boundary, jksBoundary);
    const keytool = join(root, 'fake-keytool.exe');
    const bindings = { jksPath: fixture.jksPath, bundlePath: fixture.bundlePath,
      baselineFilePath: fixture.baselineFilePath, keytoolExecutable: keytool,
      baselineStoreSha256: sha256(baseline), bundleSha256: sha256(prepared.bundle) };
    const run = (env = {}) => spawnSync(operation.executable.name,
      ['--require', boundary, ...operation.args.map(slot => slot.literal ?? bindings[slot.input])],
      { env: { ...process.env, FIXTURE_KEYTOOL: keytool, ...env }, encoding: 'utf8', timeout: operation.timeoutMs, windowsHide: true });
    // First publication builds the store through the bound keytool.
    let result = run();
    assert.equal(result.status, 0, `publish: ${result.stderr}`);
    const published = readFileSync(fixture.jksPath);
    assert.ok(published.length > baseline.length, 'published store carries baseline plus managed certificates');
    // Second run validates the identical content-addressed output and reuses it byte-for-byte.
    result = run();
    assert.equal(result.status, 0, 'validated existing output is reused');
    assert.deepEqual(readFileSync(fixture.jksPath), published);
    // Unknown bytes at the content-addressed path block and are preserved exactly.
    writeFileSync(fixture.jksPath, 'foreign store bytes');
    result = run();
    assert.equal(result.status, 1, 'unknown existing output blocks');
    assert.equal(readFileSync(fixture.jksPath, 'utf8'), 'foreign store bytes', 'unknown output is never replaced');
    // A valid store missing the managed certificates also blocks (multiset must match exactly).
    writeFileSync(fixture.jksPath, baseline);
    result = run();
    assert.equal(result.status, 1, 'baseline-only output blocks');
    assert.deepEqual(readFileSync(fixture.jksPath), baseline);
    // A failed keytool import publishes nothing and keeps earlier effects untouched.
    rmSync(fixture.jksPath, { force: true });
    result = run({ FIXTURE_TOOL_FAIL: '1' });
    assert.equal(result.status, 1, 'failed materialization reports failure');
    assert.equal(existsSync(fixture.jksPath), false, 'no store published after tool failure');
    assert.equal(readFileSync(fixture.bundlePath, 'utf8'), prepared.bundle, 'managed PEM effect preserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('jks-content check requires every supplied fingerprint in the published store', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-jvm-content-'));
  try {
    const prepared = prepare(['gradle', 'maven']);
    const fixture = materializeFixture(root, prepared);
    const recipe = getRepairRecipe(variantRef(['gradle', 'maven']));
    const boundary = join(root, 'boundary.cjs');
    writeFileSync(boundary, jksBoundary);
    const keytool = join(root, 'fake-keytool.exe');
    const materialize = recipe.operations.find(item => item.id === 'jks-materialize');
    const bindings = { jksPath: fixture.jksPath, bundlePath: fixture.bundlePath,
      baselineFilePath: fixture.baselineFilePath, keytoolExecutable: keytool,
      baselineStoreSha256: sha256(baseline), bundleSha256: sha256(prepared.bundle) };
    assert.equal(spawnSync(materialize.executable.name,
      ['--require', boundary, ...materialize.args.map(slot => slot.literal ?? bindings[slot.input])],
      { env: { ...process.env, FIXTURE_KEYTOOL: keytool }, encoding: 'utf8', windowsHide: true }).status, 0);
    const check = recipe.checks.find(item => item.id === 'jks-content');
    const run = (csv, env = {}) => spawnSync(check.executable.name,
      ['--require', boundary, ...check.args.map(slot => slot.literal ?? ({ ...bindings, fingerprintCsv: csv })[slot.input])],
      { env: { ...process.env, FIXTURE_KEYTOOL: keytool, ...env }, encoding: 'utf8', windowsHide: true });
    assert.equal(run(prepared.bindings.fingerprintCsv).status, 0, 'all supplied fingerprints verified');
    assert.equal(run(sha256(caDer)).status, 0, 'the supplied root is present');
    assert.equal(run('0'.repeat(64)).status, 1, 'a missing fingerprint fails');
    assert.equal(run(prepared.bindings.fingerprintCsv, { FIXTURE_TOOL_FAIL: '1' }).status, 1, 'tool failure is not success');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function managerCheckFixture(root, id) {
  const prepared = prepare(['gradle', 'maven']);
  const recipe = getRepairRecipe(`jvm-ca/${process.platform}/gradle+maven/declared`);
  const check = recipe.checks.find(item => item.id === `${id}-behavior`);
  const home = join(root, 'home');
  const configDir = id === 'gradle' ? join(home, '.gradle') : home;
  mkdirSync(configDir, { recursive: true });
  const jksPath = join(root, 'state', prepared.bindings.jksPath.split(/[\\/]/).at(-1));
  const manager = join(root, id === 'gradle' ? (process.platform === 'win32' ? 'gradle.bat' : 'gradle') :
    (process.platform === 'win32' ? 'mvn.cmd' : 'mvn'));
  const boundary = join(root, 'boundary.cjs');
  writeFileSync(boundary, managerBoundary);
  const configPath = id === 'gradle' ? join(configDir, 'gradle.properties') :
    join(configDir, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc');
  const bindings = { gradleConfigPath: id === 'gradle' ? configPath : '', mavenConfigPath: id === 'maven' ? configPath : '',
    jksPath, gradleExecutable: id === 'gradle' ? manager : '', mavenExecutable: id === 'maven' ? manager : '',
    javaExecutable: process.execPath, fingerprintCsv: prepared.bindings.fingerprintCsv };
  const run = (env = {}, marker = join(root, `launch-${Date.now()}-${Math.random()}`)) => {
    const result = spawnSync(check.executable.name,
      ['--require', boundary, ...check.args.map(slot => slot.literal ?? bindings[slot.input])],
      { env: { ...process.env, HOME: home, USERPROFILE: home, FIXTURE_LAUNCH_MARKER: marker,
        AIH_EXPECTED_FINGERPRINTS: bindings.fingerprintCsv, AIH_EXPECTED_STORE: jksPath,
        AIH_ENDPOINT: check.env.AIH_ENDPOINT.literal, ...env },
        encoding: 'utf8', timeout: check.timeoutMs, windowsHide: true });
    return { result, launched: existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null };
  };
  return { check, home, configPath, jksPath, run };
}

test('Gradle behavior check launches the pinned manager only after the repaired config verifies', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-jvm-gradle-check-'));
  try {
    const fixture = managerCheckFixture(root, 'gradle');
    const normalized = fixture.jksPath.replaceAll('\\', '/');
    const config = `systemProp.http.proxyHost=proxy.example\nsystemProp.javax.net.ssl.trustStore=${normalized}\nsystemProp.javax.net.ssl.trustStorePassword=changeit\n`;
    writeFileSync(fixture.configPath, config);
    const pass = fixture.run();
    assert.equal(pass.result.status, 0, `manager pass: ${pass.result.stderr}`);
    assert.ok(pass.launched, 'pinned manager launched');
    const command = pass.launched.args.join(' ');
    assert.ok(command.includes('--gradle-user-home'), 'reviewed Gradle user home selected explicitly');
    assert.ok(!command.includes('trustStore='), 'no trust injection through check arguments');
    assert.equal(fixture.run({ FIXTURE_MANAGER_STATUS: '3' }).result.status, 1, 'manager failure is check failure');
    writeFileSync(fixture.configPath, config.replace(normalized, '/other/store.jks'));
    const mismatch = fixture.run();
    assert.equal(mismatch.result.status, 1, 'config drift fails before launch');
    assert.equal(mismatch.launched, null, 'no launch after config drift');
    writeFileSync(fixture.configPath, config);
    for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS']) {
      const guarded = fixture.run({ [key]: '-Djavax.net.ssl.trustStore=/inherited.jks' });
      assert.equal(guarded.result.status, 1, `${key} override fails before launch`);
      assert.equal(guarded.launched, null, `no launch under ${key} override`);
    }
    const storeMismatch = fixture.run({ AIH_EXPECTED_STORE: '/unexpected.jks' });
    assert.equal(storeMismatch.result.status, 1, 'unexpected reviewed store binding fails');
    assert.equal(storeMismatch.launched, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Maven behavior check guards rc consumption and environment before launching', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-jvm-maven-check-'));
  try {
    const fixture = managerCheckFixture(root, 'maven');
    const win = process.platform === 'win32';
    const [begin, end] = win ? ['REM BEGIN AIHQ MAVEN CA', 'REM END AIHQ MAVEN CA'] : ['# BEGIN AIHQ MAVEN CA', '# END AIHQ MAVEN CA'];
    const opts = `-Djavax.net.ssl.trustStore=${fixture.jksPath} -Djavax.net.ssl.trustStorePassword=changeit`;
    const config = win ? `${begin}\nset "MAVEN_OPTS=%MAVEN_OPTS% ${opts}"\n${end}\n` :
      `${begin}\nMAVEN_OPTS="\${MAVEN_OPTS:-} ${opts}"\nexport MAVEN_OPTS\n${end}\n`;
    writeFileSync(fixture.configPath, config);
    const pass = fixture.run();
    assert.equal(pass.result.status, 0, `manager pass: ${pass.result.stderr}`);
    assert.ok(pass.launched, 'pinned manager launched');
    assert.equal(fixture.run({ FIXTURE_MANAGER_STATUS: '3' }).result.status, 1, 'manager failure is check failure');
    const skipped = fixture.run({ MAVEN_SKIP_RC: '1' });
    assert.equal(skipped.result.status, 1, 'skipped rc fails before launch');
    assert.equal(skipped.launched, null);
    writeFileSync(fixture.configPath, config.replace(fixture.jksPath, '/other/store.jks'));
    const mismatch = fixture.run();
    assert.equal(mismatch.result.status, 1, 'rc drift fails before launch');
    assert.equal(mismatch.launched, null);
    writeFileSync(fixture.configPath, config);
    for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS']) {
      const guarded = fixture.run({ [key]: '-Djavax.net.ssl.trustStore=/inherited.jks' });
      assert.equal(guarded.result.status, 1, `${key} override fails before launch`);
      assert.equal(guarded.launched, null, `no launch under ${key} override`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Env-gated native evidence with the provisioned JDK/Gradle/Maven and the host-converted
// JKS baseline. TEMP HOMES ONLY — never the real user home. Skipped unless explicitly set.
const nativeKeytool = process.env.AIHQ_TEST_JVM_KEYTOOL;
const nativeJava = process.env.AIHQ_TEST_JVM_JAVA;
const nativeBaseline = process.env.AIHQ_TEST_JVM_BASELINE ? readFileSync(process.env.AIHQ_TEST_JVM_BASELINE) : undefined;
const nativeGradle = process.env.AIHQ_TEST_JVM_GRADLE;
const nativeMaven = process.env.AIHQ_TEST_JVM_MAVEN;
const nativeReady = nativeKeytool && nativeJava && nativeBaseline;

test('native keytool materializes, verifies and protects the real baseline store',
  { skip: !nativeReady }, () => {
    const root = mkdtempSync(join(tmpdir(), 'aih-jvm-native-store-'));
    try {
      const prepared = prepare(['gradle'], {}, { files: { caFile: ca, baselineStore: nativeBaseline } });
      assert.equal(prepared.status, 'completed', JSON.stringify(prepared.diagnostics));
      const fixture = materializeFixture(root, prepared);
      const recipe = getRepairRecipe(variantRef(['gradle']));
      const materialize = recipe.operations.find(item => item.id === 'jks-materialize');
      const bindings = { jksPath: fixture.jksPath, bundlePath: fixture.bundlePath,
        baselineFilePath: fixture.baselineFilePath, keytoolExecutable: nativeKeytool,
        baselineStoreSha256: sha256(nativeBaseline), bundleSha256: sha256(prepared.bundle) };
      const run = script => spawnSync(script.executable.name,
        script.args.map(slot => slot.literal ?? bindings[slot.input]),
        { encoding: 'utf8', timeout: script.timeoutMs ?? 60000, windowsHide: true });
      const published = run(materialize);
      assert.equal(published.status, 0, `real keytool publication: ${published.stderr}`);
      const first = readFileSync(fixture.jksPath);
      assert.ok(first.length > nativeBaseline.length, 'managed certificate added to baseline copy');
      assert.equal(run(materialize).status, 0, 'real re-run validates and reuses');
      assert.deepEqual(readFileSync(fixture.jksPath), first, 'bytes preserved on reuse');
      const content = recipe.checks.find(item => item.id === 'jks-content');
      const verified = spawnSync(content.executable.name,
        content.args.map(slot => slot.literal ??
          { ...bindings, fingerprintCsv: prepared.bindings.fingerprintCsv }[slot.input]),
        { encoding: 'utf8', timeout: content.timeoutMs, windowsHide: true });
      assert.equal(verified.status, 0, `real keytool store listing verifies: ${verified.stderr}`);
      writeFileSync(fixture.jksPath, nativeBaseline);
      assert.equal(run(materialize).status, 1, 'baseline-only real output blocks');
      assert.deepEqual(readFileSync(fixture.jksPath), nativeBaseline, 'untouched after block');
    } finally { try { rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 1000 }); } catch { /* A manager JVM may still hold the fixture; the OS temp cleaner owns it. */ } }
  });

test('native Gradle consumes the repaired truststore and reaches its declared endpoint',
  { skip: !(nativeReady && nativeGradle), timeout: 600000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'aih-jvm-native-gradle-'));
    try {
      const home = join(root, 'home');
      const stateDir = join(root, 'state');
      mkdirSync(join(home, '.gradle'), { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      const managed = join(stateDir, 'trust.pem');
      const prepared = prepare(['gradle'], {}, { files: { caFile: ca, baselineStore: nativeBaseline }, managedPath: managed });
      assert.equal(prepared.status, 'completed', JSON.stringify(prepared.diagnostics));
      writeFileSync(managed, prepared.bundle);
      const baselineFile = join(stateDir, 'baseline.store.b64');
      writeFileSync(baselineFile, prepared.privateBindings.baselineStoreBase64);
      const jksPath = join(stateDir, prepared.bindings.jksPath.split(/[\\/]/).at(-1));
      const recipe = getRepairRecipe(`jvm-ca/${process.platform}/gradle/declared`);
      const materialize = recipe.operations.find(item => item.id === 'jks-materialize');
      const bindings = { jksPath, bundlePath: managed, baselineFilePath: baselineFile,
        keytoolExecutable: nativeKeytool, baselineStoreSha256: sha256(nativeBaseline),
        bundleSha256: sha256(prepared.bundle) };
      assert.equal(spawnSync(materialize.executable.name,
        materialize.args.map(slot => slot.literal ?? bindings[slot.input]),
        { encoding: 'utf8', timeout: materialize.timeoutMs, windowsHide: true }).status, 0,
        'real store materialized');
      const configPath = join(home, '.gradle', 'gradle.properties');
      writeFileSync(configPath, prepared.privateBindings.gradleConfig);
      const check = recipe.checks.find(item => item.id === 'gradle-behavior');
      const env = { ...process.env, HOME: home, USERPROFILE: home,
        AIH_EXPECTED_FINGERPRINTS: prepared.bindings.fingerprintCsv, AIH_EXPECTED_STORE: jksPath,
        AIH_ENDPOINT: check.env.AIH_ENDPOINT.literal };
      for (const key of ['GRADLE_USER_HOME', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS',
        'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS', 'MAVEN_SKIP_RC']) delete env[key];
      const result = spawnSync(check.executable.name,
        check.args.map(slot => slot.literal ??
          { gradleConfigPath: configPath, jksPath, gradleExecutable: nativeGradle, javaExecutable: nativeJava }[slot.input]),
        { env, encoding: 'utf8', timeout: check.timeoutMs, windowsHide: true });
      assert.equal(result.status, 0,
        `real Gradle trust+endpoint check: ${String(result.stderr).slice(0, 512)}`);
    } finally { try { rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 1000 }); } catch { /* A manager JVM may still hold the fixture; the OS temp cleaner owns it. */ } }
  });

test('native Maven consumes the repaired truststore and reaches its declared endpoint',
  { skip: !(nativeReady && nativeMaven), timeout: 600000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'aih-jvm-native-maven-'));
    try {
      const home = join(root, 'home');
      const stateDir = join(root, 'state');
      mkdirSync(home, { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      const managed = join(stateDir, 'trust.pem');
      const prepared = prepare(['maven'], {}, { files: { caFile: ca, baselineStore: nativeBaseline }, managedPath: managed });
      assert.equal(prepared.status, 'completed', JSON.stringify(prepared.diagnostics));
      writeFileSync(managed, prepared.bundle);
      const baselineFile = join(stateDir, 'baseline.store.b64');
      writeFileSync(baselineFile, prepared.privateBindings.baselineStoreBase64);
      const jksPath = join(stateDir, prepared.bindings.jksPath.split(/[\\/]/).at(-1));
      const recipe = getRepairRecipe(`jvm-ca/${process.platform}/maven/declared`);
      const materialize = recipe.operations.find(item => item.id === 'jks-materialize');
      const bindings = { jksPath, bundlePath: managed, baselineFilePath: baselineFile,
        keytoolExecutable: nativeKeytool, baselineStoreSha256: sha256(nativeBaseline),
        bundleSha256: sha256(prepared.bundle) };
      assert.equal(spawnSync(materialize.executable.name,
        materialize.args.map(slot => slot.literal ?? bindings[slot.input]),
        { encoding: 'utf8', timeout: materialize.timeoutMs, windowsHide: true }).status, 0,
        'real store materialized');
      const configPath = join(home, process.platform === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc');
      writeFileSync(configPath, prepared.privateBindings.mavenConfig);
      const check = recipe.checks.find(item => item.id === 'maven-behavior');
      const env = { ...process.env, HOME: home, USERPROFILE: home,
        AIH_EXPECTED_FINGERPRINTS: prepared.bindings.fingerprintCsv, AIH_EXPECTED_STORE: jksPath,
        AIH_ENDPOINT: check.env.AIH_ENDPOINT.literal };
      for (const key of ['GRADLE_USER_HOME', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS',
        'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS', 'MAVEN_SKIP_RC']) delete env[key];
      const result = spawnSync(check.executable.name,
        check.args.map(slot => slot.literal ??
          { mavenConfigPath: configPath, jksPath, mavenExecutable: nativeMaven, javaExecutable: nativeJava }[slot.input]),
        { env, encoding: 'utf8', timeout: check.timeoutMs, windowsHide: true });
      assert.equal(result.status, 0,
        `real Maven trust+endpoint check: ${String(result.stderr).slice(0, 512)}`);
    } finally { try { rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 1000 }); } catch { /* A manager JVM may still hold the fixture; the OS temp cleaner owns it. */ } }
  });
