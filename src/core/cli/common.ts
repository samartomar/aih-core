// Shared CLI plumbing for the 0.1.0 commands (contract 14.1, 22): one JSON result on stdout and its exit code.
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { stdin, stderr } from 'node:process';
import { readRegularFile } from '../internal/fsxn.js';
import { parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import type { PlanPreparation, RemovalResult, Review, Run } from '../plan/types.js';

export interface Output { json: boolean }
export function emit(output: Output, result: unknown, code: number): void {
  process.stdout.write(JSON.stringify(result, null, output.json ? undefined : 2) + '\n');
  process.exitCode = code;
}
/** Progress of program steps (each command's start and finish), one JSON line each on stderr; stdout keeps the result. */
export const progressLine = (event: unknown): void => { process.stderr.write(JSON.stringify({ progress: event }) + '\n'); };
/** A CLI-level refusal in the 0.1.0 result shape. */
export const refusal = (code: string, reason: string) => ({ status: 'refused' as const, code, reason });

/** Exit codes: 0 ready / complete / ok; 1 partial, blocked, incomplete, or nothing prepared; 2 refused, invalid, rejected; 130 cancelled. */
export function exitCode(result: PlanPreparation | RemovalResult | Run | { status: string; code?: string }): number {
  if ('completion' in result) return ({ complete: 0, incomplete: 1, rejected: 2, cancelled: 130 })[result.completion];
  if (result.status === 'refused' && (result as { code?: string }).code === 'cancelled') return 130;
  if ('entries' in result && result.status === 'ok' && !('schema' in result)) {
    const counted = (result.entries as { disposition: string; status?: string }[]).filter(entry => entry.disposition === 'prepared');
    if (!counted.length) return 1;
    return counted.every(entry => entry.status === 'ready') ? 0 : 1;
  }
  return ({ ready: 0, ok: 0, partial: 1, blocked: 1 } as Record<string, number>)[result.status] ?? 2;
}

/** A strict JSON document from a file the person named, read once with a byte bound. */
export function readDocument(path: string, maxBytes: number): Record<string, unknown> {
  const bytes = readRegularFile(resolve(path), { maxBytes });
  if (!bytes) throw new Error('file-unavailable');
  return parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 'document');
}

/** `--yes` approves; otherwise an interactive terminal asks. Anything else is not approval. */
export async function approved(review: Review, yes: boolean, signal: AbortSignal): Promise<boolean> {
  if (yes) return true;
  if (!stdin.isTTY || !stderr.isTTY) return false;
  stderr.write(JSON.stringify(review, null, 2) + '\n');
  const prompt = createInterface({ input: stdin, output: stderr });
  try { return /^y(?:es)?$/i.test((await prompt.question('Apply this reviewed work? [y/N] ', { signal })).trim()); }
  finally { prompt.close(); }
}
/** The printable form of a preparation: the handle stays in this process. */
export const printable = <T extends { handle?: unknown }>(result: T): Omit<T, 'handle'> => {
  const { handle: _handle, ...rest } = result; return rest;
};

/**
 * `--private-input <item>.<input>=<ENV>` mappings (contract 22): each names a set environment variable holding the
 * secret, keyed by item id then input name as `controls.privateInputs`. Item ids hold dots, so the last literal dot
 * separates the input; a dot inside either part may be written `%2E`. `undefined` when a mapping is malformed, repeated
 * or names an unset variable.
 */
export function privateInputMappings(mappings: string[] | undefined): Record<string, Record<string, string>> | undefined {
  const inputs: Record<string, Record<string, string>> = Object.create(null);
  for (const mapping of mappings ?? []) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._%-]*)\.([A-Za-z_%][A-Za-z0-9_%-]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(mapping);
    let item = '', input = '';
    try { item = decodeURIComponent(match?.[1] ?? ''); input = decodeURIComponent(match?.[2] ?? ''); } catch { return undefined; }
    const value = match ? process.env[match[3]!] : undefined;
    if (!match || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item) || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(input) || value === undefined ||
        Object.hasOwn(inputs[item] ?? {}, input)) return undefined;
    (inputs[item] ??= Object.create(null))[input] = value;
  }
  return inputs;
}
