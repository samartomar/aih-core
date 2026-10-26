// Portable wording rules for run result 1.4.0 member checks: what a consumer may claim from a run.
import type { RunMember, RunResult } from './host-types.js';
import type { RemovalEntry, RemovalSelector } from './removal-types.js';

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

export interface RemovalClaims {
  /**
   * Per requested removal, in request order: `removed` when every member it removes is confirmed absent or restored and
   * nothing of the selection is kept as changed or required; `partly-removed` when those are confirmed but members stay
   * kept as changed or required; `inclusion-removed` when only the named origin went while another keeps the selection;
   * `not-confirmed` for anything else, including a removal that was not prepared.
   */
  removals: (RemovalSelector & { claim: 'removed' | 'partly-removed' | 'inclusion-removed' | 'not-confirmed' })[];
}
/**
 * Apply the removal claim rules of removal preparation 1.2.0 to the run that applied its review, using run result 1.4.0
 * member checks. Only a `complete` run whose `authorization.reviewDigest` is the preparation's `reviewDigest` supports a
 * claim; intended operations alone never do.
 */
export function removalClaims(preparation: { removals?: readonly RemovalEntry[]; reviewDigest?: string },
  result: Pick<RunResult, 'completion' | 'members' | 'operations' | 'authorization'>): RemovalClaims {
  const members: readonly RunMember[] = Array.isArray(result?.members) ? result.members : [];
  const operations = new Set((Array.isArray(result?.operations) ? result.operations : []).map(operation => operation.id));
  // Only the run that applied this very review speaks for it: operation ids repeat across cleanup reviews.
  const complete = result?.completion === 'complete' && typeof preparation?.reviewDigest === 'string' &&
    result.authorization?.reviewDigest === preparation.reviewDigest;
  return { removals: (preparation?.removals ?? []).map(entry => {
    const selector = { managementId: entry.managementId, ...(entry.origin === undefined ? {} : { origin: entry.origin }) };
    const reviewed = entry.members.every(member => member.operationId === null || operations.has(member.operationId));
    if (!complete || entry.disposition !== 'prepared' || !reviewed) return { ...selector, claim: 'not-confirmed' as const };
    if (entry.change === 'remove-origin') return { ...selector, claim: 'inclusion-removed' as const };
    const confirmed = entry.members.filter(member => ['remove', 'restore', 'unregister'].includes(member.action)).every(member => {
      const checked = members.find(item => item.operationId === member.operationId);
      return !!checked && (member.action === 'restore' ? checked.outcome === 'restored' && checked.check === 'present-matching' :
        checked.outcome === 'claim-removed' && checked.check === 'absent');
    });
    const kept = entry.members.some(member => member.action === 'keep-changed' || member.action === 'keep-required');
    return { ...selector, claim: !confirmed ? 'not-confirmed' as const : kept ? 'partly-removed' as const : 'removed' as const };
  }) };
}
