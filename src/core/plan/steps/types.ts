// The step-handler seam: one file per Catalog step kind, registered in `./index.ts`. A handler checks one plan step
// against the request (sources, containment, clients) before any effect and lowers it into the existing engine's
// operations. It never touches the disk.
import type { Json } from '../../types.js';
import type { PlanControls, PlanRequest, PlanStep, Problem, Refusal } from '../types.js';
import type { AcquireSpec } from '../acquire/types.js';
import type { BoundInputs, InputContext, ReviewInput } from '../inputs.js';

/** A source file the plan's documents name, with what they say about it. */
export interface SourceFacts { sourceId: string; sourcePath: string; sha256: string; executable: boolean }
export interface StepContext {
  request: PlanRequest;
  controls: PlanControls;
  index: number;
  /**
   * A content item's file, or a file of one of its `editions`, by item id and source path; where several share that path,
   * the one with the step's `from` source id and sha256.
   */
  itemFile(item: string, sourcePath: string, want?: { sourceId?: string; sha256?: string }): SourceFacts | undefined;
  /**
   * A file the plan copies that belongs to no one item, by source id and source path: a source notice, or, with
   * `bundle`, a file of that runtime bundle (Catalog content `bundles[].files`).
   */
  sourceFile(sourceId: string, sourcePath: string, bundle?: string): SourceFacts | undefined;
  /** The supplied bytes for one `{ sourceId, sourcePath }`, after checking them; marks the entry as named by a step. */
  bytesFor(facts: SourceFacts): { bytes: Buffer } | { refusal: Refusal };
  /** A supplied qualification document by its sha256 (hex, over its canonical JSON). */
  qualification(sha256: string): { [field: string]: Json } | undefined;
  /** An item's declared input (`requirements.inputs[name]`), as its content document states it. */
  itemInput(item: string, input: string): { isSecret: boolean } | undefined;
  /** What filling this step's input bindings needs, for the CLIs it serves (contract 4.1, C59). */
  inputs(clis: string[]): InputContext;
  /** A file of a framework's recorded plugin folder (Catalog content `plugins[].files`), by source id and source path. */
  pluginFile(framework: string, sourceId: string, sourcePath: string): SourceFacts | undefined;
}
/** One owned file effect the engine carries out as a `file.write`. */
export interface LoweredWrite {
  kind: 'write';
  managementIds: string[];
  root: 'project' | 'user';
  path: string;
  bytes: Buffer;
  executable: boolean;
  sentence: string;
  cantPromise: string | null;
  review: { item?: string; items?: string[]; clis?: string[]; framework?: string; route?: 'local-plugin'; contains?: string[]; inputs?: ReviewInput[] };
  /** The step's filled input bindings, when it has any. */
  bound?: BoundInputs;
  /** An `acquire` step: the acquisition Apply carries out immediately before writing this marker file. */
  acquire?: AcquireSpec;
  /** For a rendered write: the tool profiles (id and version) the render records, checked against the request. */
  profiles?: { id: string; version: string | number }[];
  /** The supplied source file the step writes from, when it names one. */
  source?: { sourceId: string; sourcePath: string; sha256: string };
}
/**
 * One native plugin install (`plugin`): the CLI's own commands, filled from the profile's templates, run in order after
 * approval of those exact commands. Its framework is one indivisible install (C68); its undo facts go to the receipt.
 */
export interface LoweredPlugin {
  kind: 'plugin';
  managementIds: [string];
  /** The request scope: where the commands run (the project folder or home) and which receipt keeps the install. */
  root: 'project' | 'user';
  cli: string; plugin: string; commit: string; framework: string;
  contains: string[];
  /** Each contained skill item's name, by item id (for a supported one-skill switch-off, C45). */
  skills?: Record<string, string>;
  commands: string[][];
  undo: string[][] | null;
  presenceCheck: 'none' | { argv: string[]; expect: string };
  sentence: string;
  cantPromise: string;
  review: { framework: string; clis: string[]; pin?: 'unverified' };
  /** Never an acquisition or a render, and binds no inputs. */
  profiles?: undefined;
  acquire?: undefined;
  bound?: undefined;
}
export type Lowered = LoweredWrite | LoweredPlugin | LoweredMerge | LoweredLink | LoweredProgram;
/**
 * One user-scope folder link (`link`): a junction or symlink Core places before writing the link's record, or, for a
 * CLI not confirmed to load junctions on Windows, a copy of the files the plan writes into `to` (C29).
 */
export interface LoweredLink {
  kind: 'link';
  managementIds: string[];
  root: 'user';
  path: string;
  to: string;
  linkType: 'junction' | 'symlink' | 'copy';
  sentence: string;
  cantPromise: string | null;
  review: { item?: string; items?: string[]; clis?: string[]; framework?: string; route?: 'local-plugin'; contains?: string[]; to: string; linkType: 'junction' | 'symlink' | 'copy' };
  /** A link binds no inputs. */
  bound?: undefined;
  acquire?: never; profiles?: never;
}
/** A command and the value its output must show (D57): the readback of a `tool-command`, or of its reverse. */
export interface Readback { argv: string[]; expected: string }
/**
 * One reviewed program step (Catalog 9 `tool-command`, `upstream-installer`, `upstream-setup`; contract 8.1, 12): an exact
 * argv run after approval. Its effects are never known to Core (C30); only a `tool-command`'s readback is checked. An
 * `upstream-setup` first clones its repository at the exact commit into a Core-owned folder, marked by one file.
 */
export interface LoweredProgram {
  kind: 'program';
  op: 'tool-command' | 'upstream-installer' | 'upstream-setup';
  managementIds: [string];
  /** Where the receipt is kept and the command runs from. */
  root: 'project' | 'user';
  /** The command as it runs (input values filled) and as the review shows it (secret values `[REDACTED]`). */
  argv: string[]; shown: string[];
  /** Environment values a binding sets, as they run and as shown. */
  env: Record<string, string>; shownEnv: Record<string, string>;
  /**
   * The executable: a PATH program pinned at Prepare; the AI setup's acquired program (from the user root, with the
   * qualified sha256 when the qualification lists that member); or a program inside the clone, both resolved at Apply.
   */
  executable: { from: 'path'; name: string } | { from: 'acquired'; path: string; sha256: string | null; tree?: string } | { from: 'clone'; path: string };
  /** The folder the command runs in, relative to the root ('' is the root itself). */
  cwd: string;
  readback?: Readback;
  /**
   * A `tool-command`'s undo known at Prepare: always `null` now. A step with a `restore` gets its undo at Apply (the
   * restore with the value its readback showed before the command), recorded in the receipt.
   */
  undo?: { argv: string[]; readback: Readback } | null;
  /** A `tool-command`'s `restore` argv as planned, with `<prior>` standing once for the value read before the command. */
  restore?: { argv: string[] };
  /** Set at Prepare when an earlier install's record of this restore is kept (its `undo` above): the prior value is not read again. */
  kept?: 'read' | 'withheld';
  /** An `upstream-setup`'s clone: the repository at the exact commit, into a folder marked by `marker`. */
  clone?: { repository: string; commit: string; into: string; marker: Buffer };
  needs?: string[];
  /** `false` for an `upstream-installer`: Core can't remove what it writes (D53). */
  managed: boolean;
  /** What Core can't remove around this program, said in the review and at removal. */
  cantRemove: string;
  sentence: string;
  cantPromise: string;
  review: { item?: string; framework?: string; clis?: string[]; inputs?: ReviewInput[]; route?: undefined; contains?: undefined };
  bound?: BoundInputs;
  profiles?: undefined;
  acquire?: undefined;
}
/**
 * One planned entry the engine adds to a file the person may already have (Catalog 9 `merge`): a JSON value at a JSON
 * Pointer (engine `config.entries`, JSONC-tolerant so a person's comments survive), the leaves of one TOML table
 * (engine `config.entries` toml), or one marked Markdown block (engine `text.block`). It never replaces the file.
 */
export interface LoweredMerge {
  kind: 'merge';
  managementIds: string[];
  root: 'project' | 'user';
  path: string;
  format: 'json' | 'toml' | 'markdown';
  /** The step's `key` as the plan states it (pointer, dotted table, or item id). */
  key: string;
  /** The key as editor path segments (JSON, TOML), or the block id (Markdown). */
  segments: string[];
  /** JSON: the value; TOML: each leaf under the table, path relative to it; Markdown: the block body. */
  entry: Json;
  leaves?: { path: string[]; value: Json }[];
  /** Known secret slots: full editor paths whose value is a declared secret input (redacted in conflicts, never in receipts). */
  secrets: string[][];
  /** The slots that now hold a secret value: the review shows them `[REDACTED]`. */
  redact: string[][];
  /** Those slots' authored text (C64): what a displaced value keeps instead of the secret. */
  slots?: { path: string[]; item: string; input: string; template: string }[];
  /** The step's filled input bindings, when it has any. */
  bound?: BoundInputs;
  /** Whether the file is Codex's always-on guidance, whose resulting size Catalog bounds at 32 KiB (C72). */
  /** A guidance file a served CLI reads only up to `maxBytes` (C72), from the Harness CLI facts. */
  guidance?: { label: string; maxBytes: number };
  sentence: string;
  cantPromise: string | null;
  review: { item?: string; items?: string[]; clis?: string[]; framework?: string; route?: 'local-plugin'; contains?: string[];
    format: 'json' | 'toml' | 'markdown'; key: string; inputs?: ReviewInput[] };
  /** Only writes acquire or render. */
  acquire?: never; profiles?: never;
}
export type StepOutcome = { lowered: Lowered } | { refusal: Refusal } | { problem: Problem };
export interface StepHandler {
  op: string;
  /** May be asynchronous: a render calls the caller's Catalog (C51). */
  prepare(step: PlanStep & Record<string, Json>, context: StepContext): StepOutcome | Promise<StepOutcome>;
}
