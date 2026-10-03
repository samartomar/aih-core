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
  'hook-selector-overlap': { summary: 'Managed hook groups in this array cannot be proven to select distinct elements.',
    steps: ['Reconcile the array manually: restore, deduplicate or retire the missing, ambiguous or overlapping managed group named in the conflict, so each managed group selects exactly one element, then prepare again.',
      'A reviewed resolution for the group being changed cannot fix another group.'] },
  'hook-selector-changed': { summary: 'The selector for this hook group ID changed.',
    steps: ['Remove the whole management selection in one reviewed run, then add the new selection in another, or use a new group ID without a collision.'] },
  'hook-after-collision': { summary: 'The edit would leave a duplicate or colliding hook group.',
    steps: ['Reconcile the array manually, then prepare again.'] },
  'hook-edit-unsafe': { summary: 'The hook array cannot be edited without moving a comment or changing a neighbor.',
    steps: ['Adjust the file manually so the container path leads to an array and no comment is adjacent to the group, then prepare again.'] },
  'duplicate-json-key': { summary: 'The target file repeats an object key, so the intended group cannot be told apart.',
    steps: ['Remove the repeated key from the target file so every object key appears once, then prepare again.'] },
  'unsupported-json-syntax': { summary: 'The target file is not JSON or JSONC this edit can read.',
    steps: ['Correct the target file syntax (comments and trailing commas need the jsonc format), then prepare again.'] },
  'unsupported-json-value': { summary: 'The selected group holds a number JSON cannot represent exactly.',
    steps: ['Replace that number in the target file with a representable value, then prepare again.'] },
  'invalid-utf8': { summary: 'The target file is not valid UTF-8.',
    steps: ['Re-save the target file as UTF-8, then prepare again.'] },
  'existing-content': { summary: 'Unmanaged content already occupies this hook group\'s target.',
    steps: ['Reconcile it manually, or use a reviewed adopt only when exactly one selected group already has the desired content.'] },
  'managed-content-changed': { summary: 'Cleanup found a changed managed hook group and preserved its custody.',
    steps: ['Restore the recorded content or reconcile every claim manually, then prepare again.',
      'Delete the group by hand only when no claim is meant to survive.'] }
});
export const isHookReason = (reason: unknown): reason is string => typeof reason === 'string' && Object.hasOwn(HOOK_REASONS, reason);
const FALLBACK: HookReasonGuidance = { summary: 'The hook group target cannot be edited safely.', steps: ['Review the target file manually, then prepare again.'] };
export const hookGuidanceText = (reason: string): string => (HOOK_REASONS[reason] ?? FALLBACK).steps.join(' ');
/** Fixed text identifying a hook-group conflict diagnostic; every hook conflict message begins with it. */
const HOOK_MESSAGE = 'Hook group ';
export const hookConflictMessage = (group: string, neighbor?: string): string => neighbor === undefined ?
  `${HOOK_MESSAGE}${group} has a conflict that needs review.` :
  `${HOOK_MESSAGE}${neighbor} cannot be proven distinct while changing hook group ${group}; it needs manual review.`;
export const isHookConflict = (item: { code?: unknown; reason?: unknown; message?: unknown }): boolean =>
  item.code === 'STATE_CONFLICT' && isHookReason(item.reason) && typeof item.message === 'string' && item.message.startsWith(HOOK_MESSAGE);
