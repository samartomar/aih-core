// `prepareUpdate` 0.1.0 (contract 12, C39, C52, C58): a complete new plan or change request, prepared against the
// receipts it replaces. Core never looks for updates itself. A plan with a proven recipe origin replaces the receipts
// whose origin has the same recipe id and repository; otherwise the request names the management ids it replaces.
// New members are added, changed members Core wrote replaced, dropped members removed unless another claim holds them,
// and every member you edited is kept and shown. The new data and origin are recorded only once the update completes.
import { isProxy } from 'node:util/types';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { canonicalJson, codeUnitCompare } from '../internal/canonical.js';
import { memberPointer, publicKind, type PlanItemFacts } from '../internal/custody-items.js';
import { claimIdentity } from '../internal/recipe-lifecycle.js';
import { waitLockTarget, ownershipPath, ownershipText, OWNERSHIP_RECORD_BYTES, protectState, readOwnership, sealOwnership,
  validateOwnership, writeStateFile } from '../internal/state.js';
import { projectRoot } from '../internal/host-files.js';
import type { PlannedMember } from '../internal/update-plan.js';
import type { CleanupPlanRow } from '../internal/removal-plan.js';
import type { Json } from '../types.js';
import { claimKey, managementIdOf, sameProject } from './claims.js';
import { place } from './lifecycle.js';
import { preparePlan } from './prepare.js';
import { prepareChange, type ChangeUpdateContext } from '../change/prepare.js';
import { peek, registerComposite, take, type HandleState } from './handles.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { FAILURE_RULE, digestOf } from './prepare.js';
import { PLAN_REQUEST, REVIEW, type Invalid, type Origin, type Plan, type PlanPreparation, type Refusal, type Review, type Run,
  type UpdateEntry, type UpdateMember, type UpdatePreparation, type UpdateResult } from './types.js';

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

/** One checked update of the request: where it is in `updates`, its kind, request and named management ids. */
interface Checked { index: number; kind: 'plan' | 'change'; request: Record<string, unknown>; ids: string[] | undefined }

export async function prepareUpdate(request: unknown, controls: unknown = {}): Promise<UpdateResult> {
  if (!plain(request, ['target', 'scope', 'updates'])) return invalid('', 'request', 'An update request is `{ target, scope, updates }`.');
  const located = place(request, ['project', 'user']);
  if ('status' in located) return located;
  const scope = located.scope as 'project' | 'user';
  const updates = request.updates;
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > 256) return invalid('/updates', 'updates', 'Name one or more updates.');
  const checked: Checked[] = [];
  for (const [index, update] of updates.entries()) {
    if (!plain(update, ['managementIds', 'request']) || !update.request || typeof update.request !== 'object' || Array.isArray(update.request))
      return invalid(`/updates/${index}`, 'update', 'An update is `{ managementIds?, request }`, with a complete plan or change request.');
    const ids = update.managementIds;
    if (ids !== undefined && !(Array.isArray(ids) && ids.length > 0 && ids.length <= 4096 && ids.every(id => typeof id === 'string' && ID.test(id)) &&
        new Set(ids).size === ids.length)) return invalid(`/updates/${index}/managementIds`, 'management-ids', 'Name one or more distinct management ids.');
    const inner = update.request as Record<string, unknown>;
    const schema = Object.getOwnPropertyDescriptor(inner, 'schema')?.value;
    const kind = schema === PLAN_REQUEST ? 'plan' : schema === CHANGE_REQUEST ? 'change' : undefined;
    if (!kind) {
      if (typeof schema === 'string' && /^urn:aihq:core:(?:plan|change)-request:/.test(schema))
        return { status: 'unsupported-version', encountered: schema, supported: [PLAN_REQUEST, CHANGE_REQUEST] };
      return invalid(`/updates/${index}/request/schema`, 'request', 'An update carries a complete plan request or change request.');
    }
    // An update acts where its request does: the same scope and project (Core never guesses the place).
    const target = inner.target as { project?: unknown } | undefined;
    let innerProject: string | null = null;
    try { innerProject = typeof target?.project === 'string' ? projectRoot(target.project) : null; } catch { innerProject = null; }
    if (inner.scope !== scope || innerProject !== located.project)
      return invalid(`/updates/${index}/request`, 'update-place', 'The request names the same scope and project as the update.');
    checked.push({ index, kind, request: inner, ids: ids as string[] | undefined });
  }
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  const one = (update: Checked) => update.kind === 'plan' ? planUpdate(update.request, controls, scope, located.project, home, update.ids) :
    changeUpdate(update.request, controls, scope, located.project, home, update.ids);
  // One update: its own result, refusals included.
  if (checked.length === 1) return one(checked[0]!);

  // Several updates (contract 12): each is prepared against its own receipts, then presented as one review with one
  // handle. An update that can't be prepared, or that conflicts with another, is an `unavailable` entry; the rest go ahead.
  const outcomes = new Map<number, UpdateResult>();
  const rejected = new Map<number, { code: string; reason: string }>();
  const namedBy = new Map<string, number>();
  for (const update of checked) for (const id of update.ids ?? []) {
    const other = namedBy.get(id);
    if (other === undefined) { namedBy.set(id, update.index); continue; }
    const reason = `Updates ${other} and ${update.index} both name \`${id}\`; an install is updated by one request. Prepare them in separate calls, or drop one.`;
    for (const at of [other, update.index]) if (!rejected.has(at)) rejected.set(at, { code: 'update-conflict', reason });
  }
  for (const update of checked) if (!rejected.has(update.index)) outcomes.set(update.index, await one(update));
  // Two updates acting on one management id or one file can't both be carried out from one review.
  const touched = new Map<number, { ids: Set<string>; files: Set<string> }>();
  for (const [index, outcome] of outcomes) if (outcome.status === 'ok') touched.set(index, {
    ids: new Set(outcome.entries.filter(entry => entry.disposition === 'prepared').map(entry => entry.managementId!)),
    files: new Set(outcome.entries.flatMap(entry => entry.members.map(member => fold(member.path)))) });
  const indexes = [...touched.keys()];
  for (const [n, a] of indexes.entries()) for (const b of indexes.slice(n + 1)) {
    const left = touched.get(a)!, right = touched.get(b)!;
    const id = [...left.ids].find(value => right.ids.has(value));
    const file = id === undefined ? [...left.files].find(value => right.files.has(value)) : undefined;
    if (id === undefined && file === undefined) continue;
    const reason = id !== undefined ? `Updates ${a} and ${b} both update \`${id}\`; an install is updated by one request. Prepare them in separate calls.` :
      `Updates ${a} and ${b} both change \`${file}\`; Apply re-checks every reviewed byte, so prepare them in separate calls.`;
    for (const at of [a, b]) if (!rejected.has(at)) rejected.set(at, { code: 'update-conflict', reason });
  }
  const entries: UpdateEntry[] = [];
  const parts: { update: Checked; result: UpdatePreparation }[] = [];
  for (const update of checked) {
    const outcome = outcomes.get(update.index);
    const refusal: Pick<UpdateEntry, 'code' | 'reason' | 'problems'> | undefined = rejected.get(update.index) ?? (!outcome || outcome.status === 'ok' ? undefined :
      outcome.status === 'refused' ? { code: outcome.code, reason: outcome.reason } :
      outcome.status === 'invalid' ? { code: 'invalid', reason: 'The update\'s request is not valid.', problems: outcome.problems } :
      { code: 'unsupported-version', reason: `\`${outcome.encountered}\` is not a request format this Core reads.` });
    if (refusal) {
      if (outcome?.status === 'ok' && outcome.handle) take(outcome.handle);
      for (const id of update.ids ?? [null]) entries.push({ managementId: id, update: update.index, disposition: 'unavailable', ...refusal, members: [] });
      continue;
    }
    const result = outcome as UpdatePreparation;
    for (const entry of result.entries) entries.push({ ...entry, update: update.index });
    if (result.review) parts.push({ update, result });
  }
  if (!parts.length) return { status: 'ok', entries };
  const steps = parts.flatMap(({ update, result }) => result.review!.steps.map(step => ({ ...step, update: update.index })));
  const conflicts = parts.flatMap(({ update, result }) => result.review!.conflicts.map(conflict => ({ ...conflict, update: update.index })));
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'update', scope, target: { project: located.project }, steps, conflicts,
    updates: parts.map(({ update, result }) => ({ update: update.index, request: update.kind, ...(result.review!.plan ? { plan: result.review!.plan } : {}),
      ...(result.review!.origin !== undefined ? { origin: result.review!.origin } : {}),
      ...(result.review!.originNote !== undefined ? { originNote: result.review!.originNote } : {}), reviewDigest: result.review!.reviewDigest })),
    failureRule: FAILURE_RULE, warnings: [...new Set(parts.flatMap(({ result }) => result.review!.warnings))] };
  const reviewDigest = digestOf(body, parts.map(({ result }) => result.review!.reviewDigest).join('\0'));
  const review = deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review;
  // A blocked update leaves the whole review without a handle: the person chooses its fixes first (section 7).
  if (parts.some(({ result }) => !result.handle)) {
    for (const { result } of parts) if (result.handle) take(result.handle);
    return { status: 'ok', entries, review };
  }
  // Each update writes the receipts of its place, which every later update's own Apply re-checks. So a later update is
  // prepared again once the ones before it ran, and runs only when that fresh preparation shows exactly the reviewed work
  // and the files it acts on still hold the bytes they held at this Prepare; otherwise it is stale and not attempted.
  const partOf = ({ update, result }: { update: Checked; result: UpdatePreparation }, at: number) => {
    const fingerprint = fingerprintOf(result);
    const files = filesOf(result);
    const bytes = filesDigest(files);
    const partial = peek(result.handle)?.partial === true || result.entries.some(entry => entry.status === 'partial');
    if (at > 0) take(result.handle);
    return { update: update.index, ...(at === 0 ? { handle: result.handle! } : {}), reviewDigest: result.review!.reviewDigest,
      partial,
      steps: result.review!.steps.map(step => ({ step: step.step, managementId: step.managementId })),
      ...(at > 0 ? { renew: async () => {
        if (filesDigest(files) !== bytes) return undefined;
        const fresh = await one(update);
        if (fresh.status !== 'ok' || !fresh.handle || !fresh.review) return undefined;
        if (fingerprintOf(fresh) !== fingerprint) { take(fresh.handle); return undefined; }
        return { handle: fresh.handle, reviewDigest: fresh.review.reviewDigest, partial: peek(fresh.handle)?.partial === true };
      } } : {}) };
  };
  const composite = parts.map(partOf);
  const handle = registerComposite({ reviewDigest, partial: composite.some(part => part.partial), parts: composite });
  return { status: 'ok', entries, review, handle };
}
/** What an update's review presents, without its digest (which binds a fresh nonce): its steps, conflicts and entries. */
function fingerprintOf(result: UpdatePreparation): string {
  const { reviewDigest: _digest, ...body } = result.review!;
  return createHash('sha256').update(canonicalJson({ body, entries: result.entries.map(({ update: _update, ...entry }) => entry) } as unknown as Json)).digest('hex');
}
/** The absolute files an update's members are in. */
const filesOf = (result: UpdatePreparation): string[] => [...new Set(result.entries.flatMap(entry => entry.members.map(member => member.path)))].sort(codeUnitCompare);
/** The bytes those files hold now (a missing or unreadable file reads as such), as one digest. */
function filesDigest(files: string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    let state: string;
    try { const stats = lstatSync(file); state = stats.isFile() ? createHash('sha256').update(readFileSync(file)).digest('hex') : stats.isDirectory() ? 'folder' : 'other'; }
    catch (error) { state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'; }
    hash.update(file).update('\0').update(state).update('\0');
  }
  return hash.digest('hex');
}
const fold = (path: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path).replaceAll('\\', '/');

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
    if (!before && !plannedIds.has(id)) return { managementId: id, update: 0, disposition: 'absent', members: [] };
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
    if (!installed(id) && !requested.has(id)) return { managementId: id, update: 0, disposition: 'absent', members: [] };
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
  return { managementId, update: 0, disposition: 'prepared', status, change, ...extra,
    members: members.map(item => item.member).sort((a, b) => codeUnitCompare(a.path, b.path) || codeUnitCompare(a.pointer ?? '', b.pointer ?? '')) };
}

/**
 * After an update's run: when every step it reviewed for application succeeded (your kept edits aside), each claim of
 * the new plan records the new data and origin (contract 12). A failed, interrupted, cancelled or rejected run leaves
 * the earlier data and origin recorded, with the run's own truthful outcome. The record is rewritten under the target's
 * state lock (waiting for another holder, within `signal`) and atomically replaced; a record that can't be written
 * leaves the earlier one and makes the run `incomplete` with reason `record-not-updated`.
 */
export async function recordUpdate(run: Run, record: NonNullable<HandleState['record']>, signal?: AbortSignal): Promise<void> {
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
      release = await waitLockTarget(root, signal);
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
    } catch {
      // The earlier data and origin stay recorded; the members the run wrote are its outcome, which is not complete.
      run.completion = 'incomplete'; run.reason = 'record-not-updated';
    }
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
