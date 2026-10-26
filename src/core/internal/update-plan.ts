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
