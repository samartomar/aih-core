import { isProxy } from 'node:util/types';
import { acquireEvidence } from '../evidence/acquire.js';
import type { AssociationResult, EvidenceAssociation } from '../evidence/types.js';
import type { HostControls } from '../host-types.js';
import { artifactEntries, type ScanArtifact } from './item-scan.js';

/** Evidence cannot contribute a setup diagnostic, permission or completion decision. */
export async function readPolicyEvidence(associations: EvidenceAssociation[] | undefined,
    options: HostControls['evidence'], signal?: AbortSignal): Promise<AssociationResult[]> {
  return (await readEvidence(associations, options, signal)).results;
}

/**
 * Prepared work 1.7.0: each association's result and, by scan id, the artifact a selection's item record may name.
 * An artifact counts as readable only when its bytes were acquired and its report's capture could be read.
 */
export async function readEvidence(associations: EvidenceAssociation[] | undefined,
    options: HostControls['evidence'], signal?: AbortSignal): Promise<{ results: AssociationResult[]; artifacts: Map<string, ScanArtifact> }> {
  const artifacts = new Map<string, ScanArtifact>();
  if (!associations?.length) return { results: [{ status: 'skipped', reason: 'not-supplied' }], artifacts };
  const refusal = (reason: 'malformed' | 'unavailable') => ({ results: associations.map((association): AssociationResult => ({
    scanId: association.scanId, status: 'unverifiable', reason
  })), artifacts: new Map<string, ScanArtifact>() });
  try {
    if (options !== undefined) {
      if (!options || typeof options !== 'object' || isProxy(options) ||
          ![null, Object.prototype].includes(Object.getPrototypeOf(options))) return refusal('malformed');
      for (const key of Reflect.ownKeys(options)) {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        if (typeof key !== 'string' || !['acquire', 'trust', 'authentication'].includes(key) ||
            !descriptor?.enumerable || !('value' in descriptor)) return refusal('malformed');
      }
      if (options.acquire !== undefined && typeof options.acquire !== 'boolean') return refusal('malformed');
    }
    const results: AssociationResult[] = [];
    for (const association of associations) {
      const acquired = await acquireEvidence({ association,
        ...(options?.acquire === undefined ? {} : { acquire: options.acquire }),
        ...(options?.trust === undefined ? {} : { trust: options.trust }) }, {
        ...(signal === undefined ? {} : { signal }),
        ...(options?.authentication === undefined ? {} : { authentication: options.authentication })
      });
      results.push(acquired.result);
      const entries = acquired.bytes && acquired.result.scanId === association.scanId ? await artifactEntries(acquired.bytes) : undefined;
      // Two associations for one scan id: a readable one is kept, never replaced by an unreadable copy.
      if (entries) artifacts.set(association.scanId, { readable: true, association: acquired.result, entries });
      else if (!artifacts.has(association.scanId)) artifacts.set(association.scanId, { readable: false });
    }
    return { results, artifacts };
  } catch {
    return refusal('unavailable');
  }
}
