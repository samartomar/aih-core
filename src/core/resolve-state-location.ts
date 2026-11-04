import { join } from 'node:path';
import { stateLocation } from './state-location.js';
import { stateRoot } from './internal/state.js';

/** A `stateLocation` marker resolved to an absolute path with the host's separators. */
export interface ResolvedStateLocationMarker { readonly path: string; readonly meaning: string }
/** `stateLocation` resolved to absolute paths for the running host (contract 3, C42). */
export type ResolvedStateLocation =
  | { readonly status: 'ok'; readonly root: string; readonly markers: readonly ResolvedStateLocationMarker[] }
  | { readonly status: 'refused'; readonly code: 'home-unavailable'; readonly reason: string };

/**
 * Resolve Core's published state location for the current account on this host, without creating,
 * protecting or reading anything inside it. Information only: not permission to write there.
 * When the home folder is not an existing absolute directory the result is `refused` `home-unavailable`.
 */
export function resolveStateLocation(): ResolvedStateLocation {
  let root: string;
  try { root = stateRoot(); }
  catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not an existing absolute folder, so Core has no state location here.' }; }
  return { status: 'ok', root, markers: stateLocation.projectMarkers.map(({ path, meaning }) => ({ path: join(root, ...path.split('/')), meaning })) };
}
