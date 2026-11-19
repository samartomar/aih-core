// A prompt-free, bounded Claude control-protocol readback. This is not verifyClient qualification.
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { parseStrictJson, isRecord } from './native/canonical.mjs';
import { observeClaudeManagedSettings } from './native/claude.mjs';
import { pinExecutable, revalidateExecutable, startLifecycle } from './native/lifecycle.mjs';

const BUDGET_MS = 20_000, OUTPUT_BYTES = 1_048_576, CLEANUP_MS = 5_000;
const ARGV = Object.freeze(['--print', '--verbose', '--input-format', 'stream-json', '--output-format',
  'stream-json', '--no-session-persistence', '--bare', '--setting-sources', 'project',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}']);
const INPUT = ['init', 'plugins'].map((request_id, index) => JSON.stringify({ type: 'control_request',
  request_id, request: { subtype: index === 0 ? 'initialize' : 'reload_plugins' } })).join('\n') + '\n';
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
const inside = (root, path) => { const value = relative(root, path); return value === '' || value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); };
const key = path => process.platform === 'win32' ? path.toLowerCase() : path;

function directDirectory(path) {
  const normalized = resolve(path), root = parse(normalized).root, parts = normalized.slice(root.length).split(sep).filter(Boolean);
  if (parts.length > 64) throw Error('input-invalid');
  let current = root;
  for (const part of ['', ...parts]) {
    current = part ? join(current, part) : current;
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('path-unsafe');
  }
  if (key(realpathSync.native(normalized)) !== key(normalized)) throw Error('path-unsafe');
  return normalized;
}

function requestPaths(request, personalHome) {
  if (!request || typeof request !== 'object' || isProxy(request) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(request)) ||
      Reflect.ownKeys(request).length !== 2 || !['project', 'home'].every(name => {
        const field = Object.getOwnPropertyDescriptor(request, name);
        return field?.enumerable && 'value' in field && text(field.value) && isAbsolute(field.value);
      })) throw Error('input-invalid');
  const project = directDirectory(request.project), home = directDirectory(request.home);
  if (key(home) === key(resolve(personalHome)) || inside(project, home) || inside(home, project)) throw Error('home-not-isolated');
  const config = join(home, '.claude');
  for (const name of ['.credentials.json', 'credentials.json']) {
    try { lstatSync(join(config, name)); throw Error('home-has-credentials'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = join(home, '.aih-claude-plugin-observation', 'tmp');
  return { project, home, config, temporary };
}
function ensureDirectory(root, parts) {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try { mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    directDirectory(current);
  }
}

// Internal test seam: the public export never accepts PATH, executable, argv or a launcher override.
export function claudePluginLookupPath(pathEnv, project, home) {
  return String(pathEnv ?? '').split(delimiter).filter(directory => {
    if (!text(directory) || !isAbsolute(directory)) return false;
    try {
      const real = realpathSync.native(directory);
      return !inside(project, real) && !inside(home, real);
    } catch { return false; }
  }).join(delimiter);
}

export function parseClaudePluginReadback(bytes) {
  const fail = reason => ({ status: 'unconfirmed', plugins: [], reason });
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > OUTPUT_BYTES) return fail('output-limit');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('response-invalid'); }
  const responses = new Map();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let value;
    try { value = parseStrictJson(line, 32); } catch { return fail('response-invalid'); }
    if (!isRecord(value)) return fail('response-invalid');
    if (value.type === 'system') continue;
    if (value.type !== 'control_response' || !isRecord(value.response)) return fail('response-unexpected');
    const response = value.response;
    if (!['init', 'plugins'].includes(response.request_id) || responses.has(response.request_id) ||
        response.subtype !== 'success' || !isRecord(response.response)) return fail('response-invalid');
    responses.set(response.request_id, response.response);
  }
  if (!responses.has('init') || !responses.has('plugins')) return fail('response-incomplete');
  const observed = responses.get('plugins');
  if (!Number.isSafeInteger(observed.error_count) || observed.error_count < 0) return fail('response-invalid');
  if (observed.error_count !== 0) return fail('plugin-errors');
  if (!Array.isArray(observed.mcpServers) || observed.mcpServers.length) return fail('mcp-not-contained');
  if (!Array.isArray(observed.plugins) || observed.plugins.length > 256) return fail('response-invalid');
  const plugins = [], seen = new Set();
  for (const plugin of observed.plugins) {
    if (!isRecord(plugin) || !text(plugin.name, 256) || !text(plugin.source, 512) || !text(plugin.path) ||
        plugin.version !== undefined && !text(plugin.version, 128)) return fail('response-invalid');
    const builtin = plugin.path === 'builtin' && plugin.source.endsWith('@builtin');
    if (!builtin && (!isAbsolute(plugin.path) && !win32.isAbsolute(plugin.path) || plugin.source.endsWith('@builtin') || plugin.path === 'builtin'))
      return fail('response-invalid');
    const identity = JSON.stringify([plugin.name, plugin.source, plugin.path]);
    if (seen.has(identity)) return fail('response-invalid');
    seen.add(identity);
    plugins.push({ name: plugin.name, source: plugin.source, path: plugin.path, builtin,
      ...(plugin.version === undefined ? {} : { version: plugin.version }) });
  }
  return { status: 'observed', plugins };
}

function environment(paths, executable) {
  const env = {};
  for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ'])
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  return { ...env, PATH: dirname(executable), HOME: paths.home, USERPROFILE: paths.home,
    APPDATA: join(paths.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(paths.home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(paths.home, '.config'), XDG_DATA_HOME: join(paths.home, '.local', 'share'),
    XDG_CACHE_HOME: join(paths.home, '.cache'), XDG_STATE_HOME: join(paths.home, '.local', 'state'),
    CLAUDE_CONFIG_DIR: paths.config, TEMP: paths.temporary, TMP: paths.temporary, TMPDIR: paths.temporary,
    NoDefaultCurrentDirectoryInExePath: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}

const host = {
  platform: process.platform, personalHome: () => userInfo().homedir,
  managed: () => observeClaudeManagedSettings(),
  pin: paths => pinExecutable({ names: ['claude.exe'], platform: process.platform,
    pathEnv: claudePluginLookupPath(process.env.PATH, paths.project, paths.home) }),
  revalidate: revalidateExecutable,
  start: input => startLifecycle({ lifecycleId: 'windows-job.v1', os: process.platform, ...input })
};

/** Internal dependency seam for deterministic process/protocol tests. */
export async function observeClaudePluginsWith(request, selectedHost) {
  const deadline = performance.now() + BUDGET_MS;
  const result = value => ({ ...value, checkedAt: new Date().toISOString(),
    scope: 'plugin-control-readback', hooks: 'disabled', mcp: 'disabled', modelTurnRequested: false });
  const fail = reason => result({ status: 'unconfirmed', plugins: [], reason });
  let paths, pin, started;
  try {
    paths = requestPaths(request, selectedHost.personalHome());
    if (selectedHost.platform !== 'win32') return fail('platform-unsupported');
    if (selectedHost.managed().outcome !== 'file-sources-clear') return fail('managed-settings-unconfirmed');
    pin = await selectedHost.pin(paths);
    if (pin.status !== 'pinned') return fail('client-unavailable');
    if (inside(paths.project, pin.path) || inside(paths.home, pin.path)) return fail('executable-unsafe');
    if (!(await selectedHost.revalidate(pin)).ok) return fail('executable-changed');
    if (performance.now() >= deadline) return fail('deadline');
    ensureDirectory(paths.home, ['.claude']);
    ensureDirectory(paths.home, ['.aih-claude-plugin-observation', 'tmp']);
    started = await selectedHost.start({ file: pin.path, argv: [...ARGV], cwd: paths.project,
      env: environment(paths, pin.path), deadline });
  } catch (error) {
    return fail(['input-invalid', 'home-not-isolated', 'home-has-credentials', 'path-unsafe'].includes(error.message) ? error.message : 'input-unavailable');
  }
  if (started.status !== 'started') {
    if (started.partial) await started.partial.terminate({ graceMs: 0, deadlineMs: CLEANUP_MS });
    return fail('containment-unavailable');
  }
  const child = started.handle, chunks = [];
  let bytes = 0, reason, timer;
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const halt = value => { reason ??= value; stop(); };
  const collect = (chunk, stdout) => {
    bytes += chunk.byteLength;
    if (bytes > OUTPUT_BYTES) return halt('output-limit');
    if (stdout) chunks.push(Buffer.from(chunk));
  };
  child.stdout.on('data', chunk => collect(chunk, true));
  child.stderr.on('data', chunk => collect(chunk, false));
  child.stdout.on('error', () => halt('response-incomplete'));
  child.stderr.on('error', () => halt('response-incomplete'));
  child.stdin.on('error', () => halt('input-unavailable'));
  let exit;
  try {
    timer = setTimeout(() => halt('deadline'), Math.max(1, deadline - performance.now()));
    child.stdin.end(INPUT);
    exit = await Promise.race([child.exited, stopped]);
    // Exited and pipe-end are distinct facility events; consume the complete bounded stream.
    if (!reason) await Promise.race([Promise.all([child.stdout.readableEnded ? null : new Promise(resolve => child.stdout.once('end', resolve)),
      child.stderr.readableEnded ? null : new Promise(resolve => child.stderr.once('end', resolve))]), stopped]);
  } catch { reason ??= 'response-incomplete'; }
  finally { clearTimeout(timer); }
  let cleanup;
  try { cleanup = await child.terminate({ graceMs: 0, deadlineMs: CLEANUP_MS }); } catch { return fail('cleanup-unconfirmed'); }
  if (cleanup.processes !== 'confirmed') return fail('cleanup-unconfirmed');
  if (reason) return fail(reason);
  if (!exit || exit.code !== 0 || exit.reason) return fail('client-failed');
  return result({ ...parseClaudePluginReadback(Buffer.concat(chunks)), client: { path: pin.path, sha256: pin.sha256 } });
}

export const observeClaudePlugins = request => observeClaudePluginsWith(request, host);
