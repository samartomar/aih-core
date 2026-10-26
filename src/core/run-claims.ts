// Portable wording rules for run result 1.4.0 member checks: what a consumer may claim from a run.
import type { RunMember, RunResult } from './host-types.js';

export interface RunMemberClaims {
  /** The run completed, wrote every member it meant to write, and each of those is present and matching on disk. */
  confirmedOnDisk: boolean;
  /** The run meant to remove members, and every one is absent or restored to its pre-existing value. */
  removed: boolean;
}

/**
 * Apply the published claim rules to a run result. Neither claim is ever inferred from the successful subset of an
 * incomplete, failed, cancelled or rejected run, and a result without member checks supports neither.
 */
export function runMemberClaims(result: Pick<RunResult, 'completion' | 'members'>): RunMemberClaims {
  const members: readonly RunMember[] = Array.isArray(result?.members) ? result.members : [];
  const writes = members.filter(member => member.intent === 'write');
  const removals = members.filter(member => member.intent === 'remove');
  return {
    confirmedOnDisk: result?.completion === 'complete' && writes.length > 0 &&
      writes.every(member => member.outcome === 'written' && member.check === 'present-matching'),
    removed: removals.length > 0 && removals.every(member => member.outcome === 'claim-removed' && member.check === 'absent' ||
      member.outcome === 'restored' && member.check === 'present-matching')
  };
}
