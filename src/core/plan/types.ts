// 0.1.0 public shapes for plan requests and the review, run and inventory documents they produce (contract 3, 4, 7, 12).
declare const planHandle: unique symbol;
/** The private, in-process key for one 0.1.0 review; consumed by its first Apply. */
export interface PlanHandle { readonly [planHandle]: true }
import type { Json } from '../types.js';
import type { ReviewInput } from './inputs.js';

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
export interface Refusal { status: 'refused'; code: string; reason: string; step?: number; op?: string; tool?: string; limit?: string; value?: number; fixes?: string[]; repair?: string;
  /** `file-too-large-for-client`: the file and the size it would have. */
  file?: string; size?: number;
  /** `input-missing` and `input-binding-missing`: the item and the input. */
  item?: string; input?: string }
export type Invalid = { status: 'invalid'; problems: Problem[] };
export type UnsupportedVersion = { status: 'unsupported-version'; encountered: string; supported: string[] };

export interface ReviewStep {
  /** A plan step index; for a change, the operation id. */
  step: number | string; op: string; managementId: string; sentence: string; cantPromise: string | null;
  effect: 'create-file' | 'replace-file' | 'remove-file' | 'already-satisfied' | 'conflict' | 'skipped' | 'unchanged' | 'run-program' | 'opaque-process' | 'unavailable';
  root?: 'project' | 'user'; path?: string; item?: string; items?: string[]; clis?: string[];
  /** A change: the operations this one waits for, and its exact effects (paths, edits, executable, argv, cwd, env, exit codes), redacted. */
  requires?: string[]; details?: Json;
  /** A plugin step or its removal: the indivisible framework install, the client and what it holds. */
  framework?: string; cli?: string; plugin?: string; commit?: string; contains?: string[];
  /** A step a local-plugin route lowers to (Catalog D120). */
  route?: 'local-plugin';
  /** The exact commands, each with the executable and sha256 Prepare pinned; only these run, in this order. */
  commands?: ReviewCommand[];
  /** The removal commands copied into the receipt at install, or `null` when the profile gave none. */
  undo?: string[][] | null;
  /** The presence check that decides `present`/`absent`, or `none` (then the step stays unverified, C56). */
  presenceCheck?: 'none' | (ReviewCommand & { expect: string });
  /** An earlier run of this program step was interrupted: its effects are uncertain. */
  previous?: 'interrupted';
  /** An `acquire` step: the AI setup, the qualified artifact it downloads and the folder it fills. */
  acquire?: { aiSetup: string; version: string; cell: string; kind: 'pypi-wheel' | 'native-archive'; qualification: string;
    artifact: { file: string; sha256: string }; into: string; members: number; closure: number };
  /** A Python AI setup's two interpreter branches (C46): approval covers both. */
  interpreter?: { installed: { path: string; version: string; note: 'in range, not qualified' } | null; range: string;
    fallback: { version: string; file: string; sha256: string }; switchesOn: string[] };
  /** A merge: its format, key, and the entry it adds (known secret slots read `[REDACTED]`). */
  format?: 'json' | 'toml' | 'markdown'; key?: string; entry?: Json;
  /** The step's input bindings: where each value lands, how it is written, and an ordinary value (never a secret's). */
  inputs?: ReviewInput[];
}
export interface ReviewCommand { argv: string[]; executable: string; executableSha256: string }
export interface ReviewConflict {
  code: 'STATE_CONFLICT'; reason: 'existing-content' | 'managed-content-changed'; managementId: string; step: number | string;
  target: string;
  /** A merge's key: the entry or block the conflict is about. */
  key?: string;
  /** The digest of the whole target file now, which a resolution names; `null` when it is absent. */
  observedSha256: string | null;
  /** The exact existing bytes (a merge's entry or block, or a written file), with known secret slots `[REDACTED]`; `null` when absent or not text. */
  existing: string | null;
  /** The pointers of the secret slots `existing` redacts. */
  redacted: string[];
  choices: ('replace' | 'adopt' | 'skip')[];
  /** Why only some fixes are offered: `resolution-stale` (the bytes changed since the choice), or the editor's reason. */
  detail?: string;
}
export interface Review {
  schema: typeof REVIEW;
  request: 'plan' | 'removal' | 'change' | 'repair' | 'export' | 'macos-session';
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
  /** Plan reviews whose served profiles list `checkedWith`: each served CLI's version against it (D110); warnings only. */
  versions?: Json[];
  /** Repair, export and macOS session reviews only (contract 10). */
  environment?: EnvironmentReview;
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
  /** A program step that may have changed something although it did not finish: never claimed as rolled back. */
  effectsUncertain?: true;
  /** A failed step's reason, such as `artifact-mismatch`. */
  reason?: string;
  /** An AI setup step: the interpreter branch that actually ran (C46). */
  interpreter?: { branch: 'installed' | 'fallback'; path: string; version: string; fallback: boolean; fallbackReason: string | null };
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
  /** Repair, export and macOS session runs only (contract 10). */
  environment?: EnvironmentRun;
}

export interface InventoryMember { kind: string; path: string; pointer?: string; blockId?: string; state: 'matching' | 'changed-by-you' | 'missing' | 'unchecked' }
export interface InventoryEntry {
  managementId: string; scope: 'project' | 'user';
  items: string[]; origin: Origin | null; data: { repository: string; commit: string } | null; clis: string[];
  /** The caller's Catalog version and the profiles recorded at install (C23); absent for records without plan facts. */
  catalog?: string | null; profiles?: { id: string; version: string | number }[];
  installState: 'complete' | 'interrupted'; members: InventoryMember[];
  /** Native plugin installs with the undo facts the receipt keeps for them. */
  plugins?: PluginFacts[];
  /** An AI setup: the interpreter its install used and whether the fallback ran (C46). */
  aiSetup?: { branch: 'installed' | 'fallback' | null; interpreter: { path: string; version: string } | null; fallback: boolean; fallbackReason: string | null };
  /** A local-plugin install (C68): the items it contains (`null` when the plan named none) and its files. */
  localPlugin?: { contains: string[] | null; files: string[] };
  /** A switch-off of one plugin item (C45, C69): removing this entry turns the item back on. */
  switchOff?: { framework: string; item: string; cli: string; name: string };
}
export interface Inventory {
  schema: typeof INVENTORY; status: 'ok'; target: { project: string | null }; scope: 'project' | 'user' | 'both';
  observation: 'complete' | 'incomplete'; entries: InventoryEntry[];
}
export type ListResult = Inventory | Refusal | Invalid;
export interface RemovalSelector { managementId: string; item?: string; origin?: string; clis?: string[];
  /** With `item`: switch that one plugin item off where its CLI supports it, instead of removing anything (C45). */
  switchOff?: true }
export interface RemovalMember { kind: string; path: string; pointer?: string; action: string; reason?: string }
export interface RemovalEntry {
  managementId: string; disposition: 'prepared' | 'absent' | 'retained' | 'reconcile-required' | 'unavailable';
  status?: 'ready' | 'partial' | 'blocked'; members: RemovalMember[];
  /** A removal named by one item inside a plugin (C45). */
  item?: string;
  /** Why an entry is not prepared: `plugin-indivisible` when the item is one part of a plugin that can't be split. */
  reason?: string;
  /** Everything the indivisible plugin holds. */
  contains?: string[];
  /** A local plugin whose plan named no contained items: its files, listed instead of guessing membership. */
  files?: string[];
  /**
   * The removals the person can prepare instead: the whole plugin, the item's switch-off where the CLI supports one, or,
   * once it is off, the switch-off's own removal (`{ managementId: <item> }`), which turns it back on.
   */
  offers?: { managementId: string; item?: string; switchOff?: true }[];
}
export interface RemovalPreparation { status: 'ok'; entries: RemovalEntry[]; review?: Review; handle?: PlanHandle }
export type RemovalResult = RemovalPreparation | Refusal | Invalid;
/** One native plugin install's receipt facts; argv lists are filled, never templates. */
export interface PluginFacts {
  step: number; cli: string; plugin: string; commit: string;
  /** The content items the plugin's recorded folder holds; the plugin is still one indivisible install (C68). */
  contains: string[];
  /** The CLI's own removal commands (`plugins.remove`), or `null` when the profile gave none. */
  undo: string[][] | null;
  /** The profile's presence check for this route, or `none` (C56). */
  presenceCheck: 'none' | { argv: string[]; expect: string };
  /** The skill name of each contained skill item, by item id: what a client keys a one-skill switch-off by (C45). */
  skills?: { [item: string]: string };
}

/** A problem that keeps environment work from being admitted on this host, named by its retained code and reason. */
export interface EnvironmentProblem { code: string; reason: string; message: string; path?: string }
/** The retained facts of a repair, certificate export or macOS session review (contract 10). */
export interface EnvironmentReview {
  job: 'repair' | 'export' | 'macos-session';
  repair: string | null;
  targets: string[];
  route: 'file' | 'native' | 'os' | 'export';
  network: 'declared' | 'off';
  /** The job's reviewed trust facts: sources, certificates, outputs and per-target admission, or the macOS session facts. */
  facts: { [field: string]: Json };
  observations: { id: string; reason: string }[];
  unavailable: EnvironmentProblem[];
}
export interface EnvironmentRun {
  job: 'repair' | 'export' | 'macos-session';
  outputs: { [field: string]: Json }[];
  targets: { [field: string]: Json }[];
  session?: { [field: string]: Json };
  diagnostics: EnvironmentProblem[];
}
