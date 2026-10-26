// Removal preparation 1.2.0 types shared by Node removal and the portable removal claim rules.
import type { Diagnostic } from './types.js';

export type RemovalMemberAction = 'remove' | 'restore' | 'unregister' | 'keep-shared' | 'keep-changed' | 'keep-required';
/** Removal preparation 1.2.0: one removal, optionally of one recorded inclusion only (as inventory 1.1.0 reports it). */
export interface RemovalSelector {
  managementId: string;
  origin?: { set: { framework: string; setId: string; setSha256: string } } | { reasonIncluded: 'chosen' };
}
/** One member a removal lists before Apply, with the action the review takes on it. */
export interface RemovalMember {
  kind: 'file' | 'text-block' | 'entry-block' | 'entry-pointer' | 'config-entry' | 'config-member' | 'hook-group-member';
  path: string; pointer?: string; blockId?: string; groupId?: string;
  /** Present when the member is an approval Core wrote for one server in that tool. */
  approval?: { tool: string };
  action: RemovalMemberAction;
  /** Why the member is kept, restored or only unregistered; absent for `remove`. */
  reason?: string;
  /** The review operation that carries the action; `null` when the review changes no target for it. */
  operationId: string | null;
}
export interface RemovalEntry extends RemovalSelector {
  disposition: 'prepared' | 'absent' | 'retained' | 'reconcile-required' | 'unavailable';
  /** For `prepared`: the whole selection, or only the named inclusion while another origin keeps it. */
  change?: 'remove-selection' | 'remove-origin';
  diagnostics: Diagnostic[];
  members: RemovalMember[];
}
