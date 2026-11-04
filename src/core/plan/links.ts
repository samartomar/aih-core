// Folder links (contract 8.1 `link`, C29, D111, L1, L2): a symlink on macOS and Linux; on Windows a junction for the
// CLIs confirmed to load junctioned folders, and a real copy for the others. The receipt claims a link through a small
// record file Core writes beside its other shared content (`~/.aihq/links/`), so the engine's claims decide when the
// last claim goes; the link itself is placed just before its record is written and removed once the record is.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../internal/canonical.js';
import type { LinkFacts } from '../internal/custody-items.js';

/** Where link records live, under the user root. */
export const LINK_RECORDS = '.aihq/links';
/** CLIs observed to load a junctioned skill folder on Windows (C29, L1, L2); Antigravity, Cursor and dsh get copies. */
export const JUNCTION_CLIS: readonly string[] = Object.freeze(['claude-code', 'codex', 'copilot', 'kimi', 'kiro', 'opencode']);

const fold = (path: string): string => process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
/** The record of one link path, relative to the user root. */
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

/** Places a junction or symlink (Apply, before its record is written). Never replaces what is already there. */
export function placeLink(home: string, link: LinkFacts): { status: 'passed' | 'failed'; reason: string; effectsUncertain: boolean } {
  const found = inspectLink(home, link.path, link.to);
  if (found === 'ours') return { status: 'passed', reason: 'already-linked', effectsUncertain: false };
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
