import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const allTargets = ['gradle', 'maven'];
const repairId = 'jvm-ca';
// Per-target reviewed config operation IDs declared by the jvm-ca definition.
const configOperationIds = { gradle: 'gradle-config', maven: 'maven-config' };
// The JVM truststore materialization (keytool) operation. Its outcome is
// explicit: Gradle/Maven configuration must never apply or report verified
// while materialization failed or was unavailable. An incomplete run can also
// come from a later TLS check failure after successful materialization, so the
// blocking invariants below are asserted only when this operation did not apply.
const materializeOperationId = 'jks-materialize';
const sentinels = {
  'gradle-config': 'org.gradle.parallel=false\n',
  'maven-config': '# Retained user Maven settings\n'
};
const retainedText = {
  'gradle-config': 'org.gradle.parallel=false',
  'maven-config': '# Retained user Maven settings'
};
// Windows fixture manager launches use one verbatim cmd string built from a
// validated launcher path and fixed literal arguments only. Paths carrying
// spaces or cmd metacharacters fail honestly instead of being interpolated.
const windowsSafePath = /^[A-Za-z0-9_.,:=+@/\\-]+$/;

function powershell() {
  return join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
}

function hostPrivilege() {
  if (process.platform === 'win32') {
    return { elevated: execFileSync(powershell(),
      ['-NoProfile', '-Command', '([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024, windowsHide: true }).trim() === 'True' };
  }
  return { uid: process.getuid(), effectiveUid: process.geteuid(), elevated: process.geteuid() === 0 };
}

function windowsDisplayVersion() {
  try {
    const out = execFileSync(join(process.env.SystemRoot, 'System32/reg.exe'),
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'DisplayVersion'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
    return /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

// The native gate proves exact contract targets. windows-2025 CI is explicitly
// supplementary and is never reported as the Windows 11 25H2 contract target.
// Windows 11 acceptance requires the exact 25H2 build 26200, not a lower bound
// that would silently admit future builds.
function hostIdentity() {
  const identity = { platform: process.platform, architecture: process.arch, osRelease: release(),
    runnerOs: process.env.RUNNER_OS ?? null, imageOs: process.env.ImageOS ?? null };
  if (process.platform === 'win32') {
    identity.osCaption = execFileSync(powershell(),
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).Caption'],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 4096, windowsHide: true }).trim();
    identity.displayVersion = windowsDisplayVersion();
    const build = Number(release().split('.')[2] ?? 0);
    identity.build = build;
    if (/Windows 11/.test(identity.osCaption)) {
      assert.equal(build, 26200,
        `Windows 11 contract gate is exactly 25H2 build 26200; got ${build} ("${identity.osCaption}")`);
      if (identity.displayVersion !== null) assert.equal(identity.displayVersion, '25H2',
        `Windows 11 build 26200 must report DisplayVersion 25H2; got ${identity.displayVersion}`);
      identity.gate = 'windows-11-25h2-contract';
    } else if (/Windows Server 2025/.test(identity.osCaption)) {
      identity.gate = 'windows-2025-supplementary-ci';
    } else {
      assert.ok(false, `Native gate requires Windows 11 25H2 build 26200 or supplementary Windows Server 2025; got "${identity.osCaption}" build ${build}`);
    }
  } else if (process.platform === 'linux') {
    const text = readFileSync('/etc/os-release', 'utf8');
    identity.osId = /^ID="?([^"\n]+)"?/m.exec(text)?.[1] ?? null;
    identity.osVersion = /^VERSION_ID="?([^"\n]+)"?/m.exec(text)?.[1] ?? null;
    assert.equal(identity.osId, 'ubuntu', `Native gate requires Ubuntu 24.04 x64; got ID=${identity.osId}`);
    assert.equal(identity.osVersion, '24.04', `Native gate requires Ubuntu 24.04 x64; got VERSION_ID=${identity.osVersion}`);
    assert.equal(process.arch, 'x64', `Native gate requires Ubuntu 24.04 x64; got ${process.arch}`);
    identity.gate = 'ubuntu-24.04-contract';
  } else if (process.platform === 'darwin') {
    identity.osVersion = execFileSync('/usr/bin/sw_vers', ['-productVersion'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 }).trim();
    assert.equal(Number(identity.osVersion.split('.')[0]), 26, `Native gate requires macOS 26 arm64; got ${identity.osVersion}`);
    assert.equal(process.arch, 'arm64', `Native gate requires macOS 26 arm64; got ${process.arch}`);
    identity.gate = 'macos-26-contract';
  }
  return identity;
}

// Standard-user evidence only: verify before any fixture provisioning or
// product effect.
function assertStandardUser() {
  const privilege = hostPrivilege();
  assert.equal(privilege.elevated, false, 'Native acceptance must run as a standard (non-elevated) user');
  return privilege;
}

function selectedJdk() {
  const javaHome = process.env.JAVA_HOME;
  assert.ok(javaHome, 'JAVA_HOME must select the fixture JDK so its lib/security/cacerts is the reviewed baselineStore');
  const executable = name => join(javaHome, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  const keytool = executable('keytool'), java = executable('java');
  assert.ok(existsSync(keytool), `Selected JDK at ${javaHome} has no keytool`);
  assert.ok(existsSync(java), `Selected JDK at ${javaHome} has no java`);
  return { javaHome, keytool, java };
}

function javaVersion(java) {
  const result = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true });
  assert.equal(result.error, undefined, `java -version failed to start: ${result.error}`);
  assert.equal(result.status, 0, `java -version exited ${result.status}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function storeTypeOf(bytes) {
  if (bytes.subarray(0, 4).toString('hex') === 'feedfeed') return 'JKS';
  if (bytes[0] === 0x30) return 'PKCS12';
  return 'unknown';
}

// Bounded `keytool -list -v` inventory of a store: entry count and the SHA-256
// trusted-certificate fingerprint multiset. Private key entries reject.
function listTrustFingerprints(keytool, storePath, storeType) {
  const result = spawnSync(keytool,
    ['-list', '-v', '-J-Duser.language=en', '-keystore', storePath, '-storetype', storeType, '-storepass', 'changeit'],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 1048576, windowsHide: true });
  assert.equal(result.error, undefined, `keytool -list failed to start: ${result.error}`);
  assert.equal(result.status, 0, `keytool -list exited ${result.status}: ${(result.stderr ?? '').slice(0, 4096)}`);
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const entryTypes = [...text.matchAll(/^Entry type:\s*(\S+)/gim)].map(match => match[1]);
  assert.ok(entryTypes.length > 0, `keytool -list reported no entries for ${storePath}`);
  assert.ok(entryTypes.every(type => !/privatekey/i.test(type)),
    `Baseline store ${storePath} must contain no private key entries`);
  const fingerprints = [...text.matchAll(/^\s*SHA256:\s*([0-9A-Fa-f:]+)/gim)]
    .map(match => match[1].toUpperCase());
  assert.equal(fingerprints.length, entryTypes.length,
    `Every baseline entry must yield a SHA-256 fingerprint (${fingerprints.length} of ${entryTypes.length})`);
  return { entryCount: entryTypes.length, fingerprints };
}

// The repair contract admits a JKS baseline store only; current JDKs ship
// cacerts as PKCS12. Fixture provisioning converts the selected JDK's store to
// JKS with the selected JDK's own keytool (conventional public container
// password `changeit`) inside the isolated fixture root — never mutating the
// vendor store — and proves the conversion retained the exact trusted
// fingerprint multiset. This is explicit fixture preparation, not a hidden
// product read or install. An already-JKS store is copied instead.
function convertBaselineToJks(root) {
  const { javaHome, keytool, java } = selectedJdk();
  let source = null;
  for (const candidate of [join(javaHome, 'lib/security/cacerts'), join(javaHome, 'jre/lib/security/cacerts')])
    if (existsSync(candidate)) source = candidate;
  assert.ok(source, `Selected JDK at ${javaHome} has no lib/security/cacerts baseline store`);
  const sourceBytes = readFileSync(source);
  const sourceSha256 = sha256(sourceBytes);
  const sourceType = storeTypeOf(sourceBytes);
  assert.notEqual(sourceType, 'unknown', `Unrecognized baseline store format at ${source}`);
  const original = listTrustFingerprints(keytool, source, sourceType);
  const baselineJks = join(root, 'baseline.jks');
  if (sourceType === 'JKS') {
    copyFileSync(source, baselineJks);
  } else {
    const conversion = spawnSync(keytool, ['-importkeystore', '-noprompt', '-srckeystore', source,
      '-srcstoretype', sourceType, '-srcstorepass', 'changeit',
      '-destkeystore', baselineJks, '-deststoretype', 'JKS', '-deststorepass', 'changeit'],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 1048576, windowsHide: true });
    assert.equal(conversion.error, undefined, `keytool baseline conversion failed to start: ${conversion.error}`);
    assert.equal(conversion.status, 0,
      `keytool baseline conversion exited ${conversion.status}: ${(conversion.stderr ?? '').slice(0, 4096)}`);
  }
  const baselineJksSha256 = sha256(readFileSync(baselineJks));
  const converted = listTrustFingerprints(keytool, baselineJks, 'JKS');
  assert.equal(converted.entryCount, original.entryCount,
    `Baseline conversion changed the entry count (${original.entryCount} -> ${converted.entryCount})`);
  assert.deepEqual([...converted.fingerprints].sort(), [...original.fingerprints].sort(),
    'Baseline conversion must preserve the exact trusted certificate fingerprint multiset');
  assert.equal(sha256(readFileSync(source)), sourceSha256, 'The selected JDK cacerts must remain byte-unchanged');
  return { baselineJks, baselineJksSha256, source, sourceType,
    sourceMagic: sourceBytes.subarray(0, 4).toString('hex'), sourceSha256,
    entryCount: original.entryCount, fingerprints: original.fingerprints,
    javaVersion: javaVersion(java), keytool };
}

function runManagerPosix(executable, args, env) {
  const result = spawnSync(executable, args, { env, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 65536 });
  return { status: result.status, error: result.error?.code,
    stdout: (result.stdout ?? '').slice(0, 8192), stderr: (result.stderr ?? '').slice(0, 8192) };
}

function windowsWhere(name) {
  const out = execFileSync(join(process.env.SystemRoot, 'System32/where.exe'), [name],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true }).trim().split(/\r?\n/);
  assert.equal(out.length, 1, `Expected exactly one ${name} on PATH, got ${out.length}`);
  assert.ok(windowsSafePath.test(out[0]), `${name} path is not safe for a verbatim cmd string: ${out[0]}`);
  return out[0];
}

function runManagerWindows(launcher, literalArgs, env) {
  for (const arg of literalArgs) assert.ok(windowsSafePath.test(arg), `Unsafe manager argument: ${arg}`);
  const comspec = process.env.ComSpec ?? join(process.env.SystemRoot, 'System32/cmd.exe');
  const command = `"${launcher}" ${literalArgs.join(' ')}`;
  const result = spawnSync(comspec, ['/d', '/v:off', '/s', '/c', `"${command}"`],
    { env, shell: false, windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 65536 });
  return { status: result.status, error: result.error?.code,
    stdout: (result.stdout ?? '').slice(0, 8192), stderr: (result.stderr ?? '').slice(0, 8192) };
}

// Real manager launches under the fixture home. Java user.home on Windows
// follows the account profile, not HOME/USERPROFILE, so Gradle is pinned to the
// canonical reviewed config directory with a fixed --gradle-user-home argument;
// the real account's Gradle configuration is never read.
function managerEvidence(env) {
  const gradleUserHome = join(homedir(), '.gradle');
  const gradleArgs = ['--gradle-user-home', gradleUserHome, '--version'];
  const mavenArgs = ['--version'];
  let gradleLauncher = 'gradle', mavenLauncher = 'mvn';
  if (process.platform === 'win32') {
    gradleLauncher = windowsWhere('gradle.bat');
    mavenLauncher = windowsWhere('mvn.cmd');
  }
  const gradle = process.platform === 'win32'
    ? runManagerWindows(gradleLauncher, gradleArgs, env)
    : runManagerPosix(gradleLauncher, gradleArgs, env);
  assert.equal(gradle.error, undefined, `gradle launch failed: ${gradle.error ?? gradle.stderr}`);
  assert.equal(gradle.status, 0, `gradle --version exited ${gradle.status}: ${gradle.stderr}`);
  const maven = process.platform === 'win32'
    ? runManagerWindows(mavenLauncher, mavenArgs, env)
    : runManagerPosix(mavenLauncher, mavenArgs, env);
  assert.equal(maven.error, undefined, `mvn launch failed: ${maven.error ?? maven.stderr}`);
  assert.equal(maven.status, 0, `mvn --version exited ${maven.status}: ${maven.stderr}`);
  return { javaHome: process.env.JAVA_HOME ?? null, gradleLauncher, mavenLauncher, gradleUserHome,
    gradleVersion: gradle.stdout, mavenVersion: maven.stdout };
}

async function loadPublicConsumer() {
  const { prepare, apply } = await import('@aihq/core');
  const { repairIndex, contractSupport } = await import('@aihq/core/harness');
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const ajv = new Ajv2020({ strict: true });
  for (const name of ['prepared-work', 'run-result'])
    ajv.addSchema((await import(`@aihq/core/schemas/${name}/1.0.0.json`, { with: { type: 'json' } })).default);
  return { prepare, apply, repairIndex, contractSupport, ajv };
}

function fixtureConfigFiles(repairIndex, targets) {
  const definition = repairIndex.find(item => item.id === repairId);
  assert.ok(definition, `Packed artifact does not ship ${repairId}`);
  const variant = definition.variants.find(item => item.os === process.platform && item.network === 'declared' &&
    item.targets.length === targets.length && targets.every(id => item.targets.includes(id)));
  assert.ok(variant, `No declared ${repairId} variant for ${process.platform} ${targets.join('+')}`);
  // Windows maven variants also declare conflict-detection snapshots for the
  // other rc filenames; only the two real config files receive sentinels.
  const files = variant.configFiles.filter(item => Object.values(configOperationIds).includes(item.operationId))
    .map(item => ({ id: item.operationId,
      path: join(homedir(), ...item.target.segments.map(segment => segment.literal)) }));
  assert.deepEqual(files.map(file => file.id).sort(),
    targets.map(id => configOperationIds[id]).sort(), 'Declared config operations cover the selected targets');
  return files;
}

function seedSentinels(files) {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, sentinels[file.id]);
  }
  return new Map(files.map(file => [file.path, readFileSync(file.path)]));
}

function assertSentinelsUnchanged(files, before, label) {
  for (const file of files)
    assert.deepEqual(readFileSync(file.path), before.get(file.path), `${label}: ${file.id} must stay untouched`);
}

async function exerciseConsumer() {
  const identity = hostIdentity();
  const privilege = assertStandardUser();
  const { prepare, apply, repairIndex, contractSupport, ajv } = await loadPublicConsumer();
  const targets = process.argv[5].split(',');
  const baselineStore = process.argv[4];
  const files = fixtureConfigFiles(repairIndex, targets);
  const before = seedSentinels(files);
  const request = { useCase: 'repair', repairs: [{ id: repairId, targets,
    inputs: { caFile: process.argv[3], baselineStore } }] };
  const preview = await prepare(request, { logging: 'off' });
  assert.ok(preview.review, JSON.stringify(preview.diagnostics));
  assert.equal(ajv.validate(preview.review.schema, preview.review), true, JSON.stringify(ajv.errors));
  assertSentinelsUnchanged(files, before, 'Prepare has no configuration effects');
  const resolutions = preview.review.operations.filter(operation => operation.effects === 'conflict').map(operation => {
    const file = files.find(item => `trust/${item.id}` === operation.id);
    assert.ok(file, `Unexpected conflict ${operation.id}`);
    return { selectionId: 'trust', operationId: file.id, choice: 'replace', observedSha256: sha256(before.get(file.path)) };
  });
  const prepared = await prepare({ ...request, ...(resolutions.length ? { resolutions } : {}) }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(prepared.review.inputs.package, contractSupport.package);
  const materialize = prepared.review.operations.find(operation => operation.id === `trust/${materializeOperationId}`);
  assert.ok(materialize, 'Review must show the explicit JVM truststore materialization operation');
  const result = await apply(prepared.prepared, { approved: true, origin: 'automation',
    reviewDigest: prepared.review.reviewDigest }, { logging: 'off' });
  assert.equal(ajv.validate(result.schema, result), true, JSON.stringify(ajv.errors));
  // Persist the complete native evidence before any outcome assertion, so a
  // failed acceptance keeps the actual review/result rather than a summary.
  writeFileSync('native-result.json', JSON.stringify({ ...identity, privilege,
    node: process.version, package: contractSupport.package, targets, baselineStore,
    review: prepared.review, result }, null, 2));
  const materializeOutcome = result.operations.find(operation => operation.id === `trust/${materializeOperationId}`);
  assert.ok(materializeOutcome, 'Result must report the explicit JVM materialization outcome');
  const materializeApplied = ['applied', 'already-satisfied'].includes(materializeOutcome.application);
  if (result.completion !== 'complete') {
    if (!materializeApplied)
      // Missing/failed keytool materialization blocks the dependent JVM
      // configuration; earlier effects/recovery stay honestly reported.
      for (const file of files) {
        const config = result.operations.find(operation => operation.id === `trust/${file.id}`);
        assert.ok(!config || config.application === 'not-attempted',
          `${file.id} must be blocked when JVM materialization did not succeed`);
        assert.ok(!config || config.verification.status !== 'passed',
          `${file.id} must never report verified while materialization failed or was unavailable`);
      }
    assert.ok(false, `jvm-ca native acceptance incomplete (${result.completion}), materialization ` +
      `${materializeOutcome.application}: ${JSON.stringify(result.operations.map(operation =>
        ({ id: operation.id, application: operation.application, verification: operation.verification.status })))}`);
  }
  assert.ok(materializeApplied, `JVM materialization outcome: ${materializeOutcome.application}`);
  writeFileSync('native-tools.json', JSON.stringify(managerEvidence({ ...process.env }), null, 2));
  // Manager TLS behavior is proven by the repair's own declared checks, which
  // launch the byte-pinned actual Gradle/Maven managers against the repaired
  // configuration; a target without a declared check must never claim passed.
  for (const id of targets) {
    const operationId = `trust/${configOperationIds[id]}`;
    const reviewed = prepared.review.operations.find(operation => operation.id === operationId);
    const outcome = result.operations.find(operation => operation.id === operationId);
    assert.ok(outcome, `Result must report ${operationId}`);
    if (reviewed.checks.length > 0) assert.equal(outcome.verification.status, 'passed',
      `${operationId} declared checks must pass`);
    else assert.notEqual(outcome.verification.status, 'passed',
      `${operationId} must not claim verification without a declared check`);
  }
  for (const file of files) {
    const text = readFileSync(file.path, 'utf8');
    assert.ok(text.includes(retainedText[file.id]), `${file.id} preserves neighboring configuration`);
  }
  const after = new Map(files.map(file => [file.path, readFileSync(file.path)]));
  const repeated = await prepare(request, { logging: 'off' });
  assert.equal(repeated.status, 'ready', JSON.stringify(repeated));
  const reapplied = await apply(repeated.prepared, { approved: true, origin: 'automation',
    reviewDigest: repeated.review.reviewDigest }, { logging: 'off' });
  assert.equal(reapplied.completion, 'complete', JSON.stringify(reapplied));
  for (const file of files) assert.deepEqual(readFileSync(file.path), after.get(file.path), `${file.id} is idempotent`);
  writeFileSync('native-repeat.json', JSON.stringify(reapplied, null, 2));
  console.log(JSON.stringify({ package: contractSupport.package, targets, completion: result.completion,
    runId: result.runId, repeatRunId: reapplied.runId, gate: identity.gate }));
}

async function exerciseNegative() {
  const scenario = process.argv[3];
  const identity = hostIdentity();
  const privilege = assertStandardUser();
  const { prepare, apply, repairIndex, contractSupport } = await loadPublicConsumer();
  const targets = process.argv[6].split(',');
  const files = fixtureConfigFiles(repairIndex, targets);
  const before = seedSentinels(files);
  const evidenceFile = `native-negative-${scenario}.json`;
  const inputs = { caFile: process.argv[4],
    baselineStore: scenario === 'invalid-baseline' ? process.argv[4] : process.argv[5] };
  const request = { useCase: 'repair', repairs: [{ id: repairId, targets, inputs }] };
  const record = { ...identity, privilege, node: process.version, package: contractSupport.package,
    scenario, targets, inputs: { caFile: inputs.caFile, baselineStore: inputs.baselineStore } };
  const preview = await prepare(request, { logging: 'off' });
  record.preview = { status: preview.status, diagnostics: preview.diagnostics ?? null, review: preview.review ?? null };
  if (preview.status === 'ready' && scenario === 'missing-keytool') {
    // A review that stayed executable without keytool must still block the JVM
    // branch at apply: no materialization, no dependent config, no verification.
    const result = await apply(preview.prepared, { approved: true, origin: 'automation',
      reviewDigest: preview.review.reviewDigest }, { logging: 'off' });
    record.result = result;
    writeFileSync(evidenceFile, JSON.stringify(record, null, 2));
    assert.notEqual(result.completion, 'complete', 'missing keytool must not complete');
    const materializeOutcome = result.operations.find(operation => operation.id === `trust/${materializeOperationId}`);
    assert.ok(!materializeOutcome || !['applied', 'already-satisfied'].includes(materializeOutcome.application),
      'missing keytool must not materialize a truststore');
    for (const file of files) {
      const config = result.operations.find(operation => operation.id === `trust/${file.id}`);
      assert.ok(!config || config.application === 'not-attempted',
        `${file.id} must be blocked when keytool is missing`);
      assert.ok(!config || config.verification.status !== 'passed',
        `${file.id} must never report verified when keytool is missing`);
    }
  } else {
    // The expected negative outcome: preparation itself refuses (missing
    // prerequisite or invalid baseline store) before any effect.
    writeFileSync(evidenceFile, JSON.stringify(record, null, 2));
    assert.notEqual(preview.status, 'ready',
      `${scenario} must block preparation, got ready: ${JSON.stringify(preview.review?.operations?.map(o => o.id))}`);
  }
  assertSentinelsUnchanged(files, before, `${scenario} has no configuration effects`);
  console.log(JSON.stringify({ scenario, status: record.result ? record.result.completion : preview.status, gate: identity.gate }));
}

if (process.argv[2] === '--consumer') {
  await exerciseConsumer();
} else if (process.argv[2] === '--consumer-negative') {
  await exerciseNegative();
} else {
  assert.ok(process.env.npm_execpath, 'Run with npm exec --offline --call "node scripts/ci/jvm-trust-native.mjs"');
  const targets = process.argv.find(value => value.startsWith('--targets='))?.slice(10).split(',') ?? allTargets;
  assert.ok(targets.length && new Set(targets).size === targets.length && targets.every(id => allTargets.includes(id)));
  // Identity and standard-user gates precede ALL fixture provisioning and
  // product effects, including the baseline store conversion.
  const identity = hostIdentity();
  const privilege = assertStandardUser();
  const scratchParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(scratchParent, 'aih-native-jvm-'));
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const consumer = join(root, 'consumer');
  const happyHome = join(root, 'home'), missingHome = join(root, 'home-missing-keytool'),
    invalidHome = join(root, 'home-invalid-baseline');
  for (const directory of [consumer, happyHome, missingHome, invalidHome]) mkdirSync(directory);
  const fixtureEnv = home => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, '.config'),
      // Canonical reviewed location only: the repair rejects a redirected
      // GRADLE_USER_HOME, and Windows Java user.home ignores HOME/USERPROFILE.
      GRADLE_USER_HOME: join(home, '.gradle') };
    // The fixture uses normal verified TLS rather than inherited host overrides.
    for (const key of Object.keys(env)) if (/^(?:npm_config_allow_scripts|node_test_context|java_tool_options|jdk_java_options|_java_options|java_opts|gradle_opts|maven_opts|maven_args|maven_skip_rc|ssl_cert_file|ssl_cert_dir)$/i.test(key)) delete env[key];
    return env;
  };
  const reportDirectory = join(source, 'native-trust-results');
  mkdirSync(reportDirectory, { recursive: true });
  const evidenceNames = ['native-failure.json', 'native-result.json', 'native-repeat.json', 'native-package.json',
    'native-tools.json', 'native-negative-missing-keytool.json', 'native-negative-invalid-baseline.json'];
  for (const name of evidenceNames)
    if (existsSync(join(reportDirectory, name))) unlinkSync(join(reportDirectory, name));
  const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env: fixtureEnv(happyHome), encoding: 'utf8', timeout: 120000 });
  let succeeded = false;
  try {
    // Fixture provisioning: convert/copy the selected JDK baseline to JKS and
    // prove fingerprint-multiset equality before any pack or product effect.
    const baseline = convertBaselineToJks(root);
    const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], source))[0];
    writeFileSync(join(reportDirectory, 'native-package.json'), JSON.stringify({ ...identity, privilege,
      name: packed.name, version: packed.version, filename: packed.filename,
      sha256: sha256(readFileSync(join(root, packed.filename))),
      integrity: packed.integrity, workflowRevision: process.env.GITHUB_SHA ?? null,
      baseline: { source: baseline.source, sourceType: baseline.sourceType, sourceMagic: baseline.sourceMagic,
        sourceSha256: baseline.sourceSha256, jksSha256: baseline.baselineJksSha256,
        entryCount: baseline.entryCount, fingerprints: baseline.fingerprints,
        javaVersion: baseline.javaVersion, keytool: baseline.keytool } }, null, 2));
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dependencies: { '@aihq/core': `file:${join(root, packed.filename)}` } }));
    // npm exec --offline selects this local script; its inherited offline flag
    // must not prevent the new consumer from obtaining published dependencies.
    npm(['install', '--offline=false', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
    const caPath = join(consumer, 'supplied-ca.pem');
    copyFileSync(join(source, 'test/fixtures/root-a.pem'), caPath);
    copyFileSync(fileURLToPath(import.meta.url), join(consumer, 'native.mjs'));
    const run = (home, args, timeout) => {
      console.log(execFileSync(process.execPath, [join(consumer, 'native.mjs'), ...args],
        { cwd: consumer, env: fixtureEnv(home), encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 }));
    };
    run(happyHome, ['--consumer', caPath, baseline.baselineJks, targets.join(',')], 1500000);
    // Negative: no JDK/keytool/java/managers resolvable. The JVM branch must
    // block honestly with zero configuration effects; earlier managed material
    // and recovery survive per the repair contract.
    const missingEnv = { ...fixtureEnv(missingHome),
      PATH: [dirname(process.execPath), ...(process.platform === 'win32'
        ? [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot] : [])].join(delimiter) };
    delete missingEnv.JAVA_HOME;
    console.log(execFileSync(process.execPath, [join(consumer, 'native.mjs'), '--consumer-negative', 'missing-keytool',
      caPath, baseline.baselineJks, targets.join(',')],
      { cwd: consumer, env: missingEnv, encoding: 'utf8', timeout: 300000, maxBuffer: 2 * 1024 * 1024 }));
    // Negative: a PEM supplied as the required JKS baseline store must reject
    // preparation before any effect.
    run(invalidHome, ['--consumer-negative', 'invalid-baseline', caPath, baseline.baselineJks, targets.join(',')], 300000);
    succeeded = true;
  } catch (error) {
    // Both conversion inputs and all evidence stay inside the retained root on
    // failure; nothing outside the fixture is mutated.
    writeFileSync(join(reportDirectory, 'native-failure.json'), JSON.stringify({ ...identity, privilege,
      node: process.version, targets,
      message: error instanceof Error ? error.message : 'Native acceptance failed' }, null, 2));
    throw error;
  } finally {
    for (const name of evidenceNames.slice(1))
      if (existsSync(join(consumer, name))) copyFileSync(join(consumer, name), join(reportDirectory, name));
    if (succeeded) {
      assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
      assert.equal(dirname(realpathSync(root)), scratchParent, 'Cleanup stays inside the dedicated temporary parent');
      rmSync(root, { recursive: true });
    }
    else console.error(`Native acceptance failed; isolated evidence retained at ${root}`);
  }
}
