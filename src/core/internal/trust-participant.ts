import type { Ownership } from './state.js';
import type { RunResult } from '../host-types.js';

/** Internal engine participant, never accepted through caller controls. */
export interface TrustEngineParticipant {
  exactReplacement: boolean;
  lockRoot: string;
  reviewBinding: string;
  allows(root: string, path: string): boolean;
  recheck(): void | Promise<void>;
  preflight(steps: readonly TrustEngineStep[], ownership: ReadonlyMap<string, { value: Ownership; digest: string | null }>): void;
  stage(runId: string, recovery: string | undefined): void;
  committed(step: TrustEngineStep): void;
  finish(result: RunResult): void;
}
export interface TrustEngineStep {
  root?: string; path?: string; recipeIdentity: string; managementId: string;
  before?: Buffer | null; after?: Buffer | null;
  review: { id: string; effects: string };
}
