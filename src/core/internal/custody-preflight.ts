// Custody preflight shared by managed removal and managed update preparation: one validated read of every protected
// receipt, the installed distribution identity, and a selection's claim classification.
import { isManagedContentRoot } from '../recipe-engine.js';
import { ownershipInventory, readOwnership, readOwnershipBatch, type Ownership } from './state.js';
import { installedDistribution } from './installed-distribution.js';
import { claimIdentity, classifyStoredClaims, retainClaimDependencies, type Claim } from './recipe-lifecycle.js';

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

