// Shared checks for the program step kinds (`tool-command`, `upstream-installer`, `upstream-setup`; contract 8.1, C30):
// an exact argv, input bindings at argv slots or environment names (C59), and how the review shows them.
import { bindProcess, parseBindings, type BoundInputs } from '../inputs.js';
import { problem } from './common.js';
import type { Json } from '../../types.js';
import type { Problem, Refusal } from '../types.js';
import type { Readback, StepContext } from './types.js';

export const REDACTED = '[REDACTED]';
/** An argv list: 1–64 non-empty strings without NUL. */
export const isArgv = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 64 &&
  value.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !arg.includes('\0'));
const plain = (value: unknown): value is Record<string, Json> => !!value && typeof value === 'object' && !Array.isArray(value);
/** `{ argv, expected }`, the readback a `tool-command` names (D57). */
export function readbackOf(value: unknown): Readback | undefined {
  if (!plain(value) || Object.keys(value).sort().join() !== 'argv,expected' || !isArgv(value.argv) || typeof value.expected !== 'string' ||
      value.expected.length > 4096) return undefined;
  return { argv: [...value.argv as string[]], expected: value.expected };
}
/** Whether this host can launch a program by this path: on Windows only `.exe` and `.com` files run without a shell. */
export const launchable = (path: string): boolean => process.platform !== 'win32' || /\.(exe|com)$/i.test(path);

/**
 * Fills a command's `inputs` bindings (argv slots index the step's argv; env bindings set variables). Secret values
 * run but are shown `[REDACTED]`; the engine redacts them from its review and history too.
 */
export function bindCommand(argv: string[], raw: Json | undefined, context: StepContext, clis: string[]):
    { argv: string[]; shown: string[]; env: Record<string, string>; shownEnv: Record<string, string>; bound?: BoundInputs } | { problem: Problem } | { refusal: Refusal } {
  const parsed = parseBindings(raw, context.index, ['argv', 'env']);
  if ('problem' in parsed) return parsed;
  if (!parsed.bindings.length) return { argv: [...argv], shown: [...argv], env: {}, shownEnv: {} };
  const done = bindProcess(argv, parsed.bindings, context.inputs(clis));
  if (!('argv' in done)) return done;
  const hide = (text: string) => done.bound.secretValues.reduce((out, secret) => secret ? out.split(secret).join(REDACTED) : out, text);
  return { argv: done.argv, shown: done.argv.map(hide), env: done.env,
    shownEnv: Object.fromEntries(Object.entries(done.env).map(([key, value]) => [key, hide(value)])), bound: done.bound };
}
export const shapeProblem = (index: number, field: string, op: string, message: string) => problem(index, field, op, message);
