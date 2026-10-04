import { prepare as preparePolicy, validateControls, dataObject, isManagedContentRoot } from './recipe-engine.js';
import { ownershipInventory, readOwnership, readOwnershipBatch, type Ownership } from './internal/state.js';
import { installedDistribution } from './internal/installed-distribution.js';
import { validGitHubPolicySource } from '../harness/github-policy.mjs';
import { projectRoot, userHomeRoot } from './internal/host-files.js';
import { claimIdentity, classifyStoredClaims, retainClaimDependencies, type Claim } from './internal/recipe-lifecycle.js';
import type { Diagnostic, ExecutionPolicy } from './types.js';
import type { GitHubPolicySource, HostControls, PreparationResult } from './host-types.js';

export interface ManagedRemovalRequest {
  target: { project: string }; managementId: string; scope: 'project' | 'user'; mode: 'vibe' | 'enterprise';
  /** Required exactly for Enterprise; selected independently of any policy document. */
  organizationSource?: GitHubPolicySource;
}
export type ManagedRemovalDisposition = 'prepared' | 'absent' | 'retained' | 'reconcile-required' | 'unavailable' | 'invalid' | 'cancelled';
export interface ManagedRemovalPreparationResult {
  schema: 'urn:aihq:core:managed-removal-preparation:1.0.0';
  package: { name: string; version: string };
  disposition: ManagedRemovalDisposition;
  target?: { project: string }; scope?: 'project' | 'user'; mode?: 'vibe' | 'enterprise'; managementId?: string;
  diagnostics: Diagnostic[];
  /** Present exactly for `prepared`; keeps the ordinary opaque handle for `apply`. */
  preparation?: PreparationResult;
}

const SCHEMA = 'urn:aihq:core:managed-removal-preparation:1.0.0' as const;
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

/** Prepares removal of one recorded selection through the existing cleanup-only policy engine; never applies. */
export async function prepareManagedRemoval(request: ManagedRemovalRequest, controls: HostControls = {}): Promise<ManagedRemovalPreparationResult> {
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
  const home = userHomeRoot();
  let image: Image;
  try { image = readImage(project, home); } catch { return unverifiable(); }
  if (image.ownUnreadable || image.inventoryFailed || scope === 'user' && image.foreignUnverifiable) return unverifiable();
  const custody = classify(image, project, home, scope, managementId);
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
  if (!custody.claimed) return done('absent', known);
  if (custody.retained) return done('retained', known, [diagnostic('PREREQUISITE_UNAVAILABLE', 'dependency-retained',
    'Another managed selection still requires this one, so its claim is retained.')]);
  if (mode === 'enterprise' && custody.members === 0) return unavailable('metadata-only-removal',
    'Organization removal admission does not cover a custody-only change.', 'AUTHORITY_DENIED');

  const policy: ExecutionPolicy = { schema: POLICY_11, mode, selections: [], removals: [{ managementId, scope }] };
  const forwarded: HostControls = { ...(controls.signal === undefined ? {} : { signal: controls.signal }),
    ...(controls.logging === undefined ? {} : { logging: controls.logging }),
    ...(controls.authentication === undefined ? {} : { authentication: controls.authentication }) };
  const preparation = await preparePolicy({ useCase: 'policy', policy, target: { project },
    ...(request.organizationSource === undefined ? {} : { organizationSource: request.organizationSource }) }, forwarded,
  undefined, sameImage);
  if (preparation.diagnostics.some(item => item.reason === 'ownership-changed'))
    return unavailable('ownership-changed', 'Protected custody changed during preparation; request removal again.');
  return done('prepared', { ...known, preparation });
}
