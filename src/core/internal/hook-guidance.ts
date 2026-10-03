// Fixed, portable next actions for each hook-group conflict reason. No observed
// group bytes, local path or authored value is ever interpolated into this text.
export interface HookReasonGuidance { summary: string; steps: string[] }
export const HOOK_REASONS: Readonly<Record<string, HookReasonGuidance>> = Object.freeze({
  'owned-hook-missing': { summary: 'The managed hook group was not found at its selector.',
    steps: ['Review the target file; a neighbor was never edited by this operation.',
      'To add the group again without touching other groups, prepare again and approve a reviewed replace using this operation\'s observed target digest.'] },
  'owned-hook-edited': { summary: 'The managed hook group was edited locally.',
    steps: ['Restore the group\'s recorded content, or approve a reviewed replace using this operation\'s observed target digest.',
      'Neighboring groups are never replaced.'] },
  'owned-hook-shared-drift': { summary: 'A hook group shared by several claims was edited.',
    steps: ['Restore the group from the surviving claimant\'s authored recipe, then prepare again; a reviewed replace cannot rewrite shared custody.',
      'To retire every claim, remove the group manually and prepare a policy that retires them all. Do not delete it while a claim should survive.'] },
  'hook-shared-change': { summary: 'Another claim still requires this hook group, so its content cannot change.',
    steps: ['Keep the shared content, or retire every claim together, then prepare again.'] },
  'hook-prior-conflict': { summary: 'An earlier step on this same hook group conflicted.',
    steps: ['Resolve the earlier step\'s conflict first, then prepare again; this step proposes no deletion.'] },
  'hook-selector-ambiguous': { summary: 'More than one hook group matches the selector.',
    steps: ['Reconcile the array manually so exactly one group matches, then prepare again.', 'No reviewed replace or adopt guesses which group to change.'] },
  'hook-selector-overlap': { summary: 'Distinct managed hook groups would select the same element.',
    steps: ['Reconcile the array manually so each managed group selects its own element, then prepare again.'] },
  'hook-selector-changed': { summary: 'The selector for this hook group ID changed.',
    steps: ['Remove the whole management selection in one reviewed run, then add the new selection in another, or use a new group ID without a collision.'] },
  'hook-after-collision': { summary: 'The edit would leave a duplicate or colliding hook group.',
    steps: ['Reconcile the array manually, then prepare again.'] },
  'hook-edit-unsafe': { summary: 'The hook array cannot be edited without moving a comment or changing a neighbor.',
    steps: ['Adjust the file manually so no comment is adjacent to the group, then prepare again.'] },
  'existing-content': { summary: 'Unmanaged content already occupies this hook group\'s target.',
    steps: ['Reconcile it manually, or use a reviewed adopt only when exactly one selected group already has the desired content.'] },
  'managed-content-changed': { summary: 'Cleanup found a changed managed hook group and preserved its custody.',
    steps: ['Restore the recorded content or reconcile every claim manually, then prepare again.',
      'Delete the group by hand only when no claim is meant to survive.'] }
});
export const isHookReason = (reason: unknown): reason is string => typeof reason === 'string' && Object.hasOwn(HOOK_REASONS, reason);
export const hookGuidanceText = (reason: string): string => (HOOK_REASONS[reason] ?? HOOK_REASONS['hook-edit-unsafe']!).steps.join(' ');
