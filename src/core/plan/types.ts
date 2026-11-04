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
  /** Enterprise (contract 11) applies with `enterprise` and an organization source in `controls.organization`. */
  mode?: 'vibe' | 'enterprise';
  /** `client` and `repository` are what the caller declares for Enterprise admission; Core never infers them. */
  target: { project?: string | null; client?: { id: string; surface: 'cli' | 'ide' }; repository?: string };
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
  /** Enterprise: the organization source, read fresh at Prepare and again at Apply (contract 11). */
  organization?: OrganizationSource;
  /** Enterprise: credentials for a private GitHub organization repository. */
  authentication?: { kind: 'none' } | { kind: 'bearer'; token: string };
}
/** One organization file in a GitHub repository at a branch, tag or commit, or a local file. */
export type OrganizationSource = { provider: 'github'; repository: { owner: string; name: string }; path: string;
  revision: { kind: 'commit' | 'branch' | 'tag'; value: string } } | { provider: 'local'; path: string };
/** The Enterprise block of a review (contract 11): enforced denials, advisory and projected fulfilment results. */
export interface OrganizationReview {
  id: string; source: Json; contentDigest: string;
  target: { scope: 'project' | 'user'; client: { id: string; surface: 'cli' | 'ide' } | null; repository: string | null };
  admitted: boolean;
  denials: { code: 'AUTHORITY_DENIED'; reason: string; message: string; entry?: string; rule?: 'sources.published' | 'sources.own';
    managementId?: string; step?: number; input?: string }[];
  advisory: { entry: string; status: 'taken' | 'not-taken'; applicability: 'applies' | 'not-applicable' | 'unknown'; unknown: string[]; managementIds: string[] }[];
  fulfilment: OrganizationFulfilment[];
  scanSigners: { replace?: ScanSignerRecord[]; add?: ScanSignerRecord[] } | null;
}
export interface OrganizationFulfilment { entry: string; status: 'fulfilled' | 'not-fulfilled' | 'not-applicable' | 'unknown'; unknown: string[]; managementIds: string[] }
export interface ScanSignerRecord { identity?: string; issuer: string; subject: string; extensions?: { [field: string]: Json } }
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
  /** Several updates in one review: the index of the update this step belongs to. */
  update?: number;
  effect: 'create-file' | 'replace-file' | 'remove-file' | 'already-satisfied' | 'conflict' | 'skipped' | 'unchanged' | 'run-program' | 'opaque-process' | 'unavailable';
  root?: 'project' | 'user'; path?: string; item?: string; items?: string[]; clis?: string[];
  /** A reviewed replace that displaces other installs' shared value (C61): their management ids. */
  displaces?: string[];
  /** A link step: the folder it points to, and how it lands on this host (C29). */
  to?: string; linkType?: 'junction' | 'symlink' | 'copy';
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
  /** A program step (`tool-command`, `upstream-installer`, `upstream-setup`): the exact command and what Core can and can't check or undo. */
  program?: ReviewProgram;
}
/** The reviewed command of a program step (contract 8.1, 12, C30). Secret values read `[REDACTED]`. */
export interface ReviewProgram {
  kind: 'tool-command' | 'upstream-installer' | 'upstream-setup';
  /** The arguments as run: after the executable for a `tool-command`, the whole command otherwise. */
  argv: string[];
  /** The program: pinned at Prepare (`path`), or made by an earlier step and resolved at Apply (`acquired`, `clone`). */
  executable: string; executableSha256: string | null; from: 'path' | 'acquired' | 'clone';
  cwd: string;
  /** Environment variables a binding sets, by name. */
  env: { name: string; value: string }[];
  /** `false` for an upstream installer: Core can't remove what it writes. */
  managed: boolean;
  /** A tool-command's readback (D57), checked after it runs. */
  readback: { argv: string[]; expected: string } | null;
  /** The reverse command and its readback copied into the receipt; `null` when Core can't undo the command. */
  undo: { argv: string[]; readback: { argv: string[]; expected: string } } | null;
  /** What Core can't remove around this program. */
  cantRemove: string;
  /** An upstream setup's clone, with the git Prepare pinned. */
  clone?: { repository: string; commit: string; into: string; git: string; gitSha256: string };
  needs?: string[];
}
export interface ReviewCommand { argv: string[]; executable: string; executableSha256: string }
export interface ReviewConflict {
  code: 'STATE_CONFLICT'; reason: 'existing-content' | 'managed-content-changed' | 'second-displacement'; managementId: string; step: number | string;
  /** Several updates in one review: the index of the update this conflict belongs to. */
  update?: number;
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
  /** The installs whose shared value a reviewed replace would displace (C61): they hold nothing on disk until this one goes. */
  displaces?: string[];
  /** `second-displacement` (C75): the installs that hold the value now, and the installs they already displace. */
  displacedBy?: string[]; displaced?: string[];
  /** `second-displacement`: how to get there (remove the overriding install through review, then prepare again). */
  fix?: string;
}
export interface Review {
  schema: typeof REVIEW;
  request: 'plan' | 'removal' | 'change' | 'update' | 'repair' | 'export' | 'macos-session';
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
  /** Several updates in one review: each update's request kind, plan reports, origin and own review digest. */
  updates?: { update: number; request: 'plan' | 'change'; plan?: Omit<Plan, 'plan'>; origin?: Origin; originNote?: string | null; reviewDigest: string }[];
  /** Enterprise requests only (contract 11). */
  organization?: OrganizationReview;
  /** The Scan results seen (contract 13, C18): shown with their signer, revision, label, coverage and match; never a gate. */
  scans?: ReviewScan[];
  /** With Scan results: the steps whose output no source scan covers (rendered, fetched or program-made). */
  notScanned?: ReviewNotScanned[];
  reviewDigest: string;
}
/**
 * One supplied Scan summary as the review shows it (contract 13). `verified` results carry what Scan authenticated;
 * `not-verified` ones carry only Scan's reason, and `unavailable` ones mean `@aihq/scan/read` is not installed.
 */
export interface ReviewScan {
  /** The entry's position in the request's `scans`. */
  index: number;
  status: 'verified' | 'not-verified' | 'unavailable';
  reason?: string;
  sentence: string;
  scanKey: string | null; revision: number | null; label: string | null; coverage: 'complete' | 'partial' | null; score: number | null;
  /** The authenticated signer: `identity` is only a label; `trusted` means an allowed signer whose result is not withdrawn. */
  signer: { identity: string; trusted: boolean; issuer: string; subject: string } | null;
  /** Withdrawn by a supplied authenticated withdrawal, or by one remembered for this key and signer. */
  withdrawn: boolean;
  /** "Older than the last result seen": a higher revision was seen before for this key and signer. */
  older: boolean;
  /** The highest revision seen before for this key and signer, or `null`. */
  lastSeen: number | null;
  /** What happened to each supplied withdrawal, as Scan reports it. */
  withdrawals: { status: string; reason?: string; throughRevision?: number }[];
  /** The planned management ids whose content this key is. */
  managementIds: string[];
  /** Scan's match of the source tree (the plan's files, or the supplied inventory), or why it was not checked. */
  match: { status: 'matches' | 'differs' | 'refused' | 'not-checked'; reason?: string; source?: 'files' | 'inventory';
    differences?: { missing: string[]; extra: string[]; changed: string[]; modeChanged: string[] } };
}
export interface ReviewNotScanned { step: number; op: string; reason: 'rendered' | 'fetched' | 'program' | 'not-scanned'; sentence: string }
/** The Scan result a receipt records for one management id (contract 5 "What it saw"). */
export interface ScanFacts {
  scanKey: string; revision: number; signer: { identity: string; trusted: boolean; issuer: string; subject: string };
  label: string; coverage: 'complete' | 'partial'; withdrawn: boolean; match: 'matches' | 'differs' | 'refused' | 'not-checked';
}
export interface Preparation {
  status: 'ready' | 'partial' | 'blocked';
  /** `AUTHORITY_DENIED` when the organization denies (blocked, no handle), naming the entry or source rule in `reason`. */
  code?: 'AUTHORITY_DENIED'; reason?: string;
  review: Review;
  handle?: PlanHandle;
}
export type PlanPreparation = Preparation | Refusal | Invalid | UnsupportedVersion;
export interface Approval { approved: true; origin: 'interactive' | 'automation'; reviewDigest: string; allowPartial?: boolean }

export interface RunStep {
  step: number | string; managementId: string;
  /** Several updates in one run: the index of the update this step belongs to. */
  update?: number;
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
  /** Enterprise runs: the actual fulfilment over the claims this run left (C71), which differs from the review's projection when steps fail. */
  organization?: { id: string; fulfilment: OrganizationFulfilment[] };
}

export interface InventoryMember { kind: string; path: string; pointer?: string; blockId?: string;
  /** How a folder link landed (C29): a junction or symlink, or a copy. */
  linkType?: 'junction' | 'symlink' | 'copy';
  /** The CLIs whose claims hold this member (contract 5); a claim that recorded none counts for every CLI of its plan. */
  clis?: string[];
  state: 'matching' | 'changed-by-you' | 'missing' | 'unchecked' | 'displaced-by';
  /** `displaced-by` (C61): the installs whose value is there now; this claim holds nothing on disk until they go. */
  displacedBy?: string[] }
export interface InventoryEntry {
  managementId: string; scope: 'project' | 'user';
  items: string[]; origin: Origin | null; data: { repository: string; commit: string } | null; clis: string[];
  /** The caller's Catalog version and the profiles recorded at install (C23); absent for records without plan facts. */
  catalog?: string | null; profiles?: { id: string; version: string | number }[];
  /** The content kind and framework recorded at install, which Enterprise fulfilment counts; `null` when the plan gave none. */
  kind?: string | null; framework?: string | null;
  installState: 'complete' | 'interrupted'; members: InventoryMember[];
  /** Every claim that holds this management id here: its CLI (`null` when its steps recorded none) and project (C28). */
  claims?: { cli: string | null; project: string | null }[];
  /** Native plugin installs with the undo facts the receipt keeps for them. */
  plugins?: PluginFacts[];
  /** Program steps (tool commands, upstream installers and setups) with their undo facts. */
  programs?: ProgramFacts[];
  /** An AI setup: the interpreter its install used and whether the fallback ran (C46). */
  aiSetup?: { branch: 'installed' | 'fallback' | null; interpreter: { path: string; version: string } | null; fallback: boolean; fallbackReason: string | null };
  /** A local-plugin install (C68): the items it contains (`null` when the plan named none) and its files. */
  localPlugin?: { contains: string[] | null; files: string[] };
  /** A switch-off of one plugin item (C45, C69): removing this entry turns the item back on. */
  switchOff?: { framework: string; item: string; cli: string; name: string };
  /** The last Scan results seen for this install, as its receipts recorded them (contract 12, 13). */
  scans?: ScanFacts[];
  /** A change: the identity it was installed with (`deriveChangeIdentity`), which Enterprise change entries admit and count. */
  change?: { identity: string };
}
export interface Inventory {
  schema: typeof INVENTORY; status: 'ok'; target: { project: string | null }; scope: 'project' | 'user' | 'both';
  observation: 'complete' | 'incomplete'; entries: InventoryEntry[];
}
export type ListResult = Inventory | Refusal | Invalid;
export interface RemovalSelector { managementId: string; item?: string; origin?: string; clis?: string[] }
/** What can be chosen for one item inside a plugin (C45): the whole plugin's removal, or the item's switch-off where the CLI supports it. */
export const REMOVAL_CHOICES = ['remove-plugin', 'switch-off'] as const;
/** A removal request's choice for a one-item entry, passed to a second preparation (section 7's resolve-and-prepare-again). */
export interface RemovalResolution { managementId: string; item: string; choice: typeof REMOVAL_CHOICES[number] }
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
   * The removals the person can prepare instead: the whole plugin, or, once the item is switched off, the switch-off's
   * own removal, which turns it back on.
   */
  offers?: { managementId: string }[];
  /** The resolutions this one-item entry accepts in `resolutions` (`remove-plugin`, and `switch-off` where supported). */
  choices?: RemovalResolution['choice'][];
}
export interface RemovalPreparation { status: 'ok'; entries: RemovalEntry[]; review?: Review; handle?: PlanHandle;
  /** `AUTHORITY_DENIED` when the organization denies the removal (no handle), naming the entry in `reason`. */
  code?: 'AUTHORITY_DENIED'; reason?: string }
export type RemovalResult = RemovalPreparation | Refusal | Invalid;
/** One update (contract 12): a complete new plan or change request, and the management ids it replaces when no proven origin names them. */
export interface UpdateSelector { managementIds?: string[]; request: Json }
/**
 * What one reviewed update does to one member: `add`, `replace`, leave it `unchanged`, `remove` it, `restore` your earlier
 * value, `unregister` one already gone, `keep-shared` one another claim holds, or `keep-changed` one you edited (never overwritten).
 */
export interface UpdateMember { kind: string; path: string; pointer?: string; blockId?: string; action: string; reason?: string }
export interface UpdateEntry {
  /** The management id; `null` for an update that named none and could not be prepared. */
  managementId: string | null;
  /** The index of the update (in `updates`) this entry belongs to. */
  update: number;
  /** An update that could not be prepared: its refusal or problems (`disposition: unavailable`). */
  code?: string; reason?: string; problems?: Problem[];
  disposition: 'prepared' | 'absent' | 'retained' | 'reconcile-required' | 'unavailable';
  status?: 'ready' | 'partial' | 'blocked';
  /** `add`: new in this request; `update`: installed and in the request; `remove`: installed, and left out of the request. */
  change?: 'add' | 'update' | 'remove';
  /** A removed item (C19, D109): "removed in data commit X", naming the new request's data commit (or that it left the plan). */
  note?: string;
  /** The recorded data and origin now, and those a complete update records. */
  from?: { data: { repository: string; commit: string } | null; origin: Origin | null } | null;
  to?: { data: { repository: string; commit: string } | null; origin: Origin | null } | null;
  members: UpdateMember[];
}
export interface UpdatePreparation { status: 'ok'; entries: UpdateEntry[]; review?: Review; handle?: PlanHandle }
export type UpdateResult = UpdatePreparation | Refusal | Invalid | UnsupportedVersion;
/**
 * One program step's receipt facts (C30, C54): the command as reviewed (secrets redacted), the acquired executable it
 * ran (from the user root), and its undo: a `tool-command`'s reverse command and readback, or `null` when Core can't.
 */
export interface ProgramFacts {
  step: number; op: 'tool-command' | 'upstream-installer' | 'upstream-setup'; argv: string[]; executable: string | null; managed: boolean;
  undo: { argv: string[]; readback: { argv: string[]; expected: string } } | null;
  clone?: { repository: string; commit: string; into: string };
}
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
