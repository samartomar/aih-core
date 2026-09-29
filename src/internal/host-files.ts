import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { OwnedFileTransaction } from './owned-file-transaction.js';
import { containedPath } from './contained-path.js';

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function validSegment(value: string): boolean {
  if (!value || value === '.' || value === '..' || /[\p{Cc}\p{Cf}\\/:]/u.test(value)) return false;
  return process.platform !== 'win32' || (!/[<>"|?*]/.test(value) && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(value));
}
export interface PathPin { path: string; identity: string }
const macSystemAliases: Readonly<Record<string, string>> = {
  '/var': '/private/var', '/tmp': '/private/tmp'
};
function macSystemAliasIdentity(path: string, link: BigIntStats): string | undefined {
  const expected = process.platform === 'darwin' ? macSystemAliases[path] : undefined;
  if (!expected || link.uid !== 0n || link.ino === 0n) return undefined;
  try {
    if (realpathSync.native(path) !== expected) return undefined;
    const target = lstatSync(expected, { bigint: true });
    if (!target.isDirectory() || target.ino === 0n) return undefined;
    return `alias:${link.dev}:${link.ino}:${link.mode}:${expected}:${target.dev}:${target.ino}:${target.mode}`;
  } catch { return undefined; }
}
export function pathPins(path: string): PathPin[] {
  const absolute = resolve(path); const base = parse(absolute).root;
  let current = base;
  const pins: PathPin[] = [];
  for (const segment of ['', ...relative(base, absolute).split(/[\\/]/).filter(Boolean)]) {
    if (segment) current = join(current, segment);
    try {
      const stats = lstatSync(current, { bigint: true });
      if (stats.isSymbolicLink()) {
        // macOS exposes these fixed, root-owned OS directories through aliases.
        // Pin both the link and its exact physical directory for Apply rechecks.
        const identity = macSystemAliasIdentity(current, stats);
        if (!identity) throw new Error('unsafe-path');
        pins.push({ path: current, identity });
        continue;
      }
      if (stats.ino === 0n || stats.nlink > 1n && stats.isFile()) throw new Error('unsafe-path');
      pins.push({ path: current, identity: `${stats.dev}:${stats.ino}:${stats.mode}` });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { pins.push({ path: current, identity: 'absent' }); break; }
      throw error;
    }
  }
  return pins;
}
export function pinsMatch(pins: PathPin[]): boolean {
  return pins.every(pin => {
    try { const current = pathPins(pin.path); return current.at(-1)?.path === pin.path && current.at(-1)?.identity === pin.identity; }
    catch { return false; }
  });
}
export function projectRoot(project: string): string {
  if (typeof project !== 'string' || !isAbsolute(project)) throw new Error('project-absolute');
  pathPins(project);
  if (!lstatSync(project).isDirectory()) throw new Error('project-directory');
  return realpathSync.native(project);
}
export function fileTransaction(root: string, stateRoot: string): OwnedFileTransaction {
  const assertPath = (parts: readonly string[]) => {
    if (parts.some(part => !validSegment(part))) throw new Error('invalid-path');
    if (containedPath(stateRoot, resolve(root, ...parts))) throw new Error('reserved-state');
  };
  return new OwnedFileTransaction(root, {
    label: 'Core file', maxFileBytes: 16 * 1024 * 1024, contentDirectoryMode: 0o700,
    stateDirectoryMode: 0o700, statePaths: new Set(),
    assertOwnedPath(path) { assertPath(path.split('/')); },
    assertResolvedSegments(parts) { assertPath(parts); }
  });
}
export function parent(path: string): string { return dirname(path); }
