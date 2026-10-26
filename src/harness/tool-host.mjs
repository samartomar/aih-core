// Node-only Harness host inspection for one observed AI tool and a set of items. It observes with bounded
// reads and runs nothing: no tool, hook, server or item content is executed, not even for a version. It never
// writes, removes or edits anything it finds. A fact it cannot establish is reported unchecked, never as works.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { parse as parseJsonc } from 'jsonc-parser';
import { deriveCellSupport, toolBindingKinds, toolBindings } from './tool-binding.mjs';
import { selectTool } from './tool-registry.mjs';

const DEFAULT_BUDGET_MS = 10000, MAX_BUDGET_MS = 60000, MAX_READS = 4096, MAX_ANCESTORS = 64;
const MAX_ITEMS = 256, MAX_MANIFEST_BYTES = 65536, MAX_CONFIG_BYTES = 1048576, MAX_PACKAGE_LEVELS = 6;
const VERSION = /^[0-9]{1,9}(?:\.[0-9]{1,9}){0,3}$/;
const EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const INPUT = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const IDENTIFIER = /^[^\u0000-\u001f]{1,256}$/;

// Where a tool's user-level root moves when the tool's own variable is set. The variable replaces the root's
// first segment (for Codex, `.codex`). Any other variable a binding's `roots.user.resolvedBy` names, when set,
// moves the root somewhere this inspection does not follow, so the user level is unavailable.
const USER_ROOT_VARIABLES = Object.freeze({ codex: 'CODEX_HOME' });
const HOME_VARIABLES = new Set(['HOME', 'USERPROFILE']);
// Kinds a tool reads from every folder above the project, as its binding's `alsoReads` `ancestor-folders`
// entry states. Elsewhere no ancestor reading is observed, so parent-folder copies are unavailable.
const ANCESTOR_KINDS = Object.freeze({ copilot: Object.freeze(['skill']) });
// No binding cell observes a plugin location yet, so plugin copies are never looked for.
const PLUGINS_UNOBSERVED = 'plugin-locations-not-observed';

const plainObject = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  !isProxy(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && keys.includes(key) && descriptor.enumerable && 'value' in descriptor;
  });
const stringArray = (value, pattern, max) => value === undefined || (Array.isArray(value) && value.length <= max &&
  value.every(item => typeof item === 'string' && pattern.test(item)) && new Set(value).size === value.length);
const reference = value => plainObject(value, ['framework', 'itemId']) &&
  typeof value.framework === 'string' && IDENTIFIER.test(value.framework) &&
  typeof value.itemId === 'string' && IDENTIFIER.test(value.itemId);
// A key is one folder entry or registration key: no separators, no characters or endings Windows treats specially.
const validKey = key => typeof key === 'string' && key.length >= 1 && key.length <= 255 && key !== '.' && key !== '..' &&
  !/[/\\:*?"<>|\u0000-\u001f]/.test(key) && !/[. ]$/.test(key);
const identityOf = item => JSON.stringify([item.framework, item.itemId]);
const ref = item => ({ framework: item.framework, itemId: item.itemId });

function invalidRequest(request, controls) {
  if (!plainObject(request, ['tool', 'project', 'items'])) return 'request-field';
  if (!plainObject(controls, ['signal', 'budgetMs'])) return 'controls-field';
  if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) return 'signal';
  if (controls.budgetMs !== undefined && (!Number.isInteger(controls.budgetMs) || controls.budgetMs < 1 ||
      controls.budgetMs > MAX_BUDGET_MS)) return 'budget-ms';
  if (typeof request.tool !== 'string') return 'tool';
  if (typeof request.project !== 'string' || !request.project || request.project.length > 4096 ||
      request.project.includes('\u0000') || !isAbsolute(request.project)) return 'project';
  if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > MAX_ITEMS) return 'items';
  const seen = new Set();
  for (const item of request.items) {
    if (!plainObject(item, ['framework', 'itemId', 'kind', 'key', 'executables', 'inputs', 'requires']) ||
        !reference({ framework: item.framework, itemId: item.itemId }) || !toolBindingKinds.includes(item.kind) ||
        (item.key !== undefined && !validKey(item.key)) || !stringArray(item.executables, EXECUTABLE, 16) ||
        !stringArray(item.inputs, INPUT, 64) ||
        (item.requires !== undefined && (!Array.isArray(item.requires) || item.requires.length > 64 ||
          !item.requires.every(reference)))) return 'item';
    if (seen.has(identityOf(item))) return 'duplicate-item';
    seen.add(identityOf(item));
  }
  return undefined;
}

const hostPlatform = () => {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = ['x64', 'arm64'].includes(process.arch) ? process.arch : undefined;
  return os && arch ? { os, arch } : undefined;
};

/**
 * Observes, without running anything, how the named tool and project look for the given items: the installed
 * tool version, each required executable, same-key copies the tool may also see, the inputs still required, and
 * whether the installed version is newer than the binding's observations.
 */
export async function inspectToolHost(request, controls = {}) {
  const started = performance.now();
  const invalid = invalidRequest(request, controls);
  const budgetMs = invalid ? DEFAULT_BUDGET_MS : controls.budgetMs ?? DEFAULT_BUDGET_MS;
  const limits = reads => ({ budgetMs, elapsedMs: Math.round(performance.now() - started), reads, maxReads: MAX_READS });
  if (invalid) return { status: 'invalid', diagnostics: [{ code: 'INPUT_INVALID', reason: invalid,
    message: 'Use a published tool, an absolute project folder and bounded item descriptions.' }], limits: limits(0) };
  const selected = selectTool(request.tool);
  if (selected.status === 'refused') return { status: 'refused', diagnostics: [{ code: selected.code, reason: selected.reason,
    message: selected.reason === 'unknown-tool' ? 'The tool is not in the tool registry.'
      : 'The tool has no observed binding; it is not offered as a target.' }], limits: limits(0) };
  const { signal } = controls;
  if (signal?.aborted) return { status: 'cancelled', diagnostics: [{ code: 'CANCELLED', reason: 'cancelled',
    message: 'Host inspection was cancelled.' }], limits: limits(0) };

  // Every filesystem read counts against one bound; past the deadline or the read limit, the remaining facts are
  // unchecked. Reads run synchronously, so a signal is honoured only when it is already aborted.
  let reads = 0, stopped;
  const deadline = started + budgetMs;
  const halt = () => {
    if (stopped) return stopped;
    if (performance.now() > deadline) stopped = 'budget';
    else if (reads >= MAX_READS) stopped = 'read-limit';
    return stopped;
  };
  const read = operation => { if (halt()) throw new Stop(); reads++; return operation(); };
  class Stop extends Error {}

  let project;
  try {
    project = read(() => realpathSync.native(request.project));
    if (!read(() => statSync(project)).isDirectory()) project = undefined;
  } catch (error) { if (error instanceof Stop) project = null; else project = undefined; }
  if (project === undefined) return { status: 'invalid', diagnostics: [{ code: 'INPUT_INVALID', reason: 'project',
    message: 'The project must be an existing folder.' }], limits: limits(reads) };

  let home;
  try { home = read(() => realpathSync.native(homedir())); } catch (error) { home = error instanceof Stop ? undefined : homedir(); }
  const binding = toolBindings.find(item => item.tool === selected.tool.id);
  const unchecked = [], hostBlockers = [], warnings = [];
  const environment = process.env;
  const windows = process.platform === 'win32';
  const pathValue = windows ? Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] : environment.PATH;
  // An empty POSIX PATH entry means the current folder. Like a relative entry it depends on the caller's folder,
  // so a name not found elsewhere is not known to be absent.
  const pathEntries = typeof pathValue === 'string' && pathValue ? pathValue.split(delimiter) : [];
  const pathDirectories = pathEntries.filter(entry => entry && isAbsolute(entry));
  const pathRelative = pathEntries.some(entry => windows ? entry && !isAbsolute(entry) : !isAbsolute(entry));
  const extensions = windows ? (Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').filter(Boolean) : [''];

  // A program is present when a regular, executable file of that name is on PATH; absent only when every PATH
  // folder was read and none has it; otherwise unknown.
  const lookups = new Map();
  const locate = name => {
    if (lookups.has(name)) return lookups.get(name);
    let result;
    if (!pathDirectories.length) result = { state: 'unknown', reason: 'path-unavailable' };
    else {
      let uncertain;
      const named = extensions.some(extension => extension.toLowerCase() === extname(name).toLowerCase() && extension);
      const names = windows && named ? [name] : extensions.map(extension => name + extension);
      search: for (const directory of pathDirectories) for (const candidate of names) {
        const path = join(directory, candidate);
        try {
          const stats = read(() => statSync(path));
          if (stats.isFile() && (windows || (stats.mode & 0o111) !== 0)) { result = { state: 'present', path }; break search; }
        } catch (error) {
          if (error instanceof Stop) { result = { state: 'unknown', reason: halt() }; break search; }
          if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) uncertain = 'path-unreadable';
        }
      }
      result ??= uncertain ? { state: 'unknown', reason: uncertain }
        : pathRelative ? { state: 'unknown', reason: 'path-relative-entry' } : { state: 'absent' };
    }
    lookups.set(name, result);
    return result;
  };

  // An npm command shim (Windows `.cmd`, or a copied script) sits in the npm prefix beside `node_modules`;
  // exactly one installed package there must name the tool's executable in its `bin`.
  const manifestAt = path => {
    try {
      const stats = read(() => statSync(path));
      if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) return undefined;
      const value = JSON.parse(read(() => readFileSync(path, 'utf8')));
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch (error) { if (error instanceof Stop) throw error; return undefined; }
  };
  const binNames = manifest => typeof manifest.bin === 'string' ? [String(manifest.name).split('/').at(-1)]
    : manifest.bin !== null && typeof manifest.bin === 'object' ? Object.keys(manifest.bin) : [];
  const shimPackageVersion = shim => {
    const modules = join(dirname(shim), 'node_modules');
    const entries = directory => { try { return read(() => readdirSync(directory, { withFileTypes: true })); }
      catch (error) { if (error instanceof Stop) throw error; return []; } };
    const packages = [];
    for (const entry of entries(modules).slice(0, 512)) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('@')) for (const scoped of entries(join(modules, entry.name)).slice(0, 512)) {
        if (scoped.isDirectory()) packages.push(join(modules, entry.name, scoped.name));
      } else packages.push(join(modules, entry.name));
    }
    const matches = packages.slice(0, 1024).map(directory => manifestAt(join(directory, 'package.json')))
      .filter(manifest => manifest && binNames(manifest).some(name => selected.tool.binaries.includes(name)));
    if (matches.length !== 1) return { state: 'unknown', reason: 'version-not-readable' };
    return typeof matches[0].version === 'string' && VERSION.test(matches[0].version)
      ? { state: 'known', version: matches[0].version, source: 'package-manifest' }
      : { state: 'unknown', reason: 'version-not-numeric' };
  };

  // The installed version comes only from files beside the tool's executable: an npm package whose `bin`
  // names it, or a `versions/<version>` file. Nothing is run to ask the tool.
  const readVersion = () => {
    const located = selected.tool.binaries.map(locate);
    const found = located.find(item => item.state === 'present');
    if (!found) return { state: 'unknown',
      reason: located.some(item => item.state === 'unknown') ? 'tool-executable-unknown' : 'tool-executable-absent' };
    try {
      const target = read(() => realpathSync.native(found.path));
      const parsed = parse(target);
      if (parse(parsed.dir).base === 'versions' && VERSION.test(parsed.base))
        return { state: 'known', version: parsed.base, source: 'version-folder' };
      let directory = parsed.dir;
      for (let level = 0; level < MAX_PACKAGE_LEVELS; level++) {
        const manifestPath = join(directory, 'package.json');
        let manifest;
        try {
          const stats = read(() => statSync(manifestPath));
          if (stats.isFile() && stats.size <= MAX_MANIFEST_BYTES) manifest = JSON.parse(read(() => readFileSync(manifestPath, 'utf8')));
        } catch (error) { if (error instanceof Stop) throw error; }
        if (manifest !== null && typeof manifest === 'object') {
          const bin = typeof manifest.bin === 'string' ? { [String(manifest.name).split('/').at(-1)]: manifest.bin } : manifest.bin;
          const names = bin && typeof bin === 'object' ? Object.entries(bin)
            .filter(([, file]) => typeof file === 'string' && resolve(directory, file) === target).map(([name]) => name) : [];
          if (names.some(name => selected.tool.binaries.includes(name)))
            return typeof manifest.version === 'string' && VERSION.test(manifest.version)
              ? { state: 'known', version: manifest.version, source: 'package-manifest' }
              : { state: 'unknown', reason: 'version-not-numeric' };
          break;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      return shimPackageVersion(found.path);
    } catch (error) {
      if (error instanceof Stop) return { state: 'unknown', reason: halt() };
      return { state: 'unknown', reason: 'version-not-readable' };
    }
  };

  // Copies are read where the binding says the tool reads that kind. A folder root holds one entry per key; a
  // registration file holds keys in its container. Anything else cannot be checked.
  const userBase = layout => {
    const variable = USER_ROOT_VARIABLES[binding.tool];
    const segments = layout.roots.user.path.split('/');
    const named = layout.roots.user.resolvedBy.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
    if (named.some(name => name !== variable && !HOME_VARIABLES.has(name) && environment[name])) return undefined;
    const override = variable && environment[variable];
    if (override) return isAbsolute(override) ? join(override, ...segments.slice(1)) : undefined;
    return join(homedir(), ...segments);
  };
  const lookIn = (location, layout, kind, key) => {
    const registration = layout.register;
    if (kind === 'mcp-server') {
      if (!registration) return { state: 'unavailable', reason: 'registration-not-observed' };
      if (!['json', 'jsonc'].includes(registration.format)) return { state: 'unavailable', reason: 'registration-format-unread' };
      let stats;
      try { stats = read(() => statSync(location)); }
      catch (error) {
        if (error instanceof Stop) throw error;
        return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? { state: 'none' } : { state: 'unavailable', reason: 'unreadable' };
      }
      if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return { state: 'unavailable', reason: 'unreadable' };
      let document;
      try {
        const text = read(() => readFileSync(location, 'utf8'));
        const errors = [];
        document = registration.format === 'json' ? JSON.parse(text) : parseJsonc(text, errors, { allowTrailingComma: true });
        if (errors.length) return { state: 'unavailable', reason: 'unreadable' };
      } catch (error) {
        if (error instanceof Stop) throw error;
        return { state: 'unavailable', reason: 'unreadable' };
      }
      // Only objects hold keys: a missing container is none, any other shape on the way is unreadable.
      const holdsKeys = value => value !== null && typeof value === 'object' && !Array.isArray(value);
      let container = document;
      for (const segment of registration.container) {
        if (!holdsKeys(container)) return { state: 'unavailable', reason: 'unreadable' };
        if (!Object.hasOwn(container, segment)) return { state: 'none' };
        container = container[segment];
      }
      if (!holdsKeys(container)) return { state: 'unavailable', reason: 'unreadable' };
      return Object.hasOwn(container, key) ? { state: 'found', path: location } : { state: 'none' };
    }
    const path = join(location, key);
    try { read(() => lstatSync(path)); return { state: 'found', path }; }
    catch (error) {
      if (error instanceof Stop) throw error;
      return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? { state: 'none' } : { state: 'unavailable', reason: 'unreadable' };
    }
  };
  const folderRoot = root => root && !extname(root.split('/').at(-1));
  const copiesOf = item => {
    const layout = binding.layouts[item.kind];
    if (item.key === undefined || item.kind === 'hook') {
      const missing = { state: 'unavailable', reason: 'item-not-keyed' };
      return { user: missing, parentFolders: missing, plugins: missing };
    }
    const guarded = body => { try { return body(); } catch (error) {
      if (error instanceof Stop) return { state: 'unavailable', reason: halt() };
      return { state: 'unavailable', reason: 'unreadable' };
    } };
    const located = (root, base) => item.kind === 'mcp-server'
      ? (root === layout.register?.file ? join(base, ...root.split('/')) : undefined)
      : folderRoot(root) ? join(base, ...root.split('/')) : undefined;
    const user = guarded(() => {
      if (!layout.roots.user) return { state: 'unavailable', reason: 'user-root-not-observed' };
      const base = userBase(layout);
      if (!base) return { state: 'unavailable', reason: 'user-root-unresolved' };
      if (item.kind === 'mcp-server') return layout.register?.file === layout.roots.user.path
        ? lookIn(base, layout, item.kind, item.key) : { state: 'unavailable', reason: 'registration-not-observed' };
      return lookIn(base, layout, item.kind, item.key);
    });
    const parentFolders = guarded(() => {
      const root = layout.roots.project;
      if (!binding.alsoReads.some(entry => entry.where === 'ancestor-folders') ||
          !ANCESTOR_KINDS[binding.tool]?.includes(item.kind)) return { state: 'unavailable', reason: 'ancestor-reading-not-observed' };
      if (!root) return { state: 'unavailable', reason: 'project-root-not-observed' };
      if (located(root, project) === undefined) return { state: 'unavailable', reason: 'single-file-root' };
      const paths = [];
      let unreadable;
      let directory = dirname(project);
      // Folders above the project up to, not including, the user home: the home itself is user level.
      for (let level = 0; level < MAX_ANCESTORS && directory !== home && project !== home; level++) {
        const result = lookIn(located(root, directory), layout, item.kind, item.key);
        if (result.state === 'unavailable') unreadable ??= result;
        if (result.state === 'found') paths.push(result.path);
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      // A copy found is a fact even when another folder could not be read.
      return paths.length ? { state: 'found', paths } : unreadable ?? { state: 'none' };
    });
    const normalized = result => result.state === 'found' && result.path ? { state: 'found', paths: [result.path] } : result;
    return { user: normalized(user), parentFolders, plugins: { state: 'unavailable', reason: PLUGINS_UNOBSERVED } };
  };

  const installedVersion = project === null ? { state: 'unknown', reason: halt() } : readVersion();
  if (installedVersion.state === 'unknown') unchecked.push({ fact: 'tool-version', reason: installedVersion.reason });
  const platform = hostPlatform();
  const requested = new Set(request.items.map(identityOf));
  const items = request.items.map(item => {
    const layout = binding.layouts[item.kind];
    const executables = (item.executables ?? []).map(name => {
      const found = project === null ? { state: 'unknown', reason: halt() } : locate(name);
      if (found.state === 'absent') hostBlockers.push({ code: 'executable-missing', item: ref(item), executable: name });
      if (found.state === 'unknown') unchecked.push({ fact: 'executable', item: ref(item), executable: name, reason: found.reason });
      return { name, state: found.state };
    });
    // Input values never reach Core's inspection, so every declared input is still required.
    const inputs = [...(item.inputs ?? [])];
    for (const input of inputs) hostBlockers.push({ code: 'input-required', item: ref(item), input });
    for (const dependency of item.requires ?? []) if (!requested.has(identityOf(dependency)))
      hostBlockers.push({ code: 'dependency-missing', item: ref(item), dependency: ref(dependency) });
    const copies = project === null ? Object.fromEntries(['user', 'parentFolders', 'plugins']
      .map(where => [where, { state: 'unavailable', reason: halt() }])) : copiesOf(item);
    for (const [where, label] of [['user', 'user'], ['parentFolders', 'parent-folder'], ['plugins', 'plugin']]) {
      const copy = copies[where];
      if (copy.state === 'found') for (const path of copy.paths)
        warnings.push({ code: 'same-key-elsewhere', item: ref(item), key: item.key, where: label, path });
      if (copy.state === 'unavailable')
        unchecked.push({ fact: `${label}-copy`, item: ref(item), reason: copy.reason });
    }
    // Staleness compares the installed version with the observations that prove the cell. Newer than all of them,
    // on any platform, is stale. Not stale needs a proving observation on this host's platform.
    const proving = layout.observations.filter(observation =>
      deriveCellSupport({ kind: item.kind, observations: [observation] }).support === 'native');
    const here = proving.filter(observation => platform && observation.os === platform.os && observation.arch === platform.arch);
    const newest = proving.length ? deriveCellSupport({ kind: item.kind, observations: proving }).observedOn.toolVersion : undefined;
    let stale, staleReason;
    if (installedVersion.state !== 'known') staleReason = 'tool-version-unknown';
    else if (!proving.length) staleReason = 'cell-not-proven';
    else if (deriveCellSupport({ kind: item.kind, observations: proving, installedVersion: installedVersion.version }).stale) stale = true;
    else if (!here.length) staleReason = 'not-observed-on-platform';
    else stale = deriveCellSupport({ kind: item.kind, observations: here, installedVersion: installedVersion.version }).stale;
    if (staleReason) { stale = 'unchecked'; unchecked.push({ fact: 'stale', item: ref(item), reason: staleReason }); }
    return { ...ref(item), kind: item.kind, ...(item.key === undefined ? {} : { key: item.key }),
      ...(newest ? { observedVersion: newest } : {}), stale, executables, inputs, copies };
  });
  for (const entry of binding.alsoReads) warnings.push({ code: 'also-reads', what: entry.what, where: entry.where });
  const stale = items.some(item => item.stale === true) ? true : items.some(item => item.stale === 'unchecked') ? 'unchecked' : false;
  const reason = halt();
  return {
    status: reason ? 'incomplete' : 'complete',
    tool: { id: selected.tool.id, label: selected.tool.label }, binding: { digest: binding.digest },
    ...(platform ? { platform } : {}), installedVersion, stale, items, hostBlockers, warnings, unchecked,
    diagnostics: reason ? [{ code: 'PREREQUISITE_UNAVAILABLE', reason, message: 'Host inspection stopped at its bound; the remaining facts are unchecked.' }] : [],
    limits: limits(reads)
  };
}
