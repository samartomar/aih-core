// 0.1.0 public shapes for plan requests and the review, run and inventory documents they produce (contract 3, 4, 7, 12).
declare const planHandle: unique symbol;
/** The private, in-process key for one 0.1.0 review; consumed by its first Apply. */
export interface PlanHandle { readonly [planHandle]: true }
import type { Json } from '../types.js';

export const PLAN_REQUEST = 'urn:aihq:core:plan-request:0.1.0' as const;
export const REVIEW = 'urn:aihq:core:review:0.1.0' as const;
export const RUN = 'urn:aihq:core:run:0.1.0' as const;
export const INVENTORY = 'urn:aihq:core:inventory:0.1.0' as const;

/** One Catalog plan step. Its fields depend on `op`; Core reads only the fields of the step kinds it carries out. */
export type PlanStep = { op: string; [field: string]: Json };
export interface Plan {
  status: 'ok' | 'incomplete';
  data: { repository: string; commit: string } | null;
  recipe?: { id: string; sha256: string; repository: string; commit: string };
  /** The profile ids and versions the plan was made with, when Catalog records them. */
  profiles?: { id: string; version: string | number }[];
  plan: PlanStep[];
  missing: Json[]; unavailable: Json[]; clashes: Json[]; duplicates: Json[]; references: Json[]; warnings: Json[];
}
/** A recipe origin Core proved by reproducing the plan (8.2): the plan's own `recipe` and its `data`. */
export interface ProvenOrigin { recipe: { id: string; sha256: string; repository: string; commit: string }; data: { repository: string; commit: string } | null }
/** `chosen`, or a proven recipe origin (C44). */
export type Origin = 'chosen' | ProvenOrigin;
/** One source file the plan names. In the Node API it carries its `bytes`; a saved request document never does (C65). */
export interface PlanFile { sourceId: string; sourcePath: string; sha256: string; bytes?: Uint8Array }
export interface PlanResolution { managementId: string; step: number; choice: 'replace' | 'adopt' | 'skip'; observedSha256: string | null }
export interface PlanRequest {
  schema: typeof PLAN_REQUEST;
  scope: 'project' | 'user';
  target: { project?: string | null };
  plan: Plan;
  contents: { [field: string]: Json }[];
  profiles: { [field: string]: Json }[];
  files: PlanFile[];
  qualifications?: Json[];
  inputs?: Record<string, Record<string, Json>>;
  recipeProof?: Json;
  scans?: Json[];
  /** A second Prepare's conflict choices (section 7). */
  resolutions?: PlanResolution[];
}
/**
 * The caller's installed Catalog reader (samartomar/aih-catalog#197): `renderStep(step, contents, profiles, files)` and
 * `planRecipe(recipe, contents, profiles, choices, options)`, with the Catalog `version`. Core never bundles its own.
 */
export interface CatalogControls {
  version: string;
  renderStep?: (step: Json, contents: Json[], profiles: Json[], files: { sourceId: string; sourcePath: string; bytes: Uint8Array }[]) => unknown;
  planRecipe?: (recipe: Json, contents: Json[], profiles: Json[], choices: Json, options: Json) => unknown;
}
/** Controls for plan requests; the rest of `HostControls` stays with the older request formats. */
export interface PlanControls {
  signal?: AbortSignal;
  logging?: 'on' | 'off';
  privateInputs?: Record<string, Record<string, Json>>;
  /** The caller's Catalog, the module that made the plan (C51). */
  catalog?: CatalogControls;
  onProgress?: (event: Json) => void;
}
export interface Problem { path: string; reason: string; message: string }
/** `refused` with `code` and `reason`; the optional fields name the step, limit, tool, step kind or the planner inputs that fix it. */
export interface Refusal { status: 'refused'; code: string; reason: string; step?: number; op?: string; tool?: string; limit?: string; value?: number; fixes?: string[] }
export type Invalid = { status: 'invalid'; problems: Problem[] };
export type UnsupportedVersion = { status: 'unsupported-version'; encountered: string; supported: string[] };

export interface ReviewStep {
  /** A plan step index; for a change, the operation id. */
  step: number | string; op: string; managementId: string; sentence: string; cantPromise: string | null;
  effect: 'create-file' | 'replace-file' | 'remove-file' | 'already-satisfied' | 'conflict' | 'skipped' | 'unchanged' | 'opaque-process' | 'unavailable';
  root?: 'project' | 'user'; path?: string; item?: string; items?: string[]; clis?: string[];
  /** A change: the operations this one waits for, and its exact effects (paths, edits, executable, argv, cwd, env, exit codes), redacted. */
  requires?: string[]; details?: Json;
}
export interface ReviewConflict {
  code: 'STATE_CONFLICT'; reason: 'existing-content' | 'managed-content-changed'; managementId: string; step: number | string;
  target: string; observedSha256: string | null; choices: ('replace' | 'adopt' | 'skip')[];
}
export interface Review {
  schema: typeof REVIEW;
  request: 'plan' | 'removal' | 'change';
  scope: 'project' | 'user';
  target: { project: string | null };
  plan?: Omit<Plan, 'plan'>;
  origin?: Origin;
  /** "origin not proven" when the plan names a recipe it did not prove (C44); otherwise `null`. */
  originNote?: string | null;
  steps: ReviewStep[];
  conflicts: ReviewConflict[];
  /** `files` entries no step names: ignored, and listed (4.1). */
  ignoredFiles?: { sourceId: string; sourcePath: string }[];
  /** A change request's named groups, as stated (C50). */
  groups?: { id: string; members: string[] }[];
  failureRule: string;
  warnings: string[];
  reviewDigest: string;
}
export interface Preparation {
  status: 'ready' | 'partial' | 'blocked';
  review: Review;
  handle?: PlanHandle;
}
export type PlanPreparation = Preparation | Refusal | Invalid | UnsupportedVersion;
export interface Approval { approved: true; origin: 'interactive' | 'automation'; reviewDigest: string; allowPartial?: boolean }

export interface RunStep {
  step: number | string; managementId: string;
  application: 'applied' | 'already-satisfied' | 'failed' | 'not-attempted';
  verification: { status: string; reason: string };
  /** A failed or cancelled command may have left effects Core cannot see; never a rollback claim. */
  effectsUncertain?: boolean;
}
export interface RunMember {
  managementId: string; scope: 'project' | 'user'; kind: string; path: string; pointer?: string; blockId?: string;
  intent: 'write' | 'remove' | 'keep'; outcome: 'written' | 'claim-removed' | 'restored' | 'kept';
  check: 'present-matching' | 'present-different' | 'absent' | 'unchecked';
}
export type StaleChange = 'policy' | 'binding' | 'target-file' | 'ownership' | 'input' | 'host';
export interface Run {
  schema: typeof RUN; status: 'ok'; runId: string;
  completion: 'complete' | 'incomplete' | 'cancelled' | 'rejected';
  /** For a rejected run: `REVIEW_STALE` with `changed`, or a `reason` such as `handle-unavailable`. */
  code?: string; changed?: StaleChange; reason?: string;
  reviewDigest: string | null;
  steps: RunStep[]; members: RunMember[];
  history: { status: 'recorded' | 'disabled' | 'not-recorded'; limit?: string };
}

export interface InventoryMember { kind: string; path: string; pointer?: string; blockId?: string; state: 'matching' | 'changed-by-you' | 'missing' | 'unchecked' }
export interface InventoryEntry {
  managementId: string; scope: 'project' | 'user';
  items: string[]; origin: Origin | null; data: { repository: string; commit: string } | null; clis: string[];
  /** The caller's Catalog version and the profiles recorded at install (C23); absent for records without plan facts. */
  catalog?: string | null; profiles?: { id: string; version: string | number }[];
  installState: 'complete' | 'interrupted'; members: InventoryMember[];
}
export interface Inventory {
  schema: typeof INVENTORY; status: 'ok'; target: { project: string | null }; scope: 'project' | 'user' | 'both';
  observation: 'complete' | 'incomplete'; entries: InventoryEntry[];
}
export type ListResult = Inventory | Refusal | Invalid;
export interface RemovalSelector { managementId: string; item?: string; origin?: string; clis?: string[] }
export interface RemovalMember { kind: string; path: string; pointer?: string; action: string; reason?: string }
export interface RemovalEntry {
  managementId: string; disposition: 'prepared' | 'absent' | 'retained' | 'reconcile-required' | 'unavailable';
  status?: 'ready' | 'partial' | 'blocked'; members: RemovalMember[];
}
export interface RemovalPreparation { status: 'ok'; entries: RemovalEntry[]; review?: Review; handle?: PlanHandle }
export type RemovalResult = RemovalPreparation | Refusal | Invalid;
