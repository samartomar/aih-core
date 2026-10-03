// Decides one owned hook-group step from exact observed bytes and projected
// custody. Pure: no host access, no execution, and never any copy of observed
// group bytes into its result (only digests and an index leave this module).
import { canonicalJson } from './canonical.js';
import { sha256 } from './host-files.js';
import { RecipeEditError } from './recipe-editors.js';
import { appendHookGroup, locateHookGroups, removeHookGroup, replaceHookGroup, type HookElement, type HookLocation } from './hook-group.js';
import type { Claim, HookDescriptor } from './recipe-lifecycle.js';
import type { Owner } from './state.js';
import type { JsonObject } from '../types.js';

export interface HookAuthored {
  format: 'json' | 'jsonc'; container: string[]; groupId: string;
  selector: { path: (string | number)[]; value: string }; action: 'set' | 'remove'; group?: JsonObject;
}
export interface RetainedHook { key: string; descriptor: HookDescriptor }
export interface HookDetails {
  container: string[]; groupId: string; selector: { path: (string | number)[]; valueSha256: string }; action: 'set' | 'remove';
  matchedIndex: number | null; memberBeforeSha256: string | null; memberAfterSha256: string | null;
  targetBeforeSha256: string | null; desiredGroup: JsonObject | null;
}
export interface HookDecision {
  effect: 'create-file' | 'replace-file' | 'already-satisfied' | 'conflict';
  /** Fixed safe conflict reason, or `explicit-replace` / `explicit-adopt` for a reviewed resolution. */
  reason?: string;
  after: Buffer | null;
  /** The member's projected owner after this step; null releases custody. */
  custody: Owner | null;
  /** Custody changes without a target write. */
  custodyOnly: boolean;
  managed: boolean;
  details: HookDetails;
  /** Group ID of a different retained group that blocked this step, so the conflict never blames the current group. */
  neighbor?: string;
}
export interface HookStepInput {
  authored: HookAuthored; path: string; key: string; before: Buffer | null; owner: Owner | undefined;
  retained: RetainedHook[]; resolution: 'replace' | 'adopt' | undefined;
  isMine(claim: Claim): boolean; addMine(claims: Claim[]): Claim[];
  recipeIdentity: string; mode: number;
  /** A fixed conflict reason decided before any observation (an earlier step on this member conflicted). */
  forced?: string;
}
const digestOf = (bytes: Buffer | null): string | null => bytes === null ? null : sha256(bytes);
const canonicalDigest = (value: unknown): string => sha256(canonicalJson(value));
const sameSelector = (a: { path: (string | number)[]; valueSha256: string }, b: { path: (string | number)[]; valueSha256: string }): boolean =>
  a.valueSha256 === b.valueSha256 && canonicalJson(a.path) === canonicalJson(b.path);

type ImageProblem = { reason: string; neighbor?: string };
/** Before/after-image proof that every retained descriptor still selects exactly its own distinct element. */
function imageConflict(a: HookAuthored, before: Buffer | null, after: Buffer | null, retained: RetainedHook[],
    current: { key: string; selector: { path: (string | number)[]; valueSha256: string } } | null, currentWasPresent: boolean): ImageProblem | undefined {
  const all = [...retained.map(item => ({ key: item.key, groupId: item.descriptor.groupId, selector: item.descriptor.selector, other: true })),
    ...(current ? [{ key: current.key, groupId: a.groupId, selector: current.selector, other: false }] : [])];
  const locate = (bytes: Buffer | null) => all.map(item => ({ ...item, found: locateHookGroups(a.format, bytes, a.container, item.selector) }));
  const distinct = (rows: ReturnType<typeof locate>): boolean => {
    const claimed = new Set<number>();
    for (const row of rows) for (const candidate of row.found.candidates) {
      if (claimed.has(candidate.index)) return false;
      claimed.add(candidate.index);
    }
    return true;
  };
  const prior = locate(before);
  // A different retained group that is missing or ambiguous cannot be proven distinct; the fix is manual and never a replace of this group.
  for (const row of prior) if (row.other && row.found.candidates.length !== 1) return { reason: 'hook-selector-overlap', neighbor: row.groupId };
  if (!distinct(prior.filter(row => row.other || currentWasPresent))) return { reason: 'hook-selector-overlap' };
  if (after === before || after !== null && before !== null && after.equals(before)) return undefined;
  const next = locate(after);
  for (const row of next) {
    if (row.found.candidates.length !== 1) return row.other ? { reason: 'hook-selector-overlap', neighbor: row.groupId } : { reason: 'hook-after-collision' };
    const element = row.found.candidates[0]!;
    if (row.other && element.rawSha256 !== prior.find(item => item.key === row.key)!.found.candidates[0]!.rawSha256) return { reason: 'hook-selector-overlap', neighbor: row.groupId };
    if (row.found.elements.filter(item => item.canonicalSha256 === element.canonicalSha256).length > 1) return { reason: 'hook-after-collision' };
  }
  return distinct(next) ? undefined : { reason: 'hook-selector-overlap' };
}

function details(a: HookAuthored, before: Buffer | null, location: HookLocation | undefined, memberAfter: string | null,
    desired: JsonObject | undefined): HookDetails {
  const found = location?.candidates[0];
  return { container: [...a.container], groupId: a.groupId, selector: { path: [...a.selector.path], valueSha256: sha256(a.selector.value) },
    action: a.action, matchedIndex: found?.index ?? null, memberBeforeSha256: found?.canonicalSha256 ?? null, memberAfterSha256: memberAfter,
    targetBeforeSha256: digestOf(before), desiredGroup: a.action === 'set' && desired ? desired : null };
}

export function decideHookStep(i: HookStepInput): HookDecision {
  const a = i.authored; const owner = i.owner;
  const selector = { path: a.selector.path, valueSha256: sha256(a.selector.value) };
  const claims = owner?.claims ?? [];
  const mine = claims.find(i.isMine);
  const others = claims.filter(claim => claim !== mine);
  const wanted = a.action === 'set' ? canonicalDigest(a.group) : null;
  const shell = (location: HookLocation | undefined, memberAfter: string | null) => details(a, i.before, location, memberAfter, a.group);
  let location: HookLocation | undefined;
  const conflict = (reason: string, neighbor?: string): HookDecision => ({ effect: 'conflict', reason, after: i.before, custody: owner ?? null, custodyOnly: false,
    managed: false, details: shell(location, null), ...(neighbor ? { neighbor } : {}) });
  if (i.forced) return conflict(i.forced);
  try { location = locateHookGroups(a.format, i.before, a.container, selector); }
  catch (error) { if (error instanceof RecipeEditError) return conflict(error.reason); throw error; }
  const hook = owner?.descriptor?.kind === 'hook' ? owner.descriptor : undefined;
  if (hook && !sameSelector(hook.selector, selector)) return conflict('hook-selector-changed');
  if (location.candidates.length > 1) return conflict('hook-selector-ambiguous');
  const found: HookElement | undefined = location.candidates[0];
  const descriptor: HookDescriptor = { path: i.path, kind: 'hook', format: a.format, container: a.container, groupId: a.groupId, selector };
  const build = (claimList: Claim[], element: HookElement | undefined, identity: string, managementId: string): Owner => ({
    managementId, recipeIdentity: identity, sha256: element?.rawSha256 ?? '',
    mode: i.mode, descriptor, claims: claimList, canonicalSha256: element?.canonicalSha256 ?? '' });
  const replace = i.resolution === 'replace';
  const adopt = i.resolution === 'adopt';
  const ownerState = !!mine && !!found && !!owner && found.rawSha256 === owner.sha256 && found.canonicalSha256 === owner.canonicalSha256;

  /** Writes `after`, proves the images, and projects custody for the located element. */
  const finish = (after: Buffer | null, claimList: Claim[], retained: boolean, reason?: string): HookDecision => {
    const written = !(after === null && i.before === null) && !(after !== null && i.before !== null && after.equals(i.before));
    const problem = imageConflict(a, i.before, after, i.retained, retained ? { key: i.key, selector } : null, !!found);
    if (problem) return conflict(problem.reason, problem.neighbor);
    const element = retained ? locateHookGroups(a.format, after, a.container, selector).candidates[0] : undefined;
    const effect = !written ? 'already-satisfied' : i.before === null ? 'create-file' : 'replace-file';
    const identity = a.action === 'set' ? i.recipeIdentity : owner?.recipeIdentity ?? i.recipeIdentity;
    const custody = retained && element ? build(claimList, element, identity, claimList.find(i.isMine)?.managementId ?? claimList[0]!.managementId) :
      claimList.length && owner ? { ...owner, claims: claimList, managementId: claimList[0]!.managementId } : null;
    const after256 = retained ? element?.canonicalSha256 ?? null : null;
    return { effect, ...(reason ? { reason } : {}), after, custody, custodyOnly: effect === 'already-satisfied' && canonicalJson(custody) !== canonicalJson(owner ?? null),
      managed: ownerState, details: shell(location, after256) };
  };
  const write = (): Buffer => {
    if (!found) return appendHookGroup(a.format, i.before, a.container, a.group!);
    return replaceHookGroup(a.format, i.before!, a.container, found.index, a.group!);
  };
  const attempt = (act: () => HookDecision): HookDecision => {
    try { return act(); }
    catch (error) { if (error instanceof RecipeEditError) return conflict(error.reason); throw error; }
  };

  if (a.action === 'set') {
    if (!owner) {
      if (!found) return attempt(() => finish(write(), i.addMine([]), true));
      if (found.canonicalSha256 === wanted && adopt) return attempt(() => finish(i.before, i.addMine([]), true, 'explicit-adopt'));
      if (adopt) throw new Error('resolution-invalid');
      return conflict('existing-content');
    }
    if (adopt) throw new Error('resolution-invalid');
    const shared = others.length > 0;
    if (!found) {
      if (!replace) return conflict('owned-hook-missing');
      if (shared && wanted !== owner.canonicalSha256) return conflict('hook-shared-change');
      return attempt(() => finish(write(), i.addMine(claims), true, 'explicit-replace'));
    }
    const canonicalDrift = found.canonicalSha256 !== owner.canonicalSha256;
    const rawDrift = found.rawSha256 !== owner.sha256;
    if (shared) {
      if (canonicalDrift) return conflict('owned-hook-shared-drift');
      if (wanted !== owner.canonicalSha256) return conflict('hook-shared-change');
      if (rawDrift && !replace) return conflict('owned-hook-edited');
      return attempt(() => finish(i.before, i.addMine(claims), true, rawDrift ? 'explicit-replace' : undefined));
    }
    if (canonicalDrift || rawDrift) {
      if (!replace) return conflict('owned-hook-edited');
      if (found.canonicalSha256 === wanted) return attempt(() => finish(i.before, i.addMine(claims), true, 'explicit-replace'));
      return attempt(() => finish(write(), i.addMine(claims), true, 'explicit-replace'));
    }
    if (found.canonicalSha256 === wanted) return attempt(() => finish(i.before, i.addMine(claims), true));
    return attempt(() => finish(write(), i.addMine(claims), true));
  }

  // Authored remove: only a claim this selection holds is revoked; an unowned or foreign group is never guessed at.
  if (adopt) throw new Error('resolution-invalid');
  if (!found) return attempt(() => finish(i.before, mine ? others : claims, others.length > 0 || !mine && claims.length > 0));
  if (!owner) return conflict('existing-content');
  if (!mine) {
    // Another claim still owns the group and this selection holds none: the removal is already satisfied and changes nothing.
    const problem = imageConflict(a, i.before, i.before, i.retained, { key: i.key, selector }, true);
    if (problem) return conflict(problem.reason, problem.neighbor);
    return { effect: 'already-satisfied', after: i.before, custody: owner, custodyOnly: false, managed: false, details: shell(location, found.canonicalSha256) };
  }
  const canonicalDrift = found.canonicalSha256 !== owner.canonicalSha256;
  const rawDrift = found.rawSha256 !== owner.sha256;
  const retainedGroup = (reason?: string): HookDecision => {
    const refreshed = { ...owner, claims: others, managementId: others[0]!.managementId, sha256: found.rawSha256, canonicalSha256: found.canonicalSha256 };
    const problem = imageConflict(a, i.before, i.before, i.retained, { key: i.key, selector }, true);
    if (problem) return conflict(problem.reason, problem.neighbor);
    return { effect: 'already-satisfied', ...(reason ? { reason } : {}), after: i.before, custody: refreshed, custodyOnly: true, managed: ownerState,
      details: shell(location, found.canonicalSha256) };
  };
  const final = others.length === 0;
  if (!final) {
    if (canonicalDrift) return conflict('owned-hook-shared-drift');
    if (rawDrift && !replace) return conflict('owned-hook-edited');
    return retainedGroup(rawDrift ? 'explicit-replace' : undefined);
  }
  if ((canonicalDrift || rawDrift) && !replace) return conflict('owned-hook-edited');
  return attempt(() => finish(removeHookGroup(a.format, i.before!, a.container, found.index), [], false, canonicalDrift || rawDrift ? 'explicit-replace' : undefined));
}

/**
 * Read-only hypothetical result of one authored operation, ignoring custody: an identity
 * transformation for a unique equal group, otherwise the bounded add, replace or removal.
 */
export function foldHookGroup(a: HookAuthored, before: Buffer | null): Buffer | null {
  const selector = { path: a.selector.path, valueSha256: sha256(a.selector.value) };
  const location = locateHookGroups(a.format, before, a.container, selector);
  if (location.candidates.length > 1) throw new RecipeEditError('hook-selector-ambiguous');
  const found = location.candidates[0];
  if (a.action === 'remove') return found ? removeHookGroup(a.format, before!, a.container, found.index) : before;
  if (!found) return appendHookGroup(a.format, before, a.container, a.group!);
  return found.canonicalSha256 === canonicalDigest(a.group) ? before : replaceHookGroup(a.format, before!, a.container, found.index, a.group!);
}

export interface HookCleanupInput {
  owner: Owner; remaining: Claim[]; before: Buffer | null; retained: RetainedHook[]; key: string; forced?: string;
}
/** Lifecycle cleanup of a hook member: no keyed resolution, so any drift preserves custody. */
export function decideHookCleanup(i: HookCleanupInput): HookDecision {
  const descriptor = i.owner.descriptor as HookDescriptor;
  const authored: HookAuthored = { format: descriptor.format, container: descriptor.container, groupId: descriptor.groupId,
    selector: { path: descriptor.selector.path, value: '' }, action: 'remove' };
  const base = (location: HookLocation | undefined, memberAfter: string | null): HookDetails => ({
    container: [...descriptor.container], groupId: descriptor.groupId, selector: { path: [...descriptor.selector.path], valueSha256: descriptor.selector.valueSha256 },
    action: 'remove', matchedIndex: location?.candidates[0]?.index ?? null, memberBeforeSha256: location?.candidates[0]?.canonicalSha256 ?? null,
    memberAfterSha256: memberAfter, targetBeforeSha256: digestOf(i.before), desiredGroup: null });
  let location: HookLocation | undefined;
  const conflict = (reason: string, neighbor?: string): HookDecision => ({ effect: 'conflict', reason, after: i.before, custody: i.owner, custodyOnly: false, managed: false, details: base(location, null),
    ...(neighbor ? { neighbor } : {}) });
  if (i.forced) return conflict(i.forced);
  try { location = locateHookGroups(descriptor.format, i.before, descriptor.container, descriptor.selector); }
  catch (error) { if (error instanceof RecipeEditError) return conflict(error.reason); throw error; }
  const found = location.candidates[0];
  const remaining = i.remaining.length ? { ...i.owner, claims: i.remaining, managementId: i.remaining[0]!.managementId } : null;
  if (location.candidates.length > 1) return conflict('managed-content-changed');
  if (!found) return { effect: 'already-satisfied', after: i.before, custody: remaining, custodyOnly: true, managed: true, details: base(location, null) };
  if (found.rawSha256 !== i.owner.sha256 || found.canonicalSha256 !== i.owner.canonicalSha256) return conflict('managed-content-changed');
  if (remaining) {
    const problem = imageConflict(authored, i.before, i.before, i.retained, { key: i.key, selector: descriptor.selector }, true);
    if (problem) return conflict(problem.reason, problem.neighbor);
    return { effect: 'already-satisfied', after: i.before, custody: remaining, custodyOnly: true, managed: true, details: base(location, found.canonicalSha256) };
  }
  try {
    const after = removeHookGroup(descriptor.format, i.before!, descriptor.container, found.index);
    const problem = imageConflict(authored, i.before, after, i.retained, null, true);
    if (problem) return conflict(problem.reason, problem.neighbor);
    return { effect: 'replace-file', after, custody: null, custodyOnly: false, managed: true, details: base(location, null) };
  } catch (error) { if (error instanceof RecipeEditError) return conflict(error.reason); throw error; }
}
