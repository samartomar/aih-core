import { isProxy } from 'node:util/types';
import { associateEvidence } from '../evidence/index.js';
import type { AssociationResult, EvidenceAssociation } from '../evidence/types.js';
import type { HostControls } from '../host-types.js';

/** Evidence cannot contribute a setup diagnostic, permission or completion decision. */
export async function readPolicyEvidence(associations: EvidenceAssociation[] | undefined,
    options: HostControls['evidence'], signal?: AbortSignal): Promise<AssociationResult[]> {
  if (!associations?.length) return [{ status: 'skipped', reason: 'not-supplied' }];
  const refusal = (reason: 'malformed' | 'unavailable'): AssociationResult[] => associations.map(association => ({
    scanId: association.scanId, status: 'unverifiable', reason
  }));
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
      results.push(await associateEvidence({ association,
        ...(options?.acquire === undefined ? {} : { acquire: options.acquire }),
        ...(options?.trust === undefined ? {} : { trust: options.trust }) }, {
        ...(signal === undefined ? {} : { signal }),
        ...(options?.authentication === undefined ? {} : { authentication: options.authentication })
      }));
    }
    return results;
  } catch {
    return refusal('unavailable');
  }
}
