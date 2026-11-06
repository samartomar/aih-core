// Folder links (contract 8.1 `link`, C29, D111, L1, L2): a symlink on macOS and Linux; on Windows a junction for the
// CLIs confirmed to load junctioned folders, and a real copy for the others. Each claim on a link keeps a small record in
// Core's private state (its own `~/.aih/core/content/<claim>/links/` folder, contract 5); the link itself is placed just
// before the first record is written, and removed once no claim's record names it any more.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { readOwnership } from '../internal/state.js';
import { readRegularFileWithStats } from '../internal/fsxn.js';
import { pathPins, pinsMatch, type PathPin } from '../internal/host-files.js';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../internal/canonical.js';
import type { LinkFacts } from '../internal/custody-items.js';
import { cliFacts } from '../../harness/cli-facts.mjs';

/** Where a claim's link records live, inside its Core state folder. */
export const LINK_RECORDS = 'links';
/** CLIs observed to load a junctioned skill folder on Windows (C29, L1, L2), from the Harness CLI facts; others get copies. */
export const JUNCTION_CLIS: readonly string[] = cliFacts.junctionLinks;

const fold = (path: string): string => process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
/** The record of one link path, relative to the claim's Core state folder. */
export const linkRecordPath = (path: string): string =>
  `${LINK_RECORDS}/${createHash('sha256').update(fold(path)).digest('hex')}.json`;
/** The record's bytes: what the link is, never anything about who claims it, so every claim shares one record. */
export const linkRecordBytes = (path: string, to: string, linkType: 'junction' | 'symlink'): Buffer =>
  Buffer.from(canonicalJson({ path, to, linkType }) + '\n');

/** How a `link` step for these CLIs lands on this host. A step that records no CLIs can't be confirmed: a copy on Windows. */
export function linkTypeFor(clis: string[]): 'junction' | 'symlink' | 'copy' {
  if (process.platform !== 'win32') return 'symlink';
  return clis.length > 0 && clis.every(cli => JUNCTION_CLIS.includes(cli)) ? 'junction' : 'copy';
}

/** What is at a link's place now: nothing, Core's link to its target, or something else. */
export function inspectLink(home: string, path: string, to: string): 'absent' | 'ours' | 'other' {
  const at = join(home, ...path.split('/'));
  let stats;
  try { stats = lstatSync(at); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'other'; }
  if (!stats.isSymbolicLink()) return 'other';
  try {
    const found = resolve(at, '..', readlinkSync(at)).replace(/[\\/]+$/, '');
    return fold(found) === fold(resolve(home, ...to.split('/'))) ? 'ours' : 'other';
  } catch { return 'other'; }
}
/** A link-place file shown in a conflict is read only up to this size; a larger one shows no bytes. */
const PLACE_BYTES_MAX = 1_048_576;
/**
 * The bytes of a file you keep at a link's place, to show in its conflict; `null` for a folder, a link, nothing, or a
 * file over 1 MiB. The file is opened without following a link and read only within that bound.
 */
export function placeBytes(home: string, path: string): Buffer | null {
  const at = join(home, ...path.split('/'));
  try {
    if (!lstatSync(at).isFile()) return null;
    const read = readRegularFileWithStats(at, { maxBytes: PLACE_BYTES_MAX });
    return read ? Buffer.from(read.contents) : null;
  } catch { return null; }
}
export function linkState(home: string, link: LinkFacts): 'matching' | 'changed-by-you' | 'missing' | 'generated' {
  const found = inspectLink(home, link.path, link.to);
  if (found === 'ours') {
    // A version folder holding a file no claim recorded is not what Core placed there; one holding only files a system
    // or a runtime generates beside them (`.DS_Store`, a recorded module's compiled `.pyc`) is `generated`.
    const contents = folderContents(home, link.to);
    if (contents.extras.length) return 'changed-by-you';
    if (contents.generated.length) return 'generated';
  }
  return found === 'ours' ? 'matching' : found === 'absent' ? 'missing' : 'changed-by-you';
}
/**
 * Removes every `__pycache__` folder under `folder` (without following links): its regular files and links are unlinked,
 * then the folder itself. A compiled module is regenerated from its recorded source, so none is ever trusted. Reports
 * false when a cache folder holds anything else, or can't be cleared.
 */
export function clearCompiledCaches(folder: string): boolean {
  const stack = [folder]; let seen = 0; let cleared = true;
  while (stack.length) {
    const current = stack.pop()!;
    let names: string[];
    try { names = readdirSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return false; }
    for (const name of names) {
      if (++seen > FOLDER_ENTRY_LIMIT) return false;
      const at = join(current, name);
      let stats;
      try { stats = lstatSync(at); } catch { return false; }
      if (!stats.isDirectory()) continue;
      if (name !== '__pycache__') { stack.push(at); continue; }
      try {
        for (const entry of readdirSync(at)) {
          const inner = join(at, entry);
          if (lstatSync(inner).isDirectory()) { cleared = false; continue; }
          unlinkSync(inner);
        }
        rmdirSync(at);
      } catch { cleared = false; }
    }
  }
  return cleared;
}
/** Files an operating system's file browser leaves in any folder it shows. */
const SYSTEM_LEFTOVERS = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
/** A compiled module's name in `__pycache__`: `<module>.cpython-<tag>.pyc` (optionally `.opt-<n>`). */
const COMPILED = /^(.+)\.cpython-[0-9a-z_]+(?:\.opt-[0-9]+)?\.pyc$/i;
/** A version folder is listed only up to this many entries; a larger one counts as holding unrecorded files. */
const FOLDER_ENTRY_LIMIT = 10_000;
/**
 * The entries in a version folder `to` (relative to it, without following links) that are neither among `planned`
 * (home-relative paths this plan writes) nor a member any receipt in the home records. Empty when the folder is absent.
 */
export function folderExtras(home: string, to: string, planned: Iterable<string> = []): string[] {
  return folderContents(home, to, planned).extras;
}
/**
 * `folderExtras`, and apart from them the files it ignores as `generated`: an OS file-browser leftover, or a compiled
 * `__pycache__/<module>.cpython-*.pyc` whose `<module>.py` is recorded or planned in the folder above.
 */
export function folderContents(home: string, to: string, planned: Iterable<string> = []): { extras: string[]; generated: string[] } {
  const root = join(home, ...to.split('/'));
  try { if (!lstatSync(root).isDirectory()) return { extras: ['.'], generated: [] }; }
  catch (error) { return { extras: (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['.'], generated: [] }; }
  const allowed = new Set([...planned].map(fold));
  try {
    for (const [key, owner] of Object.entries(readOwnership(home, false).value.members ?? {}))
      allowed.add(fold((owner as { descriptor?: { path?: string } }).descriptor?.path ?? key));
  } catch { /* no receipt: only the planned writes are known */ }
  const extras: string[] = []; const generated: string[] = []; const stack = ['']; let seen = 0;
  const compiledFor = (path: string): boolean => {
    const parts = path.split('/'); const name = parts.pop()!; const cache = parts.pop();
    const module = COMPILED.exec(name)?.[1];
    return cache === '__pycache__' && !!module && allowed.has(fold(`${to}/${[...parts, `${module}.py`].join('/')}`));
  };
  while (stack.length) {
    const relative = stack.pop()!;
    let names: string[];
    try { names = readdirSync(relative ? join(root, ...relative.split('/')) : root); } catch { return { extras: ['.'], generated }; }
    for (const name of names) {
      if (++seen > FOLDER_ENTRY_LIMIT) return { extras: [...extras, '…'], generated };
      const path = relative ? `${relative}/${name}` : name;
      let stats;
      try { stats = lstatSync(join(root, ...path.split('/'))); } catch { extras.push(path); continue; }
      if (stats.isDirectory()) { stack.push(path); continue; }
      if (allowed.has(fold(`${to}/${path}`))) continue;
      if (stats.isFile() && (SYSTEM_LEFTOVERS.has(name.toLowerCase()) || compiledFor(path))) generated.push(path);
      else extras.push(path);
    }
  }
  return { extras: extras.sort(), generated: generated.sort() };
}
/** The link's parent folders that don't exist yet, outermost first: the ones Core creates and removes again. */
export function missingParents(home: string, path: string): string[] {
  const segments = path.split('/');
  const missing: string[] = [];
  for (let at = 1; at < segments.length; at++) {
    const parent = segments.slice(0, at).join('/');
    try { lstatSync(join(home, ...segments.slice(0, at))); } catch { missing.push(parent); }
  }
  return missing;
}

/**
 * Places a junction or symlink (Apply, before its record is written). Never replaces what is already there, except, for
 * an update, Core's own link to the earlier version folder `from`, which is repointed (contract 12 "Version folder moved").
 */
export function placeLink(home: string, link: LinkFacts, from?: string, planned?: readonly string[]): { status: 'passed' | 'failed'; reason: string; effectsUncertain: boolean } {
  // The version folder still holds only what the plan writes and receipts record (re-listed now, as at Prepare).
  if (planned && folderExtras(home, link.to, planned).length) return { status: 'failed', reason: 'link-target-changed', effectsUncertain: false };
  // Compiled caches are regenerable and never trusted: they go before the folder is linked (or linked again).
  if (!clearCompiledCaches(join(home, ...link.to.split('/')))) return { status: 'failed', reason: 'link-target-changed', effectsUncertain: false };
  let found = inspectLink(home, link.path, link.to);
  if (found === 'ours') return { status: 'passed', reason: 'already-linked', effectsUncertain: false };
  if (from !== undefined && found === 'other' && inspectLink(home, link.path, from) === 'ours') {
    const at = join(home, ...link.path.split('/'));
    // Only the link goes, never what it points to: a junction is removed as a folder entry, a symlink unlinked.
    try { rmdirSync(at); } catch { try { unlinkSync(at); } catch { return { status: 'failed', reason: 'relink-failed', effectsUncertain: false }; } }
    found = inspectLink(home, link.path, link.to);
    if (found !== 'absent') return { status: 'failed', reason: 'relink-failed', effectsUncertain: true };
  }
  if (found === 'other') return { status: 'failed', reason: 'link-place-taken', effectsUncertain: false };
  const segments = link.path.split('/');
  const unsafe = { status: 'failed' as const, reason: 'link-parent-unsafe', effectsUncertain: false };
  try {
    // Every parent is pinned as a real folder (no link anywhere in its chain) once checked or created; the chain is
    // re-checked against those pins just before the link is made and again after, so a parent swapped for a link in
    // between is refused, and a link made through it is taken back.
    let pins: PathPin[] = [];
    try { pins = pathPins(home); } catch { return unsafe; }
    for (let at = 1; at < segments.length; at++) {
      const parent = join(home, ...segments.slice(0, at));
      if (!pinsMatch(pins)) return unsafe;
      try { lstatSync(parent); } catch { mkdirSync(parent); }
      let stats;
      try { stats = lstatSync(parent); } catch { return unsafe; }
      // Never place a link through another link or into something that is not a folder.
      if (stats.isSymbolicLink() || !stats.isDirectory()) return unsafe;
      try { pins = pathPins(parent); } catch { return unsafe; }
    }
    const place = join(home, ...segments);
    if (!pinsMatch(pins)) return unsafe;
    symlinkSync(resolve(home, ...link.to.split('/')), place, link.linkType === 'junction' ? 'junction' : 'dir');
    if (!pinsMatch(pins)) {
      try { rmdirSync(place); } catch { try { unlinkSync(place); } catch { /* left as found below */ } }
      return { status: 'failed', reason: 'link-parent-unsafe', effectsUncertain: true };
    }
    return { status: 'passed', reason: 'linked', effectsUncertain: false };
  } catch { return { status: 'failed', reason: 'link-failed', effectsUncertain: true }; }
}

/**
 * Removes a released link: only Core's link to its target, never a folder you put there, and then the parent folders
 * Core created for it, innermost first, while they are empty.
 */
export function removeLink(home: string, link: LinkFacts): void {
  const at = join(home, ...link.path.split('/'));
  if (inspectLink(home, link.path, link.to) === 'ours') {
    try { rmdirSync(at); } catch { try { unlinkSync(at); } catch { return; } }
  }
  for (const parent of [...link.created].sort((a, b) => b.split('/').length - a.split('/').length))
    try { rmdirSync(join(home, ...parent.split('/'))); } catch { /* not empty, or not ours to remove */ }
}
