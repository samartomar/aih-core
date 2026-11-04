// Plan-module handles: the private key that lets Apply carry out one 0.1.0 review. Each wraps one engine handle; a
// handle is consumed by its first Apply.
import type { PreparedHandle } from '../host-types.js';
import type { ResolvedExecutable } from '../internal/approved-process.js';
import type { PlanHandle } from './types.js';

export interface StepRef { step: number; managementId: string; /** A plugin step's command or removal. */ program?: true }
/** A reviewed presence check for one plugin step: the executable pinned at Prepare, its argv and expected line. */
export interface ProgramCheck { executable: ResolvedExecutable; argv: string[]; expect: string; cwd: string }
export interface HandleState {
  engine: PreparedHandle;
  engineDigest: string;
  /** Whether the engine's own review is partial, so its approval must carry `allowPartial`. */
  enginePartial: boolean;
  reviewDigest: string;
  partial: boolean;
  /** Engine operation id → the plan step and management id it carries out. */
  operations: Map<string, StepRef>;
  /** Plugin steps' presence checks by plan step index, run after the engine's commands (plan requests only). */
  programs?: Map<number, ProgramCheck>;
  /**
   * A removal's native plugin commands (prepareRemoval): their own engine handle, run before `engine` releases the
   * receipts, then their presence checks. `unremovable` are plugin steps the receipt holds no removal command for.
   */
  before?: { engine: PreparedHandle | undefined; engineDigest: string; operations: Map<string, StepRef>; programs: Map<number, ProgramCheck>;
    unremovable: StepRef[] };
  /** The caller's request object and the digests Prepare read from it (plan requests only). */
  request?: { value: unknown; documentDigest: string; bytesDigest: string };
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
