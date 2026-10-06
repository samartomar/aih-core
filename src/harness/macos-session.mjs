// Bounded macOS session Harness helpers: one owned LaunchAgent, fail-closed GUI session
// identity, strict no-link app observation, fixed literal /bin/launchctl GUI-domain key I/O
// and bounded login replay. Node-only. Every helper distinguishes an observed pass from an
// honest 'unavailable'; missing native provenance is never replaced by a UID/PID guess.
//
// The optional `environment` argument is an internal deterministic boundary seam for focused
// tests (the same pattern as trust-os.mjs). It is NOT a Core public control and must never be
// forwarded from a caller's {signal, logging} object.
import { createHash } from 'node:crypto';
import { lstatSync, openSync, closeSync, readSync, fstatSync, constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { arch as hostArch, platform as hostPlatform, release as hostRelease } from 'node:os';
import { spawn } from 'node:child_process';
import { canonicalJson } from './native/canonical.mjs';

export const macosSessionBudgets = Object.freeze({
  commandMs: 10000,
  commandBytes: 65536,
  phaseMs: 60000,
  cleanupMs: 15000
});

/** Finite selected trust family keys; PATH/HOME/DYLD/credential/TLS-disable keys never qualify. */
export const macosSessionTrustKeys = Object.freeze([
  'CARGO_HTTP_CAINFO',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'PIP_CERT',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE'
]);

const LABEL_PREFIX = 'dev.aihq.trust.';
const SESSION_ROOT = ['.aih', 'core', 'macos-session'];
const HEX64 = /^[a-f0-9]{64}$/;
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const LABEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const CONTROL_RE = /[\p{Cc}\p{Cf}]/u;
const SHELL_RE = /(?:^|\/)(?:ba|da|z|k|c|t)?sh$/;
const MAX_PATH = 4096;
const MAX_VALUE = 4096;

const invalid = reason => ({ status: 'invalid', code: 'INPUT_INVALID', reason });

const isPlainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string');

const hasExactKeys = (value, keys) => isPlainRecord(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

const safeAbsolute = path => typeof path === 'string' && path.length >= 1 && path.length <= MAX_PATH &&
  path.startsWith('/') && !CONTROL_RE.test(path) && !path.includes('//') &&
  path.slice(1).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');

// True only when the normalized path contains the protected .../.aih/core/macos-session root.
const underSessionRoot = path => {
  const segments = path.split('/');
  for (let index = 1; index + SESSION_ROOT.length <= segments.length; index++)
    if (SESSION_ROOT.every((segment, offset) => segments[index + offset] === segment))return true;
  return false;
};

const sessionLabel = key => `${LABEL_PREFIX}${key.toLowerCase().replaceAll('_', '-')}`;

const escapeXml = value => value.replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));

const sha256Hex = input => createHash('sha256').update(input).digest('hex');

const LAUNCHCTL = '/bin/launchctl';
const UNAVAILABLE = (reason, code = 'PREREQUISITE_UNAVAILABLE') => ({ status: 'unavailable', code, reason });

/* ------------------------------------------------------------------- OS boundary --- */

/** Internal file boundary; descriptor bytes are bounded and every named ancestor stays pinned. */
export function readMacosSessionFile(path, maxBytes = macosSessionBudgets.commandBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > macosSessionBudgets.commandBytes) return;
  let fd;
  try {
    const pins = [];
    for (let current = resolve(path); ; current = dirname(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (pins.length ? !stat.isDirectory() : !stat.isFile())) return;
      pins.push({ path: current, dev: stat.dev, ino: stat.ino });
      if (dirname(current) === current) break;
    }
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes || before.dev !== pins[0].dev || before.ino !== pins[0].ino) return;
    const chunks = []; let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes - total + 1));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) return;
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || pins.some(pin => {
      const current = lstatSync(pin.path);
      return current.isSymbolicLink() || current.dev !== pin.dev || current.ino !== pin.ino;
    })) return;
    return Buffer.concat(chunks, total);
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Real host boundary. `overrides` is the internal deterministic test seam only. */
function hostEnvironment(overrides = {}) {
  return {
    platform: hostPlatform(), arch: hostArch(), release: hostRelease(),
    uid: () => (typeof process.getuid === 'function' && typeof process.geteuid === 'function' &&
      process.getuid() === process.geteuid() ? process.geteuid() : -1),
    lstat: path => { try { return lstatSync(path); } catch { return undefined; } },
    readFile: readMacosSessionFile,
    run: spec => runCommand(spec),
    ...overrides
  };
}

function runCommand({ executable, args, input, timeoutMs = macosSessionBudgets.commandMs,
  maxOutputBytes = macosSessionBudgets.commandBytes }) {
  return new Promise(resolveResult => {
    let child; let timer; let cleanup; let done = false; let timedOut = false;
    const finish = value => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(cleanup);
      resolveResult(value);
    };
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      if (input) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    } catch { finish({ status: 'unavailable', reason: 'probe-invocation' }); return; }
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0; let overflow = false;
    const capture = (name, chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { overflow = true; child.kill(); return; }
      chunks[name].push(chunk);
    };
    const output = () => ({ stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    cleanup = setTimeout(() => finish({ status: 'timeout' }), timeoutMs + macosSessionBudgets.cleanupMs);
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.on('error', () => finish({ status: 'unavailable', reason: 'probe-invocation' }));
    child.on('close', code => {
      if (timedOut) return finish({ status: 'timeout' });
      if (overflow) return finish({ status: 'output-limit' });
      return finish({ status: code === 0 ? 'ok' : 'error', code, ...output() });
    });
  });
}

// One fixed literal command with the shared command budget; never a shell or caller argv.
async function fixedRun(environment, executable, args, controls, maxOutputBytes = macosSessionBudgets.commandBytes, input) {
  if (controls?.signal?.aborted) return { status: 'cancelled' };
  let result;
  try {
    result = await environment.run({ executable, args, timeoutMs: macosSessionBudgets.commandMs, maxOutputBytes, ...(input ? { input } : {}) });
  } catch { return { status: 'unavailable', reason: 'command-unavailable' }; }
  if (!result || !['ok', 'error', 'timeout', 'output-limit'].includes(result.status))
    return { status: 'unavailable', reason: result?.reason ?? 'command-unavailable' };
  return { status: result.status, code: result.code ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const validControls = controls => isPlainRecord(controls) &&
  Object.keys(controls).every(key => key === 'signal');

/* ------------------------------------------------------------ GUI session identity */

export async function observeMacosGuiSession(controls = {}, environment) {
  if (!validControls(controls)) return UNAVAILABLE('gui-session-unavailable');
  if (controls.signal?.aborted) return UNAVAILABLE('cancelled');
  const host = hostEnvironment(environment);
  if (host.platform !== 'darwin') return UNAVAILABLE('session-platform-unsupported');
  const uid = host.uid();
  if (!Number.isSafeInteger(uid) || uid <= 0) return UNAVAILABLE('gui-session-unavailable');
  const consoleProbe = await fixedRun(host, '/usr/bin/stat', ['-f', '%u', '/dev/console'], controls, 4096);
  if (consoleProbe.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (consoleProbe.status !== 'ok') return UNAVAILABLE('gui-session-unavailable');
  const consoleUid = Number(consoleProbe.stdout.trim());
  if (!Number.isSafeInteger(consoleUid) || consoleUid !== uid) return UNAVAILABLE('gui-session-unavailable');
  const manager = await fixedRun(host, LAUNCHCTL, ['managername'], controls, 4096);
  if (manager.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (manager.status !== 'ok' || manager.stdout.trim() !== 'Aqua') return UNAVAILABLE('gui-session-unavailable');
  const managerUid = await fixedRun(host, LAUNCHCTL, ['manageruid'], controls, 4096);
  if (managerUid.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (managerUid.status !== 'ok' || Number(managerUid.stdout.trim()) !== uid) return UNAVAILABLE('gui-session-unavailable');
  const boot = await fixedRun(host, '/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], controls, 4096);
  if (boot.status === 'cancelled') return UNAVAILABLE('cancelled');
  const bootSessionUuid = boot.status === 'ok' ? boot.stdout.trim() : '';
  if (!/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(bootSessionUuid))
    return UNAVAILABLE('gui-session-unavailable');
  // A native boot/console/manager tuple, never a bare UID heuristic. macOS exposes no narrow
  // public channel that distinguishes a fresh logout/login here, so that is reported, not guessed.
  const identitySha256 = sha256Hex(canonicalJson({ uid, consoleUid, managerName: 'Aqua', managerUid,
    bootSessionUuid }));
  return { status: 'observed', uid, domain: `gui/${uid}`, consoleUid, managerName: 'Aqua',
    bootSessionUuid, identitySha256, loginSessionDistinguished: false };
}

/* --------------------------------------------------------- application identity pins */

const APP_REQUEST_KEYS = ['clientId', 'appPath', 'targets', 'launch'];
const cleanString = (value, max = 512) => typeof value === 'string' && value.length >= 1 &&
  value.length <= max && !CONTROL_RE.test(value);
// Standard users cannot mutate root-owned wheel/admin-group directories such as
// /Applications (root:admin 0775). World-writable paths are always refused.
const trustedMode = stat => (Number(stat.mode) & 0o002) === 0 &&
  ((Number(stat.mode) & 0o020) === 0 || Number(stat.uid) === 0 && [0, 80].includes(Number(stat.gid)));

function safeBundleMember(host, appPath, relativePath, maxBytes) {
  const segments = relativePath.split('/');
  for (let index = 1; index <= segments.length; index++) {
    const stat = host.lstat(`${appPath}/${segments.slice(0, index).join('/')}`);
    if (!stat || stat.isSymbolicLink() || !trustedMode(stat) ||
      (index < segments.length ? !stat.isDirectory() : typeof stat.isFile !== 'function' || !stat.isFile() ||
        !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes)) return false;
  }
  return true;
}

export async function observeMacosApplication(request, controls = {}, environment) {
  if (!hasExactKeys(request, APP_REQUEST_KEYS) || !validControls(controls))
    return UNAVAILABLE('app-request-invalid');
  const { clientId, appPath, targets, launch } = request;
  if (!cleanString(clientId, 128) || !['finder', 'dock'].includes(launch)) return UNAVAILABLE('app-request-invalid');
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 64 ||
      new Set(targets).size !== targets.length || targets.some(target => !cleanString(target, 128)))
    return UNAVAILABLE('app-request-invalid');
  if (controls.signal?.aborted) return UNAVAILABLE('cancelled');
  const host = hostEnvironment(environment);
  if (host.platform !== 'darwin') return UNAVAILABLE('app-session-unsupported');
  if (!safeAbsolute(appPath) || !appPath.endsWith('.app')) return UNAVAILABLE('app-path-unsafe');
  const segments = appPath.slice(1).split('/');
  let appStat;
  for (let index = 1; index <= segments.length; index++) {
    const current = `/${segments.slice(0, index).join('/')}`;
    const entry = host.lstat(current);
    if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory() || entry.isSymbolicLink())
      return UNAVAILABLE('app-path-unsafe');
    if (!trustedMode(entry)) return UNAVAILABLE('app-path-mutable');
    if (index === segments.length) appStat = entry;
  }
  const infoPath = `${appPath}/Contents/Info.plist`;
  if (!safeBundleMember(host, appPath, 'Contents/Info.plist', macosSessionBudgets.commandBytes)) return UNAVAILABLE('app-path-unsafe');
  const infoBytes = host.readFile(infoPath, macosSessionBudgets.commandBytes);
  if (!infoBytes) return UNAVAILABLE('app-info-unavailable');
  const info = await fixedRun(host, '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', '--', '-'], controls, macosSessionBudgets.commandBytes, infoBytes);
  if (info.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (info.status !== 'ok') return UNAVAILABLE('app-info-unavailable');
  let plist;
  try { plist = JSON.parse(info.stdout); } catch { plist = undefined; }
  if (!isPlainRecord(plist)) return UNAVAILABLE('app-info-unavailable');
  const field = name => cleanString(plist[name]) ? plist[name] : null;
  const bundleId = field('CFBundleIdentifier');
  const version = field('CFBundleShortVersionString') ?? field('CFBundleVersion');
  const build = field('CFBundleVersion');
  const executableName = field('CFBundleExecutable');
  const display = await fixedRun(host, '/usr/bin/codesign', ['--display', '--verbose=4', '--', appPath], controls);
  if (display.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (display.status === 'timeout' || display.status === 'output-limit' || display.status === 'unavailable')
    return UNAVAILABLE('app-signature-unavailable');
  const signatureText = `${display.stdout}\n${display.stderr}`;
  const signatureField = name => new RegExp(`^${name}=(.+)$`, 'm').exec(signatureText)?.[1]?.trim() ?? null;
  const teamId = cleanString(signatureField('TeamIdentifier')) ? signatureField('TeamIdentifier') : null;
  const cdHashCandidate = signatureField('CDHash');
  const cdHash = typeof cdHashCandidate === 'string' && /^[a-f0-9]{40}$/.test(cdHashCandidate) ? cdHashCandidate : null;
  const verify = await fixedRun(host, '/usr/bin/codesign', ['--verify', '--strict', '--', appPath], controls);
  if (verify.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (!['ok', 'error'].includes(verify.status)) return UNAVAILABLE('app-signature-unavailable');
  let executableSha256 = null;
  if (executableName && /^[A-Za-z0-9._ -]{1,255}$/.test(executableName)) {
    if (!safeBundleMember(host, appPath, `Contents/MacOS/${executableName}`, macosSessionBudgets.commandBytes)) return UNAVAILABLE('app-path-unsafe');
    const executableBytes = host.readFile(`${appPath}/Contents/MacOS/${executableName}`, macosSessionBudgets.commandBytes);
    if (!executableBytes) return UNAVAILABLE('app-executable-unavailable');
    executableSha256 = sha256Hex(executableBytes);
  }
  const infoPlistSha256 = sha256Hex(infoBytes);
  const device = Number(appStat?.dev);
  const inode = Number(appStat?.ino);
  const appPathKey = sha256Hex(canonicalJson({ device, inode, bundleId }));
  const applicationIdentitySha256 = sha256Hex(canonicalJson({ bundleId, version, build, teamId, cdHash,
    executableSha256, infoPlistSha256, device, inode }));
  return { status: 'observed', clientId, appPath, appPathKey, bundleId, version, build, teamId, cdHash,
    signatureVerified: verify.status === 'ok', executableSha256, infoPlistSha256, applicationIdentitySha256,
    device, inode };
}

/* ------------------------------------------------------------------- launch agent */


export function renderMacosSessionLaunchAgent(intent) {
  const KEYS = ['key', 'helperPath', 'runtimePath', 'recordPath', 'helperSha256', 'runtimeSha256',
    'bindingSha256', 'sessionIdentitySha256', 'desired'];
  if (!hasExactKeys(intent, KEYS)) return invalid('launch-agent-intent');
  const { key, helperPath, runtimePath, recordPath, helperSha256, runtimeSha256, bindingSha256,
    sessionIdentitySha256, desired } = intent;
  if (typeof key !== 'string' || !KEY_RE.test(key) || !macosSessionTrustKeys.includes(key))
    return invalid('launch-agent-key');
  const label = sessionLabel(key);
  if (!LABEL_RE.test(label) || label.length > 64) return invalid('launch-agent-label');
  if (!safeAbsolute(helperPath) || !underSessionRoot(helperPath) || !helperPath.endsWith('.mjs'))
    return invalid('launch-agent-helper-path');
  if (!safeAbsolute(runtimePath) || SHELL_RE.test(runtimePath) ||
      !/^node(?:[.-][A-Za-z0-9._-]+)?$/.test(runtimePath.split('/').at(-1) ?? ''))
    return invalid('launch-agent-runtime-path');
  if (!safeAbsolute(recordPath) || !underSessionRoot(recordPath) ||
      recordPath.split('/').at(-1) !== `${key.toLowerCase().replaceAll('_', '-')}.json`)
    return invalid('launch-agent-record-path');
  for (const value of [helperSha256, runtimeSha256, bindingSha256, sessionIdentitySha256])
    if (typeof value !== 'string' || !HEX64.test(value)) return invalid('launch-agent-hash');
  if (!hasExactKeys(desired, ['present', 'value']) || typeof desired.present !== 'boolean')
    return invalid('launch-agent-desired');
  if (desired.present) {
    if (typeof desired.value !== 'string' || desired.value.length < 1 ||
        Buffer.byteLength(desired.value) > MAX_VALUE || CONTROL_RE.test(desired.value))
      return invalid('launch-agent-value');
  } else if (desired.value !== null) return invalid('launch-agent-desired');

  const argv = [runtimePath, helperPath, '--key', key, '--record', recordPath,
    '--binding', bindingSha256, '--label', label];
  const string = value => `\t\t<string>${escapeXml(value)}</string>`;
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${escapeXml(label)}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...argv.map(string),
    '\t</array>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>LimitLoadToSessionType</key>',
    '\t<string>Aqua</string>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
  return { status: 'rendered', key, label, plistFileName: `${label}.plist`,
    argv: Object.freeze(argv), plist, plistSha256: sha256Hex(plist) };
}

/* ------------------------------------------------------------- GUI domain key I/O --- */

// One fixed literal `launchctl getenv`. An empty capture is present-empty or absent and is
// reported as ambiguous: the helper never guesses presence and never overwrites on a guess.
async function probeGuiKey(host, key, controls) {
  const probe = await fixedRun(host, LAUNCHCTL, ['getenv', key], controls, macosSessionBudgets.commandBytes);
  if (probe.status === 'cancelled') return { status: 'cancelled' };
  if (probe.status === 'output-limit') return { status: 'unavailable', reason: 'getenv-output-limit' };
  if (probe.status !== 'ok') return { status: 'unavailable', reason: 'getenv-unavailable' };
  const value = probe.stdout.endsWith('\n') ? probe.stdout.slice(0, -1) : probe.stdout;
  if (value === '') return { status: 'unavailable', reason: 'getenv-ambiguous' };
  return { status: 'present', value };
}

const promptPresence = value => value === null || (typeof value === 'string' &&
  Buffer.byteLength(value) <= MAX_VALUE && !CONTROL_RE.test(value));

export async function readMacosGuiDomainKey(request, controls = {}, environment) {
  if (!hasExactKeys(request, ['key', 'uid']) || !validControls(controls) ||
      !Number.isSafeInteger(request.uid) || request.uid <= 0)
    return UNAVAILABLE('session-unavailable');
  if (typeof request.key !== 'string' || !macosSessionTrustKeys.includes(request.key))
    return UNAVAILABLE('key-unsupported');
  if (controls.signal?.aborted) return UNAVAILABLE('cancelled');
  const host = hostEnvironment(environment);
  if (host.platform !== 'darwin') return UNAVAILABLE('session-platform-unsupported');
  // `getenv` only reads the caller's current domain, so the caller must actually be that user.
  if (host.uid() !== request.uid) return UNAVAILABLE('session-uid-mismatch');
  const probe = await probeGuiKey(host, request.key, controls);
  if (probe.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (probe.status !== 'present') return UNAVAILABLE(probe.reason);
  return { status: 'present', key: request.key, value: probe.value };
}

const KEY_INTENT_KEYS = ['key', 'label', 'desired', 'owned', 'bindingSha256', 'sessionIdentitySha256'];

const keyIntentValid = intent => hasExactKeys(intent, KEY_INTENT_KEYS) &&
  typeof intent.key === 'string' && macosSessionTrustKeys.includes(intent.key) &&
  intent.label === sessionLabel(intent.key) &&
  HEX64.test(intent.bindingSha256 ?? '') && HEX64.test(intent.sessionIdentitySha256 ?? '') &&
  hasExactKeys(intent.desired, ['present', 'value']) && typeof intent.desired.present === 'boolean' &&
  (intent.desired.present
    ? (typeof intent.desired.value === 'string' && intent.desired.value.length >= 1 && promptPresence(intent.desired.value))
    : intent.desired.value === null) &&
  hasExactKeys(intent.owned, ['have', 'present', 'value']) &&
  typeof intent.owned.have === 'boolean' && typeof intent.owned.present === 'boolean' &&
  promptPresence(intent.owned.value);

export async function applyMacosGuiDomainKey(intent, controls = {}, environment) {
  const shape = intent => ({ key: typeof intent?.key === 'string' ? intent.key : '',
    label: typeof intent?.label === 'string' ? intent.label : '' });
  const result = (status, reason, before, after, verified, readback) => ({
    status, ...shape(intent), before: before ?? null, after: after ?? null, verified, readback, reason });
  if (!keyIntentValid(intent) || !validControls(controls)) return result('unavailable', 'intent-invalid', null, null, false, 'not-run');
  if (controls.signal?.aborted) return result('unavailable', 'cancelled', null, null, false, 'not-run');
  const host = hostEnvironment(environment);
  if (host.platform !== 'darwin') return result('unavailable', 'session-platform-unsupported', null, null, false, 'not-run');
  const current = await probeGuiKey(host, intent.key, controls);
  if (current.status === 'cancelled') return result('unavailable', 'cancelled', null, null, false, 'not-run');
  if (current.status !== 'present') return result('unavailable', current.reason, null, null, false, 'not-run');
  const before = { present: true, value: current.value };
  const ownedMatch = intent.owned.have && intent.owned.present && intent.owned.value === current.value;
  if (intent.desired.present) {
    if (current.value === intent.desired.value)
      return result('unchanged', 'already-owned-value', before, { ...before }, true, 'match');
    if (!ownedMatch) return result('conflict', 'foreign-value-preserved', before, null, false, 'not-run');
    const write = await fixedRun(host, LAUNCHCTL, ['setenv', intent.key, intent.desired.value], controls, 4096);
    if (write.status === 'cancelled') return result('unavailable', 'cancelled', before, null, false, 'not-run');
    if (write.status !== 'ok') return result('unavailable', 'setenv-unavailable', before, null, false, 'not-run');
    const readback = await probeGuiKey(host, intent.key, controls);
    if (readback.status === 'present' && readback.value === intent.desired.value)
      return result('applied', 'readback-verified', before, { present: true, value: readback.value }, true, 'match');
    if (readback.status === 'present')
      return result('applied', 'readback-mismatch', before, { present: true, value: readback.value }, false, 'mismatch');
    if (readback.status === 'cancelled') return result('unavailable', 'cancelled', before, null, false, 'not-run');
    return result('applied', readback.reason, before, null, false, 'ambiguous');
  }
  if (!ownedMatch) return result('conflict', 'foreign-value-preserved', before, null, false, 'not-run');
  const unset = await fixedRun(host, LAUNCHCTL, ['unsetenv', intent.key], controls, 4096);
  if (unset.status === 'cancelled') return result('unavailable', 'cancelled', before, null, false, 'not-run');
  if (unset.status !== 'ok') return result('unavailable', 'unsetenv-unavailable', before, null, false, 'not-run');
  const readback = await probeGuiKey(host, intent.key, controls);
  if (readback.status === 'present')
    return result('applied', 'readback-mismatch', before, { present: true, value: readback.value }, false, 'mismatch');
  if (readback.status === 'cancelled') return result('unavailable', 'cancelled', before, null, false, 'not-run');
  return result('applied', readback.reason, before, null, false, 'ambiguous');
}

/* ------------------------------------------------------- bootstrap / bootout / replay */

const REGISTRATION_KEYS = ['key', 'label', 'plistPath', 'uid'];
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only an exact `"<owned label>" => true` line counts; no wholesale environment is parsed.
const labelDisabled = (text, label) =>
  new RegExp(`^\\s*"${escapeRegExp(label)}"\\s*=>\\s*true\\s*$`, 'm').test(text);

const registrationRequest = request => {
  if (!hasExactKeys(request, REGISTRATION_KEYS)) return { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'registration-request-invalid' };
  if (typeof request.key !== 'string' || !macosSessionTrustKeys.includes(request.key))
    return { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'key-unsupported' };
  if (request.label !== sessionLabel(request.key))
    return { status: 'conflict', code: 'STATE_CONFLICT', reason: 'session-ownership-conflict' };
  if (!Number.isSafeInteger(request.uid) || request.uid <= 0 || !safeAbsolute(request.plistPath) ||
      request.plistPath.split('/').at(-1) !== `${request.label}.plist` ||
      !request.plistPath.includes('/Library/LaunchAgents/'))
    return { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'plist-path-unsafe' };
  return { status: 'ok' };
};

export async function macosSessionBootstrap(request, controls = {}, environment) {
  if (!validControls(controls)) return UNAVAILABLE('registration-controls-invalid');
  const valid = registrationRequest(request);
  if (valid.status !== 'ok') return valid;
  if (controls.signal?.aborted) return UNAVAILABLE('cancelled');
  const host = hostEnvironment(environment);
  if (host.platform !== 'darwin') return UNAVAILABLE('session-platform-unsupported');
  const domain = `gui/${request.uid}`;
  const disabled = await fixedRun(host, LAUNCHCTL, ['print-disabled', domain], controls);
  if (disabled.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (disabled.status !== 'ok') return UNAVAILABLE('session-disabled-state-unavailable');
  if (labelDisabled(disabled.stdout, request.label))
    return { status: 'disabled', code: 'PREREQUISITE_UNAVAILABLE', reason: 'session-persistence-disabled' };
  const bootstrap = await fixedRun(host, LAUNCHCTL, ['bootstrap', domain, request.plistPath], controls, 4096);
  if (bootstrap.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (bootstrap.status !== 'ok') return UNAVAILABLE('bootstrap-failed');
  return { status: 'registered', label: request.label, domain };
}

export async function macosSessionBootout(request, controls = {}, environment) {
  if (!validControls(controls)) return UNAVAILABLE('registration-controls-invalid');
  const valid = registrationRequest(request);
  if (valid.status !== 'ok') return valid;
  if (controls.signal?.aborted) return UNAVAILABLE('cancelled');
  const host = hostEnvironment(environment);
  if (host.platform !== 'darwin') return UNAVAILABLE('session-platform-unsupported');
  const domain = `gui/${request.uid}`;
  const bootout = await fixedRun(host, LAUNCHCTL, ['bootout', `${domain}/${request.label}`], controls, 4096);
  if (bootout.status === 'cancelled') return UNAVAILABLE('cancelled');
  if (bootout.status !== 'ok') return UNAVAILABLE('bootout-failed');
  return { status: 'removed', label: request.label, domain };
}

const asStringOrNull = value => (typeof value === 'string' && !CONTROL_RE.test(value) ? value : null);

/** Bounded protected recovery context: no timestamps, no raw environment, exact owned scope. */
export function createMacosSessionRecoveryContext(intent) {
  return {
    key: asStringOrNull(intent?.key) ?? '',
    label: asStringOrNull(intent?.label) ?? '',
    bindingSha256: HEX64.test(intent?.bindingSha256 ?? '') ? intent.bindingSha256 : '',
    sessionIdentitySha256: HEX64.test(intent?.sessionIdentitySha256 ?? '') ? intent.sessionIdentitySha256 : '',
    desired: { present: intent?.desired?.present === true, value: asStringOrNull(intent?.desired?.value) },
    owned: { have: intent?.owned?.have === true, present: intent?.owned?.present === true,
      value: asStringOrNull(intent?.owned?.value) },
    phaseMs: 60000, commandMs: 10000, commandBytes: 65536, cleanupMs: 15000,
    operations: Object.freeze(['read-domain-key', 'conditional-setenv-or-unsetenv', 'readback'])
  };
}

const REPLAY_KEYS = ['key', 'label', 'desired', 'owned', 'bindingSha256', 'sessionIdentitySha256',
  'uid', 'recordPath', 'helperSha256', 'phaseStartedAtMs'];

export async function runMacosSessionLoginReplay(intent, controls = {}, environment) {
  const fail = (status, reason) => ({ status, key: asStringOrNull(intent?.key) ?? '',
    label: asStringOrNull(intent?.label) ?? '', reason, before: null, after: null, verified: false,
    recovery: createMacosSessionRecoveryContext(intent) });
  if (!hasExactKeys(intent, REPLAY_KEYS) || !validControls(controls) ||
      !Number.isSafeInteger(intent.phaseStartedAtMs) || intent.phaseStartedAtMs < 0 ||
      !Number.isSafeInteger(intent.uid) || intent.uid <= 0 || !safeAbsolute(intent.recordPath) ||
      !underSessionRoot(intent.recordPath) || !HEX64.test(intent.helperSha256 ?? ''))
    return fail('unavailable', 'intent-invalid');
  if (controls.signal?.aborted) return fail('unavailable', 'cancelled');
  const host = hostEnvironment(environment);
  const session = await observeMacosGuiSession(controls, host);
  if (session.status !== 'observed') return fail('unavailable', session.reason);
  if (session.uid !== intent.uid) return fail('conflict', 'session-uid-changed');
  if (intent.sessionIdentitySha256 !== session.identitySha256) return fail('conflict', 'session-binding-changed');
  const now = typeof host.now === 'function' ? host.now() : Date.now();
  if (now - intent.phaseStartedAtMs > macosSessionBudgets.phaseMs)
    return fail('unavailable', 'session-budget-exceeded');
  const mutation = await applyMacosGuiDomainKey({ key: intent.key, label: intent.label, desired: intent.desired,
    owned: intent.owned, bindingSha256: intent.bindingSha256, sessionIdentitySha256: intent.sessionIdentitySha256 },
  controls, host);
  return { status: mutation.status, key: mutation.key, label: mutation.label, reason: mutation.reason,
    before: mutation.before, after: mutation.after, verified: mutation.verified,
    recovery: createMacosSessionRecoveryContext(intent) };
}

/* --------------------------------------------------------------- verification ------ */

/** Pure observational decision. It never launches an app and accepts no caller evidence. */
export function evaluateMacosSessionVerification(intent) {
  const binding = HEX64.test(intent?.bindingSha256 ?? '') ? intent.bindingSha256 : null;
  const verdict = (status, reason, launchContext, appTrust, profileId = null) =>
    ({ status, reason, launchContext, appTrust, profileId, bindingSha256: binding });
  if (!isPlainRecord(intent) || !Array.isArray(intent.profiles) || typeof intent.profileId !== 'string' ||
      !['finder', 'dock'].includes(intent.launch))
    return verdict('unavailable', binding === null ? 'session-binding-invalid' : 'app-session-unsupported',
      'launch-context-unobservable', 'app-trust-unobservable');
  if (binding === null)
    return verdict('unavailable', 'session-binding-invalid', 'launch-context-unobservable', 'app-trust-unobservable');
  if (intent.profiles.length === 0)
    return verdict('unavailable', 'app-session-unsupported', 'launch-context-unobservable', 'app-trust-unobservable');
  const profile = intent.profiles.find(item => isPlainRecord(item) && item.id === intent.profileId &&
    item.launch === intent.launch && item.clientId === intent.clientId);
  if (!profile)
    return verdict('unavailable', 'app-session-unsupported', 'launch-context-unobservable', 'app-trust-unobservable');
  if (intent.launchObservation?.available !== true)
    return verdict('unavailable', 'launch-context-unobservable', 'launch-context-unobservable',
      'app-trust-unobservable', profile.id);
  if (intent.launchObservation.context !== intent.launch)
    return verdict('incomplete', 'launch-context-mismatch', 'observed', 'app-trust-unobservable', profile.id);
  if (intent.network === 'off')
    return verdict('incomplete', 'network-off', 'observed', 'skipped', profile.id);
  if (intent.trustProbe?.available !== true)
    return verdict('incomplete', 'app-trust-unobservable', 'observed', 'app-trust-unobservable', profile.id);
  if (intent.trustProbe.outcome === 'failed')
    return verdict('failed', 'app-trust-failed', 'observed', 'failed', profile.id);
  if (intent.trustProbe.outcome !== 'passed')
    return verdict('incomplete', 'app-trust-unobservable', 'observed', 'app-trust-unobservable', profile.id);
  return verdict('passed', 'verified', 'observed', 'passed', profile.id);
}
