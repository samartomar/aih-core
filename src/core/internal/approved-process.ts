import { spawn, type ChildProcess } from 'node:child_process';
import { system32 } from './system-root.js';
import { accessSync, constants, existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { sha256 } from './host-files.js';
import { readRegularFileWithStats } from './fsxn.js';
import type { PathPin } from './host-files.js';

/**
 * A pinned program. `launcher` is set for an npm command shim (`claude.cmd`): Core then starts the pinned `node` with the
 * shim's pinned JS entry directly, never the shim through `cmd.exe`, which would look `node` up by name.
 */
export interface ResolvedExecutable { path: string; launchPath: string; pins: PathPin[]; sha256: string; launcher?: ShimLauncher }
export interface ShimLauncher {
  node: { path: string; launchPath: string; pins: PathPin[]; sha256: string };
  script: { path: string; pins: PathPin[]; sha256: string };
}
export interface ProcessResult {
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled'; reason: string;
  exitCode?: number; effectsUncertain: boolean; terminationUnconfirmed: boolean;
  /** Standard output, only when the request asked to `capture` it (a read-only readback); bounded by `maxOutputBytes`. */
  stdout?: Buffer;
}
const WINDOWS_SUFFIX = process.platform === 'win32' ? ['.exe', '.com'] : [''];
/**
 * The environment every child Core starts receives: the host's, the request's, and
 * `NoDefaultCurrentDirectoryInExePath=1`, so on Windows a program found by bare name is never one in the working folder.
 */
export function childEnvironment(base: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, ...extra };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[key];
  env.NoDefaultCurrentDirectoryInExePath = '1';
  return env;
}
/** Spawn options that let `stopTree` reach every process a child starts: its own process group on POSIX. */
export const treeSpawnOptions = (): { detached?: true } => process.platform === 'win32' ? {} : { detached: true };

/**
 * The process groups of Core's live POSIX children. While any runs, a SIGINT, SIGTERM or SIGHUP Core receives is passed
 * on to every group (a terminal's Ctrl-C reaches only Core's own group), and Core's exit kills every group. When Core has
 * no other handler for the signal, it then ends on it as it would have without these handlers.
 */
const groups = new Set<number>();
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const forward = (signal: NodeJS.Signals) => {
  for (const group of groups) try { process.kill(-group, signal); } catch { /* already gone */ }
  if (process.listenerCount(signal) === 1) {
    unwatch();
    process.kill(process.pid, signal);
  }
};
const handlers = new Map(FORWARDED.map(signal => [signal, () => forward(signal)]));
const killAll = () => { for (const group of groups) try { process.kill(-group, 'SIGKILL'); } catch { /* already gone */ } };
let watching = false;
function watch(): void {
  if (watching) return;
  watching = true;
  for (const [signal, handler] of handlers) process.on(signal, handler);
  process.on('exit', killAll);
}
function unwatch(): void {
  if (!watching) return;
  watching = false;
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  process.removeListener('exit', killAll);
}
/** Tracks a POSIX child's process group until it closes; see `groups`. */
export function trackTree(child: ChildProcess): void {
  if (process.platform === 'win32' || child.pid === undefined) return;
  const group = child.pid;
  groups.add(group); watch();
  child.once('close', () => { groups.delete(group); if (!groups.size) unwatch(); });
}
/**
 * Stops a child and everything it started: `taskkill /T /F` on Windows (by absolute path under the kernel's
 * `\SystemRoot`); on POSIX the child's process group (`SIGTERM`, then `SIGKILL` with `force`). The child itself is killed too.
 */
export function stopTree(child: ChildProcess, force = false): void {
  const direct = () => { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Close or the cleanup deadline determines uncertainty. */ } };
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) { direct(); return; }
  if (process.platform === 'win32') {
    // The tree is found from the live child, so the child itself is killed only once taskkill is done.
    let killer: ChildProcess;
    try { killer = spawn(system32('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch { direct(); return; }
    const timer = setTimeout(direct, 1_500); timer.unref?.();
    const done = () => { clearTimeout(timer); direct(); };
    killer.once('error', done); killer.once('close', done);
    return;
  }
  try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* not a group leader, or already gone */ }
  direct();
}

// Read-only executable admission has different link rules from mutation targets.
// Pin the selected path and its resolved regular file; never reuse
// these pins to authorize a file write.
function executablePathPins(path: string): PathPin[] {
  const absolute = resolve(path), base = parse(absolute).root;
  let current = base;
  return ['', ...relative(base, absolute).split(/[\\/]/).filter(Boolean)].map(segment => {
    if (segment) current = join(current, segment);
    const stats = lstatSync(current, { bigint: true });
    if (stats.ino === 0n || !stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink())
      throw new Error('executable-path');
    const link = stats.isSymbolicLink() ? Buffer.from(readlinkSync(current)).toString('hex') : '';
    return { path: current, identity: `executable:${stats.dev}:${stats.ino}:${stats.mode}:${stats.isFile() ? stats.nlink : 0n}:${link}` };
  });
}

export function executablePinsMatch(pins: PathPin[]): boolean {
  return pins.length > 0 && pins.every(pin => {
    try {
      const current = executablePathPins(pin.path).at(-1);
      return current?.path === pin.path && current.identity === pin.identity;
    } catch { return false; }
  });
}

/** Re-resolve the launcher too: lexical pins cannot cover intermediate link targets. */
export function executableIdentityMatches(executable: Pick<ResolvedExecutable, 'path' | 'launchPath' | 'pins'>): boolean {
  try {
    return executablePinsMatch(executable.pins) && realpathSync.native(executable.launchPath) === executable.path;
  } catch { return false; }
}

export function resolveExecutable(name: string): ResolvedExecutable | undefined {
  if (!name || /[\r\n\0]/.test(name)) return undefined;
  const candidates: string[] = [];
  if (isAbsolute(name)) candidates.push(name);
  else if (!/[\\/]/.test(name) && name !== '.' && name !== '..') {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      for (const suffix of WINDOWS_SUFFIX) candidates.push(join(dir, process.platform === 'win32' && !/\.(exe|com)$/i.test(name) ? name + suffix : name));
    }
  }
  for (const path of candidates) {
    if (process.platform === 'win32' && !/\.(exe|com)$/i.test(path)) continue;
    try {
      accessSync(path, constants.X_OK);
      const resolved = realpathSync.native(path);
      const pins = [...executablePathPins(path), ...executablePathPins(resolved)];
      const captured = readRegularFileWithStats(resolved, { maxBytes: 512 * 1024 * 1024 });
      const current = lstatSync(resolved, { bigint: true });
      if (captured && current.isFile() && captured.identity.dev === current.dev && captured.identity.ino === current.ino &&
          realpathSync.native(path) === resolved && executablePinsMatch(pins))
        return { path: resolved, launchPath: resolve(path), pins, sha256: sha256(captured.contents) };
    } catch { /* Try the next explicit PATH candidate. */ }
  }
  return undefined;
}

/** Capture an installed launcher for a fixed helper; this does not admit direct execution. */
export function resolveLauncher(name: string): ResolvedExecutable | undefined {
  if (!name || /[\r\n\0]/.test(name)) return undefined;
  const suffixes = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  const candidates: string[] = [];
  if (isAbsolute(name)) candidates.push(name);
  else if (!/[\\/]/.test(name) && name !== '.' && name !== '..') {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      for (const suffix of suffixes) candidates.push(join(dir,
        process.platform === 'win32' && !/\.(exe|com|cmd|bat)$/i.test(name) ? name + suffix : name));
    }
  }
  for (const path of candidates) {
    if (process.platform === 'win32' && !/\.(exe|com|cmd|bat)$/i.test(path)) continue;
    try {
      accessSync(path, constants.R_OK);
      const resolved = realpathSync.native(path);
      const pins = [...executablePathPins(path), ...executablePathPins(resolved)];
      const captured = readRegularFileWithStats(resolved, { maxBytes: 16 * 1024 * 1024 });
      const current = lstatSync(resolved, { bigint: true });
      if (captured && current.isFile() && captured.identity.dev === current.dev && captured.identity.ino === current.ino &&
          realpathSync.native(path) === resolved && executablePinsMatch(pins)) {
        const launcher = isCommandShim(path) ? npmShimLauncher(resolve(path), captured.contents) : undefined;
        return { path: resolved, launchPath: resolve(path), pins, sha256: sha256(captured.contents), ...(launcher ? { launcher } : {}) };
      }
    } catch { /* Try the next declared PATH candidate. */ }
  }
  return undefined;
}

/** A Windows `.cmd`/`.bat` command shim: run by the system command processor, never directly. */
const isCommandShim = (path: string): boolean => process.platform === 'win32' && /\.(cmd|bat)$/i.test(path);

/** npm's shim names its JS entry relative to its own folder (`"%dp0%\…\cli.js" %*`, older `"%~dp0\…\cli.js" %*`). */
const NPM_ENTRY = /"%(?:~dp0|dp0%)\\?([^"%*<>|\r\n]+?\.(?:js|cjs|mjs))"\s+%\*/i;
/**
 * The pinned `node` and JS entry an npm command shim starts: `node.exe` beside the shim when there (npm's own choice),
 * else the `node` found on PATH (absolute folders only, never the working folder). `undefined` when the shim is not
 * npm's form or either can't be pinned; such a shim still runs through `cmd.exe`.
 */
function npmShimLauncher(shim: string, bytes: Buffer): ShimLauncher | undefined {
  if (bytes.length > 64 * 1024) return undefined;
  const text = bytes.toString('utf8');
  const found = NPM_ENTRY.exec(text);
  if (!found || !/_prog=node"/i.test(text.replace(/\s+/g, ''))) return undefined;
  const relativeEntry = found[1]!.replace(/^[\\/]+/, '');
  if (relativeEntry.split(/[\\/]/).some(part => part === '..' || part === '' || part === '.')) return undefined;
  try {
    const entry = join(dirname(shim), relativeEntry);
    const real = realpathSync.native(entry);
    const scriptPins = [...executablePathPins(entry), ...executablePathPins(real)];
    const script = readRegularFileWithStats(real, { maxBytes: 256 * 1024 * 1024 });
    if (!script || !executablePinsMatch(scriptPins)) return undefined;
    const beside = join(dirname(shim), 'node.exe');
    const node = resolveExecutable(existsSync(beside) ? beside : 'node');
    if (!node) return undefined;
    return { node: { path: node.path, launchPath: node.launchPath, pins: node.pins, sha256: node.sha256 },
      script: { path: real, pins: scriptPins, sha256: sha256(script.contents) } };
  } catch { return undefined; }
}
/** Whether a shim's node and JS entry are still the pinned files. */
function launcherMatches(launcher: ShimLauncher): boolean {
  try {
    if (!executableIdentityMatches(launcher.node) || !executablePinsMatch(launcher.script.pins) ||
        realpathSync.native(launcher.script.path) !== launcher.script.path) return false;
    const node = readRegularFileWithStats(launcher.node.path, { maxBytes: 512 * 1024 * 1024 });
    const script = readRegularFileWithStats(launcher.script.path, { maxBytes: 256 * 1024 * 1024 });
    return !!node && !!script && sha256(node.contents) === launcher.node.sha256 && sha256(script.contents) === launcher.script.sha256 &&
      executableIdentityMatches(launcher.node) && executablePinsMatch(launcher.script.pins);
  } catch { return false; }
}

/**
 * A program a plan runs (a client's plugin commands, an upstream installer, a tool command): an executable, or on
 * Windows also the `.cmd`/`.bat` command shim a package manager installs a CLI as (npm's `claude.cmd`). The shim is
 * captured and pinned by its exact path and sha256 like any other program (`resolveLauncher`). On Windows each PATH
 * folder is searched in the system's order (`.exe`, `.com`, `.cmd`, `.bat`), so the program that runs is the one found.
 */
export function resolveProgram(name: string): ResolvedExecutable | undefined {
  if (process.platform !== 'win32') return resolveExecutable(name);
  if (!name || /[\r\n\0]/.test(name)) return undefined;
  const found = (path: string) => /\.(exe|com)$/i.test(path) ? resolveExecutable(path) : /\.(cmd|bat)$/i.test(path) ? resolveLauncher(path) : undefined;
  if (isAbsolute(name)) return found(name);
  if (/[\\/]/.test(name) || name === '.' || name === '..') return undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const suffix of /\.(exe|com|cmd|bat)$/i.test(name) ? [''] : ['.exe', '.com', '.cmd', '.bat']) {
      const program = found(join(dir, name + suffix));
      if (program) return program;
    }
  }
  return undefined;
}

/**
 * The command line that runs a command shim through `cmd.exe /d /s /c`, every argument quoted. Text the command
 * processor would still read inside quotes (`"`, `%`, line breaks) is refused (`undefined`): Core never runs a command
 * other than the one reviewed. Backslashes before a closing quote are doubled, so the program reads each argument back.
 */
function shimCommandLine(path: string, args: string[]): string | undefined {
  const quoted = (value: string) => /["%\r\n\0]/.test(value) ? undefined : `"${value.replace(/(\\+)$/, '$1$1')}"`;
  const parts = [path, ...args].map(quoted);
  return parts.every(part => part !== undefined) ? `"${parts.join(' ')}"` : undefined;
}

/** Whether `args` can be run with `executable`: always, unless it is a command shim that could not pass them back. */
export function argumentsRunnable(executable: Pick<ResolvedExecutable, 'launchPath' | 'launcher'>, args: string[]): boolean {
  return !!executable.launcher || !isCommandShim(executable.launchPath) || shimCommandLine(executable.launchPath, args) !== undefined;
}

export async function runApprovedProcess(request: {
  executable: ResolvedExecutable; args: string[]; cwd: string; env: Record<string, string>;
  stdin?: string; timeoutMs: number; maxOutputBytes: number; acceptedExitCodes: number[];
  signal?: AbortSignal; capture?: boolean;
  /** Prefixes of inherited host variables the child never receives (the request's own `env` still does). */
  clearInherited?: string[];
}): Promise<ProcessResult> {
  if (request.signal?.aborted) return { status: 'cancelled', reason: 'cancelled', effectsUncertain: false, terminationUnconfirmed: false };
  const live = executableIdentityMatches(request.executable) ?
    readRegularFileWithStats(request.executable.path, { maxBytes: 512 * 1024 * 1024 }) : undefined;
  if (!live || sha256(live.contents) !== request.executable.sha256 || !executableIdentityMatches(request.executable))
    return { status: 'unavailable', reason: 'executable-changed', effectsUncertain: false, terminationUnconfirmed: false };
  const launcher = request.executable.launcher;
  if (launcher && !launcherMatches(launcher))
    return { status: 'unavailable', reason: 'executable-changed', effectsUncertain: false, terminationUnconfirmed: false };
  const shim = !launcher && isCommandShim(request.executable.launchPath);
  const line = shim ? shimCommandLine(request.executable.launchPath, request.args) : undefined;
  if (shim && line === undefined) return { status: 'unavailable', reason: 'shim-argument-unsafe', effectsUncertain: false, terminationUnconfirmed: false };
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    let byteCount = 0; let settled = false; const captured: Buffer[] = []; let closing = false; let forcedReason: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: ProcessResult['status'], reason: string, exitCode?: number, uncertain = false, unconfirmed = false) => {
      if (settled) return;
      settled = true; if (timeout) clearTimeout(timeout); if (cleanup) clearTimeout(cleanup);
      request.signal?.removeEventListener('abort', abort);
      resolve({ status, reason, ...(exitCode === undefined ? {} : { exitCode }), effectsUncertain: uncertain, terminationUnconfirmed: unconfirmed,
        ...(request.capture ? { stdout: Buffer.concat(captured) } : {}) });
    };
    const stop = (reason: string) => {
      if (closing || settled) return;
      closing = true; forcedReason = reason;
      stopTree(child);
      cleanup = setTimeout(() => { stopTree(child, true); finish(reason === 'cancelled' ? 'cancelled' : 'failed', reason, undefined, true, true); }, 2_000);
      cleanup.unref?.();
    };
    const abort = () => stop('cancelled');
    try {
      // Dispatchers such as rustup select the tool by the original launcher name.
      // The launcher still resolves to the reviewed, byte-pinned executable.
      // A command shim runs through the system's command processor with the pinned shim and its quoted arguments.
      // An npm shim's pinned node runs its pinned JS entry directly, with no command processor.
      const inherited = request.clearInherited?.length ? Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !request.clearInherited!.some(prefix => key.toUpperCase().startsWith(prefix.toUpperCase())))) : process.env;
      const env = childEnvironment(inherited, request.env);
      child = launcher ? spawn(launcher.node.launchPath, [launcher.script.path, ...request.args], { shell: false, windowsHide: true,
        cwd: request.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...treeSpawnOptions() }) :
        shim ? spawn(system32('cmd.exe'), ['/d', '/v:off', '/s', '/c', line!], { shell: false,
        windowsHide: true, windowsVerbatimArguments: true, cwd: request.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) :
        spawn(request.executable.launchPath, request.args, { shell: false, windowsHide: true, cwd: request.cwd,
          env, stdio: ['pipe', 'pipe', 'pipe'], ...treeSpawnOptions() });
    } catch { finish('unavailable', 'spawn-failed'); return; }
    trackTree(child);
    const observe = (chunk: Buffer) => { byteCount += chunk.byteLength; if (byteCount > request.maxOutputBytes) stop('output-bytes'); };
    child.stdout?.on('data', (chunk: Buffer) => { if (request.capture) captured.push(chunk); observe(chunk); });
    child.stderr?.on('data', observe);
    child.once('error', () => finish('unavailable', 'spawn-failed', undefined, false));
    child.once('close', code => {
      if (request.signal?.aborted) { finish('cancelled', 'cancelled', code ?? undefined, true); return; }
      if (forcedReason) { finish('failed', forcedReason, code ?? undefined, true); return; }
      const accepted = code !== null && request.acceptedExitCodes.includes(code);
      finish(accepted ? 'passed' : 'failed', accepted ? 'exit-accepted' : 'exit-code', code ?? undefined, !accepted);
    });
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    timeout = setTimeout(() => stop('deadline'), request.timeoutMs);
    timeout.unref?.();
    child.stdin?.on('error', () => stop('stdin-failed'));
    try { child.stdin?.end(request.stdin); } catch { stop('stdin-failed'); }
  });
}
