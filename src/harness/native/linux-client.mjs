// Linux client resolution runs its version probe inside the same fixed denial profile as sessions.
import { closeSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClaudeCollector } from './collector.mjs';
import { resolveLinuxPlatform, windowsPolicyDirectoryFromMounts } from './linux-platform.mjs';
import { observeLinuxManagedPolicy } from './managed-policy.mjs';
import { verifyLinuxVendorClosure } from './linux-runtime.mjs';
import { linuxObserverPins, prepareLinuxSandboxContext } from './linux-sandbox.mjs';
import { parseClaudeVersionOutput } from './select.mjs';
import { publishNativeAdmission, publishNativePlatformDrift } from './admission.mjs';
import { sha256 } from './digest.mjs';

export function observeLinuxNativePolicy(execution) {
  let windowsDirectory;
  if (execution === 'wsl2') {
    try {
      const fd = openSync('/proc/mounts', 'r');
      try {
        const bytes = Buffer.alloc(1024 * 1024 + 1);
        let size = 0, read;
        while (size < bytes.length && (read = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += read;
        if (size <= 1024 * 1024) windowsDirectory = windowsPolicyDirectoryFromMounts(bytes.subarray(0, size).toString('utf8')) ?? undefined;
      } finally { closeSync(fd); }
    } catch { /* unknown host sources must remain unreadable */ }
  }
  return observeLinuxManagedPolicy({ execution, windowsDirectory, windowsSourceKnown: windowsDirectory !== undefined });
}

const defaultDependencies = Object.freeze({ observePolicy: observeLinuxNativePolicy, resolvePlatform: resolveLinuxPlatform });

export async function resolveLinuxNativeClient({ definition, input, client, cell, check }) {
  return resolveLinuxNativeClientWith(defaultDependencies, { definition, input, client, cell, check });
}

// Internal seam: tests substitute only managed-policy observation and platform resolution. Not re-exported by runtime.mjs.
export async function resolveLinuxNativeClientWith({ observePolicy, resolvePlatform }, { definition, input, client, cell, check }) {
  const fail = reason => ({ outcome: 'unavailable', reason });
  const managed = observePolicy(definition.platform.execution);
  if (managed.outcome === 'restricted') return { outcome: 'restricted', reason: 'managed-restriction' };
  if (managed.outcome !== 'file-sources-clear') return fail('restriction-unobservable');
  const platform = await resolvePlatform({ client, check }); check();
  if (platform.reason === 'platform-record-drift') publishNativePlatformDrift({ runSha256: sha256(cell.path), ...platform.drift });
  if (platform.status !== 'ready') return fail(platform.reason === 'restriction-unobservable' ? platform.reason : 'isolation-unobserved');
  const vendor = verifyLinuxVendorClosure({ check }); check();
  if (vendor.status !== 'ready') return fail(vendor.reason);
  let observer;
  try { observer = linuxObserverPins(); } catch { return fail('executable-changed'); }
  const pins = [...new Map([...platform.pins, ...vendor.pins, ...observer].map(pin => [pin.path, pin])).values()];
  const runtime = { ...platform.runtime, libraryClosure: platform.libraryClosure, ldLibraryPath: platform.ldLibraryPath };
  const collector = createClaudeCollector({ expected: { accountUuid: '', organizationId: '' } });
  const marker = join(cell.project, '.aih-native-version');
  let context, handle, startedAt, cleanup;
  let output = '', bytes = 0, stopped, timer, abort, watchdog, tracking;
  const terminate = () => cleanup ??= (async () => {
    startedAt ??= performance.now();
    const allowance = Math.max(0, 10000 - (performance.now() - startedAt));
    const closed = collector.cancel();
    const receipt = context ? await context.terminate({ graceMs: 1000, deadlineMs: allowance }) : { processes: 'confirmed', survivors: [] };
    await closed;
    if (context) publishNativeAdmission({ phase: 'version', definition: definition.id, runSha256: sha256(cell.path),
      vendorTreeSha256: vendor.treeSha256, innerArgv: [client.path, ...definition.versionArgv], outerArgv: handle?.argv,
      isolation: context.isolationRecord(), cleanupConfirmed: receipt.processes === 'confirmed' });
    return { confirmed: receipt.processes === 'confirmed', survivors: receipt.survivors };
  })();
  const failed = async reason => ({ ...fail(reason), cleanup: await terminate(), cleanupStartedAt: startedAt, probeBytes: bytes });
  try {
    writeFileSync(marker, 'fixed-version-probe', { flag: 'wx', mode: 0o600 });
    const telemetry = await collector.start(); check();
    const prepared = await prepareLinuxSandboxContext({ cell, runtime, vendor, phase: 'preflight', collector: telemetry, execution: definition.platform.execution,
      deadline: input.deadline, signal: input.signal, runtimePins: pins, selectedEntries: [], selectedPaths: [marker], expectedArgv: definition.versionArgv });
    if (prepared.status !== 'ready') { const failure = await failed('isolation-unobserved'); return prepared.cleanup?.confirmed === false ? { ...failure, cleanup: prepared.cleanup } : failure; }
    context = prepared.context;
    const pipe = await context.createPipe();
    if (pipe.status !== 'ready') return failed('server-evidence-unavailable');
    check();
    const started = await context.start({ file: client.path, argv: definition.versionArgv, cwd: cell.project, env: {
      PATH: [dirname(runtime.node), dirname(runtime.client)].join(':'), HOME: cell.home, USERPROFILE: cell.home,
      XDG_CONFIG_HOME: cell.home, XDG_DATA_HOME: cell.home, XDG_CACHE_HOME: cell.scratch, XDG_STATE_HOME: cell.scratch,
      CLAUDE_CONFIG_DIR: join(cell.home, '.claude'), TEMP: join(cell.scratch, 'tmp'), TMP: join(cell.scratch, 'tmp'), TMPDIR: join(cell.scratch, 'tmp'),
      DISABLE_AUTOUPDATER: '1', LANG: 'C', LC_ALL: 'C'
    } });
    if (started.status !== 'started') return failed('session-launch-failed');
    handle = started.handle;
    let resolveStopped;
    const stopPromise = new Promise(resolve => { resolveStopped = resolve; });
    const stop = reason => { stopped ??= reason; void terminate().then(resolveStopped, resolveStopped); };
    handle.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 4096) output += chunk.toString(); else stop('limit-exceeded'); });
    handle.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) stop('limit-exceeded'); });
    abort = () => stop('cancelled'); input.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('budget-exhausted'), Math.max(1, input.deadline - performance.now()));
    if (input.signal?.aborted) abort();
    watchdog = setInterval(() => {
      if (!tracking) tracking = handle.track().catch(() => stop('isolation-unobserved')).finally(() => { tracking = undefined; });
    }, 50);
    handle.stdin.end();
    const exit = await Promise.race([handle.exited, stopPromise]);
    const receipt = await terminate();
    const proof = context.versionProbeReady();
    if (!receipt.confirmed) return { ...fail('termination-unresolved'), cleanup: receipt, cleanupStartedAt: startedAt, probeBytes: bytes };
    if (stopped) return failed(stopped);
    if (!proof) return failed(context.failureReason ?? 'isolation-unobserved');
    const version = exit?.code === 0 ? parseClaudeVersionOutput(output) : null;
    if (!version) return failed('version-unreadable');
    return { status: 'resolved', platform, vendor, runtime, pin: {
      executable: client.path, sha256: client.sha256, observedVersion: version,
      argv: [client.path, ...definition.sessionArgv], runtime: pins.filter(pin => pin.path !== client.path), probeCreated: true, probeBytes: bytes
    } };
  } catch { return failed(input.signal?.aborted ? 'cancelled' : performance.now() >= input.deadline ? 'budget-exhausted' : 'isolation-unobserved'); }
  finally {
    clearTimeout(timer); clearInterval(watchdog); if (abort) input.signal?.removeEventListener('abort', abort);
    await terminate();
    try { unlinkSync(marker); } catch { /* owned-cell cleanup handles an interrupted staging attempt */ }
  }
}
