// `prepareUpdate` 0.1.0 (contract 12, C39, C52, C58): a complete new plan or change request, prepared against the
// receipts it replaces. Core never looks for updates itself. A plan with a proven recipe origin replaces the receipts
// whose origin has the same recipe id and repository; otherwise the request names the management ids it replaces.
// New members are added, changed members Core wrote replaced, dropped members removed unless another claim holds them,
// and every member you edited is kept and shown. The new data and origin are recorded only once the update completes.
import { isProxy } from 'node:util/types';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { canonicalJson, codeUnitCompare } from '../internal/canonical.js';
import { memberPointer, publicKind, type PlanItemFacts } from '../internal/custody-items.js';
import { claimIdentity } from '../internal/recipe-lifecycle.js';
import { lockTarget, ownershipPath, ownershipText, OWNERSHIP_RECORD_BYTES, protectState, readOwnership, sealOwnership,
  validateOwnership, writeStateFile } from '../internal/state.js';
import { projectRoot } from '../internal/host-files.js';
import type { PlannedMember } from '../internal/update-plan.js';
import type { CleanupPlanRow } from '../internal/removal-plan.js';
import type { Json } from '../types.js';
import { claimKey, managementIdOf, sameProject } from './claims.js';
import { place } from './lifecycle.js';
import { preparePlan } from './prepare.js';
import { prepareChange, type ChangeUpdateContext } from '../change/prepare.js';
import type { HandleState } from './handles.js';
import { PLAN_REQUEST, type Invalid, type Origin, type Plan, type PlanPreparation, type Refusal, type Run,
  type UpdateEntry, type UpdateMember, type UpdateResult } from './types.js';

const CHANGE_REQUEST = 'urn:aihq:core:change-request:0.1.0';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const invalid = (path: string, reason: string, message: string): Invalid => ({ status: 'invalid', problems: [{ path, reason, message }] });
const plain = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value) && Object.keys(value).every(key => keys.includes(key));
const named = (ids: string[]): string => ids.map(id => `\`${id}\``).join(', ');

/** One claim the new plan makes: its engine claim key, management id, scope and CLI. */
export interface PlannedClaim { key: string; managementId: string; scope: 'project' | 'user'; cli: string | null }
/** What an update replaces: the claims it removes (the new plan no longer makes them) and every replaced claim's recorded facts. */
export interface UpdateSelection {
  removals: { key: string; managementId: string; scope: 'project' | 'user' }[];
  prior: Map<string, PlanItemFacts>;
}
/** How `preparePlan` runs as an update: `select` names the replaced receipts; Prepare fills the planned member rows. */
export interface PlanUpdateContext {
  select(found: { origin: Origin; plan: Plan; project: string | null; home: string; groups: PlannedClaim[] }): UpdateSelection | Refusal;
  rows?: PlannedMember[];
  cleanupRows?: CleanupPlanRow[];
}

export async function prepareUpdate(request: unknown, controls: unknown = {}): Promise<UpdateResult> {
  if (!plain(request, ['target', 'scope', 'updates'])) return invalid('', 'request', 'An update request is `{ target, scope, updates }`.');
  const located = place(request, ['project', 'user']);
  if ('status' in located) return located;
  const scope = located.scope as 'project' | 'user';
  const updates = request.updates;
  if (!Array.isArray(updates) || updates.length === 0) return invalid('/updates', 'updates', 'Name one update.');
  // One review carries one request's steps: this Core prepares one update per call.
  if (updates.length > 1) return invalid('/updates', 'update-one-request', 'This Core prepares one update per call; prepare each request on its own.');
  const update = updates[0];
  if (!plain(update, ['managementIds', 'request']) || !update.request || typeof update.request !== 'object' || Array.isArray(update.request))
    return invalid('/updates/0', 'update', 'An update is `{ managementIds?, request }`, with a complete plan or change request.');
  const ids = update.managementIds;
  if (ids !== undefined && !(Array.isArray(ids) && ids.length > 0 && ids.length <= 4096 && ids.every(id => typeof id === 'string' && ID.test(id)) &&
      new Set(ids).size === ids.length)) return invalid('/updates/0/managementIds', 'management-ids', 'Name one or more distinct management ids.');
  const inner = update.request as Record<string, unknown>;
  const schema = Object.getOwnPropertyDescriptor(inner, 'schema')?.value;
  const kind = schema === PLAN_REQUEST ? 'plan' : schema === CHANGE_REQUEST ? 'change' : undefined;
  if (!kind) {
    if (typeof schema === 'string' && /^urn:aihq:core:(?:plan|change)-request:/.test(schema))
      return { status: 'unsupported-version', encountered: schema, supported: [PLAN_REQUEST, CHANGE_REQUEST] };
    return invalid('/updates/0/request/schema', 'request', 'An update carries a complete plan request or change request.');
  }
  // The update acts where its request does: the same scope and project (Core never guesses the place).
  const target = inner.target as { project?: unknown } | undefined;
  let innerProject: string | null = null;
  try { innerProject = typeof target?.project === 'string' ? projectRoot(target.project) : null; } catch { innerProject = null; }
  if (inner.scope !== scope || innerProject !== located.project)
    return invalid('/updates/0/request', 'update-place', 'The request names the same scope and project as the update.');
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  return kind === 'plan' ? planUpdate(inner, controls, scope, located.project, home, ids as string[] | undefined) :
    changeUpdate(inner, controls, scope, located.project, home, ids as string[] | undefined);
}

/** A recorded claim in this place: its engine key and plan facts. */
interface Recorded { key: string; plan: PlanItemFacts; scope: 'project' | 'user' }

async function planUpdate(input: Record<string, unknown>, controls: unknown, scope: 'project' | 'user', project: string | null, home: string,
    ids: string[] | undefined): Promise<UpdateResult> {
  const root = scope === 'project' ? project! : home;
  let here: Recorded[] = [];
  let targets = new Set<string>();
  let selection: UpdateSelection | undefined;
  let planned: PlannedClaim[] = [];
  let newData: PlanItemFacts['data'] = null; let newOrigin: Origin = 'chosen';
  const context: PlanUpdateContext = {
    select(found) {
      planned = found.groups; newData = found.plan.data; newOrigin = found.origin;
      // A plan's steps may land at either root (an AI setup in home for a project install): every claim made from this place.
      here = ([['project', project], ['user', home]] as const).flatMap(([at, base]) => base === null || at === 'project' && scope === 'user' ? [] :
        [...planFacts([base])].flatMap(([key, plan]) => key.startsWith(`${at}\0`) && sameProject(plan, project) ?
          [{ key: key.slice(at.length + 1), plan, scope: at }] : []));
      const idOf = (claim: Recorded) => managementIdOf(claim.key, claim.plan);
      targets = new Set(ids ?? []);
      const proven = found.origin === 'chosen' ? null : found.origin;
      if (proven) {
        // C52: the receipts whose proven origin has this recipe's id and repository, whatever their recipe or data commit.
        const matching = here.filter(claim => claim.plan.origin !== 'chosen' && claim.plan.origin.recipe.id === proven.recipe.id &&
          claim.plan.origin.recipe.repository === proven.recipe.repository);
        const origins = new Map(matching.map(claim => [canonicalJson(claim.plan.origin as unknown as Json), claim]));
        if (origins.size > 1) {
          const described = [...origins.values()].map(claim => { const origin = claim.plan.origin as Exclude<Origin, 'chosen'>;
            return `recipe commit ${origin.recipe.commit} (data ${origin.data?.commit ?? 'none'}, ${named([...new Set(matching.filter(other =>
              canonicalJson(other.plan.origin as unknown as Json) === canonicalJson(origin as unknown as Json)).map(idOf))].sort(codeUnitCompare))})`; });
          return { status: 'refused', code: 'update-ambiguous', reason: `Two installs here match recipe \`${proven.recipe.id}\` from ` +
            `${proven.recipe.repository}: ${described.join('; ')}. Name the \`managementIds\` of the one to update.` };
        }
        for (const claim of matching) targets.add(idOf(claim));
      }
      if (!targets.size) return { status: 'refused', code: 'update-target-required', reason: proven ?
        `No install here has recipe \`${proven.recipe.id}\` from ${proven.recipe.repository}. Name the \`managementIds\` this update replaces.` :
        'This plan has no proven recipe origin, so Core can\'t tell which install it updates. Name the `managementIds` it replaces.' };
      // A management id installed here that the new plan holds is replaced by it: it must be one this update names.
      const unnamed = [...new Set(found.groups.map(group => group.managementId))].filter(id => !targets.has(id) &&
        here.some(claim => idOf(claim) === id)).sort(codeUnitCompare);
      if (unnamed.length) return { status: 'refused', code: 'update-target-required', reason: `The plan also holds ${named(unnamed)}, installed ` +
        'here but not named by this update. Name it in `managementIds` too, or leave it out of the plan.' };
      const keys = new Set(found.groups.map(group => group.key));
      const replaced = here.filter(claim => targets.has(idOf(claim)));
      selection = { prior: new Map(replaced.map(claim => [claim.key, claim.plan])),
        removals: replaced.filter(claim => !keys.has(claim.key)).map(claim => ({ key: claim.key, managementId: idOf(claim), scope: claim.scope })) };
      return selection;
    } };
  const prepared = await preparePlan(input, controls, context);
  if (!('review' in prepared)) return prepared;
  const idOf = (key: string) => planned.find(group => group.key === key)?.managementId ??
    selection!.removals.find(removal => removal.key === key)?.managementId ?? managementIdOf(key, here.find(claim => claim.key === key)?.plan);
  const installed = (id: string) => here.find(claim => managementIdOf(claim.key, claim.plan) === id);
  const plannedIds = new Set(planned.map(group => group.managementId));
  const members = membersOf(context, root, idOf);
  const all = [...new Set([...targets, ...plannedIds])].sort(codeUnitCompare);
  const entries = all.map((id): UpdateEntry => {
    const before = installed(id);
    if (!before && !plannedIds.has(id)) return { managementId: id, disposition: 'absent', members: [] };
    const change = !before ? 'add' : plannedIds.has(id) ? 'update' : 'remove';
    return entryOf(id, prepared, members.get(id) ?? [], change, {
      ...(change === 'remove' ? { note: newData ? `removed in data commit ${newData.commit}` : 'removed from the plan' } : {}),
      from: before ? { data: before.plan.data === null ? null : { ...before.plan.data }, origin: structuredClone(before.plan.origin) } : null,
      to: plannedIds.has(id) ? { data: newData === null ? null : { ...(newData as { repository: string; commit: string }) }, origin: structuredClone(newOrigin) } : null });
  });
  return { status: 'ok', entries, review: prepared.review, ...(prepared.handle ? { handle: prepared.handle } : {}) };
}

async function changeUpdate(input: Record<string, unknown>, controls: unknown, scope: 'project' | 'user', project: string | null, home: string,
    ids: string[] | undefined): Promise<UpdateResult> {
  // A change has no recipe origin: it updates exactly the management ids it names (C52).
  if (!ids) return { status: 'refused', code: 'update-target-required',
    reason: 'A change updates exactly the `managementIds` it names; name the ones it replaces.' };
  const root = scope === 'project' ? project! : home;
  const anchor = project ?? home;
  const attributed = scope === 'user' && project !== null;
  const engineId = (id: string) => attributed ? claimKey(id, 'user', null, project) : id;
  const stored = readOwnership(root).value;
  // A change is installed here when a receipt member, item or selection record holds its claim.
  const installed = (id: string) => { const identity = claimIdentity(scope, engineId(id), anchor);
    return !!stored.items?.[identity] || !!stored.selections?.[identity] || Object.values(stored.members).some(owner =>
      (owner.claims ?? []).some(claim => claim.scope === scope && claim.managementId === engineId(id))); };
  const changes = Array.isArray(input.changes) ? input.changes as { managementId?: unknown }[] : [];
  const requested = new Set(changes.map(entry => entry?.managementId).filter((id): id is string => typeof id === 'string'));
  const unnamed = [...requested].filter(id => !ids.includes(id) && installed(id)).sort(codeUnitCompare);
  if (unnamed.length) return { status: 'refused', code: 'update-target-required', reason: `The request also holds ${named(unnamed)}, installed ` +
    'here but not named by this update. Name it in `managementIds` too, or leave it out of the request.' };
  const context: ChangeUpdateContext = { removals: ids.filter(id => !requested.has(id) && installed(id))
    .map(id => ({ key: engineId(id), managementId: id, scope })) };
  const prepared = await prepareChange(input, controls, context);
  if (!('review' in prepared)) return prepared;
  const keys = new Map([...new Set([...ids, ...requested])].map(id => [engineId(id), id]));
  const members = membersOf(context as { rows?: PlannedMember[]; cleanupRows?: CleanupPlanRow[] }, root, key => keys.get(key) ?? key);
  const entries = [...new Set([...ids, ...requested])].sort(codeUnitCompare).map((id): UpdateEntry => {
    if (!installed(id) && !requested.has(id)) return { managementId: id, disposition: 'absent', members: [] };
    return entryOf(id, prepared, members.get(id) ?? [], !installed(id) ? 'add' : requested.has(id) ? 'update' : 'remove',
      requested.has(id) ? {} : { note: 'removed from the request' });
  });
  return { status: 'ok', entries, review: prepared.review, ...(prepared.handle ? { handle: prepared.handle } : {}) };
}

/** Each management id's members as the review leaves them: what is added, replaced, removed, kept or left unchanged. */
function membersOf(context: { rows?: PlannedMember[]; cleanupRows?: CleanupPlanRow[] }, root: string, idOf: (key: string) => string):
    Map<string, { member: UpdateMember; held: boolean }[]> {
  const found = new Map<string, { member: UpdateMember; held: boolean }[]>();
  const add = (keys: string[], member: UpdateMember, held: boolean) => {
    for (const id of new Set(keys.map(idOf))) {
      const list = found.get(id) ?? []; found.set(id, list);
      // A member several claims (CLIs) share is listed once, with what the first claim's step does to it.
      const same = (known: UpdateMember) => known.kind === member.kind && known.path === member.path && known.pointer === member.pointer && known.blockId === member.blockId;
      const at = list.findIndex(known => same(known.member));
      if (at < 0) list.push({ member, held });
      else if (list[at]!.member.action === 'unchanged' && member.action !== 'unchanged') list[at] = { member, held };
    }
  };
  const shown = (descriptor: PlannedMember['descriptor'], rowRoot: string, redacted?: string) => {
    const pointer = memberPointer(descriptor);
    return { kind: publicKind(descriptor), path: join(rowRoot ?? root, redacted ?? descriptor.path), ...(pointer === undefined ? {} : { pointer }),
      ...(descriptor.kind === 'block' ? { blockId: descriptor.blockId } : {}) };
  };
  for (const row of context.rows ?? []) {
    if (row.operationId.startsWith('lifecycle/')) continue;
    // A member you edited is never overwritten (C58): it is kept, and the review leaves its step out.
    const kept = row.action === 'conflict' && row.reason === 'managed-content-changed';
    add(row.managementIds, { ...shown(row.descriptor, row.root, row.redactedPath), action: kept ? 'keep-changed' : row.action,
      ...(row.reason === undefined ? {} : { reason: row.reason }) }, row.action === 'conflict');
  }
  for (const row of context.cleanupRows ?? [])
    add(row.removed.map(identity => identity.slice(identity.lastIndexOf(':') + 1)), { ...shown(row.descriptor, row.root, row.redactedPath),
      action: row.action, ...(row.reason === undefined ? {} : { reason: row.reason }) }, false);
  return found;
}

function entryOf(managementId: string, prepared: Exclude<PlanPreparation, Refusal | Invalid | { status: 'unsupported-version' }>,
    members: { member: UpdateMember; held: boolean }[], change: NonNullable<UpdateEntry['change']>, extra: Partial<UpdateEntry>): UpdateEntry {
  const status = prepared.status === 'blocked' ? 'blocked' : members.some(item => item.held) ? 'partial' : 'ready';
  return { managementId, disposition: 'prepared', status, change, ...extra,
    members: members.map(item => item.member).sort((a, b) => codeUnitCompare(a.path, b.path) || codeUnitCompare(a.pointer ?? '', b.pointer ?? '')) };
}

/**
 * After an update's run: when every step it reviewed for application succeeded (your kept edits aside), each claim of
 * the new plan records the new data and origin (contract 12). A failed, interrupted, cancelled or rejected run leaves
 * the earlier data and origin recorded, with the run's own truthful outcome.
 */
export function recordUpdate(run: Run, record: NonNullable<HandleState['record']>): void {
  if (run.completion !== 'complete' && run.completion !== 'incomplete') return;
  const kept = new Set(record.kept);
  const settled = run.steps.every(step => step.verification.status !== 'failed' && (step.application === 'applied' ||
    step.application === 'already-satisfied' || step.application === 'not-attempted' && kept.has(`${step.step}\0${step.managementId}`)));
  if (!settled) return;
  const roots = new Map<string, string[]>();
  for (const claim of record.claims) roots.set(claim.root, [...roots.get(claim.root) ?? [], claim.identity]);
  for (const [root, identities] of roots) {
    let release: (() => void) | undefined;
    try {
      release = lockTarget(root);
      const stored = readOwnership(root, false).value;
      const items = { ...stored.items };
      let changed = false;
      for (const identity of identities) {
        const item = items[identity];
        if (!item?.plan || item.installState) continue;
        items[identity] = { ...item, plan: { ...item.plan, data: record.data === null ? null : { ...record.data }, origin: structuredClone(record.origin) } };
        changed = true;
      }
      if (!changed) continue;
      const next = sealOwnership({ ...stored, items });
      validateOwnership(next, root);
      protectState([ownershipPath(root)]);
      writeStateFile(ownershipPath(root), Buffer.from(ownershipText(next)), 0o600, false, OWNERSHIP_RECORD_BYTES);
    } catch { /* The earlier data and origin stay recorded; the members the run wrote are its outcome. */ }
    finally { try { release?.(); } catch { /* a lock left behind is reclaimed later */ } }
  }
}
/** Plan facts recorded for each management id and scope in the receipts of these roots (as `list` reads them). */
function planFacts(roots: string[]): Map<string, PlanItemFacts> {
  const facts = new Map<string, PlanItemFacts>();
  for (const root of new Set(roots)) for (const item of Object.values(readOwnership(root).value.items ?? {}))
    if (item.plan) facts.set(`${item.scope}\0${item.managementId}`, item.plan);
  return facts;
}
