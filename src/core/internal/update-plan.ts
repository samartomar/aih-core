// Managed update preparation 1.0.0: how the policy engine reports each member a reviewed update touches.
import type { MemberDescriptor } from './recipe-lifecycle.js';
import type { UpdateMemberAction } from '../update-types.js';

/** One member of one review step, with what the review does to it. */
export interface PlannedMember {
  operationId: string; selectionId: string | null;
  /** The selection that authors the step, or the selections whose claims a cleanup step releases. */
  managementIds: string[];
  root: string; descriptor: MemberDescriptor; redactedPath?: string; approval?: { tool: string };
  action: UpdateMemberAction; reason?: string;
}
/**
 * Engine options used only by managed update preparation. A replacement's claim keeps the dependency edges recorded at
 * install as well as its own, since a replacement can name only other replacements as `requires`.
 */
export interface UpdateOptions {
  /** Receives every planned member once the review's steps are final. */
  plan(rows: PlannedMember[]): void;
}
