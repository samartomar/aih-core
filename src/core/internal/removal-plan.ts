// Removal preparation 1.2.0: how the cleanup-only engine reports each member it plans to remove or keep.
import { basename } from 'node:path';
import type { ItemFacts } from './custody-items.js';
import type { MemberDescriptor } from './recipe-lifecycle.js';
import type { RemovalMemberAction } from '../removal-types.js';

/** One lifecycle cleanup step as planned: its member, the claims it removes and the named action. */
export interface CleanupPlanRow {
  operationId: string; root: string; descriptor: MemberDescriptor; approval?: { tool: string }; redactedPath?: string;
  /** Claim identities this step releases. */
  removed: string[];
  action: RemovalMemberAction; reason?: string;
}
/** Engine options used only by removal preparation 1.2.0 over a cleanup-only policy. */
export interface CleanupOptions {
  /** A recorded inclusion released from a selection another origin keeps: the recorded facts with the remaining origins. */
  originReleases: { root: string; id: string; facts: ItemFacts }[];
  /** Receives the planned rows once the review's cleanup steps are final. */
  plan(rows: CleanupPlanRow[]): void;
}

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown', 'rst', 'adoc', 'asciidoc', 'org', 'html', 'htm']);
/** A licence or notice name: (UN)LICENSE/LICENCE(S), COPYING, COPYRIGHT or (THIRD-PARTY) NOTICE(S), optionally with an SPDX-like suffix. */
const LEGAL_STEM = /^(?:(?:un)?licen[cs]es?|copying(?:\.lesser)?|copyright|(?:third[-_ ]?party[-_ ]?)?notices?)(?:[-_.][A-Za-z0-9][A-Za-z0-9.+-]*)?$/i;
/**
 * A licence or notice file an item carries, by its file name. A text extension is ignored; any other extension must
 * belong to an SPDX-like suffix (`LICENSE.Apache-2.0`), so source files such as `license-check.js` never match.
 */
export function isLegalFile(descriptor: MemberDescriptor): boolean {
  if (descriptor.kind !== 'file') return false;
  const name = basename(descriptor.path);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const stem = TEXT_EXTENSIONS.has(extension) ? name.slice(0, dot) : name;
  if (!LEGAL_STEM.test(stem)) return false;
  // Past the legal word, an extension-looking tail of letters only (".js", ".py", ".sh") is a source file, not a suffix.
  const tail = /^(?:(?:un)?licen[cs]es?|copying(?:\.lesser)?|copyright|(?:third[-_ ]?party[-_ ]?)?notices?)(.*)$/i.exec(stem)![1]!;
  // An upper-case tail (".MIT", ".BSD") or one carrying a version (".Apache-2.0") is an SPDX-like suffix.
  return !/\.[A-Za-z]{1,4}$/.test(tail) || /^[-_.](?:[A-Za-z]+-)?[0-9]/.test(tail) || /^\.[A-Z][A-Z0-9.+-]*$/.test(tail) || /^\.lesser$/i.test(tail);
}
