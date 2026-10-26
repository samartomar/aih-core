// Custody preflight shared by managed removal and managed update preparation: one validated read of every protected
// receipt, the installed distribution identity, and a selection's claim classification.
import { isContentRoot, ownershipInventory, readOwnership, readOwnershipBatch, type Ownership } from './state.js';
import { installedDistribution } from './installed-distribution.js';
import { claimIdentity, classifyStoredClaims, retainClaimDependencies, type Claim } from './recipe-lifecycle.js';
import { managedRepairRemovalNeedsReconciliation } from '../../harness/runtime.mjs';
import type { Diagnostic } from '../types.js';

export interface Image {
  receipts: Map<string, { value: Ownership; digest: string | null }>;
  /** Raw receipt inventory plus the digest of each mandatory receipt: equal images classify identically. */
  fingerprint: string;
  ownUnreadable: boolean; inventoryFailed: boolean; foreignUnverifiable: boolean;
}
/** One validated read of every protected receipt the policy engine will also read. */
export function readImage(project: string, home: string): Image {
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

/** The installed distribution identity removal and update preparation report, and whether it could be verified. */
export function distributionIdentity(): { identity: { name: string; version: string }; valid: boolean } {
  try { return { identity: installedDistribution(), valid: true }; } catch { return { identity: { name: '@aihq/core', version: 'unavailable' }, valid: false }; }
}
/** A re-read of every receipt still classifies identically to `image`. */
export const sameImageAs = (project: string, home: string, image: Image) => (): boolean => {
  const current = readImage(project, home);
  return current.fingerprint === image.fingerprint && current.ownUnreadable === image.ownUnreadable &&
    current.inventoryFailed === image.inventoryFailed && current.foreignUnverifiable === image.foreignUnverifiable;
};
export interface Custody { claimed: boolean; claimless: boolean; ambiguous: boolean; members: number; retained: boolean }
export function classify(image: Image, project: string, home: string, scope: 'project' | 'user', managementId: string): Custody {
  const wanted = claimIdentity(scope, managementId, project);
  const matches = (claim: Claim, root: string) => claim.scope === scope && claim.managementId === managementId &&
    claimIdentity(claim.scope, claim.managementId, root) === wanted;
  const custody: Custody = { claimed: false, claimless: false, ambiguous: false, members: 0, retained: false };
  const effectRoot = (root: string) => root === project || root === home || isContentRoot(root);
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

const diagnostic = (code: string, reason: string, message: string, guidance?: string): Diagnostic =>
  ({ code, reason, message, ...(guidance === undefined ? {} : { guidance }) });
/**
 * Why removal preparation 1.2.0 or update preparation cannot change one selection's custody, or `undefined` when it holds
 * an eligible claim. Both apply the same safeguards in the same order; only their wording differs.
 */
export function claimRefusal(image: Image, project: string, home: string, scope: 'project' | 'user', managementId: string,
    special: ReadonlySet<string>, change: 'removal' | 'update'): { disposition: 'unavailable' | 'reconcile-required' | 'absent'; diagnostic?: Diagnostic } | undefined {
  if (special.has(managementId)) return { disposition: 'unavailable', diagnostic: change === 'removal' ?
    diagnostic('PREREQUISITE_UNAVAILABLE', 'single-removal-required', 'Trust or session custody is removed through the single-id removal call.') :
    diagnostic('PREREQUISITE_UNAVAILABLE', 'special-custody', 'Trust or session custody is changed only through its own repair and removal.') };
  const custody = classify(image, project, home, scope, managementId);
  if (custody.ambiguous) return { disposition: 'unavailable', diagnostic: diagnostic('PREREQUISITE_UNAVAILABLE', 'ambiguous-scope', 'Legacy custody for this ID cannot be assigned to one scope.') };
  if (custody.claimless) return { disposition: 'reconcile-required', diagnostic: diagnostic('PREREQUISITE_UNAVAILABLE', 'legacy-reconcile', 'This ID has legacy custody without an explicit claim.',
    `Reselect the original recipe under the same management ID to establish a claim, then request ${change === 'removal' ? 'removal' : 'the update'} again; otherwise reconcile manually.`) };
  if (!custody.claimed) return change === 'removal' ? { disposition: 'absent' } : { disposition: 'absent', diagnostic: diagnostic('PREREQUISITE_UNAVAILABLE', 'not-managed',
    'No selection with this management ID is managed in this scope, so there is nothing to update.', 'Install the selection with an ordinary policy Prepare instead.') };
  const members = [...image.receipts.values()].flatMap(stored => Object.entries(stored.value.members)
    .filter(([, owner]) => owner.claims?.some(claim => claim.managementId === managementId && claim.scope === scope))
    .map(([path, owner]) => owner.descriptor ?? { kind: 'file' as const, path }));
  if (managedRepairRemovalNeedsReconciliation({ managementId, scope, members, platform: process.platform }))
    return { disposition: 'reconcile-required', diagnostic: diagnostic('STATE_CONFLICT', 'repair-custody-reconcile',
      `An earlier repair owns a complete configuration file. Reconcile that receipt and its configuration manually before ${change === 'removal' ? 'using bounded removal' : 'updating it'}.`) };
  return undefined;
}
