// The one loader for Core's optional peers (`@aihq/scan/read`, `@aihq/catalog/node`, `@aihq/catalog/reader`). A peer is
// used only when its real path is inside one of these folders (each by its real path):
// - Core's own package folder;
// - the `node_modules` folder that holds `@aihq/core`, and in a pnpm install the `node_modules` holding that `.pnpm`
//   store;
// - for a linked Core (`npm link`, a `file:` link), the `node_modules` folder of the project whose own
//   `node_modules/@aihq/core` links to this Core, found from the main script.
// One found anywhere else (a parent folder's `node_modules`, `NODE_PATH`, a link to elsewhere) is not loaded. The
// accepted file is imported by its file URL, so what is checked is what runs. This module imports only Node built-ins.
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type PeerLoad =
  | { status: 'loaded'; module: Record<string, unknown>; version?: string }
  | { status: 'missing' | 'not-exported' | 'outside' | 'unreadable' };

const MANIFEST_LIMIT = 1_000_000;

/** Core's own package folder, the one holding `dist/`. */
function coreFolder(): string {
  return realpathSync.native(fileURLToPath(new URL('../../../', import.meta.url)));
}

const last = (path: string): string => path.split(sep).at(-1)?.toLowerCase() ?? '';
/**
 * The folders a peer may come from: Core's package folder and, when Core is installed, the `node_modules` holding it;
 * in pnpm's layout (`<project>/node_modules/.pnpm/<entry>/node_modules/@aihq/core`) also `<project>/node_modules`.
 */
export function peerRoots(core: string = coreFolder()): string[] {
  const roots = [core];
  const scope = dirname(core), holder = dirname(scope);
  if (last(scope) === '@aihq' && last(holder) === 'node_modules') {
    roots.push(holder);
    const store = dirname(dirname(holder)), outer = dirname(store);
    if (last(store) === '.pnpm' && last(outer) === 'node_modules') roots.push(outer);
  }
  return roots;
}

const same = (a: string, b: string): boolean => inside(a, b) && inside(b, a);
/**
 * For a linked Core: the real path of the nearest `node_modules` above `main` whose `@aihq/core` resolves to `core`.
 * A folder at a filesystem root (where any local user may create `node_modules`) is never used.
 */
export function linkedHolder(main: string | undefined, core: string = coreFolder()): string | undefined {
  if (!main) return undefined;
  for (let folder = dirname(resolve(main)), depth = 0; depth < 64 && dirname(folder) !== folder; depth += 1, folder = dirname(folder)) {
    try { if (same(realpathSync.native(join(folder, 'node_modules', '@aihq', 'core')), core)) return realpathSync.native(join(folder, 'node_modules')); }
    catch { /* not here */ }
  }
  return undefined;
}

const CONDITIONS = new Set(['node', 'import', 'module-sync', 'default']);
/** One `exports` target for the conditions Core loads with, or `undefined`. */
function conditional(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) { for (const item of value) { const found = conditional(item); if (found) return found; } return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) if (CONDITIONS.has(key)) { const found = conditional(item); if (found !== undefined) return found; }
  return undefined;
}
/** The file a package's `exports` names for `subpath` (`.` or `./x`), relative to the package; `null` when not exported. */
function exportTarget(exports: unknown, subpath: string): string | null {
  let target: string | undefined;
  const map = exports && typeof exports === 'object' && !Array.isArray(exports) ? exports as Record<string, unknown> : undefined;
  if (map && Object.keys(map).some(key => key.startsWith('.'))) {
    if (Object.hasOwn(map, subpath)) target = conditional(map[subpath]);
    else for (const [key, item] of Object.entries(map)) {
      const star = key.indexOf('*');
      if (star < 0 || key.indexOf('*', star + 1) >= 0) continue;
      const before = key.slice(0, star), after = key.slice(star + 1);
      if (subpath.length >= key.length - 1 && subpath.startsWith(before) && subpath.endsWith(after)) {
        const found = conditional(item);
        if (found) target = found.replaceAll('*', subpath.slice(before.length, subpath.length - after.length));
        break;
      }
    }
  } else if (subpath === '.') target = conditional(exports);
  if (!target || !target.startsWith('./') || target.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === 'node_modules')) return null;
  return target;
}

function inside(root: string, path: string): boolean {
  const fold = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
  const rel = relative(fold(root), fold(path));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function readManifest(path: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MANIFEST_LIMIT) return undefined;
    const bytes = new Uint8Array(stat.size);
    let at = 0;
    while (at < bytes.length) { const read = readSync(fd, bytes, at, bytes.length - at, at); if (read <= 0) break; at += read; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, at))) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

/** The version in the named package's own `package.json`, found by walking up from `file` without leaving `root`. */
function packageVersion(file: string, root: string, name: string): string | undefined {
  for (let folder = dirname(file), depth = 0; depth < 16 && inside(root, folder); depth += 1, folder = dirname(folder)) {
    const manifest = readManifest(join(folder, 'package.json'));
    if (manifest?.name === name) return typeof manifest.version === 'string' && manifest.version && manifest.version.length <= 64 ? manifest.version : undefined;
    if (dirname(folder) === folder) break;
  }
  return undefined;
}

/**
 * Load an optional peer by specifier. `missing` means it is not installed, `not-exported` that the package lacks that
 * subpath, `outside` that the resolved file is not under Core's package folder or the `node_modules` holding Core.
 * Never throws.
 */
export async function loadPeer(specifier: string): Promise<PeerLoad> {
  const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  let core: string;
  try { core = coreFolder(); } catch { return { status: 'missing' }; }
  const roots = peerRoots(core);
  let found: { real: string; root: string } | undefined;
  let status: Exclude<PeerLoad['status'], 'loaded'> = 'missing';
  try {
    const resolved = import.meta.resolve(specifier);
    if (!resolved.startsWith('file:')) status = 'outside';
    else {
      const real = realpathSync.native(fileURLToPath(resolved));
      const root = roots.find(candidate => inside(candidate, real));
      if (root) found = { real, root }; else status = 'outside';
    }
  } catch (error) { if ((error as { code?: unknown })?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') status = 'not-exported'; }
  // A linked Core resolves from its checkout, so the project's own peer is looked up in the project's `node_modules`.
  const linked = found ? undefined : linkedHolder(process.argv[1], core);
  if (linked && !roots.some(root => same(root, linked))) {
    const folder = join(linked, ...name.split('/'));
    const manifest = readManifest(join(folder, 'package.json'));
    if (manifest?.name === name) {
      const target = exportTarget(manifest.exports, '.' + specifier.slice(name.length));
      if (target === null) status = 'not-exported';
      else try {
        const real = realpathSync.native(join(folder, ...target.slice(2).split('/')));
        if (inside(linked, real)) found = { real, root: linked }; else status = 'outside';
      } catch { status = 'missing'; }
    }
  }
  if (!found) return { status };
  const { real, root } = found;
  try {
    const module = await import(pathToFileURL(real).href) as Record<string, unknown>;
    const version = packageVersion(real, root, name);
    return { status: 'loaded', module, ...(version ? { version } : {}) };
  } catch { return { status: 'unreadable' }; }
}
