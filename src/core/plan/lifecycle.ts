// `list` and `prepareRemoval` 0.1.0 (contract 12): the inventory and removal forms over the retained custody,
// claim and removal rules (14.2). The place is always named; Core never guesses it from the working folder.
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';
import { listManagedSelections } from '../managed-inventory.js';
import { prepareManagedRemoval } from '../managed-removal.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState, readOwnership } from '../internal/state.js';
import { register, type StepRef } from './handles.js';
import { FAILURE_RULE, digestOf, engineControls, planControls } from './prepare.js';
import type { PlanItemFacts } from '../internal/custody-items.js';
import type { Json } from '../types.js';
import { INVENTORY, REVIEW, type Inventory, type InventoryEntry, type ListResult, type Problem, type RemovalEntry, type RemovalResult,
  type Review, type ReviewStep } from './types.js';

const invalid = (path: string, reason: string, message: string): { status: 'invalid'; problems: Problem[] } =>
  ({ status: 'invalid', problems: [{ path, reason, message }] });
const plain = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value) && Object.keys(value).every(key => keys.includes(key));
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The project and the folder the engine anchors a request on: the project, or home for a user-only place. */
function place(request: Record<string, unknown>, scopes: string[]): { project: string | null; anchor: string; scope: string } | { status: 'invalid'; problems: Problem[] } {
  if (!scopes.includes(request.scope as string)) return invalid('/scope', 'scope', `The scope is one of ${scopes.join(', ')}.`);
  if (!plain(request.target, ['project'])) return invalid('/target', 'target', 'The target is `{ project? }`.');
  const named = request.target.project;
  if (named !== undefined && named !== null && (typeof named !== 'string' || !isAbsolute(named)))
    return invalid('/target/project', 'absolute', 'The project folder is an absolute path.');
  if (request.scope !== 'user' && typeof named !== 'string') return invalid('/target/project', 'required', 'This scope needs the project folder.');
  try {
    const project = typeof named === 'string' ? projectRoot(named) : null;
    return { project, anchor: project ?? projectRoot(homedir()), scope: request.scope as string };
  } catch { return invalid('/target/project', 'project', 'The project folder is not usable.'); }
}

/** Plan facts recorded for each management id and scope in the receipts of these roots. */
function planFacts(roots: string[]): Map<string, PlanItemFacts> {
  const facts = new Map<string, PlanItemFacts>();
  for (const root of new Set(roots)) for (const item of Object.values(readOwnership(root).value.items ?? {}))
    if (item.plan) facts.set(`${item.scope}\0${item.managementId}`, item.plan);
  return facts;
}

export async function list(request: unknown, controls: unknown = {}): Promise<ListResult> {
  forgetProvenState();
  if (!plain(request, ['target', 'scope'])) return invalid('', 'request', 'A list request is `{ target, scope }`.');
  const located = place(request, ['project', 'user', 'both']);
  if ('status' in located) return located;
  const options = planControls(controls);
  if (!options) return invalid('', 'controls', 'The controls are not valid.');
  const scope = located.scope as 'project' | 'user' | 'both';
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  const listed = await listManagedSelections({ target: { project: located.anchor }, scope, format: 'urn:aihq:core:managed-inventory-result:1.1.0' },
    options.signal ? { signal: options.signal } : {});
  if (listed.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Listing was cancelled.' };
  if (listed.status === 'invalid') return { status: 'invalid', problems: listed.diagnostics.map(item => ({ path: item.path ?? '', reason: item.reason, message: item.message })) };
  const facts = planFacts([...(scope !== 'user' && located.project ? [located.project] : []), ...(scope !== 'project' ? [home] : [])]);
  const entries: InventoryEntry[] = listed.selections.map(row => {
    const plan = facts.get(`${row.scope}\0${row.managementId}`);
    return { managementId: row.managementId, scope: row.scope, items: plan ? [...plan.items] : [], origin: plan ? plan.origin : null,
      data: plan?.data ? { ...plan.data } : null, clis: plan ? [...plan.clis] : [],
      ...(plan ? { catalog: plan.catalog, profiles: plan.profiles.map(profile => ({ ...profile })) } : {}), installState: row.installState,
      ...(plan?.aiSetup ? { aiSetup: { ...plan.aiSetup, interpreter: plan.aiSetup.interpreter ? { ...plan.aiSetup.interpreter } : null } } : {}),
      members: row.members.map(member => ({ kind: member.kind, path: member.path, ...(member.pointer === undefined ? {} : { pointer: member.pointer }),
        ...(member.blockId === undefined ? {} : { blockId: member.blockId }),
        state: member.fileState === 'matches' ? 'matching' : member.fileState === 'changed' || member.fileState === 'block-changed' ? 'changed-by-you' :
          member.fileState === 'missing' || member.fileState === 'block-missing' ? 'missing' : 'unchecked' })) };
  });
  const inventory: Inventory = { schema: INVENTORY, status: 'ok', target: { project: located.project }, scope,
    observation: listed.status === 'complete' ? 'complete' : 'incomplete', entries };
  return deepFreezeStrictJsonV1(inventory as unknown as Json) as unknown as Inventory;
}

export async function prepareRemoval(request: unknown, controls: unknown = {}): Promise<RemovalResult> {
  forgetProvenState();
  if (!plain(request, ['target', 'scope', 'removals'])) return invalid('', 'request', 'A removal request is `{ target, scope, removals }`.');
  const located = place(request, ['project', 'user']);
  if ('status' in located) return located;
  const options = planControls(controls);
  if (!options) return invalid('', 'controls', 'The controls are not valid.');
  if (options.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Removal preparation was cancelled.' };
  const removals = request.removals;
  if (!Array.isArray(removals) || removals.length === 0 || removals.length > 4096) return invalid('/removals', 'removals', 'Name one or more removals.');
  const selectors: { managementId: string; origin?: { reasonIncluded: 'chosen' } }[] = [];
  for (const [index, entry] of removals.entries()) {
    if (!plain(entry, ['managementId', 'item', 'origin', 'clis']) || typeof entry.managementId !== 'string' || !ID.test(entry.managementId))
      return invalid(`/removals/${index}`, 'removal', 'A removal names a `managementId`.');
    if (entry.clis !== undefined) return { status: 'refused', code: 'client-attribution-missing',
      reason: `Removal by CLI is refused: this Core does not yet record which CLI claims each member of \`${entry.managementId}\`.` };
    if (entry.item !== undefined) return invalid(`/removals/${index}/item`, 'item-removal-unavailable', 'Removing one item inside a plugin is not available in this Core yet.');
    if (entry.origin !== undefined && entry.origin !== 'chosen') return invalid(`/removals/${index}/origin`, 'origin', 'Only the `chosen` origin can be recorded by this Core.');
    selectors.push({ managementId: entry.managementId, ...(entry.origin === 'chosen' ? { origin: { reasonIncluded: 'chosen' as const } } : {}) });
  }
  const scope = located.scope as 'project' | 'user';
  // `origin: chosen` removes the whole management id here: a plan install records exactly that one origin.
  const prepared = await prepareManagedRemoval({ target: { project: located.anchor }, scope,
    removals: selectors.map(({ managementId }) => ({ managementId })) }, engineControls(options));
  if (prepared.disposition === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Removal preparation was cancelled.' };
  if (prepared.disposition === 'invalid') return { status: 'invalid', problems: prepared.diagnostics.map(item => ({ path: item.path ?? '', reason: item.reason, message: item.message })) };
  const engine = prepared.preparation;
  const entries: RemovalEntry[] = (prepared.removals ?? []).map(entry => ({ managementId: entry.managementId, disposition: entry.disposition,
    ...(entry.disposition === 'prepared' && engine && ['ready', 'partial', 'blocked'].includes(engine.status) ?
      { status: engine.status as 'ready' | 'partial' | 'blocked' } : {}),
    members: entry.members.map(member => ({ kind: member.kind, path: member.path, ...(member.pointer === undefined ? {} : { pointer: member.pointer }),
      action: member.action, ...(member.reason === undefined ? {} : { reason: member.reason }) })) }));
  if (prepared.disposition === 'unavailable' && !entries.length)
    return { status: 'refused', code: 'home-unavailable', reason: prepared.diagnostics[0]?.message ?? 'Removal could not be prepared here.' };
  if (!engine?.review || !engine.prepared || !['ready', 'partial'].includes(engine.status)) return { status: 'ok', entries };
  // Each review operation carries one listed member's action; its management id is that member's entry.
  const owners = new Map<string, string>();
  for (const entry of prepared.removals ?? []) for (const member of entry.members) if (member.operationId) owners.set(member.operationId, entry.managementId);
  const operations = new Map<string, StepRef>();
  const steps: ReviewStep[] = engine.review.operations.map((operation, index) => {
    const managementId = owners.get(operation.id) ?? '';
    operations.set(operation.id, { step: index, managementId });
    const target = operation.details.target ?? '';
    const effect: ReviewStep['effect'] = ['create-file', 'replace-file', 'remove-file', 'already-satisfied'].includes(operation.effects) ?
      operation.effects as ReviewStep['effect'] : operation.effects === 'conflict' ? 'conflict' : 'unchanged';
    const sentence = effect === 'remove-file' ? `Removes \`${target}\`` : effect === 'replace-file' ? `Restores \`${target}\`` :
      effect === 'already-satisfied' ? `Releases \`${target}\`, already as it should be` : `Leaves \`${target}\` as it is`;
    return { step: index, op: 'remove', managementId, sentence, cantPromise: null, effect, path: target };
  });
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'removal', scope, target: { project: located.project }, steps,
    conflicts: [], failureRule: FAILURE_RULE, warnings: [] };
  const reviewDigest = digestOf(body, engine.review.reviewDigest);
  const review = deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review;
  const partial = engine.status === 'partial';
  const handle = register({ engine: engine.prepared, engineDigest: engine.review.reviewDigest, enginePartial: partial, reviewDigest, partial, operations });
  return { status: 'ok', entries, review, handle };
}
