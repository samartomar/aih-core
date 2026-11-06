// Claim identity for plan installs (contract 5 "Claim identity", C28, C48): the management id, the scope, the CLI and
// the project folder that made the claim, for user-scope members too. The engine keeps claims by one opaque claim key
// derived from exactly those four facts; the receipt's plan facts record them in the open, so `list` and removal map
// claim keys back to management ids, CLIs and projects.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../internal/canonical.js';
import type { PlanItemFacts } from '../internal/custody-items.js';

const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;

/** The engine claim key of one claim: `claim-` and the sha256 of its identity. */
export function claimKey(managementId: string, scope: 'project' | 'user', cli: string | null, project: string | null): string {
  return 'claim-' + createHash('sha256').update(canonicalJson({ managementId, scope, cli, project: project === null ? null : fold(project) })).digest('hex');
}
export const isClaimKey = (id: string): boolean => /^claim-[a-f0-9]{64}$/.test(id);

/** The management id a recorded claim belongs to: its plan facts' item, else the engine id itself. */
export const managementIdOf = (engineId: string, plan: PlanItemFacts | undefined): string => plan?.managementId ?? engineId;

/** Whether a recorded claim was made from this project (`null`: a user-scope request that named none). */
export const sameProject = (plan: PlanItemFacts | undefined, project: string | null): boolean =>
  (plan?.project ?? null) === null ? project === null : project !== null && fold(plan!.project!) === fold(project);
