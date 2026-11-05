// Shared CLI plumbing for the 0.1.0 commands (contract 14.1, 22): one JSON result on stdout and its exit code.
import { createInterface } from 'node:readline/promises';
import { isAbsolute, resolve } from 'node:path';
import { stdin, stderr } from 'node:process';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { apply } from '../index.js';
import { readRegularFile } from '../internal/fsxn.js';
import { parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import type { PlanHandle, PlanPreparation, RemovalResult, Review, Run } from '../plan/types.js';

export interface Output { json: boolean }

/** The options every request command takes: Apply and its approval, history logging, the output form and help. */
export const COMMON_OPTIONS = { apply: { type: 'boolean' }, yes: { type: 'boolean' }, 'allow-partial': { type: 'boolean' },
  'no-log': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } as const;
/** `--private-input <item>.<input>=<ENV>`, once per input. */
export const PRIVATE_INPUT_OPTION = { 'private-input': { type: 'string', multiple: true } } as const;
/** `--resolutions <file>`: the choices for a second preparation. */
export const RESOLUTIONS_OPTION = { resolutions: { type: 'string' } } as const;
/** `--artifacts <dir>`: a folder of exact files for `acquire` downloads (C78), read only. */
export const ARTIFACTS_OPTION = { artifacts: { type: 'string' } } as const;
export const ARTIFACTS_USAGE = '[--artifacts <dir>]';
/** `--artifacts` as `controls.artifacts` (an absolute path), or nothing when not given. */
export const artifactsControl = (folder: string | undefined): { artifacts?: string } =>
  folder === undefined ? {} : { artifacts: isAbsolute(folder) ? folder : resolve(folder) };

/** The usage line on stderr and a `usage` refusal (exit 2). */
export function usageRefusal(output: Output, usage: string, reason: string): void {
  process.stderr.write(usage);
  emit(output, refusal('usage', reason), 2);
}

/**
 * Parses one command's arguments with the common options added (strict, positionals allowed). Invalid options are a
 * `usage` refusal and `--help` prints the usage; both return `undefined`, having written the result.
 */
export function parseCommand<O extends ParseArgsOptionsConfig>(args: string[], name: string, usage: string, options: O) {
  const output: Output = { json: args.includes('--json') };
  let parsed;
  try { parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { ...COMMON_OPTIONS, ...options } }); }
  catch { usageRefusal(output, usage, `The ${name} options are not valid.`); return undefined; }
  if ((parsed.values as { help?: boolean }).help) { process.stdout.write(usage); return undefined; }
  return { output, values: parsed.values, positionals: parsed.positionals };
}

/** `--yes` and `--allow-partial` approve an Apply: without `--apply` they are a `usage` refusal (`false`). */
export function applyFlagsHold(output: Output, usage: string, values: { apply?: boolean; yes?: boolean; 'allow-partial'?: boolean }): boolean {
  if ((values.yes || values['allow-partial']) && !values.apply) { usageRefusal(output, usage, '`--yes` and `--allow-partial` need `--apply`.'); return false; }
  return true;
}

/** The Enterprise options read, or `undefined` after a `usage` refusal. */
export function enterpriseOptions(output: Output, usage: string, values: Record<string, unknown>): Exclude<ReturnType<typeof organizationFrom>, 'usage'> | undefined {
  const enterprise = organizationFrom(values);
  if (enterprise !== 'usage') return enterprise;
  usageRefusal(output, usage, 'The Enterprise options name `--mode enterprise` and one organization source.');
  return undefined;
}

/** `--private-input` mappings as `controls.privateInputs`, or `undefined` after a `usage` refusal naming the mapping form. */
export function privateInputsOption(output: Output, mappings: string[] | undefined, form = '<item>.<input>=<ENV>'): Record<string, Record<string, string>> | undefined {
  const inputs = privateInputMappings(mappings);
  if (!inputs) emit(output, refusal('usage', `\`--private-input\` is \`${form}\` naming a set environment variable, once per input.`), 2);
  return inputs;
}

/**
 * The end of every request command: without `--apply`, or without a handle, the preparation is printed (its handle stays
 * in this process). Otherwise the review is approved (`--yes`, or an interactive yes), and applied with `--allow-partial`
 * when given. `beforeApply` may return a run to print instead (an input that changed since the review).
 */
export async function applyReviewed(output: Output, preparation: { status: string; handle?: PlanHandle; review?: Review },
    values: { apply?: boolean; yes?: boolean; 'allow-partial'?: boolean }, signal: AbortSignal, controls: object,
    beforeApply?: (handle: PlanHandle, review: Review) => Promise<Run | undefined>): Promise<void> {
  if (!values.apply || !preparation.handle || !preparation.review)
    return emit(output, printable(preparation), exitCode(preparation as PlanPreparation));
  if (!await approved(preparation.review, values.yes === true, signal))
    return emit(output, refusal('approval-required', 'Apply needs `--yes` or an interactive yes.'), 2);
  const instead = await beforeApply?.(preparation.handle, preparation.review);
  if (instead) return emit(output, instead, exitCode(instead));
  const result = await apply(preparation.handle, { approved: true, origin: values.yes ? 'automation' : 'interactive',
    reviewDigest: preparation.review.reviewDigest, ...(values['allow-partial'] ? { allowPartial: true } : {}) }, controls);
  emit(output, result, exitCode(result));
}
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

/** A `--resolutions <file>` document (`{ "resolutions": [...] }`): the choices for a second preparation, or `undefined` when unreadable. */
export function readResolutions(path: string): unknown[] | undefined {
  try {
    const document = readDocument(path, 1_000_000);
    return Object.keys(document).length === 1 && Array.isArray(document.resolutions) ? document.resolutions as unknown[] : undefined;
  } catch { return undefined; }
}
export const RESOLUTIONS_UNREADABLE = 'The resolutions file holds `{ "resolutions": [...] }`.';

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

/** The Enterprise options every request command takes (contract 22): `--mode enterprise` and one organization source. */
export const ORGANIZATION_OPTIONS = { mode: { type: 'string' }, 'org-repository': { type: 'string' }, 'org-path': { type: 'string' },
  'org-ref': { type: 'string' }, 'org-token-env': { type: 'string' }, 'org-file': { type: 'string' } } as const;
export const ORGANIZATION_USAGE = '[--mode enterprise --org-repository <owner/repo> --org-path <path> --org-ref <branch:name|tag:name|commit:sha> [--org-token-env <NAME>] | --org-file <path>]';
/**
 * The organization source and credential from the Enterprise options, or `undefined` for Vibe. A GitHub source names the
 * repository, path and ref; a local one the file. The token is read only from the named environment variable.
 */
export function organizationFrom(values: Record<string, unknown>): { mode?: 'vibe' | 'enterprise'; organization?: import('../plan/types.js').OrganizationSource;
    authentication?: { kind: 'bearer'; token: string } } | 'usage' {
  const mode = values.mode;
  const github = ['org-repository', 'org-path', 'org-ref'].filter(name => values[name] !== undefined);
  const named = github.length || values['org-file'] !== undefined || values['org-token-env'] !== undefined;
  if (mode === undefined) return named ? 'usage' : {};
  if (mode === 'vibe') return named ? 'usage' : { mode: 'vibe' };
  if (mode !== 'enterprise') return 'usage';
  let authentication: { kind: 'bearer'; token: string } | undefined;
  if (values['org-token-env'] !== undefined) {
    const name = String(values['org-token-env']);
    const token = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? process.env[name] : undefined;
    if (!token || values['org-file'] !== undefined) return 'usage';
    authentication = { kind: 'bearer', token };
  }
  if (values['org-file'] !== undefined) {
    if (github.length) return 'usage';
    return { mode, organization: { provider: 'local', path: resolve(String(values['org-file'])) } };
  }
  const repository = /^([^/\s]+)\/([^/\s]+)$/.exec(String(values['org-repository'] ?? ''));
  const revision = /^(branch|tag|commit):(.+)$/s.exec(String(values['org-ref'] ?? ''));
  if (!repository || !revision || typeof values['org-path'] !== 'string' || !values['org-path']) return 'usage';
  return { mode, organization: { provider: 'github', repository: { owner: repository[1]!, name: repository[2]! }, path: values['org-path'],
    revision: { kind: revision[1] as 'branch' | 'tag' | 'commit', value: revision[2]! } }, ...(authentication ? { authentication } : {}) };
}
