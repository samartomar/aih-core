// What Core placed in a folder it fills by a program (an acquired AI setup, an upstream-setup clone): a manifest of every
// file and link with its bytes' digest, recorded when Core finished placing them. Removal deletes only what still
// matches that record and keeps anything else, so a folder tree is never removed recursively (contract 14).
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readlinkSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { readRegularFile, readRegularFileWithStats } from './fsxn.js';

/** At most this many entries are recorded; a larger tree is not recorded, and its removal then keeps everything. */
export const TREE_ENTRY_LIMIT = 200_000;
const MANIFEST_BYTES = 64 * 1_048_576;
const FILE_BYTES = 4 * 1024 * 1_048_576;

interface TreeEntry { path: string; sha256?: string; link?: string }
interface TreeManifest { schema: 'aih-core-tree'; entries: TreeEntry[] }

/** Each entry under `folder`, without following links, as POSIX relative paths; `skip` names relative paths to leave out. */
function walk(folder: string, skip: ReadonlySet<string>, visit: (path: string, absolute: string, stats: Stats) => void, directories?: string[]): void {
  const stack: string[] = [''];
  while (stack.length) {
    const relative = stack.pop()!;
    const absolute = relative ? join(folder, ...relative.split('/')) : folder;
    for (const name of readdirSync(absolute)) {
      const path = relative ? `${relative}/${name}` : name;
      if (skip.has(path)) continue;
      const at = join(absolute, name); const stats = lstatSync(at);
      if (stats.isDirectory()) { stack.push(path); directories?.push(path); }
      else visit(path, at, stats);
    }
  }
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Records every file and link now under `folder` into `manifest` (an absolute path, normally inside the folder and then
 * skipped). Returns false, recording nothing, when the tree is too large or can't be read whole.
 */
export function recordTree(folder: string, manifest: string, skip: readonly string[] = []): boolean {
  const entries: TreeEntry[] = [];
  try {
    walk(folder, new Set(skip), (path, absolute, stats) => {
      if (entries.length >= TREE_ENTRY_LIMIT) throw new Error('tree-limit');
      if (stats.isSymbolicLink()) { entries.push({ path, link: readlinkSync(absolute) }); return; }
      if (!stats.isFile()) return;
      const read = readRegularFileWithStats(absolute, { maxBytes: FILE_BYTES });
      if (!read) throw new Error('tree-unreadable');
      entries.push({ path, sha256: digest(read.contents) });
    });
    writeFileSync(manifest, JSON.stringify({ schema: 'aih-core-tree', entries } satisfies TreeManifest), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * Removes what `manifest` records under `folder` while its bytes (or link target) still match, then every folder left
 * empty, innermost first, and the manifest itself once nothing else is kept. Everything else stays and is reported in
 * `kept`: files you or the tool added or changed, and the whole folder when no readable manifest exists.
 */
export function removeRecordedTree(folder: string, manifest: string): { removed: boolean; kept: string[] } {
  let recorded: Map<string, TreeEntry>;
  try {
    const bytes = readRegularFile(manifest, { maxBytes: MANIFEST_BYTES });
    const value = bytes ? JSON.parse(bytes.toString('utf8')) as TreeManifest : undefined;
    if (!value || value.schema !== 'aih-core-tree' || !Array.isArray(value.entries)) return { removed: false, kept: ['.'] };
    recorded = new Map(value.entries.map(entry => [entry.path, entry]));
  } catch { return { removed: false, kept: ['.'] }; }
  const kept: string[] = []; const directories: string[] = [];
  try {
    walk(folder, new Set(), (path, absolute, stats) => {
      if (absolute === manifest) return;
      const entry = recorded.get(path);
      let matches = false;
      try {
        if (entry?.link !== undefined) matches = stats.isSymbolicLink() && readlinkSync(absolute) === entry.link;
        else if (entry?.sha256 && stats.isFile()) {
          const read = readRegularFileWithStats(absolute, { maxBytes: FILE_BYTES });
          matches = !!read && digest(read.contents) === entry.sha256;
        }
      } catch { matches = false; }
      if (!matches) { kept.push(path); return; }
      try { unlinkSync(absolute); } catch { kept.push(path); }
    }, directories);
  } catch { return { removed: false, kept: kept.length ? kept.sort() : ['.'] }; }
  // The record goes only with the last recorded file; while anything is kept, a later removal still has it.
  if (!kept.length) try { unlinkSync(manifest); } catch { /* the folder then stays */ }
  for (const path of directories.sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1)))
    try { rmdirSync(join(folder, ...path.split('/'))); } catch { /* holds something kept */ }
  let removed = false;
  if (!kept.length) { try { rmdirSync(folder); removed = true; } catch { removed = false; } }
  return { removed, kept: kept.sort() };
}
