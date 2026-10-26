import { join } from 'node:path';
import { stateLocation } from './state-location.js';
import { stateRoot } from './internal/state.js';

/** A `stateLocation` marker resolved to an absolute path with the host's separators. */
export interface ResolvedStateLocationMarker { readonly path: string; readonly meaning: string }
/** `stateLocation` resolved to absolute paths for the running host. */
export interface ResolvedStateLocation { readonly root: string; readonly projectMarkers: readonly ResolvedStateLocationMarker[] }

/**
 * Resolve Core's published state location for the current account on this host, without creating,
 * protecting or reading anything inside it. Information only: not permission to write there.
 * Throws when the home folder is not an existing absolute directory, as Core's own operations do.
 */
export function resolveStateLocation(): ResolvedStateLocation {
  const root = stateRoot();
  return { root, projectMarkers: stateLocation.projectMarkers.map(({ path, meaning }) => ({ path: join(root, ...path.split('/')), meaning })) };
}
