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
export type Lowered = LoweredWrite;
export type StepOutcome = { lowered: Lowered } | { refusal: Refusal } | { problem: Problem };
export interface StepHandler {
  op: string;
  /** May be asynchronous: a render calls the caller's Catalog (C51). */
  prepare(step: PlanStep & Record<string, Json>, context: StepContext): StepOutcome | Promise<StepOutcome>;
}
