// Plan-module handles: the private key that lets Apply carry out one 0.1.0 review. Each wraps one engine handle; a
// handle is consumed by its first Apply.
import type { PreparedHandle } from '../host-types.js';
import type { ResolvedExecutable } from '../internal/approved-process.js';
import type { PlanHandle } from './types.js';
import type { AcquireFacts } from './acquire/types.js';
import type { PrivateInputBinding } from './inputs.js';

export interface StepRef { step: number | string; managementId: string; /** A plugin step's command or removal. */ program?: true;
  /** A program step's command (tool-command, upstream installer or setup, or a reverse command at removal). */ command?: true }
/** A reviewed presence check for one plugin step: the executable pinned at Prepare, its argv and expected line. */
export interface ProgramCheck { executable: ResolvedExecutable; argv: string[]; expect: string; cwd: string;
  /** A tool-command readback (D57): the output must show `expect`, whatever presence is wanted. */
  readback?: true }
/** The switch-off block a run reads back: the file, its markers, and the `plugin:skill` name it must turn off. */
export interface SwitchOffReadback { file: string; blockId: string; startMarker: string; endMarker: string; content: string; name: string;
  step: number; managementId: string }
export interface HandleState {
  engine: PreparedHandle;
  engineDigest: string;
  /** Whether the engine's own review is partial, so its approval must carry `allowPartial`. */
  enginePartial: boolean;
  reviewDigest: string;
  partial: boolean;
  /** Engine operation id → the plan step and management id it carries out. */
  operations: Map<string, StepRef>;
  /** Engine claim key -> the management id it belongs to (plan claims, C28); run members name the management id. */
  claims?: Map<string, string>;
  /** A removal's folder links (receipt facts): each goes once its record is released (C28). */
  links?: import('../internal/custody-items.js').LinkFacts[];
  /** Plugin steps' presence checks by plan step index, run after the engine's commands (plan requests only). */
  programs?: Map<number, ProgramCheck>;
  /**
   * A removal's native plugin commands (prepareRemoval): their own engine handle, run before `engine` releases the
   * receipts, then their presence checks. `unremovable` are plugin steps the receipt holds no removal command for.
   */
  before?: { engine: PreparedHandle | undefined; engineDigest: string; operations: Map<string, StepRef>; programs: Map<number, ProgramCheck>;
    unremovable: StepRef[] };
  /** Plan step index -> what its program step's check found (a readback, or that its effects can't be checked), filled during Apply. */
  verifications?: Map<number, { status: string; reason: string }>;
  /** Plan step index -> what its AI setup acquisition did, filled during Apply. */
  acquired?: Map<number, AcquireFacts>;
  /** Where an acquisition reports progress: the Apply call's `onProgress`. */
  progress?: { onProgress?: (event: import('../types.js').Json) => void };
  /** A one-item switch-off (C69): the block Apply reads back and checks after writing it. */
  readback?: SwitchOffReadback;
  /** The caller's request object and the digests Prepare read from it (plan requests only). */
  request?: { value: unknown; documentDigest: string; bytesDigest: string };
  /** The private inputs the review was prepared with: Apply re-checks them by digest (`REVIEW_STALE` `input`). */
  privateInputs?: PrivateInputBinding;
  /**
   * An update (contract 12): the new data and origin each of its claims records once the run completes. Steps it kept
   * because you edited their member (`<step>\0<managementId>`) are reviewed as left alone, so they don't hold it back.
   */
  record?: { data: { repository: string; commit: string } | null; origin: import('../internal/custody-items.js').PlanItemFacts['origin'];
    claims: { root: string; identity: string }[]; kept: string[] };
}
const handles = new WeakMap<PreparedHandle, HandleState>();
/** Every handle this module issued, also once consumed, so a second Apply still gets a 0.1.0 rejection. */
const issued = new WeakSet<object>();

export function register(state: HandleState): PlanHandle {
  const handle = Object.freeze({}) as PlanHandle;
  handles.set(handle as unknown as PreparedHandle, state); issued.add(handle);
  return handle;
}
export const isPlanHandle = (value: unknown): boolean => !!value && typeof value === 'object' && issued.has(value);
/** Takes the handle's state and consumes it. */
export function take(handle: unknown): HandleState | undefined {
  if (!handle || typeof handle !== 'object') return undefined;
  const state = handles.get(handle as PreparedHandle);
  handles.delete(handle as PreparedHandle);
  return state;
}
export const peek = (handle: unknown): HandleState | undefined =>
  handle && typeof handle === 'object' ? handles.get(handle as PreparedHandle) : undefined;
