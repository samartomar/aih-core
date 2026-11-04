// Python interpreters for AI setups (D105, C46): find an installed one inside the step's range, and run Core's fixed
// helper with it to make a dedicated environment, install the hash-checked wheels offline and read the tool back.
// An installed interpreter is never byte-qualified: its version range and the tool's readback are the only checks.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '../../internal/approved-process.js';
import { inRange } from './range.js';
import type { InstalledInterpreter } from './types.js';

/** Core's fixed helper. It is always run as `python <helper> <command> …`, never with interpreter flags. */
const HELPER = `import json, os, subprocess, sys
command = sys.argv[1]
if command == 'probe':
    print(json.dumps({'version': '%d.%d.%d' % tuple(sys.version_info[:3]), 'executable': sys.executable}))
elif command == 'venv':
    import venv
    venv.EnvBuilder(with_pip=True, symlinks=(os.name != 'nt')).create(sys.argv[2])
    print(json.dumps({'ok': True}))
elif command == 'install':
    result = subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-index', '--no-deps', '--only-binary=:all:', '--no-cache-dir',
                             '--disable-pip-version-check', '--no-input', *sys.argv[2:]], stdout=sys.stderr)
    sys.exit(result.returncode)
elif command == 'readback':
    import importlib.metadata
    print(json.dumps({'version': importlib.metadata.version(sys.argv[2])}))
else:
    sys.exit(2)
`;
export interface PythonResult { ok: boolean; output: unknown; reason: string }

/** Runs the helper with one interpreter; output is bounded, and a deadline or the caller's signal stops it. */
export async function runHelper(executable: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number; cwd: string }): Promise<PythonResult> {
  const resolved = resolveExecutable(executable);
  if (!resolved) return { ok: false, output: null, reason: 'interpreter-unavailable' };
  const dir = mkdtempSync(join(tmpdir(), 'aih-python-'));
  const helper = join(dir, 'aih_acquire_helper.py');
  writeFileSync(helper, HELPER, { mode: 0o600 });
  const env: Record<string, string | undefined> = { ...process.env, PYTHONNOUSERSITE: '1', PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONUTF8: '1' };
  delete env.PYTHONPATH; delete env.PYTHONHOME; delete env.PYTHONSTARTUP; delete env.VIRTUAL_ENV;
  try {
    return await new Promise<PythonResult>(resolve => {
      let child: ReturnType<typeof spawn>;
      const out: Buffer[] = []; let size = 0; let settled = false;
      const done = (result: PythonResult) => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', stop); resolve(result); } };
      const stop = () => { try { child.kill(); } catch { /* close settles */ } };
      const timer = setTimeout(stop, options.timeoutMs); timer.unref?.();
      try { child = spawn(resolved.launchPath, [helper, ...args], { shell: false, windowsHide: true, cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { done({ ok: false, output: null, reason: 'interpreter-unavailable' }); return; }
      options.signal?.addEventListener('abort', stop, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1_048_576) stop(); else out.push(chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1_048_576) stop(); });
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
/** The first interpreter on PATH whose version is inside `range` (C46), or `null` when none is. */
export async function discoverInterpreter(range: string, signal?: AbortSignal): Promise<InstalledInterpreter | null> {
  const seen = new Set<string>();
  for (const name of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    const found = resolveExecutable(name);
    if (!found || seen.has(found.path)) continue;
    seen.add(found.path);
    const probed = await probeInterpreter(found.launchPath, signal);
    if (probed && inRange(probed.version, range)) return probed;
  }
  return null;
}
/** The interpreter inside a dedicated environment. */
export const environmentPython = (environment: string): string =>
  process.platform === 'win32' ? join(environment, 'Scripts', 'python.exe') : join(environment, 'bin', 'python');
/** The interpreter inside an extracted python-build-standalone `install_only` archive. */
export const standalonePython = (root: string): string =>
  process.platform === 'win32' ? join(root, 'python', 'python.exe') : join(root, 'python', 'bin', 'python3');
