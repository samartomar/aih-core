// Folder links (contract 8.1 `link`, C29, D111, L1, L2): a symlink on macOS and Linux; on Windows a junction for the
// CLIs confirmed to load junctioned folders, and a real copy for the others. Each claim on a link keeps a small record in
// Core's private state (its own `~/.aih/core/content/<claim>/links/` folder, contract 5); the link itself is placed just
// before the first record is written, and removed once no claim's record names it any more.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
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
/** The bytes of a file you keep at a link's place, to show in its conflict; `null` for a folder, a link or nothing. */
export function placeBytes(home: string, path: string): Buffer | null {
  const at = join(home, ...path.split('/'));
  try { return lstatSync(at).isFile() ? readFileSync(at) : null; } catch { return null; }
}
export function linkState(home: string, link: LinkFacts): 'matching' | 'changed-by-you' | 'missing' {
  const found = inspectLink(home, link.path, link.to);
  return found === 'ours' ? 'matching' : found === 'absent' ? 'missing' : 'changed-by-you';
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
export function placeLink(home: string, link: LinkFacts, from?: string): { status: 'passed' | 'failed'; reason: string; effectsUncertain: boolean } {
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
  try {
    for (let at = 1; at < segments.length; at++) {
      const parent = join(home, ...segments.slice(0, at));
      let stats;
      try { stats = lstatSync(parent); } catch { mkdirSync(parent); continue; }
      // Never place a link through another link or into something that is not a folder.
      if (stats.isSymbolicLink() || !stats.isDirectory()) return { status: 'failed', reason: 'link-parent-unsafe', effectsUncertain: false };
    }
    symlinkSync(resolve(home, ...link.to.split('/')), join(home, ...segments), link.linkType === 'junction' ? 'junction' : 'dir');
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
