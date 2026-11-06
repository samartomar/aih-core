// Python interpreters for AI setups (D105, C46): find an installed one inside the step's range, and run Core's fixed
// helper with it to make a dedicated environment, install the hash-checked wheels offline and read the tool back.
// An installed interpreter is never byte-qualified: its version range and the tool's readback are the only checks.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment, resolveExecutable, stopTree, trackTree, treeSpawnOptions } from '../../internal/approved-process.js';
import { inRange } from './range.js';
import type { InstalledInterpreter } from './types.js';

/**
 * Core's fixed helper. It is always run as `python <helper> <command> …`, never with interpreter flags, and with no
 * `PYTHON*` variable of the host's: only `PYTHONNOUSERSITE`, `PYTHONSAFEPATH` and `PYTHONUTF8` as Core sets them, which
 * isolate it as `-I` would. Its own pip runs are isolated (`-I`).
 */
const HELPER = `import json, os, subprocess, sys
command = sys.argv[1]
if command == 'probe':
    print(json.dumps({'version': '%d.%d.%d' % tuple(sys.version_info[:3]), 'executable': sys.executable}))
elif command == 'venv':
    import venv
    venv.EnvBuilder(with_pip=True, symlinks=(os.name != 'nt')).create(sys.argv[2])
    print(json.dumps({'ok': True}))
elif command == 'install':
    result = subprocess.run([sys.executable, '-I', '-m', 'pip', 'install', '--isolated', '--no-index', '--no-deps', '--only-binary=:all:', '--no-cache-dir',
                             '--disable-pip-version-check', '--no-input', *sys.argv[2:]], stdout=sys.stderr)
    sys.exit(result.returncode)
elif command == 'compatible':
    from pip._vendor.packaging.tags import sys_tags
    from pip._vendor.packaging.utils import parse_wheel_filename
    supported = set(sys_tags())
    print(json.dumps({'compatible': [bool(set(parse_wheel_filename(os.path.basename(path))[3]) & supported) for path in sys.argv[2:]]}))
elif command == 'buildenv':
    import importlib.metadata, re
    normal = lambda name: re.sub(r'[-_.]+', '-', name).lower()
    pinned = {normal(os.path.basename(path).split('-')[0]) for path in sys.argv[2:]}
    extra = sorted({dist.metadata['Name'] for dist in importlib.metadata.distributions() if normal(dist.metadata['Name']) not in pinned | {'pip'}})
    if extra:
        result = subprocess.run([sys.executable, '-I', '-m', 'pip', 'uninstall', '--isolated', '-y', *extra], stdout=sys.stderr)
        if result.returncode:
            sys.exit(result.returncode)
    if len(sys.argv) > 2:
        result = subprocess.run([sys.executable, '-I', '-m', 'pip', 'install', '--isolated', '--no-index', '--no-deps', '--only-binary=:all:', '--no-cache-dir',
                                 '--disable-pip-version-check', '--no-input', *sys.argv[2:]], stdout=sys.stderr)
        sys.exit(result.returncode)
elif command == 'build':
    out = sys.argv[3]
    result = subprocess.run([sys.executable, '-I', '-m', 'pip', 'wheel', '--isolated', '--no-index', '--no-deps', '--no-build-isolation', '--no-cache-dir',
                             '--disable-pip-version-check', '--no-input', '--wheel-dir', out, sys.argv[2]], stdout=sys.stderr)
    if result.returncode:
        sys.exit(result.returncode)
    print(json.dumps({'wheels': sorted(os.listdir(out))}))
elif command == 'readback':
    import importlib.metadata
    dist = importlib.metadata.distribution(sys.argv[2])
    # With a script name: it must be one of that distribution's console (or GUI) scripts.
    if len(sys.argv) > 3 and sys.argv[3] not in {ep.name for ep in dist.entry_points if ep.group in ('console_scripts', 'gui_scripts')}:
        sys.exit(1)
    print(json.dumps({'version': dist.version}))
else:
    sys.exit(2)
`;
/** `log`: the end of the helper's standard error (pip's own output goes there), at most `LOG_TAIL_BYTES`, raw. */
export interface PythonResult { ok: boolean; output: unknown; reason: string; log?: string }
const LOG_TAIL_BYTES = 65_536;

/** Runs the helper with one interpreter; output is bounded, and a deadline or the caller's signal stops it. */
/**
 * The host variables a source build receives (C78): only what finds programs and describes the machine, the locale, and
 * Node's own options and certificates. Everything else, such as compiler and linker flags (`CL`, `INCLUDE`, `LIB`,
 * `RUSTFLAGS`, `CARGO_*`), package settings and proxies, never reaches a build; Core sets the rest itself.
 */
const BUILD_KEPT = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|OS|NUMBER_OF_PROCESSORS|PROCESSOR_(ARCHITECTURE|IDENTIFIER|LEVEL|REVISION)|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|PROGRAMDATA|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|LOCALAPPDATA|USERNAME|USERDOMAIN|COMPUTERNAME|USER|LOGNAME|SHELL|TERM|LANG|LANGUAGE|LC_[A-Z]+|TZ|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
/** What Core sets for every source build: offline package tools. */
const BUILD_SET = { PIP_NO_INDEX: '1', CARGO_NET_OFFLINE: 'true' };
export async function runHelper(executable: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number; cwd: string; env?: Record<string, string>; build?: boolean }): Promise<PythonResult> {
  const resolved = resolveExecutable(executable);
  if (!resolved) return { ok: false, output: null, reason: 'interpreter-unavailable' };
  const dir = mkdtempSync(join(tmpdir(), 'aih-python-'));
  const helper = join(dir, 'aih_acquire_helper.py');
  writeFileSync(helper, HELPER, { mode: 0o600 });
  const env: Record<string, string | undefined> = { ...process.env };
  // No host Python setting reaches the helper or pip (`-I`'s isolation, set by environment).
  for (const key of Object.keys(env)) if (/^PYTHON/i.test(key) || key.toUpperCase() === 'VIRTUAL_ENV') delete env[key];
  Object.assign(env, { PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1', PYTHONUTF8: '1', PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' });
  // pip's configuration, user site and index variables never reach an install or build (C78): only the files Core names.
  for (const key of Object.keys(env)) if (/^PIP_/i.test(key) && !['PIP_NO_INPUT', 'PIP_DISABLE_PIP_VERSION_CHECK'].includes(key)) delete env[key];
  env.PIP_CONFIG_FILE = devNull; env.PIP_NO_INDEX = '1';
  // A source build never takes the host's compiler, flags, package settings or proxies (C78): an allowlist.
  if (options.build) {
    for (const key of Object.keys(env)) if (!BUILD_KEPT.test(key) && !/^(PYTHON|PIP_)/i.test(key)) delete env[key];
    Object.assign(env, BUILD_SET);
  }
  Object.assign(env, options.env ?? {});
  try {
    return await new Promise<PythonResult>(resolve => {
      let child: ReturnType<typeof spawn>;
      const out: Buffer[] = []; let size = 0; let settled = false;
      let tail = Buffer.alloc(0);
      const done = (result: PythonResult) => { if (!settled) { settled = true; if (tail.length) result.log = tail.toString('utf8'); clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', stop); resolve(result); } };
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { if (!child) return; stopTree(child); force ??= setTimeout(() => stopTree(child, true), 2_000); force.unref?.(); };
      const timer = setTimeout(stop, options.timeoutMs); timer.unref?.();
      try { child = spawn(resolved.launchPath, [helper, ...args], { shell: false, windowsHide: true, cwd: options.cwd, env: childEnvironment(env),
        stdio: ['ignore', 'pipe', 'pipe'], ...treeSpawnOptions() }); }
      catch { done({ ok: false, output: null, reason: 'interpreter-unavailable' }); return; }
      trackTree(child);
      options.signal?.addEventListener('abort', stop, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1_048_576) stop(); else out.push(chunk); });
      child.stderr?.on('data', (chunk: Buffer) => {
        size += chunk.length; if (size > 16 * 1_048_576) stop();
        tail = Buffer.concat([tail, chunk]); if (tail.length > LOG_TAIL_BYTES) tail = tail.subarray(tail.length - LOG_TAIL_BYTES);
      });
      child.once('error', () => done({ ok: false, output: null, reason: 'interpreter-unavailable' }));
      child.once('close', code => {
        if (options.signal?.aborted) { done({ ok: false, output: null, reason: 'cancelled' }); return; }
        if (code !== 0) { done({ ok: false, output: null, reason: 'exit-code' }); return; }
        const text = Buffer.concat(out).toString('utf8').trim().split(/\r?\n/).at(-1) ?? '';
        try { done({ ok: true, output: text ? JSON.parse(text) : null, reason: 'exit-accepted' }); }
        catch { done({ ok: true, output: null, reason: 'exit-accepted' }); }
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The installed interpreter's version, read by running it. */
export async function probeInterpreter(path: string, signal?: AbortSignal): Promise<InstalledInterpreter | undefined> {
  const result = await runHelper(path, ['probe'], { ...(signal ? { signal } : {}), timeoutMs: 30_000, cwd: tmpdir() });
  const output = result.output as { version?: unknown } | null;
  if (!result.ok || !output || typeof output.version !== 'string') return undefined;
  return { path, version: output.version };
}
/** The file an interpreter path resolves to and its sha256 now: Apply runs only the one Prepare found. */
export function interpreterIdentity(path: string): { realpath: string; sha256: string } | undefined {
  const found = resolveExecutable(path);
  return found ? { realpath: found.path, sha256: found.sha256 } : undefined;
}
/** The first interpreter on PATH whose version is inside `range` (C46), or `null` when none is. */
export async function discoverInterpreter(range: string, signal?: AbortSignal): Promise<InstalledInterpreter | null> {
  const seen = new Set<string>();
  for (const name of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    const found = resolveExecutable(name);
    if (!found || seen.has(found.path)) continue;
    seen.add(found.path);
    const probed = await probeInterpreter(found.launchPath, signal);
    if (probed && inRange(probed.version, range)) return { ...probed, identity: { realpath: found.path, sha256: found.sha256 } };
  }
  return null;
}
/** The interpreter inside a dedicated environment. */
export const environmentPython = (environment: string): string =>
  process.platform === 'win32' ? join(environment, 'Scripts', 'python.exe') : join(environment, 'bin', 'python');
/** The interpreter inside an extracted python-build-standalone `install_only` archive. */
export const standalonePython = (root: string): string =>
  process.platform === 'win32' ? join(root, 'python', 'python.exe') : join(root, 'python', 'bin', 'python3');
