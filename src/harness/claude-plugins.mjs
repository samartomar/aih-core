// A prompt-free, bounded Claude control-protocol readback. This is not verifyClient qualification.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
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
        return field?.enumerable && 'value' in field && text(field.value) && isAbsolute(field.value) && !field.value.startsWith('\\\\');
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

// Claude follows registry/cache paths independently of CLAUDE_CONFIG_DIR. Admit only ordinary
// bounded files/directories in this owned cell, including the local marketplace inputs it names.
function checkWorkspaceInputs(paths) {
  let entries = 0, jsonBytes = 0;
  const visited = new Set();
  const walk = (path, depth = 0) => {
    const id = key(path); if (visited.has(id)) return;
    if (++entries > 8192 || depth > 32) throw Error('client-state-limit');
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.isFile() && stat.nlink !== 1) throw Error('path-unsafe');
    visited.add(id);
    if (!stat.isDirectory()) return;
    const directory = opendirSync(path);
    try { for (let entry; (entry = directory.readSync()) !== null;) walk(join(path, entry.name), depth + 1); }
    finally { directory.closeSync(); }
  };
  const json = path => {
    walk(path);
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.size > OUTPUT_BYTES || (jsonBytes += before.size) > 4 * OUTPUT_BYTES) throw Error('client-state-limit');
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) { const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (!count) throw Error('client-state-unconfirmed'); offset += count; }
      const after = fstatSync(descriptor), current = lstatSync(path);
      if (current.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== current.dev || after.ino !== current.ino ||
          after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) throw Error('client-state-unconfirmed');
      return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 32);
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  };
  const local = (value, base) => {
    if (!text(value) || value.startsWith('\\\\')) throw Error('client-state-outside-workspace');
    const path = resolve(base, value);
    if (!inside(paths.project, path) && !inside(paths.home, path)) throw Error('client-state-outside-workspace');
    // Inspect every existing ancestor before following a named subtree.
    let current = parse(path).root;
    for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      let stat; try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (stat.isSymbolicLink()) throw Error('path-unsafe');
    }
    walk(path);
  };
  walk(paths.config); walk(join(paths.home, '.claude.json')); walk(join(paths.project, '.claude'));
  const settings = json(join(paths.project, '.claude', 'settings.json'));
  if (settings !== undefined && !isRecord(settings)) throw Error('client-state-unconfirmed');
  if (settings?.extraKnownMarketplaces !== undefined && !isRecord(settings.extraKnownMarketplaces)) throw Error('client-state-unconfirmed');
  for (const entry of Object.values(settings?.extraKnownMarketplaces ?? {}))
    if (entry?.source?.source === 'directory') local(entry.source.path, paths.project);
  const installed = json(join(paths.config, 'plugins', 'installed_plugins.json'));
  if (installed !== undefined) {
    if (!isRecord(installed) || !isRecord(installed.plugins)) throw Error('client-state-unconfirmed');
    for (const registrations of Object.values(installed.plugins)) {
      if (!Array.isArray(registrations)) throw Error('client-state-unconfirmed');
      for (const registration of registrations) { if (!isRecord(registration)) throw Error('client-state-unconfirmed'); local(registration.installPath, paths.project); }
    }
  }
  const marketplaces = json(join(paths.config, 'plugins', 'known_marketplaces.json'));
  if (marketplaces !== undefined && !isRecord(marketplaces)) throw Error('client-state-unconfirmed');
  for (const entry of Object.values(marketplaces ?? {})) {
    if (!isRecord(entry)) throw Error('client-state-unconfirmed');
    if (entry.installLocation !== undefined) local(entry.installLocation, paths.project);
    if (entry.source?.source === 'directory') local(entry.source.path, paths.project);
  }
}

// Internal test seam: the public export never accepts PATH, executable, argv or a launcher override.
export function claudePluginLookupPath(pathEnv, project, home) {
  return String(pathEnv ?? '').split(delimiter).filter(directory => {
    if (!text(directory) || !isAbsolute(directory) || directory.startsWith('\\\\')) return false;
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
    if (value.type === 'system') {
      if (value.is_error === true || typeof value.subtype === 'string' && /error/i.test(value.subtype)) return fail('response-unexpected');
      if (Array.isArray(value.mcp_servers) && value.mcp_servers.length) return fail('mcp-not-contained');
      continue;
    }
    if (value.type !== 'control_response' || !isRecord(value.response)) return fail('response-unexpected');
    const response = value.response;
    if (!['init', 'plugins'].includes(response.request_id) || responses.has(response.request_id) ||
        response.subtype !== 'success' || !isRecord(response.response)) return fail('response-invalid');
    responses.set(response.request_id, response.response);
  }
  if (!responses.has('init') || !responses.has('plugins')) return fail('response-incomplete');
  const initialized = responses.get('init');
  if (initialized.error_count !== undefined && initialized.error_count !== 0) return fail('plugin-errors');
  if (Array.isArray(initialized.mcpServers) && initialized.mcpServers.length) return fail('mcp-not-contained');
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
async function pinClaude(paths) {
  const directories = claudePluginLookupPath(process.env.PATH, paths.project, paths.home).split(delimiter).filter(directory => {
    try {
      const executable = realpathSync.native(join(directory, 'claude.exe')), stat = lstatSync(executable);
      return stat.isFile() && stat.size > 0 && stat.size <= 512 * 1024 * 1024 &&
        !executable.startsWith('\\\\') && !inside(paths.project, executable) && !inside(paths.home, executable);
    } catch { return false; }
  });
  return pinExecutable({ names: ['claude.exe'], platform: process.platform, pathEnv: directories.join(delimiter) });
}

const host = {
  platform: process.platform, personalHome: () => userInfo().homedir,
  managed: () => observeClaudeManagedSettings(),
  pin: pinClaude,
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
    checkWorkspaceInputs(paths);
    started = await selectedHost.start({ file: pin.path, argv: [...ARGV], cwd: paths.project,
      env: environment(paths, pin.path), deadline });
  } catch (error) {
    return fail(['input-invalid', 'home-not-isolated', 'home-has-credentials', 'path-unsafe', 'client-state-limit',
      'client-state-outside-workspace', 'client-state-unconfirmed'].includes(error.message) ? error.message : 'input-unavailable');
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
  try { checkWorkspaceInputs(paths); } catch (error) { return fail(['path-unsafe', 'client-state-limit', 'client-state-outside-workspace'].includes(error.message) ? error.message : 'client-state-unconfirmed'); }
  return result({ ...parseClaudePluginReadback(Buffer.concat(chunks)), client: { path: pin.path, sha256: pin.sha256 } });
}

export const observeClaudePlugins = request => observeClaudePluginsWith(request, host);
