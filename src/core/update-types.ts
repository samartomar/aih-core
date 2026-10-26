// Managed update preparation 1.0.0 types.
import type { Diagnostic, InclusionOrigin, Selection, SelectionMetadata } from './types.js';

/**
 * What the reviewed update does to one member: `add` a new one, `replace` Core's unchanged bytes, leave it `unchanged`,
 * `remove` one the replacement no longer delivers, `restore` the person's earlier value, `unregister` one already gone,
 * `keep-shared` one another selection still owns, or leave it as it is because of a `conflict` (a local edit included).
 */
export type UpdateMemberAction = 'add' | 'replace' | 'unchanged' | 'remove' | 'restore' | 'unregister' | 'keep-shared' | 'conflict';
/** One update: the installed selection's management id and the exact replacement selection the consumer chose. */
export interface UpdateSelector { managementId: string; replacement: Selection }
/** The item facts on one side of an update, as inventory 1.1.0 reports them; `null` when none are recorded or given. */
export interface UpdateItemFacts {
  name: string | null; kind: SelectionMetadata['kind'] | null; tool: string | null;
  framework: string | null; item: SelectionMetadata['item'] | null;
  origins: InclusionOrigin[];
}
/** One member an update lists before Apply. */
export interface UpdateMember {
  kind: 'file' | 'text-block' | 'entry-block' | 'entry-pointer' | 'config-entry' | 'config-member' | 'hook-group-member';
  path: string; pointer?: string; blockId?: string; groupId?: string;
  /** Present when the member is an approval for one server in that tool. */
  approval?: { tool: string };
  action: UpdateMemberAction;
  /** Why the member is left as it is, kept, restored or only unregistered. */
  reason?: string;
  operationId: string;
}
export interface UpdateEntry {
  managementId: string;
  disposition: 'prepared' | 'absent' | 'reconcile-required' | 'unavailable' | 'invalid';
  /** The replacement's selection id in the review; present for `prepared`. */
  selectionId?: string;
  /** Recorded facts of the installed selection, and those the replacement carries; present for `prepared`. */
  from?: UpdateItemFacts | null; to?: UpdateItemFacts | null;
  diagnostics: Diagnostic[];
  members: UpdateMember[];
}
