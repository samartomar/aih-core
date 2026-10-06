import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMacosSessionLaunchAgent, macosSessionTrustKeys, macosSessionBudgets,
  observeMacosGuiSession, observeMacosApplication, readMacosGuiDomainKey, applyMacosGuiDomainKey,
  macosSessionBootstrap, macosSessionBootout, runMacosSessionLoginReplay,
  createMacosSessionRecoveryContext, evaluateMacosSessionVerification }
  from '../../src/harness/macos-session.mjs';

const BOOT_UUID = '5D3C1A2B-0000-4000-8000-000000000073';
const APP = '/Applications/Test.app';
const dir = (over = {}) => ({ mode: 0o755, uid: 0, gid: 0, dev: 1, ino: 7, size: 0,
  isDirectory: () => true, isSymbolicLink: () => false, ...over });

const fakeHost = ({ platform = 'darwin', uid = 502, lstat = {}, files = {}, runs = {} } = {}) => ({
  platform, arch: 'arm64', release: '25.0.0',
  uid: () => uid,
  lstat: path => lstat[path],
  readFile: (path, maxBytes) => {
    const value = files[path];
    if (value === undefined) return undefined;
    const bytes = Buffer.from(value);
    return bytes.byteLength > (maxBytes ?? Infinity) ? undefined : bytes;
  },
  run: async spec => runs[`${spec.executable} ${spec.args.join(' ')}`] ?? { status: 'unavailable' }
});

const guiRuns = (over = {}) => ({
  '/usr/bin/stat -f %u /dev/console': { status: 'ok', code: 0, stdout: '502\n' },
  '/bin/launchctl managername': { status: 'ok', code: 0, stdout: 'Aqua\n' },
  '/bin/launchctl manageruid': { status: 'ok', code: 0, stdout: '502\n' },
  '/usr/sbin/sysctl -n kern.bootsessionuuid': { status: 'ok', code: 0, stdout: `${BOOT_UUID}\n` },
  ...over
});
const guiHost = (over = {}) => fakeHost({ ...over, runs: guiRuns(over.runs) });

const bundleHost = (over = {}) => fakeHost({
  platform: over.platform, uid: over.uid,
  lstat: { '/': dir(), '/Applications': dir({ mode: 0o755 }), [APP]: dir({ mode: 0o755 }), ...(over.lstat ?? {}) },
  files: {
    [`${APP}/Contents/Info.plist`]: '<plist/>',
    [`${APP}/Contents/MacOS/Test`]: 'binary',
    ...(over.files ?? {})
  },
  runs: {
    [`/usr/bin/plutil -convert json -o - -- ${APP}/Contents/Info.plist`]: { status: 'ok', code: 0,
      stdout: JSON.stringify({ CFBundleIdentifier: 'com.example.test', CFBundleShortVersionString: '1.2.3',
        CFBundleVersion: '456', CFBundleExecutable: 'Test' }) },
    [`/usr/bin/codesign --display --verbose=4 -- ${APP}`]: { status: 'ok', code: 0, stdout: '',
      stderr: 'Identifier=com.example.test\nTeamIdentifier=ABCDE12345\n' +
        'CDHash=0123456789abcdef0123456789abcdef01234567\n' },
    [`/usr/bin/codesign --verify --strict -- ${APP}`]: { status: 'ok', code: 0 },
    ...(over.runs ?? {})
  }
});

test('GUI session observation fails closed off macOS and never guesses a session', async () => {
  assert.deepEqual(await observeMacosGuiSession({}, fakeHost({ platform: 'win32' })),
    { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'session-platform-unsupported' });
  assert.deepEqual(await observeMacosGuiSession({}, guiHost({ uid: 0 })).then(result => result.reason),
    'gui-session-unavailable', 'root effective UID is not a GUI session');
  assert.deepEqual(await observeMacosGuiSession({}, guiHost({
    runs: { '/usr/bin/stat -f %u /dev/console': { status: 'ok', code: 0, stdout: '501\n' } }
  })).then(result => [result.status, result.reason]), ['unavailable', 'gui-session-unavailable'], 'SSH/other session');
  assert.deepEqual(await observeMacosGuiSession({}, guiHost({
    runs: { '/bin/launchctl managername': { status: 'ok', code: 0, stdout: 'Standard\n' } }
  })).then(result => [result.status, result.reason]), ['unavailable', 'gui-session-unavailable']);
  assert.deepEqual(await observeMacosGuiSession({}, guiHost({
    runs: { '/usr/sbin/sysctl -n kern.bootsessionuuid': { status: 'ok', code: 0, stdout: 'not-a-uuid\n' } }
  })).then(result => [result.status, result.reason]), ['unavailable', 'gui-session-unavailable']);
  const aborted = AbortSignal.abort();
  assert.equal((await observeMacosGuiSession({ signal: aborted }, guiHost())).reason, 'cancelled');
});

test('GUI session observation binds the narrow native identity and admits it is not login-fresh', async () => {
  const result = await observeMacosGuiSession({}, guiHost());
  assert.equal(result.status, 'observed');
  assert.equal(result.uid, 502);
  assert.equal(result.domain, 'gui/502');
  assert.equal(result.managerName, 'Aqua');
  assert.equal(result.loginSessionDistinguished, false);
  assert.match(result.identitySha256, /^[a-f0-9]{64}$/);
  assert.equal(result.identitySha256, (await observeMacosGuiSession({}, guiHost())).identitySha256, 'stable');
  const other = await observeMacosGuiSession({}, guiHost({
    runs: { '/usr/sbin/sysctl -n kern.bootsessionuuid': { status: 'ok', code: 0,
      stdout: '5D3C1A2B-0000-4000-8000-000000000074\n' } }
  }));
  assert.notEqual(other.identitySha256, result.identitySha256, 'another boot session is a different identity');
});

test('application observation requires a no-link, non-mutable .app and rejects everything else', async () => {
  const request = { clientId: 'codex', appPath: APP, targets: ['node'], launch: 'finder' };
  const offHost = await observeMacosApplication(request, {}, fakeHost({ platform: 'win32' }));
  assert.deepEqual([offHost.status, offHost.reason], ['unavailable', 'app-session-unsupported']);
  const notApp = await observeMacosApplication({ ...request, appPath: '/Applications/Test' }, {}, bundleHost());
  assert.deepEqual([notApp.status, notApp.reason], ['unavailable', 'app-path-unsafe']);
  const linked = await observeMacosApplication(request, {}, bundleHost({
    lstat: { '/Applications': dir({ isSymbolicLink: () => true }) }
  }));
  assert.deepEqual([linked.status, linked.reason], ['unavailable', 'app-path-unsafe']);
  const mutable = await observeMacosApplication(request, {}, bundleHost({ lstat: { [APP]: dir({ mode: 0o777, uid: 502 }) } }));
  assert.deepEqual([mutable.status, mutable.reason], ['unavailable', 'app-path-mutable']);
  const noInfo = await observeMacosApplication(request, {}, bundleHost({
    runs: { [`/usr/bin/plutil -convert json -o - -- ${APP}/Contents/Info.plist`]: { status: 'timeout' } }
  }));
  assert.deepEqual([noInfo.status, noInfo.reason], ['unavailable', 'app-info-unavailable']);
  const noSignatureChannel = await observeMacosApplication(request, {}, bundleHost({
    runs: { [`/usr/bin/codesign --verify --strict -- ${APP}`]: { status: 'timeout' } }
  }));
  assert.deepEqual([noSignatureChannel.status, noSignatureChannel.reason], ['unavailable', 'app-signature-unavailable']);
  const badTargets = await observeMacosApplication({ ...request, targets: [] }, {}, bundleHost());
  assert.deepEqual([badTargets.status, badTargets.reason], ['unavailable', 'app-request-invalid']);
});

test('application observation captures bundle identity, signature facts and byte pins', async () => {
  const request = { clientId: 'codex', appPath: APP, targets: ['node', 'npm'], launch: 'dock' };
  const observed = await observeMacosApplication(request, {}, bundleHost());
  assert.equal(observed.status, 'observed');
  assert.equal(observed.bundleId, 'com.example.test');
  assert.equal(observed.version, '1.2.3');
  assert.equal(observed.build, '456');
  assert.equal(observed.teamId, 'ABCDE12345');
  assert.equal(observed.cdHash, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(observed.signatureVerified, true);
  assert.match(observed.executableSha256, /^[a-f0-9]{64}$/);
  assert.match(observed.infoPlistSha256, /^[a-f0-9]{64}$/);
  assert.match(observed.applicationIdentitySha256, /^[a-f0-9]{64}$/);
  assert.equal(observed.device, 1);
  assert.equal(observed.inode, 7);
  const invalid = await observeMacosApplication(request, {}, bundleHost({
    runs: { [`/usr/bin/codesign --verify --strict -- ${APP}`]: { status: 'error', code: 1 } }
  }));
  assert.equal(invalid.status, 'observed');
  assert.equal(invalid.signatureVerified, false, 'an observed invalid signature is not an unavailable channel');
});

/* ---------------------------------------------------- GUI-domain key and login replay */

const launchctlHost = (initial = {}, options = {}) => {
  const { uid = 502, getenvStatus = 'ok', disabled = {}, bootstrapStatus = 'ok',
    bootoutStatus = 'ok', now = () => 1_000_000 } = options;
  const domain = { ...initial };
  const calls = [];
  const host = { ...fakeHost({ uid }), now };
  host.run = async spec => {
    calls.push(`${spec.executable} ${spec.args.join(' ')}`);
    if (spec.executable === '/usr/bin/stat') return { status: 'ok', code: 0, stdout: `${uid}\n` };
    if (spec.executable === '/usr/sbin/sysctl') {
      return { status: 'ok', code: 0, stdout: `${BOOT_UUID}\n` };
    }
    if (spec.executable !== '/bin/launchctl') return { status: 'unavailable' };
    const [command, ...rest] = spec.args;
    if (command === 'managername') return { status: 'ok', code: 0, stdout: 'Aqua\n' };
    if (command === 'manageruid') return { status: 'ok', code: 0, stdout: `${uid}\n` };
    if (command === 'getenv') {
      if (getenvStatus !== 'ok') return { status: getenvStatus };
      const key = rest[0];
      return { status: 'ok', code: 0,
        stdout: Object.hasOwn(domain, key) && domain[key] !== '' ? `${domain[key]}\n` : '' };
    }
    if (command === 'setenv') { domain[rest[0]] = rest[1]; return { status: 'ok', code: 0 }; }
    if (command === 'unsetenv') { delete domain[rest[0]]; return { status: 'ok', code: 0 }; }
    if (command === 'print-disabled') return { status: 'ok', code: 0,
      stdout: Object.entries(disabled).map(([label, value]) => `\t"${label}" => ${value}`).join('\n') };
    if (command === 'bootstrap') return bootstrapStatus === 'ok' ? { status: 'ok', code: 0 } : { status: bootstrapStatus, code: 1 };
    if (command === 'bootout') return bootoutStatus === 'ok' ? { status: 'ok', code: 0 } : { status: bootoutStatus, code: 1 };
    return { status: 'unavailable' };
  };
  return { host, calls, domain };
};

const LAUNCH_AGENT = { key: 'NODE_EXTRA_CA_CERTS', label: 'dev.aihq.trust.node-extra-ca-certs',
  plistPath: '/Users/aihtest/Library/LaunchAgents/dev.aihq.trust.node-extra-ca-certs.plist', uid: 502 };

test('GUI domain key mutation reports interfered writes and honours cancellation', async () => {
  const base = { key: 'NODE_EXTRA_CA_CERTS', label: 'dev.aihq.trust.node-extra-ca-certs',
    desired: { present: true, value: '/new.pem' }, owned: { have: true, present: true, value: '/old.pem' },
    bindingSha256: 'c'.repeat(64), sessionIdentitySha256: 'd'.repeat(64) };
  const interfered = launchctlHost({ NODE_EXTRA_CA_CERTS: '/old.pem' });
  const originalRun = interfered.host.run;
  interfered.host.run = async spec => spec.args[0] === 'setenv'
    ? { status: 'ok', code: 0 } : originalRun(spec);
  const result = await applyMacosGuiDomainKey(base, {}, interfered.host);
  assert.deepEqual([result.status, result.verified, result.readback], ['applied', false, 'mismatch'],
    'a setenv that does not persist is reported, never assumed');
  const aborted = AbortSignal.abort();
  const cancelled = await applyMacosGuiDomainKey(base, { signal: aborted },
    launchctlHost({ NODE_EXTRA_CA_CERTS: '/old.pem' }).host);
  assert.deepEqual([cancelled.status, cancelled.reason], ['unavailable', 'cancelled']);
  const readCancelled = await readMacosGuiDomainKey({ key: 'NODE_EXTRA_CA_CERTS', uid: 502 }, { signal: aborted },
    launchctlHost({ NODE_EXTRA_CA_CERTS: '/x.pem' }).host);
  assert.deepEqual([readCancelled.status, readCancelled.reason], ['unavailable', 'cancelled']);
});

test('GUI domain key read refuses to guess absent-versus-empty and rejects unsafe keys', async () => {
  const present = await readMacosGuiDomainKey({ key: 'NODE_EXTRA_CA_CERTS', uid: 502 }, {},
    launchctlHost({ NODE_EXTRA_CA_CERTS: '/x.pem' }).host);
  assert.deepEqual(present, { status: 'present', key: 'NODE_EXTRA_CA_CERTS', value: '/x.pem' });
  const empty = await readMacosGuiDomainKey({ key: 'NODE_EXTRA_CA_CERTS', uid: 502 }, {},
    launchctlHost({ NODE_EXTRA_CA_CERTS: '' }).host);
  assert.deepEqual([empty.status, empty.reason], ['unavailable', 'getenv-ambiguous']);
  const absent = await readMacosGuiDomainKey({ key: 'NODE_EXTRA_CA_CERTS', uid: 502 }, {}, launchctlHost().host);
  assert.deepEqual([absent.status, absent.reason], ['unavailable', 'getenv-ambiguous']);
  const limited = await readMacosGuiDomainKey({ key: 'NODE_EXTRA_CA_CERTS', uid: 502 }, {},
    launchctlHost({}, { getenvStatus: 'output-limit' }).host);
  assert.deepEqual([limited.status, limited.reason], ['unavailable', 'getenv-output-limit']);
  const badKey = await readMacosGuiDomainKey({ key: 'NODE_TLS_REJECT_UNAUTHORIZED', uid: 502 }, {}, launchctlHost().host);
  assert.deepEqual([badKey.status, badKey.reason], ['unavailable', 'key-unsupported']);
  const wrongUser = await readMacosGuiDomainKey({ key: 'NODE_EXTRA_CA_CERTS', uid: 501 }, {},
    launchctlHost({ NODE_EXTRA_CA_CERTS: '/x.pem' }).host);
  assert.deepEqual([wrongUser.status, wrongUser.reason], ['unavailable', 'session-uid-mismatch']);
});

test('GUI domain key mutation preserves foreign values and only replaces a current-owned one', async () => {
  const base = { key: 'NODE_EXTRA_CA_CERTS', label: 'dev.aihq.trust.node-extra-ca-certs',
    bindingSha256: 'c'.repeat(64), sessionIdentitySha256: 'd'.repeat(64) };
  const owned = { have: true, present: true, value: '/old.pem' };
  const absentOwned = { have: false, present: false, value: null };

  const foreign = launchctlHost({ NODE_EXTRA_CA_CERTS: '/foreign.pem' });
  const conflict = await applyMacosGuiDomainKey({ ...base, desired: { present: true, value: '/new.pem' },
    owned: absentOwned }, {}, foreign.host);
  assert.equal(conflict.status, 'conflict');
  assert.equal(foreign.calls.some(call => call.includes('setenv') || call.includes('unsetenv')), false);

  const empty = await applyMacosGuiDomainKey({ ...base, desired: { present: true, value: '/new.pem' }, owned },
    {}, launchctlHost({ NODE_EXTRA_CA_CERTS: '' }).host);
  assert.deepEqual([empty.status, empty.reason], ['unavailable', 'getenv-ambiguous'], 'never overwrite a foreign empty value');

  const replace = launchctlHost({ NODE_EXTRA_CA_CERTS: '/old.pem' });
  const applied = await applyMacosGuiDomainKey({ ...base, desired: { present: true, value: '/new.pem' }, owned },
    {}, replace.host);
  assert.deepEqual([applied.status, applied.verified, applied.readback], ['applied', true, 'match']);
  assert.ok(replace.calls.includes('/bin/launchctl setenv NODE_EXTRA_CA_CERTS /new.pem'));

  const same = launchctlHost({ NODE_EXTRA_CA_CERTS: '/new.pem' });
  const unchanged = await applyMacosGuiDomainKey({ ...base, desired: { present: true, value: '/new.pem' },
    owned: absentOwned }, {}, same.host);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(same.calls.some(call => call.includes('setenv') || call.includes('unsetenv')), false);

  const removal = launchctlHost({ NODE_EXTRA_CA_CERTS: '/old.pem' });
  const removed = await applyMacosGuiDomainKey({ ...base, desired: { present: false, value: null }, owned },
    {}, removal.host);
  assert.deepEqual([removed.status, removed.verified, removed.readback], ['applied', false, 'ambiguous']);
  assert.ok(removal.calls.includes('/bin/launchctl unsetenv NODE_EXTRA_CA_CERTS'));

  const foreignRemoval = launchctlHost({ NODE_EXTRA_CA_CERTS: '/foreign.pem' });
  const refused = await applyMacosGuiDomainKey({ ...base, desired: { present: false, value: null },
    owned: absentOwned }, {}, foreignRemoval.host);
  assert.equal(refused.status, 'conflict');
  assert.equal(foreignRemoval.calls.some(call => call.includes('unsetenv')), false);
});

test('bootstrap and bootout only touch the exact owned label and never enable a disabled job', async () => {
  const host = launchctlHost();
  const registered = await macosSessionBootstrap(LAUNCH_AGENT, {}, host.host);
  assert.deepEqual([registered.status, registered.domain], ['registered', 'gui/502']);
  assert.ok(host.calls.includes(`/bin/launchctl bootstrap gui/502 ${LAUNCH_AGENT.plistPath}`));
  const removed = await macosSessionBootout(LAUNCH_AGENT, {}, host.host);
  assert.deepEqual([removed.status, removed.domain], ['removed', 'gui/502']);
  assert.ok(host.calls.includes('/bin/launchctl bootout gui/502/dev.aihq.trust.node-extra-ca-certs'));
  const wrongLabel = await macosSessionBootstrap({ ...LAUNCH_AGENT, label: 'dev.aihq.trust.other' }, {}, host.host);
  assert.deepEqual([wrongLabel.status, wrongLabel.reason], ['conflict', 'session-ownership-conflict']);
  const wrongPath = await macosSessionBootstrap({ ...LAUNCH_AGENT, plistPath: '/tmp/x.plist' }, {}, host.host);
  assert.equal(wrongPath.status, 'unavailable');
  const disabled = launchctlHost({}, { disabled: { 'dev.aihq.trust.node-extra-ca-certs': true } });
  const result = await macosSessionBootstrap(LAUNCH_AGENT, {}, disabled.host);
  assert.deepEqual([result.status, result.reason], ['disabled', 'session-persistence-disabled']);
  assert.equal(disabled.calls.some(call => call.includes('bootstrap')), false, 'a disabled job is never enabled or reset');
});

test('login replay writes only an owned matching value within the phase budget', async () => {
  const replayIntent = async (host, over = {}) => {
    const session = await observeMacosGuiSession({}, host);
    return { key: 'NODE_EXTRA_CA_CERTS', label: 'dev.aihq.trust.node-extra-ca-certs',
      desired: { present: true, value: '/new.pem' }, owned: { have: true, present: true, value: '/old.pem' },
      bindingSha256: 'c'.repeat(64), sessionIdentitySha256: session.identitySha256, uid: 502,
      recordPath: '/Users/aihtest/.aih/core/macos-session/status/node-extra-ca-certs.json',
      helperSha256: 'a'.repeat(64), phaseStartedAtMs: 1_000_000, ...over };
  };
  const appliedHost = launchctlHost({ NODE_EXTRA_CA_CERTS: '/old.pem' });
  const applied = await runMacosSessionLoginReplay(await replayIntent(appliedHost.host), {}, appliedHost.host);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.verified, true);
  const recovery = createMacosSessionRecoveryContext(await replayIntent(launchctlHost().host));
  assert.deepEqual(recovery.operations, ['read-domain-key', 'conditional-setenv-or-unsetenv', 'readback']);
  assert.deepEqual([recovery.phaseMs, recovery.commandMs, recovery.commandBytes, recovery.cleanupMs],
    [60000, 10000, 65536, 15000]);

  const oldHost = launchctlHost({ NODE_EXTRA_CA_CERTS: '/old.pem' });
  const stale = await runMacosSessionLoginReplay(await replayIntent(oldHost.host, { sessionIdentitySha256: 'd'.repeat(64) }),
    {}, oldHost.host);
  assert.deepEqual([stale.status, stale.reason], ['conflict', 'session-binding-changed']);
  const foreignHost = launchctlHost({ NODE_EXTRA_CA_CERTS: '/foreign.pem' });
  const foreign = await runMacosSessionLoginReplay(await replayIntent(foreignHost.host), {}, foreignHost.host);
  assert.equal(foreign.status, 'conflict');
  const expiredHost = launchctlHost({ NODE_EXTRA_CA_CERTS: '/old.pem' }, { now: () => 1_060_001 });
  const expired = await runMacosSessionLoginReplay(await replayIntent(expiredHost.host), {}, expiredHost.host);
  assert.deepEqual([expired.status, expired.reason], ['unavailable', 'session-budget-exceeded']);
  const offHostReplay = await runMacosSessionLoginReplay(await replayIntent(launchctlHost().host), {},
    fakeHost({ platform: 'win32' }));
  assert.deepEqual([offHostReplay.status, offHostReplay.reason], ['unavailable', 'session-platform-unsupported']);
});

/* ------------------------------------------------------------- verification decision */

test('session verification never fabricates launch or TLS provenance', () => {
  const profiles = [
    { id: 'codex-app-v1', clientId: 'codex', bundleId: 'com.example.test', launch: 'finder' },
    { id: 'codex-dock-v1', clientId: 'codex', bundleId: 'com.example.test', launch: 'dock' }
  ];
  const base = { profiles, clientId: 'codex', appPath: '/Applications/Test.app',
    profileId: 'codex-app-v1', launch: 'finder', network: 'declared', bindingSha256: 'c'.repeat(64) };
  const decide = over => evaluateMacosSessionVerification({ ...base, ...over });
  assert.deepEqual([decide({ profiles: [], launchObservation: null, trustProbe: null }).status,
    decide({ profiles: [], launchObservation: null, trustProbe: null }).reason], ['unavailable', 'app-session-unsupported']);
  assert.deepEqual([decide({ profileId: 'nope', launchObservation: null, trustProbe: null }).status], ['unavailable']);
  const noLaunch = decide({ launchObservation: { available: false, context: null }, trustProbe: null });
  assert.deepEqual([noLaunch.status, noLaunch.reason, noLaunch.launchContext],
    ['unavailable', 'launch-context-unobservable', 'launch-context-unobservable']);
  const noTrust = decide({ launchObservation: { available: true, context: 'finder' },
    trustProbe: { available: false, outcome: null } });
  assert.deepEqual([noTrust.status, noTrust.appTrust], ['incomplete', 'app-trust-unobservable']);
  const offline = decide({ network: 'off', launchObservation: { available: true, context: 'finder' }, trustProbe: null });
  assert.deepEqual([offline.status, offline.appTrust, offline.reason], ['incomplete', 'skipped', 'network-off']);
  const failed = decide({ launchObservation: { available: true, context: 'finder' },
    trustProbe: { available: true, outcome: 'failed' } });
  assert.deepEqual([failed.status, failed.appTrust, failed.reason], ['failed', 'failed', 'app-trust-failed']);
  const passed = decide({ launchObservation: { available: true, context: 'finder' },
    trustProbe: { available: true, outcome: 'passed' } });
  assert.deepEqual([passed.status, passed.appTrust, passed.reason], ['passed', 'passed', 'verified']);
  assert.equal(passed.bindingSha256, 'c'.repeat(64), 'a pass carries the exact host binding');
  const noBinding = decide({ bindingSha256: 'nope', launchObservation: { available: true, context: 'finder' },
    trustProbe: { available: true, outcome: 'passed' } });
  assert.deepEqual([noBinding.status, noBinding.reason, noBinding.bindingSha256],
    ['unavailable', 'session-binding-invalid', null]);
  const mismatch = decide({ profileId: 'codex-dock-v1', launch: 'dock',
    launchObservation: { available: true, context: 'finder' }, trustProbe: { available: true, outcome: 'passed' } });
  assert.deepEqual([mismatch.status, mismatch.reason], ['incomplete', 'launch-context-mismatch']);
});

const intent = (over = {}) => ({
  key: 'NODE_EXTRA_CA_CERTS',
  helperPath: '/Users/aihtest/.aih/core/macos-session/login-helper.mjs',
  runtimePath: '/usr/local/bin/node',
  recordPath: '/Users/aihtest/.aih/core/macos-session/status/node-extra-ca-certs.json',
  helperSha256: 'a'.repeat(64),
  runtimeSha256: 'b'.repeat(64),
  bindingSha256: 'c'.repeat(64),
  sessionIdentitySha256: 'd'.repeat(64),
  desired: { present: true, value: '/Users/aihtest/.aih/core/trust.pem' },
  ...over
});

test('launch agent renders a deterministic literal Aqua RunAtLoad plist with direct argv', () => {
  const rendered = renderMacosSessionLaunchAgent(intent());
  assert.equal(rendered.status, 'rendered');
  assert.equal(rendered.label, 'dev.aihq.trust.node-extra-ca-certs');
  assert.equal(rendered.plistFileName, 'dev.aihq.trust.node-extra-ca-certs.plist');
  assert.equal(rendered.plist, renderMacosSessionLaunchAgent(intent()).plist, 'byte-stable');
  assert.match(rendered.plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.match(rendered.plist, /<key>LimitLoadToSessionType<\/key>\n\t<string>Aqua<\/string>/);
  assert.doesNotMatch(rendered.plist, /KeepAlive|WatchPaths|StartInterval|StartCalendarInterval|EnvironmentVariables/);
  assert.deepEqual(rendered.argv, [
    '/usr/local/bin/node',
    '/Users/aihtest/.aih/core/macos-session/login-helper.mjs',
    '--key', 'NODE_EXTRA_CA_CERTS',
    '--record', '/Users/aihtest/.aih/core/macos-session/status/node-extra-ca-certs.json',
    '--binding', 'c'.repeat(64),
    '--label', 'dev.aihq.trust.node-extra-ca-certs'
  ]);
  assert.match(rendered.plistSha256, /^[a-f0-9]{64}$/);
});

test('launch agent XML-escapes every literal and never runs a shell', () => {
  const helperPath = '/Users/aihtest/.aih/core/macos-session/a&b<c>"d\'e.mjs';
  const rendered = renderMacosSessionLaunchAgent(intent({ helperPath }));
  assert.equal(rendered.status, 'rendered');
  assert.doesNotMatch(rendered.plist, /a&b<c>"d'e\.mjs/);
  assert.match(rendered.plist, /a&amp;b&lt;c&gt;&quot;d&apos;e\.mjs/);
  assert.ok(rendered.argv.includes(helperPath), 'direct argv keeps the literal path unescaped');
  assert.ok(rendered.argv.every(part => !/[/\\](?:ba|z|k)?sh$/.test(part)));
  assert.equal(rendered.argv.includes('-c'), false);
});

test('launch agent rejects unsafe keys, private paths, hashes and desired shapes', () => {
  const cases = [
    ['PATH', { key: 'PATH' }],
    ['HOME', { key: 'HOME' }],
    ['DYLD_INSERT_LIBRARIES', { key: 'DYLD_INSERT_LIBRARIES' }],
    ['NODE_TLS_REJECT_UNAUTHORIZED', { key: 'NODE_TLS_REJECT_UNAUTHORIZED' }],
    ['GIT_SSL_NO_VERIFY', { key: 'GIT_SSL_NO_VERIFY' }],
    ['lowercase key', { key: 'node_extra_ca_certs' }],
    ['relative helper', { helperPath: 'login-helper.mjs' }],
    ['unprotected helper root', { helperPath: '/tmp/login-helper.mjs' }],
    ['traversal helper', { helperPath: '/Users/aihtest/.aih/core/macos-session/../../evil.mjs' }],
    ['shell runtime', { runtimePath: '/bin/sh' }],
    ['record outside root', { recordPath: '/tmp/status.json' }],
    ['record name mismatch', { recordPath: '/Users/aihtest/.aih/core/macos-session/status/other.json' }],
    ['bad helper hash', { helperSha256: 'A'.repeat(64) }],
    ['absent with value', { desired: { present: false, value: 'x' } }],
    ['present with null', { desired: { present: true, value: null } }],
    ['control char value', { desired: { present: true, value: 'a\nb' } }],
    ['unknown intent member', { extra: true }]
  ];
  for (const [name, over] of cases) {
    const rendered = renderMacosSessionLaunchAgent(intent(over));
    assert.equal(rendered.status, 'invalid', name);
    assert.equal(rendered.code, 'INPUT_INVALID', name);
  }
});

test('budgets are fixed and the key allowlist stays finite and safe', () => {
  assert.deepEqual(macosSessionBudgets,
    { commandMs: 10000, commandBytes: 65536, phaseMs: 60000, cleanupMs: 15000 });
  assert.ok(Object.isFrozen(macosSessionBudgets));
  assert.ok(macosSessionTrustKeys.includes('NODE_EXTRA_CA_CERTS'));
  assert.equal(macosSessionTrustKeys.some(key => /^(PATH|HOME|DYLD_)/.test(key)), false);
  assert.equal(new Set(macosSessionTrustKeys).size, macosSessionTrustKeys.length);
});
