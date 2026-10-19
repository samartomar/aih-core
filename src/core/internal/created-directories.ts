import { lstatSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathPins, sha256, validSegment } from './host-files.js';

/** Protected absence-before evidence, recorded only after our mkdir succeeds. */
export type CreatedDirectories = Record<string, string>;

export function directoryIdentity(root: string, path: string): string | undefined {
  const absolute = join(root, ...path.split('/'));
  const pin = pathPins(absolute).at(-1);
  if (pin?.path !== absolute || pin.identity === 'absent' || !lstatSync(absolute).isDirectory()) return undefined;
  return sha256(pin.identity);
}

export function directoryParents(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

export function validCreatedDirectories(value: unknown): value is CreatedDirectories {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length <= 8192 && Object.entries(value).every(([path, identity]) =>
      path.length <= 1024 && path.split('/').every(validSegment) &&
      typeof identity === 'string' && /^[a-f0-9]{64}$/.test(identity));
}

/** Each removal is nonrecursive and limited to reviewed parents of a removed file. */
export function removeCreatedDirectories(root: string, stored: CreatedDirectories, reviewed: CreatedDirectories,
    retainedPaths: string[]): CreatedDirectories {
  const next = { ...stored };
  const folded = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  for (const path of Object.keys(reviewed).sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (retainedPaths.some(member => folded(member).startsWith(`${folded(path)}/`))) continue;
    try {
      if (stored[path] !== reviewed[path] || directoryIdentity(root, path) !== reviewed[path]) continue;
      rmdirSync(join(root, ...path.split('/')));
      delete next[path];
    } catch {
      // Foreign content, links, replacement or inaccessible directories stay put.
      // Cleanup is conditional; it never broadens a file-removal authorization.
    }
  }
  return next;
}
