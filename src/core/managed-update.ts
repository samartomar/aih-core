import { join } from 'node:path';
import { prepare as preparePolicy, validateControls, dataObject, safeText } from './recipe-engine.js';
import { claimRefusal, distributionIdentity, readImage, sameImageAs, type Image } from './internal/custody-preflight.js';
import { projectRoot, userHomeRoot } from './internal/host-files.js';
import { forgetProvenState, isContentRoot } from './internal/state.js';
import { claimIdentity } from './internal/recipe-lifecycle.js';
import { readTrustCustody, readPendingTrust, pendingEntries } from './internal/trust-custody.js';
import { readMacosCustody } from './internal/macos-session-custody.js';
import { memberPointer, publicKind } from './internal/custody-items.js';
import type { PlannedMember } from './internal/update-plan.js';
import { bindingLayout } from '../harness/delivery-review.mjs';
import type { UpdateEntry, UpdateItemFacts, UpdatePolicy, UpdateSelector } from './update-types.js';
import type { Diagnostic, ExecutionPolicy, Selection } from './types.js';
import type { HostControls, PreparationResult } from './host-types.js';

export type { UpdateMemberAction, UpdateSelector, UpdateItemFacts, UpdateMember, UpdateEntry, UpdatePolicy } from './update-types.js';
/**
 * Managed update preparation 1.0.0: replacements the consumer chose for installed selections, in one reviewed step.
 * A request that names its `policy` is 1.1.0: replacements in that execution policy version, up to 1.6.0.
 */
export interface ManagedUpdateRequest { target: { project: string }; scope: 'project' | 'user'; updates: UpdateSelector[]; policy?: UpdatePolicy }
export interface ManagedUpdatePreparationResult {
  schema: 'urn:aihq:core:managed-update-preparation:1.0.0' | 'urn:aihq:core:managed-update-preparation:1.1.0';
  package: { name: string; version: string };
  disposition: 'prepared' | 'not-prepared' | 'unavailable' | 'invalid' | 'cancelled';
  target?: { project: string }; scope?: 'project' | 'user';
  diagnostics: Diagnostic[];
  /** One entry per requested update, in request order; absent when the request is invalid, cancelled or unavailable. */
  updates?: UpdateEntry[];
  /** The one review digest that binds every listed member; present exactly with `preparation.review`. */
  reviewDigest?: string;
  /**
   * Present exactly for `prepared`: one policy preparation of every prepared replacement, applied with the ordinary `apply`.
   * A preparation without a review is never `prepared`: the request is `not-prepared` and each entry it held says why.
   */
  preparation?: PreparationResult;
}

const SCHEMA = 'urn:aihq:core:managed-update-preparation:1.0.0' as const;
const SCHEMA_11 = 'urn:aihq:core:managed-update-preparation:1.1.0' as const;
const POLICY_14 = 'urn:aihq:core:execution-policy:1.4.0' as const;
/** Every execution policy version an update can carry; each is prepared exactly as an install in that version is. */
const POLICIES: readonly UpdatePolicy['schema'][] = [POLICY_14, 'urn:aihq:core:execution-policy:1.5.0', 'urn:aihq:core:execution-policy:1.6.0'];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const diagnostic = (code: string, reason: string, message: string, guidance?: string): Diagnostic =>
  ({ code, reason, message, ...(guidance === undefined ? {} : { guidance }) });
const UNVERIFIABLE = 'Protected custody for this update could not be verified.';
/**
 * An update reads its replacement's material and private inputs; it never reads an organization. Only a request that names
 * its policy reads the Scan evidence and release index that policy's checks use, as an install in that version does.
 */
const forbiddenControls = (controls: HostControls, named: boolean): boolean =>
  (named ? ['authentication'] : ['authentication', 'evidence']).some(name => Object.hasOwn(controls, name));
const forwardedControls = (controls: HostControls, named: boolean): HostControls => Object.fromEntries(
  (['signal', 'logging', 'privateInputs', 'materialRoots', ...(named ? ['evidence', 'index'] as const : [])] as const)
    .filter(name => controls[name] !== undefined).map(name => [name, controls[name]]));
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Prepares updates to the exact replacement selections the consumer supplies; never chooses or applies one. Every
 * installed selection keeps its management id; a member the person changed is a conflict the review never overwrites.
 * The result's preparation is applied with the ordinary `apply`, its review digest and re-check.
 */
export async function prepareUpdate(request: ManagedUpdateRequest, controls: HostControls = {}): Promise<ManagedUpdatePreparationResult> {
  forgetProvenState();
  const { identity, valid: identityValid } = distributionIdentity();
  // A request in the earlier shape keeps its 1.0.0 result; one that names its policy gets 1.1.0.
  const named = !!request && typeof request === 'object' && Object.hasOwn(request, 'policy');
  const known: Partial<ManagedUpdatePreparationResult> = {};
  const done = (disposition: ManagedUpdatePreparationResult['disposition'], diagnostics: Diagnostic[] = [], fields: Partial<ManagedUpdatePreparationResult> = {}): ManagedUpdatePreparationResult =>
    ({ schema: named ? SCHEMA_11 : SCHEMA, package: identity, disposition, ...known, ...fields, diagnostics });
  const invalid = (reason: 'request-shape' | 'management-id-changed' | 'scope-changed' | 'update-conflict') => done('invalid', [diagnostic('INPUT_INVALID', reason, {
    'request-shape': 'The managed update request is not valid.',
    'management-id-changed': 'A replacement keeps the management id of the selection it updates.',
    'scope-changed': 'A replacement keeps the scope of the update request.',
    'update-conflict': 'Each update names a different management id and replacement selection id.' }[reason])]);
  let project: string | undefined;
  try {
    dataObject(request, ['target', 'scope', 'updates', 'policy']);
    validateControls(controls);
    if (named) {
      dataObject(request.policy, ['schema', 'catalogReleases', 'evidence']);
      if (!POLICIES.includes(request.policy!.schema)) throw new Error('request-shape');
    }
    dataObject(request.target, ['project']); project = projectRoot(request.target.project);
    if (!Array.isArray(request.updates) || request.updates.length === 0 || request.updates.length > 256) throw new Error('request-shape');
    for (const update of request.updates) {
      dataObject(update, ['managementId', 'replacement']);
      if (typeof update.managementId !== 'string' || !idPattern.test(update.managementId) || !plainObject(update.replacement) ||
        typeof update.replacement.id !== 'string') throw new Error('request-shape');
    }
  } catch { return invalid('request-shape'); }
  if (!['project', 'user'].includes(request.scope) || forbiddenControls(controls, named)) return invalid('request-shape');
  known.target = { project }; known.scope = request.scope;
  const scope = request.scope;
  // The replacement is the consumer's exact selection: Core never substitutes its id or scope.
  if (request.updates.some(update => update.replacement.managementId !== update.managementId)) return invalid('management-id-changed');
  if (request.updates.some(update => update.replacement.scope !== scope)) return invalid('scope-changed');
  const ids = request.updates.map(update => update.managementId), selectionIds = request.updates.map(update => update.replacement.id);
  if (new Set(ids).size !== ids.length || new Set(selectionIds).size !== selectionIds.length) return invalid('update-conflict');
  if (controls.signal?.aborted) return done('cancelled', [diagnostic('CANCELLED', 'cancelled', 'Managed update preparation was cancelled.')]);
  const unavailable = (reason: string, message: string, code = 'PREREQUISITE_UNAVAILABLE') => done('unavailable', [diagnostic(code, reason, message)]);
  if (!identityValid) return unavailable('core-distribution-identity', 'The installed Core distribution identity could not be verified.');
  let home: string;
  let image: Image;
  try { home = userHomeRoot(); image = readImage(project, home); } catch { return unavailable('ownership-unverifiable', UNVERIFIABLE); }
  if (image.ownUnreadable || image.inventoryFailed || scope === 'user' && image.foreignUnverifiable) return unavailable('ownership-unverifiable', UNVERIFIABLE);
  // Trust and session custody are changed only through their own reviewed repair and removal paths.
  const special = new Set<string>();
  if (scope === 'user') {
    try {
      const trust = readTrustCustody(true); const pendingTrust = readPendingTrust(trust);
      for (const entry of [...trust.value.entries, ...(pendingTrust ? pendingEntries(pendingTrust) : [])]) special.add(entry.managementId);
      for (const entry of readMacosCustody().value.entries) special.add(entry.managementId);
    } catch { return unavailable('special-custody-unverifiable', 'Protected trust or session custody could not be verified.', 'STATE_CONFLICT'); }
  }

  const identityOf = (managementId: string) => claimIdentity(scope, managementId, project!);
  const effectRoot = (candidate: string) => candidate === project || candidate === home || isContentRoot(candidate);
  const recordedFacts = (managementId: string): UpdateItemFacts | null => {
    for (const [candidate, stored] of image.receipts) {
      const item = effectRoot(candidate) ? stored.value.items?.[identityOf(managementId)] : undefined;
      if (item) return clone({ name: item.name, kind: item.kind, tool: item.tool, framework: item.framework, item: item.item, origins: item.origins });
    }
    return null;
  };
  const prepared: { entry: UpdateEntry; replacement: Selection; from: UpdateItemFacts | null }[] = [];
  const entries = request.updates.map((update): UpdateEntry => {
    const { managementId, replacement } = update;
    const settled = (disposition: UpdateEntry['disposition'], detail?: Diagnostic): UpdateEntry =>
      ({ managementId, disposition, diagnostics: detail ? [detail] : [], members: [] });
    const refusal = claimRefusal(image, project!, home, scope, managementId, special, 'update');
    if (refusal) return settled(refusal.disposition, refusal.diagnostic);
    // A management id belongs to one item and tool: a replacement for a described item names the same ones.
    const from = recordedFacts(managementId);
    const named = plainObject(replacement.item);
    if (from?.item && !named) return settled('invalid', diagnostic('INPUT_INVALID', 'replacement-unnamed',
      'A replacement for an item recorded at install names its item and tool.'));
    const sameItem = !from || !named || (from.framework === null || replacement.item!.framework === from.framework) &&
      (from.item === null || replacement.item!.itemId === from.item.itemId);
    const sameTool = from?.tool == null || replacement.tool === undefined || replacement.tool === from.tool;
    if (!sameItem || !sameTool) return settled('invalid', diagnostic('INPUT_INVALID', 'replacement-item-changed',
      'A replacement updates the same item for the same tool; another item needs its own management ID.'));
    const entry = settled('prepared');
    prepared.push({ entry, replacement: clone(replacement), from });
    return entry;
  });
  if (!prepared.length) return done('not-prepared', [], { updates: entries });

  const sameImage = sameImageAs(project, home, image);
  try { if (!sameImage()) return unavailable('ownership-changed', 'Protected custody changed during preflight; request the update again.'); }
  catch { return unavailable('ownership-unverifiable', UNVERIFIABLE); }
  // The replacements are prepared in the policy version the request names, with its Catalog releases and Scan evidence,
  // so Prepare renders, binds and checks each exactly as it would at install.
  const { schema, catalogReleases, evidence }: UpdatePolicy = clone(request.policy ?? { schema: POLICY_14 });
  const policy = { schema, mode: 'vibe', ...(catalogReleases === undefined ? {} : { catalogReleases }), ...(evidence === undefined ? {} : { evidence }),
    selections: prepared.map(item => item.replacement) } as ExecutionPolicy;
  let rows: PlannedMember[] = [];
  let preparation = await preparePolicy({ useCase: 'policy', policy, target: { project } }, forwardedControls(controls, named),
    undefined, sameImage, undefined, undefined, { plan: planned => { rows = planned; } });
  // No reviewed resolution is offered: a local edit stays a conflict instead of becoming a replace choice.
  // Review operations name their selections, so the embedded preparation omits the separate selection list too.
  const { resolutionInputs: _resolutions, operationSelections: _selections, ...embedded } = preparation; preparation = embedded;
  if (preparation.diagnostics.some(item => item.reason === 'ownership-changed'))
    return unavailable('ownership-changed', 'Protected custody changed during preparation; request the update again.');
  if (!preparation.review) {
    if (preparation.status === 'cancelled') return done('cancelled', clone(preparation.diagnostics));
    // Without a review nothing is listed or can be applied: no entry is reported prepared, and each carries the reasons.
    for (const { entry } of prepared) Object.assign(entry, { disposition: preparation.status === 'blocked' ? 'unavailable' : 'invalid',
      diagnostics: clone(preparation.diagnostics) });
    return done('not-prepared', [], { updates: entries });
  }
  // A step that requires a conflicting or unavailable one never runs in this review, so its member stays as it is too.
  const operations = new Map((preparation.review?.operations ?? []).map(operation => [operation.id, operation]));
  const held = new Map<string, boolean>();
  const isHeld = (id: string): boolean => {
    if (held.has(id)) return held.get(id)!;
    held.set(id, false);
    const operation = operations.get(id);
    const value = !!operation && (operation.effects === 'conflict' || operation.effects === 'unavailable' || operation.requires.some(isHeld));
    held.set(id, value); return value;
  };
  const privateValues = Object.values(controls.privateInputs ?? {}).flatMap(inputs => Object.values(inputs ?? {})).map(String);
  const review = preparation.review;
  for (const { entry, replacement, from } of prepared) {
    entry.selectionId = replacement.id; entry.from = from;
    const facts = review.selections?.find(item => item.selectionId === replacement.id);
    entry.to = facts?.item ? { name: facts.name!, kind: facts.kind!, tool: facts.tool!, framework: facts.item.framework,
      item: clone(facts.item), origins: clone(facts.origins!) } : null;
    // Prepare's own binding check: a replacement rendered for a binding Core no longer ships is a conflict, stale at Apply.
    const shipped = replacement.bindingDigest === undefined ? undefined : bindingLayout(replacement.tool!, replacement.kind!)?.bindingDigest;
    if (shipped !== undefined && shipped !== replacement.bindingDigest)
      entry.diagnostics = clone(review.conflicts.filter(item => item.reason === 'binding-changed' && item.message.startsWith(`${safeText(replacement.name!, privateValues)} was rendered`)));
    entry.members = rows.filter(row => row.managementIds.includes(entry.managementId)).map(row => {
      const pointer = memberPointer(row.descriptor);
      const waits = row.action !== 'conflict' && isHeld(row.operationId);
      return { kind: publicKind(row.descriptor), path: safeText(join(row.root, row.redactedPath ?? row.descriptor.path), privateValues),
        ...(pointer === undefined ? {} : { pointer: safeText(pointer, privateValues) }),
        ...(row.descriptor.kind === 'block' ? { blockId: row.descriptor.blockId } : {}), ...(row.descriptor.kind === 'hook' ? { groupId: row.descriptor.groupId } : {}),
        ...(row.approval ? { approval: row.approval } : {}), ...(waits ? { action: 'conflict' as const, reason: 'depends-on-conflict' } : { action: row.action, ...(row.reason === undefined ? {} : { reason: row.reason }) }),
        operationId: row.operationId };
    });
  }
  return done('prepared', [], { updates: entries, reviewDigest: review.reviewDigest, preparation });
}
