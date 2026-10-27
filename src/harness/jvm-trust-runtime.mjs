import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';

const path = value => typeof value === 'string' && value.length <= 4096 &&
  isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value);
const plain = (value, keys) => value && typeof value === 'object' && !isProxy(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && keys.includes(key) && descriptor.enumerable && 'value' in descriptor;
  });

// JSSE's default file selection is jssecacerts before cacerts. This is only
// discovery for the explicitly queried java.home, never a manager trust claim.
function defaultStore(javaHome) {
  for (const name of ['jssecacerts', 'cacerts']) {
    const selected = join(javaHome, 'lib', 'security', name);
    let descriptor;
    try {
      const resolvedPath = realpathSync(selected);
      if (!lstatSync(resolvedPath).isFile()) return { state: 'unavailable', path: selected };
      descriptor = openSync(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.size < 1 || before.size > 4 * 1024 * 1024)
        return { state: 'unavailable', path: selected };
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!count) return { state: 'unavailable', path: selected };
        offset += count;
      }
      const after = fstatSync(descriptor);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        return { state: 'unavailable', path: selected };
      let format = 'unknown';
      if (bytes.length >= 12 && bytes.readUInt32BE(0) === 0xfeedfeed && bytes.readUInt32BE(4) === 2) format = 'jks-envelope';
      else if (bytes[0] === 0x30) {
        // Recognize the PFX version-3 envelope only. No password, MAC or safe-bag
        // parsing is implied; it cannot enter the existing CA-only JKS repair.
        const lengthBytes = bytes[1] & 0x80 ? bytes[1] & 0x7f : 0;
        const offset = 2 + lengthBytes;
        if (lengthBytes <= 4 && bytes.length > offset + 3 &&
            bytes[offset] === 2 && bytes[offset + 1] === 1 && bytes[offset + 2] === 3 && bytes[offset + 3] === 0x30)
          format = 'pkcs12-envelope';
      }
      return { state: 'observed', path: selected, resolvedPath, format,
        sha256: createHash('sha256').update(bytes).digest('hex'), admission: 'unverified' };
    } catch (error) {
      if (error.code !== 'ENOENT') return { state: 'unavailable', path: selected };
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  return { state: 'absent', admission: 'unverified' };
}

// POSIX discovery owns a process group, including launcher children. Windows
// remains refused until its launcher/observer/cleanup protocol is qualified.
function query(executable, args, project, deadline, signal) {
  if (signal?.aborted) return Promise.resolve({ reason: 'cancelled' });
  if (performance.now() >= deadline) return Promise.resolve({ reason: 'deadline' });
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: project, env: process.env, shell: false,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', size = 0, reason, finished = false, escalation, cleanup;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(cleanup);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const kill = signal => {
      try { if (child.pid) process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') reason = 'termination-unresolved'; }
    };
    const stop = value => {
      reason ??= value;
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 250);
      cleanup ??= setTimeout(() => { kill('SIGKILL'); finish({ reason: 'termination-unresolved' }); }, 2000);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('deadline'), Math.max(1, deadline - performance.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      size += bytes.length;
      if (size > 32768) { stop('output-limit'); return; }
      text += bytes.toString('utf8');
    });
    child.once('error', () => finish({ reason: 'executable-unavailable' }));
    child.once('close', code => {
      if (child.pid) {
        try { process.kill(-child.pid, 0); kill('SIGKILL'); return finish({ reason: 'descendant-cleanup' }); }
        catch (error) { if (error.code !== 'ESRCH') return finish({ reason: 'termination-unresolved' }); }
      }
      finish(reason ? { reason } : code === 0 ? { text } : { reason: 'version-query-failed' });
    });
  });
}

/** Bounded launcher discovery only. Version output never establishes effective TLS. */
export async function inspectJvmRuntime(request, controls = {}) {
  const observation = { tls: 'unconfirmed', toolchain: { state: 'unconfirmed' } };
  const result = (decision, reason) => ({ decision, reason, observation });
  if (!plain(request, ['target', 'javaExecutable', 'executable', 'project']) ||
      !['gradle', 'maven'].includes(request.target) ||
      !['javaExecutable', 'executable', 'project'].every(key => path(request[key])) ||
      !plain(controls, ['budgetMs', 'signal']) ||
      controls.signal !== undefined && !(controls.signal instanceof AbortSignal) ||
      controls.budgetMs !== undefined && (!Number.isInteger(controls.budgetMs) || controls.budgetMs < 1 || controls.budgetMs > 60000))
    return result('blocked', 'input-invalid');
  if (controls.signal?.aborted) return result('blocked', 'cancelled');
  if (process.platform === 'win32') return result('blocked', 'windows-observer-unqualified');
  if (process.platform === 'darwin' && process.arch === 'x64') return result('blocked', 'distribution-unqualified');
  try {
    if (!lstatSync(request.project).isDirectory()) return result('blocked', 'project-unavailable');
  } catch { return result('blocked', 'project-unavailable'); }
  // Do not run rc files or silently strip explicit selection/verification options.
  for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS'])
    if (process.env[key]) return result('blocked', 'explicit-jvm-options');
  if (request.target === 'maven' && process.env.MAVEN_SKIP_RC) return result('blocked', 'maven-rc-bypassed');
  const deadline = performance.now() + (controls.budgetMs ?? 10000);
  const java = await query(request.javaExecutable, ['-XshowSettings:properties', '-version'], request.project, deadline, controls.signal);
  if (java.reason) return result('blocked', java.reason);
  const property = name => {
    const values = [...java.text.matchAll(new RegExp(`^\\s+${name.replaceAll('.', '\\.')} = (.+)$`, 'gm'))];
    return values.length === 1 ? values[0][1].trim() : undefined;
  };
  const javaHome = property('java.home'), version = property('java.runtime.version'), arch = property('os.arch');
  if (!path(javaHome) || !version || !/^[0-9][0-9A-Za-z.+_-]{0,127}$/.test(version) || !['amd64', 'x86_64', 'aarch64'].includes(arch))
    return result('blocked', 'java-identity-unconfirmed');
  observation.launcher = { executable: request.javaExecutable, javaHome, version, arch, selection: 'explicit-java-only' };
  observation.store = { ...defaultStore(javaHome), scope: 'selected-java-default-only' };
  observation.manager = { executable: request.executable };
  const manager = await query('/bin/sh', [request.executable, '--version'], request.project, deadline, controls.signal);
  if (manager.reason) return result('blocked', manager.reason);
  if (request.target === 'gradle') {
    const versions = [...manager.text.matchAll(/^Gradle ([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$/gm)];
    const daemons = [...manager.text.matchAll(/^Daemon JVM:\s+(.+?)\s+\([^\r\n]*\)\s*$/gm)];
    if (versions.length !== 1) return result('blocked', 'manager-identity-unconfirmed');
    observation.manager.version = versions[0][1];
    const daemonHome = daemons.length === 1 ? daemons[0][1] : undefined;
    observation.daemon = path(daemonHome) ? { state: 'reported', javaHome: daemonHome } : { state: 'unconfirmed' };
    if (daemonHome && daemonHome !== javaHome) return result('blocked', 'daemon-jvm-differs');
  } else {
    const versions = [...manager.text.matchAll(/^Apache Maven ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/gm)];
    const runtimes = [...manager.text.matchAll(/^Java version: [^\r\n]*, runtime: ([^\r\n]+)$/gm)];
    if (versions.length !== 1) return result('blocked', 'manager-identity-unconfirmed');
    observation.manager.version = versions[0][1];
    const runtimeHome = runtimes.length === 1 ? runtimes[0][1].trim() : undefined;
    observation.manager.javaHome = path(runtimeHome) ? runtimeHome : null;
    if (runtimeHome && runtimeHome !== javaHome) return result('blocked', 'manager-jvm-differs');
  }
  return result('unconfirmed', 'effective-manager-trust-unobserved');
}
