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

/** A licence or notice file an item carries, by its file name (`LICENSE`, `LICENCE.md`, `COPYING`, `NOTICE.txt`, ...). */
export function isLegalFile(descriptor: MemberDescriptor): boolean {
  return descriptor.kind === 'file' && /^(licen[cs]e|copying|notice)([._-][A-Za-z0-9._-]*)?$/i.test(basename(descriptor.path));
}
