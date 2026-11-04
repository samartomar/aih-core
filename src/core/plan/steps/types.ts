// The step-handler seam: one file per Catalog step kind, registered in `./index.ts`. A handler checks one plan step
// against the request (sources, containment, clients) before any effect and lowers it into the existing engine's
// operations. It never touches the disk.
import type { Json } from '../../types.js';
import type { PlanControls, PlanRequest, PlanStep, Problem, Refusal } from '../types.js';
import type { AcquireSpec } from '../acquire/types.js';

/** A source file the plan's documents name, with what they say about it. */
export interface SourceFacts { sourceId: string; sourcePath: string; sha256: string; executable: boolean }
export interface StepContext {
  request: PlanRequest;
  controls: PlanControls;
  index: number;
  /** A content item's file by item id and source path. */
  itemFile(item: string, sourcePath: string): SourceFacts | undefined;
  /** A source notice by source id and source path. */
  notice(sourceId: string, sourcePath: string): SourceFacts | undefined;
  /** The supplied bytes for one `{ sourceId, sourcePath }`, after checking them; marks the entry as named by a step. */
  bytesFor(facts: SourceFacts): { bytes: Buffer } | { refusal: Refusal };
  /** A supplied qualification document by its sha256 (hex, over its canonical JSON). */
  qualification(sha256: string): { [field: string]: Json } | undefined;
  /** An item's declared input (`requirements.inputs[name]`), as its content document states it. */
  itemInput(item: string, input: string): { isSecret: boolean } | undefined;
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
  review: { item?: string; items?: string[]; clis?: string[] };
  /** An `acquire` step: the acquisition Apply carries out immediately before writing this marker file. */
  acquire?: AcquireSpec;
  /** For a rendered write: the tool profiles (id and version) the render records, checked against the request. */
  profiles?: { id: string; version: string | number }[];
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
  commands: string[][];
  undo: string[][] | null;
  presenceCheck: 'none' | { argv: string[]; expect: string };
  sentence: string;
  cantPromise: string;
  review: { framework: string; clis: string[] };
  /** Never an acquisition or a render. */
  profiles?: undefined;
  acquire?: undefined;
}
export type Lowered = LoweredWrite | LoweredPlugin | LoweredMerge | LoweredLink;
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
  review: { item?: string; items?: string[]; clis?: string[]; to: string; linkType: 'junction' | 'symlink' | 'copy' };
  acquire?: never; profiles?: never;
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
  /** Whether the file is Codex's always-on guidance, whose resulting size Catalog bounds at 32 KiB (C72). */
  codexGuidance: boolean;
  sentence: string;
  cantPromise: string | null;
  review: { item?: string; items?: string[]; clis?: string[]; format: 'json' | 'toml' | 'markdown'; key: string };
  /** Only writes acquire or render. */
  acquire?: never; profiles?: never;
}
export type StepOutcome = { lowered: Lowered } | { refusal: Refusal } | { problem: Problem };
export interface StepHandler {
  op: string;
  /** May be asynchronous: a render calls the caller's Catalog (C51). */
  prepare(step: PlanStep & Record<string, Json>, context: StepContext): StepOutcome | Promise<StepOutcome>;
}
