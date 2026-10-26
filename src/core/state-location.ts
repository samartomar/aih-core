// Portable: no Node imports and no host discovery. `resolveStateLocation` in the Node entry resolves these.

/** Where Core's state root sits, relative to the current account's home folder. */
export interface StateLocationRoot { readonly base: 'userHome'; readonly segments: readonly string[] }
/** A state-root child holding Core's records of changes it makes to project folders (or home). `path` is relative to the state root, `/`-separated. */
export interface StateLocationMarker { readonly path: string; readonly meaning: string }
/**
 * Where Core keeps its state, as relative descriptors. Information only: knowing the location is not
 * permission to write there. Core alone creates, protects and changes its state.
 */
export interface StateLocation { readonly root: StateLocationRoot; readonly projectMarkers: readonly StateLocationMarker[] }

export const stateLocation: StateLocation = Object.freeze({
  root: Object.freeze({ base: 'userHome', segments: Object.freeze(['.aih', 'core']) }),
  projectMarkers: Object.freeze([
    Object.freeze({ path: 'ownership', meaning: 'Ownership records: one per project folder (or home) whose files Core manages.' }),
    Object.freeze({ path: 'recovery', meaning: 'Recovery manifests and private original-file snapshots, one folder per run that changed files.' }),
    Object.freeze({ path: 'runs', meaning: 'Redacted run history, one record per run.' })
  ])
});
