// The one loader for Core's optional peers (`@aihq/scan/read`, `@aihq/catalog/node`, `@aihq/catalog/reader`). A peer is
// used only when its real path is inside Core's own package folder or the `node_modules` folder that holds
// `@aihq/core`; one found anywhere else (a parent folder's `node_modules`, for instance) is not loaded. The accepted file
// is imported by its file URL, so what is checked is what runs. This module imports only Node built-ins.
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type PeerLoad =
  | { status: 'loaded'; module: Record<string, unknown>; version?: string }
  | { status: 'missing' | 'not-exported' | 'outside' | 'unreadable' };

const MANIFEST_LIMIT = 1_000_000;

/** Core's own package folder, the one holding `dist/`. */
function coreFolder(): string {
  return realpathSync.native(fileURLToPath(new URL('../../../', import.meta.url)));
}

/** The folders a peer may come from: Core's package folder and, when Core is installed, the `node_modules` holding it. */
export function peerRoots(core: string = coreFolder()): string[] {
  const roots = [core];
  const scope = dirname(core), holder = dirname(scope);
  if (scope.split(sep).at(-1)?.toLowerCase() === '@aihq' && holder.split(sep).at(-1)?.toLowerCase() === 'node_modules') roots.push(holder);
  return roots;
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
  let resolved: string;
  try { resolved = import.meta.resolve(specifier); } catch (error) {
    return { status: (error as { code?: unknown })?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? 'not-exported' : 'missing' };
  }
  let real: string, roots: string[];
  try {
    if (!resolved.startsWith('file:')) return { status: 'outside' };
    real = realpathSync.native(fileURLToPath(resolved));
    roots = peerRoots();
  } catch { return { status: 'missing' }; }
  const root = roots.find(candidate => inside(candidate, real));
  if (!root) return { status: 'outside' };
  const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  try {
    const module = await import(pathToFileURL(real).href) as Record<string, unknown>;
    const version = packageVersion(real, root, name);
    return { status: 'loaded', module, ...(version ? { version } : {}) };
  } catch { return { status: 'unreadable' }; }
}
