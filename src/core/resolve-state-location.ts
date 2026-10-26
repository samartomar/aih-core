import { join } from 'node:path';
import { stateLocation, type StateLocationMarker } from './state-location.js';
import { stateRoot } from './internal/state.js';

/** `stateLocation` resolved to absolute paths for the running host. */
export interface ResolvedStateLocation { readonly root: string; readonly projectMarkers: readonly StateLocationMarker[] }

/**
 * Resolve Core's published state location for the current account on this host, without creating,
 * protecting or reading anything inside it. Information only: not permission to write there.
 * Throws when the home folder is not an existing absolute directory, as Core's own operations do.
 */
export function resolveStateLocation(): ResolvedStateLocation {
  const root = stateRoot();
  return { root, projectMarkers: stateLocation.projectMarkers.map(({ path, meaning }) => ({ path: join(root, ...path.split('/')), meaning })) };
}
