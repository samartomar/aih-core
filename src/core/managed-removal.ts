import { prepare as preparePolicy, validateControls, dataObject, isManagedContentRoot } from './recipe-engine.js';
import { ownershipInventory, readOwnership, readOwnershipBatch, type Ownership } from './internal/state.js';
import { installedDistribution } from './internal/installed-distribution.js';
import { validGitHubPolicySource } from '../harness/github-policy.mjs';
import { managedRepairRemovalNeedsReconciliation } from '../harness/runtime.mjs';
import { projectRoot, userHomeRoot } from './internal/host-files.js';
import { claimIdentity, classifyStoredClaims, retainClaimDependencies, type Claim } from './internal/recipe-lifecycle.js';
import { readTrustCustody, readPendingTrust, pendingEntries, readTrustOwner, custodyParticipant, type TrustPendingImage, type TrustCustodyImage, type TrustCustodyEntry } from './internal/trust-custody.js';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathPins } from './internal/host-files.js';
import { readMacosCustody, macosCustodyParticipant, joinSessionParticipant, sessionFilesMatch } from './internal/macos-session-custody.js';
import { wrapMacosRemoval } from './macos-session.js';
import type { MacosSessionEffect } from './macos-session-contracts.js';
import { claimedMembers, memberPointer, publicKind, redactedPathFor, type ItemFacts } from './internal/custody-items.js';
import { canonicalJson } from './internal/canonical.js';
import type { CleanupPlanRow } from './internal/removal-plan.js';
import type { RemovalEntry, RemovalSelector } from './removal-types.js';
import type { Diagnostic, ExecutionPolicy, InclusionOrigin } from './types.js';
import type { GitHubPolicySource, HostControls, PreparationResult } from './host-types.js';

export interface ManagedRemovalRequest {
  target: { project: string }; managementId: string; scope: 'project' | 'user'; mode: 'vibe' | 'enterprise';
  /** Required exactly for Enterprise; selected independently of any policy document. */
  organizationSource?: GitHubPolicySource;
}
export type ManagedRemovalDisposition = 'prepared' | 'absent' | 'retained' | 'reconcile-required' | 'unavailable' | 'invalid' | 'cancelled';
export interface ManagedRemovalPreparationResult {
  schema: 'urn:aihq:core:managed-removal-preparation:1.0.0' | 'urn:aihq:core:managed-removal-preparation:1.1.0';
  package: { name: string; version: string };
  disposition: ManagedRemovalDisposition;
  target?: { project: string }; scope?: 'project' | 'user'; mode?: 'vibe' | 'enterprise'; managementId?: string;
  diagnostics: Diagnostic[];
  /** Present exactly for `prepared`; keeps the ordinary opaque handle for `apply`. */
  preparation?: PreparationResult;
}

export type { RemovalMemberAction, RemovalSelector, RemovalMember, RemovalEntry } from './removal-types.js';
/** Removal preparation 1.2.0: several removals in one reviewed step. `mode` defaults to `vibe`. */
export interface ManagedRemovalsRequest {
  target: { project: string }; scope: 'project' | 'user'; removals: RemovalSelector[];
  mode?: 'vibe' | 'enterprise'; organizationSource?: GitHubPolicySource;
}
export interface ManagedRemovalPreparationResult12 {
  schema: 'urn:aihq:core:managed-removal-preparation:1.2.0';
  package: { name: string; version: string };
  disposition: 'prepared' | 'not-prepared' | 'unavailable' | 'invalid' | 'cancelled';
  target?: { project: string }; scope?: 'project' | 'user'; mode?: 'vibe' | 'enterprise';
  diagnostics: Diagnostic[];
  /** One entry per requested removal, in request order; absent when the request is invalid or cancelled. */
  removals?: RemovalEntry[];
  /** The one review digest that binds every listed member; present exactly with `preparation.review`. */
  reviewDigest?: string;
  /** Present exactly for `prepared`: one cleanup-only preparation for every prepared removal. */
  preparation?: PreparationResult;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const SCHEMA = 'urn:aihq:core:managed-removal-preparation:1.0.0' as const;
const SCHEMA_12 = 'urn:aihq:core:managed-removal-preparation:1.2.0' as const;
const POLICY_14 = 'urn:aihq:core:execution-policy:1.4.0' as const;
const POLICY_11 = 'urn:aihq:core:execution-policy:1.1.0' as const;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const diagnostic = (code: string, reason: string, message: string, guidance?: string): Diagnostic =>
  ({ code, reason, message, ...(guidance === undefined ? {} : { guidance }) });

interface Image {
  receipts: Map<string, { value: Ownership; digest: string | null }>;
  /** Raw receipt inventory plus the digest of each mandatory receipt: equal images classify identically. */
  fingerprint: string;
  ownUnreadable: boolean; inventoryFailed: boolean; foreignUnverifiable: boolean;
}
/** One validated read of every protected receipt the policy engine will also read. */
function readImage(project: string, home: string): Image {
  const receipts: Image['receipts'] = new Map();
  let ownUnreadable = false; let inventoryFailed = false; let foreignUnverifiable = false;
  const own: [string, string | null][] = [];
  const ownRoots = [...new Set([project, home])];
  try {
    const stored = readOwnershipBatch(ownRoots);
    for (const root of ownRoots) {
      const receipt = stored.get(root)!;
      receipts.set(root, receipt); own.push([root, receipt.digest]);
    }
  } catch {
    // A bad receipt should not mask an independently verifiable root.
    for (const root of ownRoots) {
      try { const receipt = readOwnership(root); receipts.set(root, receipt); own.push([root, receipt.digest]); }
      catch { ownUnreadable = true; own.push([root, 'unverifiable']); }
    }
  }
  let entries: [string, string][] = [];
  try {
    const inventory = ownershipInventory(); entries = [...inventory.entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    foreignUnverifiable = inventory.unverifiable;
    const foreign = inventory.targets.filter(root => !receipts.has(root));
    try { for (const [root, stored] of readOwnershipBatch(foreign)) receipts.set(root, stored); }
    catch {
      for (const root of foreign) {
        try { receipts.set(root, readOwnership(root)); }
        catch { foreignUnverifiable = true; }
      }
    }
  } catch { inventoryFailed = true; }
  return { receipts, fingerprint: JSON.stringify({ own, entries, inventoryFailed }), ownUnreadable, inventoryFailed, foreignUnverifiable };
}

interface Custody { claimed: boolean; claimless: boolean; ambiguous: boolean; members: number; retained: boolean }
function classify(image: Image, project: string, home: string, scope: 'project' | 'user', managementId: string): Custody {
  const wanted = claimIdentity(scope, managementId, project);
  const matches = (claim: Claim, root: string) => claim.scope === scope && claim.managementId === managementId &&
    claimIdentity(claim.scope, claim.managementId, root) === wanted;
  const custody: Custody = { claimed: false, claimless: false, ambiguous: false, members: 0, retained: false };
  const effectRoot = (root: string) => root === project || root === home || isManagedContentRoot(root);
  // The same candidate, retention and dependency-closure rule the policy engine applies to a cleanup-only policy.
  const { candidates, retained, dependencies } = classifyStoredClaims(image.receipts,
    (_claim, root, identity) => effectRoot(root) && identity === wanted);
  for (const [root, stored] of image.receipts) {
    const owners = Object.values(stored.value.members);
    for (const owner of owners) {
      if (owner.claims?.some(claim => matches(claim, root))) custody.members++;
      if (owner.claims !== undefined || owner.managementId !== managementId || !effectRoot(root)) continue;
      // Claimless custody carries no scope of its own: it comes from the receipt root.
      if (root === project && root === home) custody.ambiguous = true;
      else if ((root === project ? 'project' : 'user') === scope) custody.claimless = true;
    }
  }
  custody.claimed = candidates.has(wanted);
  retainClaimDependencies(retained, dependencies);
  custody.retained = retained.has(wanted);
  return custody;
}

/**
 * Prepares removal through the existing cleanup-only policy engine; never applies. A request with `removals` is removal
 * preparation 1.2.0: several removals, by origin or whole, in one review. The single-id form keeps its earlier results.
 */
export function prepareManagedRemoval(request: ManagedRemovalsRequest, controls?: HostControls): Promise<ManagedRemovalPreparationResult12>;
export function prepareManagedRemoval(request: ManagedRemovalRequest, controls?: HostControls): Promise<ManagedRemovalPreparationResult>;
export async function prepareManagedRemoval(request: ManagedRemovalRequest | ManagedRemovalsRequest, controls: HostControls = {}): Promise<ManagedRemovalPreparationResult | ManagedRemovalPreparationResult12> {
  if (request && typeof request === 'object' && Object.hasOwn(request, 'removals')) return prepareRemovals(request as ManagedRemovalsRequest, controls);
  return prepareOne(request as ManagedRemovalRequest, controls);
}
async function prepareOne(request: ManagedRemovalRequest, controls: HostControls): Promise<ManagedRemovalPreparationResult> {
  let identity: { name: string; version: string } = { name: '@aihq/core', version: 'unavailable' };
  let identityValid = true;
  try { identity = installedDistribution(); } catch { identityValid = false; }
  const base = { schema: SCHEMA, package: identity } as const;
  const done = (disposition: ManagedRemovalDisposition, fields: Partial<ManagedRemovalPreparationResult>, diagnostics: Diagnostic[] = []): ManagedRemovalPreparationResult =>
    ({ ...base, disposition, ...fields, diagnostics });
  const known: Partial<ManagedRemovalPreparationResult> = {};
  const invalid = (reason: 'request-shape' | 'organization-source') => done('invalid', known, [diagnostic('INPUT_INVALID', reason,
    reason === 'request-shape' ? 'The managed removal request is not valid.' : 'Enterprise removal needs an organization source and Vibe removal accepts none.')]);
  try {
    dataObject(request, ['target', 'managementId', 'scope', 'mode', 'organizationSource']);
    validateControls(controls);
  } catch { return invalid('request-shape'); }
  // Removal never acquires material or accepts private inputs, even an empty map.
  const hasControl = (name: string) => Object.hasOwn(controls, name);
  let project: string | undefined;
  try { dataObject(request.target, ['project']); project = projectRoot(request.target.project); known.target = { project }; } catch { /* reported below */ }
  if (['vibe', 'enterprise'].includes(request.mode)) known.mode = request.mode;
  if (['project', 'user'].includes(request.scope)) known.scope = request.scope;
  if (typeof request.managementId === 'string' && idPattern.test(request.managementId)) known.managementId = request.managementId;
  if (!project || !known.mode || !known.scope || !known.managementId || hasControl('privateInputs') || hasControl('materialRoots') || hasControl('evidence'))
    return invalid('request-shape');
  const { scope, mode, managementId } = known as Required<Pick<ManagedRemovalPreparationResult, 'scope' | 'mode' | 'managementId'>>;
  if ((mode === 'enterprise') !== (request.organizationSource !== undefined)) return invalid('organization-source');
  if (mode === 'enterprise') {
    let validSource = false;
    try { validSource = validGitHubPolicySource(request.organizationSource); } catch { /* invalid request data */ }
    if (!validSource) return invalid('organization-source');
  }
  if (controls.signal?.aborted) return done('cancelled', known, [diagnostic('CANCELLED', 'cancelled', 'Managed removal preparation was cancelled.')]);
  if (!identityValid) return done('unavailable', known, [diagnostic('PREREQUISITE_UNAVAILABLE',
    'core-distribution-identity', 'The installed Core distribution identity could not be verified.')]);

  const unavailable = (reason: string, message: string, code = 'PREREQUISITE_UNAVAILABLE') => done('unavailable', known, [diagnostic(code, reason, message)]);
  const unverifiable = () => unavailable('ownership-unverifiable', 'Protected custody for this removal could not be verified.');
  let home: string;
  let image: Image;
  try { home = userHomeRoot(); image = readImage(project, home); } catch { return unverifiable(); }
  if (image.ownUnreadable || image.inventoryFailed || scope === 'user' && image.foreignUnverifiable) return unverifiable();
  const custody = classify(image, project, home, scope, managementId);
  let sessionImage: ReturnType<typeof readMacosCustody> | undefined;
  let sessionEntry: NonNullable<typeof sessionImage>['value']['entries'][number] | undefined;
  if (scope === 'user') {
    try {
      sessionImage = readMacosCustody(); sessionEntry = sessionImage.value.entries.find(entry => entry.managementId === managementId);
      if (sessionEntry && (sessionEntry.context !== 'terminal' || sessionEntry.keys.length || sessionEntry.profileIds.length || !sessionFilesMatch(sessionEntry)))
        return done('reconcile-required', known, [diagnostic('STATE_CONFLICT', 'session-ownership-conflict', 'Session configuration changed; reconcile it before removal.')]);
    } catch (error) { return unavailable(error instanceof Error ? error.message : 'session-custody-unavailable', 'Session recovery requires reconciliation.', 'STATE_CONFLICT'); }
  }
  let trustImage: TrustCustodyImage | undefined; let trustEntries: TrustCustodyEntry[] = [];let pending:TrustPendingImage|undefined;
  if (scope === 'user') {
    try {
      trustImage = readTrustCustody(true); trustEntries = trustImage.value.entries.filter(entry => entry.managementId === managementId);
      const observed=readPendingTrust(trustImage);const entries=observed?pendingEntries(observed):[];
      if(entries.some(e=>e.managementId===managementId)) {
        if(mode!=='vibe'||entries.some(e=>e.managementId!==managementId)) throw new Error('trust-custody-pending');
        pending=observed;trustEntries=entries.map(entry=>{
          const owner=readTrustOwner(entry).owner;
          return [entry,...observed!.before.entries].find(candidate=>candidate.pathKey===entry.pathKey&&(!owner||candidate.recipeIdentity===owner.recipeIdentity&&candidate.outputSha256===owner.sha256))??entry;
        });
      } else if (trustEntries.length) trustImage = readTrustCustody();
    }
    catch (error) { return unavailable(error instanceof Error ? error.message : 'trust-custody-conflict','Protected trust custody requires reconciliation.','STATE_CONFLICT'); }
  }
  const sameImage = () => {
    const current = readImage(project!, home);
    return current.fingerprint === image.fingerprint && current.ownUnreadable === image.ownUnreadable &&
      current.inventoryFailed === image.inventoryFailed && current.foreignUnverifiable === image.foreignUnverifiable;
  };
  try { if (!sameImage()) return unavailable('ownership-changed', 'Protected custody changed during preflight; request removal again.'); }
  catch { return unverifiable(); }
  if (custody.ambiguous) return unavailable('ambiguous-scope', 'Legacy custody for this ID cannot be assigned to one scope.');
  if (custody.claimless) return done('reconcile-required', known, [diagnostic('PREREQUISITE_UNAVAILABLE', 'legacy-reconcile',
    'This ID has legacy custody without an explicit claim.', 'Reselect the original recipe under the same management ID to establish a claim, then request removal again; otherwise reconcile manually.')]);
  const absent = (path: string) => {
    pathPins(path);
    try { lstatSync(path); return false; } catch(error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  };
  if (!custody.claimed && !trustEntries.length) return done('absent', known);
  const members = [...image.receipts.values()].flatMap(stored => Object.entries(stored.value.members)
    .filter(([, owner]) => owner.claims?.some(claim => claim.managementId === managementId && claim.scope === scope))
    .map(([path, owner]) => owner.descriptor ?? { kind: 'file' as const, path }));
  if (managedRepairRemovalNeedsReconciliation({ managementId, scope, members, platform: process.platform }))
    return done('reconcile-required', known, [diagnostic('STATE_CONFLICT', 'repair-custody-reconcile',
      'An earlier repair owns a complete configuration file. Reconcile that receipt and its configuration manually before using bounded removal.')]);
  if (trustEntries.length) {
    try {
      for (const entry of trustEntries) {
        const {absolute:path,owner:member}=readTrustOwner(entry);
        if (!custody.claimed) {
          if (mode === 'enterprise') return unavailable('metadata-only-removal','Organization admission does not cover trust-only cleanup.','AUTHORITY_DENIED');
          if (member || !absent(path)) return done('reconcile-required',known,[diagnostic('STATE_CONFLICT','trust-custody-conflict','Trust output or ownership remains; reconcile it before cleanup.')]);
        } else if (member && (member.recipeIdentity !== entry.recipeIdentity || member.sha256 !== entry.outputSha256))
          return done('reconcile-required',known,[diagnostic('STATE_CONFLICT','trust-custody-conflict','Trust ownership and provenance disagree.')]);
      }
    } catch { return unavailable('trust-custody-conflict','Trust custody could not be verified.','STATE_CONFLICT'); }
  }
  if (custody.retained) return done('retained', known, [diagnostic('PREREQUISITE_UNAVAILABLE', 'dependency-retained',
    'Another managed selection still requires this one, so its claim is retained.')]);
  if (mode === 'enterprise' && custody.members === 0) return unavailable('metadata-only-removal',
    'Organization removal admission does not cover a custody-only change.', 'AUTHORITY_DENIED');

  const hasBoundedConfig = members.some(member => member.kind === 'entry' && ['ini', 'yaml', 'properties'].includes(member.format));
  const policy: ExecutionPolicy = { schema: hasBoundedConfig ? 'urn:aihq:core:execution-policy:1.2.0' : POLICY_11, mode, selections: [], removals: [{ managementId, scope }] };
  const forwarded: HostControls = { ...(controls.signal === undefined ? {} : { signal: controls.signal }),
    ...(controls.logging === undefined ? {} : { logging: controls.logging }),
    ...(controls.authentication === undefined ? {} : { authentication: controls.authentication }) };
  const trustParticipant = trustImage && trustEntries.length ? custodyParticipant(trustImage, [], () => {
    if (!sameImage()) throw new Error('review-stale');
    for (const entry of trustEntries) if (!custody.claimed && !absent(join(home,...entry.relativePath.split('/')))) throw new Error('review-stale');
  }, trustEntries, pending) : undefined;
  const effects: MacosSessionEffect[] = [];
  const sessionParticipant = sessionImage && sessionEntry ? macosCustodyParticipant(sessionImage, null, sessionEntry, () => {
    if (!sameImage() || !sessionFilesMatch(sessionEntry!)) throw new Error('review-stale');
  }, effects) : undefined;
  if (sessionParticipant && !trustParticipant) return unavailable('session-custody-unavailable', 'Ordinary trust and session custody must agree.', 'STATE_CONFLICT');
  const participant = sessionParticipant ? joinSessionParticipant(trustParticipant!, sessionParticipant) : trustParticipant;
  let preparation = await preparePolicy({ useCase: 'policy', policy, target: { project },
    ...(request.organizationSource === undefined ? {} : { organizationSource: request.organizationSource }) }, forwarded,
  undefined, sameImage, participant);
  if (sessionEntry) preparation = wrapMacosRemoval(preparation, sessionEntry, forwarded, effects);
  // A removal review holds only generated lifecycle cleanup; the embedded preparation keeps its published shape.
  const { operationSelections: _selections, ...embedded } = preparation; preparation = embedded;
  if (preparation.diagnostics.some(item => item.reason === 'ownership-changed'))
    return unavailable('ownership-changed', 'Protected custody changed during preparation; request removal again.');
  return done('prepared', { ...known, preparation,
    ...(preparation.review?.schema === 'urn:aihq:core:prepared-work:1.4.0' ? { schema: 'urn:aihq:core:managed-removal-preparation:1.1.0' as const } : {}) });
}

const text = (value: unknown, bound: number): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= bound;
function validOrigin(origin: unknown): origin is NonNullable<RemovalSelector['origin']> {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false;
  const keys = Object.keys(origin);
  if (keys.length === 1 && keys[0] === 'reasonIncluded') return (origin as { reasonIncluded: unknown }).reasonIncluded === 'chosen';
  if (keys.length !== 1 || keys[0] !== 'set') return false;
  const set = (origin as { set: unknown }).set as Record<string, unknown>;
  return !!set && typeof set === 'object' && !Array.isArray(set) && Object.keys(set).length === 3 &&
    text(set.framework, 128) && text(set.setId, 128) && typeof set.setSha256 === 'string' && /^[a-f0-9]{64}$/.test(set.setSha256);
}
/** Does a recorded inclusion equal the selector's origin: the full qualified set identity, never a bare set id. */
const sameOrigin = (recorded: InclusionOrigin, origin: NonNullable<RemovalSelector['origin']>): boolean => 'set' in origin ?
  recorded.reasonIncluded === 'in-set' && recorded.set.framework === origin.set.framework && recorded.set.setId === origin.set.setId &&
    recorded.set.setSha256 === origin.set.setSha256 : recorded.reasonIncluded === 'chosen';

/** Removal preparation 1.2.0: preflight every removal with the single-id safeguards, then one cleanup-only review. */
async function prepareRemovals(request: ManagedRemovalsRequest, controls: HostControls): Promise<ManagedRemovalPreparationResult12> {
  let identity: { name: string; version: string } = { name: '@aihq/core', version: 'unavailable' };
  let identityValid = true;
  try { identity = installedDistribution(); } catch { identityValid = false; }
  const known: Partial<ManagedRemovalPreparationResult12> = {};
  const done = (disposition: ManagedRemovalPreparationResult12['disposition'], diagnostics: Diagnostic[] = [], fields: Partial<ManagedRemovalPreparationResult12> = {}): ManagedRemovalPreparationResult12 =>
    ({ schema: SCHEMA_12, package: identity, disposition, ...known, ...fields, diagnostics });
  const invalid = (reason: 'request-shape' | 'organization-source' | 'removal-conflict') => done('invalid', [diagnostic('INPUT_INVALID', reason,
    reason === 'request-shape' ? 'The managed removal request is not valid.' : reason === 'removal-conflict' ?
      'Each removal names a selection once, either whole or by distinct origins.' : 'Enterprise removal needs an organization source and Vibe removal accepts none.')]);
  let project: string | undefined;
  try {
    dataObject(request, ['target', 'scope', 'removals', 'mode', 'organizationSource']);
    validateControls(controls);
    dataObject(request.target, ['project']); project = projectRoot(request.target.project);
    if (!Array.isArray(request.removals) || request.removals.length === 0 || request.removals.length > 256) throw new Error('request-shape');
    for (const removal of request.removals) {
      dataObject(removal, ['managementId', 'origin']);
      if (typeof removal.managementId !== 'string' || !idPattern.test(removal.managementId) || removal.origin !== undefined && !validOrigin(removal.origin)) throw new Error('request-shape');
    }
  } catch { return invalid('request-shape'); }
  const hasControl = (name: string) => Object.hasOwn(controls, name);
  const mode = request.mode ?? 'vibe';
  if (!['project', 'user'].includes(request.scope) || !['vibe', 'enterprise'].includes(mode) ||
      hasControl('privateInputs') || hasControl('materialRoots') || hasControl('evidence')) return invalid('request-shape');
  known.target = { project }; known.scope = request.scope; known.mode = mode;
  const scope = request.scope;
  // A selection is named once whole, or by distinct origins; the same removal twice is ambiguous.
  const seen = new Map<string, Set<string>>();
  for (const removal of request.removals) {
    const forms = seen.get(removal.managementId) ?? new Set<string>();
    const form = removal.origin === undefined ? 'whole' : canonicalJson(removal.origin);
    if (forms.has(form) || forms.size && (form === 'whole' || forms.has('whole'))) return invalid('removal-conflict');
    seen.set(removal.managementId, forms.add(form));
  }
  if ((mode === 'enterprise') !== (request.organizationSource !== undefined)) return invalid('organization-source');
  if (mode === 'enterprise') {
    let validSource = false;
    try { validSource = validGitHubPolicySource(request.organizationSource); } catch { /* invalid request data */ }
    if (!validSource) return invalid('organization-source');
  }
  if (controls.signal?.aborted) return done('cancelled', [diagnostic('CANCELLED', 'cancelled', 'Managed removal preparation was cancelled.')]);
  const unavailable = (reason: string, message: string, code = 'PREREQUISITE_UNAVAILABLE') => done('unavailable', [diagnostic(code, reason, message)]);
  if (!identityValid) return unavailable('core-distribution-identity', 'The installed Core distribution identity could not be verified.');
  let home: string;
  let image: Image;
  try { home = userHomeRoot(); image = readImage(project, home); } catch { return unavailable('ownership-unverifiable', 'Protected custody for this removal could not be verified.'); }
  if (image.ownUnreadable || image.inventoryFailed || scope === 'user' && image.foreignUnverifiable)
    return unavailable('ownership-unverifiable', 'Protected custody for this removal could not be verified.');
  // Trust and session custody keep their own reviewed path: the single-id call.
  const special = new Set<string>();
  if (scope === 'user') {
    try {
      const trust = readTrustCustody(true); const pendingTrust = readPendingTrust(trust);
      for (const entry of [...trust.value.entries, ...(pendingTrust ? pendingEntries(pendingTrust) : [])]) special.add(entry.managementId);
      for (const entry of readMacosCustody().value.entries) special.add(entry.managementId);
    } catch { return unavailable('special-custody-unverifiable', 'Protected trust or session custody could not be verified.', 'STATE_CONFLICT'); }
  }

  const identityOf = (managementId: string) => claimIdentity(scope, managementId, project!);
  const effectRoot = (candidate: string) => candidate === project || candidate === home || isManagedContentRoot(candidate);
  // The receipt recording a selection's item facts; user custody can also live in Core-managed content roots.
  const itemRoot = (managementId: string) => [...image.receipts].find(([candidate, stored]) => effectRoot(candidate) &&
    stored.value.items?.[identityOf(managementId)] !== undefined)?.[0];
  type Plan = { entry: RemovalEntry; whole?: true; releases?: InclusionOrigin[] };
  const plans: Plan[] = request.removals.map(removal => ({ entry: { managementId: removal.managementId, ...(removal.origin === undefined ? {} : { origin: clone(removal.origin) }),
    disposition: 'absent', diagnostics: [], members: [] } }));
  const settle = (plan: Plan, disposition: RemovalEntry['disposition'], detail?: Diagnostic) => {
    plan.entry.disposition = disposition; if (detail) plan.entry.diagnostics = [detail];
  };
  // Removals of whole selections are candidates together, so removing a dependant with its dependency frees both.
  const releaseOrigins = new Map<string, InclusionOrigin[]>();
  const wholeIds = new Set<string>();
  for (const [managementId] of seen) {
    const own = plans.filter(plan => plan.entry.managementId === managementId);
    const custody = classify(image, project, home, scope, managementId);
    const members = [...image.receipts.values()].flatMap(stored => Object.entries(stored.value.members)
      .filter(([, owner]) => owner.claims?.some(claim => claim.managementId === managementId && claim.scope === scope))
      .map(([path, owner]) => owner.descriptor ?? { kind: 'file' as const, path }));
    const all = (disposition: RemovalEntry['disposition'], detail?: Diagnostic) => own.forEach(plan => settle(plan, disposition, detail));
    if (special.has(managementId)) { all('unavailable', diagnostic('PREREQUISITE_UNAVAILABLE', 'single-removal-required',
      'Trust or session custody is removed through the single-id removal call.')); continue; }
    if (custody.ambiguous) { all('unavailable', diagnostic('PREREQUISITE_UNAVAILABLE', 'ambiguous-scope', 'Legacy custody for this ID cannot be assigned to one scope.')); continue; }
    if (custody.claimless) { all('reconcile-required', diagnostic('PREREQUISITE_UNAVAILABLE', 'legacy-reconcile', 'This ID has legacy custody without an explicit claim.',
      'Reselect the original recipe under the same management ID to establish a claim, then request removal again; otherwise reconcile manually.')); continue; }
    if (!custody.claimed) { all('absent'); continue; }
    if (managedRepairRemovalNeedsReconciliation({ managementId, scope, members, platform: process.platform })) {
      all('reconcile-required', diagnostic('STATE_CONFLICT', 'repair-custody-reconcile',
        'An earlier repair owns a complete configuration file. Reconcile that receipt and its configuration manually before using bounded removal.')); continue;
    }
    const byOrigin = own.filter(plan => plan.entry.origin !== undefined);
    if (byOrigin.length) {
      const recordedRoot = itemRoot(managementId);
      const recorded = recordedRoot === undefined ? [] : image.receipts.get(recordedRoot)!.value.items![identityOf(managementId)]!.origins;
      if (!recorded.length) { all('reconcile-required', diagnostic('PREREQUISITE_UNAVAILABLE', 'origin-unrecorded',
        'No origin is recorded for this selection.', 'Remove the whole selection without an origin.')); continue; }
      let remaining = recorded;
      for (const plan of byOrigin) {
        const matched = recorded.filter(origin => sameOrigin(origin, plan.entry.origin!));
        if (!matched.length) settle(plan, 'absent', diagnostic('PREREQUISITE_UNAVAILABLE', 'origin-absent', 'This inclusion is not recorded for the selection.'));
        else { remaining = remaining.filter(origin => !matched.includes(origin)); plan.whole = true; }
      }
      const matchedPlans = byOrigin.filter(plan => plan.whole);
      if (!matchedPlans.length) continue;
      if (remaining.length) {
        for (const plan of matchedPlans) { delete plan.whole; plan.releases = remaining; }
        releaseOrigins.set(managementId, remaining);
        continue;
      }
    } else own.forEach(plan => { plan.whole = true; });
    wholeIds.add(managementId);
  }
  // The same retention rule the single-id call applies, over every whole removal at once.
  const wanted = new Set([...wholeIds].map(identityOf));
  const { retained, dependencies } = classifyStoredClaims(image.receipts, (_claim, claimRoot, id) => effectRoot(claimRoot) && wanted.has(id));
  retainClaimDependencies(retained, dependencies);
  for (const managementId of [...wholeIds]) {
    const own = plans.filter(plan => plan.entry.managementId === managementId && plan.whole);
    if (retained.has(identityOf(managementId))) {
      own.forEach(plan => { delete plan.whole; settle(plan, 'retained', diagnostic('PREREQUISITE_UNAVAILABLE', 'dependency-retained',
        'Another managed selection still requires this one, so its claim is retained.')); });
      wholeIds.delete(managementId);
    } else if (mode === 'enterprise' && classify(image, project, home, scope, managementId).members === 0) {
      own.forEach(plan => { delete plan.whole; settle(plan, 'unavailable', diagnostic('AUTHORITY_DENIED', 'metadata-only-removal',
        'Organization removal admission does not cover a custody-only change.')); });
      wholeIds.delete(managementId);
    }
  }
  // A released origin changes only custody metadata, which Enterprise admission does not cover.
  if (mode === 'enterprise') for (const [managementId] of releaseOrigins) {
    plans.filter(plan => plan.entry.managementId === managementId && plan.releases).forEach(plan => { delete plan.releases; settle(plan, 'unavailable',
      diagnostic('AUTHORITY_DENIED', 'metadata-only-removal', 'Organization removal admission does not cover a custody-only change.')); });
    releaseOrigins.delete(managementId);
  }
  if (!wholeIds.size && !releaseOrigins.size) return done('not-prepared', [], { removals: plans.map(plan => plan.entry) });

  const sameImage = () => {
    const current = readImage(project!, home);
    return current.fingerprint === image.fingerprint && current.ownUnreadable === image.ownUnreadable &&
      current.inventoryFailed === image.inventoryFailed && current.foreignUnverifiable === image.foreignUnverifiable;
  };
  try { if (!sameImage()) return unavailable('ownership-changed', 'Protected custody changed during preflight; request removal again.'); }
  catch { return unavailable('ownership-unverifiable', 'Protected custody for this removal could not be verified.'); }
  const originReleases = [...releaseOrigins].map(([managementId, origins]) => {
    const root = itemRoot(managementId)!;
    const item = image.receipts.get(root)!.value.items![identityOf(managementId)]!;
    const facts: ItemFacts = { managementId: item.managementId, scope: item.scope, name: item.name, kind: item.kind, framework: item.framework,
      item: item.item, tool: item.tool, origins: clone(origins) };
    return { root, id: identityOf(managementId), facts };
  });
  const policy: ExecutionPolicy = { schema: POLICY_14, mode, selections: [],
    ...(wholeIds.size ? { removals: [...wholeIds].map(managementId => ({ managementId, scope })) } : {}) };
  const forwarded: HostControls = { ...(controls.signal === undefined ? {} : { signal: controls.signal }),
    ...(controls.logging === undefined ? {} : { logging: controls.logging }),
    ...(controls.authentication === undefined ? {} : { authentication: controls.authentication }) };
  let rows: CleanupPlanRow[] = [];
  let preparation = await preparePolicy({ useCase: 'policy', policy, target: { project },
    ...(request.organizationSource === undefined ? {} : { organizationSource: request.organizationSource }) }, forwarded,
  undefined, sameImage, undefined, { originReleases, plan: planned => { rows = planned; } });
  const { operationSelections: _selections, ...embedded } = preparation; preparation = embedded;
  if (preparation.diagnostics.some(item => item.reason === 'ownership-changed'))
    return unavailable('ownership-changed', 'Protected custody changed during preparation; request removal again.');
  const listed = (descriptorRoot: string, descriptor: CleanupPlanRow['descriptor'], path: string | undefined) => {
    const pointer = memberPointer(descriptor);
    return { kind: publicKind(descriptor), path: join(descriptorRoot, path ?? descriptor.path), ...(pointer === undefined ? {} : { pointer }),
      ...(descriptor.kind === 'block' ? { blockId: descriptor.blockId } : {}), ...(descriptor.kind === 'hook' ? { groupId: descriptor.groupId } : {}) };
  };
  for (const plan of plans) {
    if (plan.whole) {
      const id = identityOf(plan.entry.managementId);
      plan.entry.disposition = 'prepared'; plan.entry.change = 'remove-selection';
      plan.entry.members = rows.filter(row => row.removed.includes(id)).map(row => ({ ...listed(row.root, row.descriptor, row.redactedPath),
        ...(row.approval ? { approval: row.approval } : {}), action: row.action, ...(row.reason === undefined ? {} : { reason: row.reason }), operationId: row.operationId }));
    } else if (plan.releases) {
      plan.entry.disposition = 'prepared'; plan.entry.change = 'remove-origin';
      plan.entry.members = [...image.receipts].filter(([candidate]) => effectRoot(candidate)).flatMap(([root, stored]) =>
        claimedMembers(stored.value, scope, plan.entry.managementId).map(([key, owner]) => ({
          ...listed(root, owner.descriptor ?? { kind: 'file', path: key }, redactedPathFor(stored.value, key)),
          ...(owner.approval ? { approval: { tool: owner.approval.tool } } : {}), action: 'keep-shared' as const, reason: 'another-origin', operationId: null })));
    }
  }
  return done('prepared', [], { removals: plans.map(plan => plan.entry), ...(preparation.review ? { reviewDigest: preparation.review.reviewDigest } : {}), preparation });
}
