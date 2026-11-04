// aih repair <repair-id> --target <id>... [--inputs-file <json>] [--offline] [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--no-log] [--json]
// aih export-ca [--format pem|pkcs7-der] [--output <path>] [--inputs-file <json>] [--offline] [--resolutions <file>] [--apply [--yes]] [--no-log] [--json]
// (contract 10, 22). Inputs files are `repair-inputs`, `macos-session-inputs` or `export-inputs` 0.1.0; supplied paths in
// them resolve from the document's own folder. Both commands print a 0.1.0 review or run.
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { repairIndex } from '../../harness/contracts.mjs';
import { readRegularFile } from '../internal/fsxn.js';
import { parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import { apply, prepare } from '../index.js';
import { approved, emit, exitCode, printable, refusal } from './common.js';
import { RUN, type PlanControls, type Run } from '../plan/types.js';
import type { EnvironmentRequest } from '../environment/request.js';

const INPUTS = { repair: 'urn:aihq:core:repair-inputs:0.1.0', session: 'urn:aihq:core:macos-session-inputs:0.1.0',
  export: 'urn:aihq:core:export-inputs:0.1.0' } as const;
const USAGE = {
  repair: 'aih repair <repair-id> --target <id>... [--inputs-file <json>] [--offline] [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--no-log] [--json]\n',
  'export-ca': 'aih export-ca [--format pem|pkcs7-der] [--output <path>] [--inputs-file <json>] [--offline] [--resolutions <file>] [--apply [--yes]] [--no-log] [--json]\n',
};
type Command = keyof typeof USAGE;
interface Bound { path: string; sha256: string; document: Record<string, unknown> }
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function read(path: string): Bound | undefined {
  const absolute = resolve(path);
  const bytes = readRegularFile(absolute, { maxBytes: 1_000_000 });
  if (!bytes) return undefined;
  try { return { path: absolute, sha256: sha256(bytes), document: parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 'document') }; }
  catch { return undefined; }
}
function optionValue(args: string[], name: string): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === `--${name}`) return args[index + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

/**
 * Whether this invocation is a 0.1.0 environment command. `repair` is, with no inputs file or a 0.1.0 one; `export-ca`
 * is with a 0.1.0 inputs file. Everything else keeps the retained command until the older formats are removed.
 */
export function accepts(command: string, args: string[]): boolean {
  if (command !== 'repair' && command !== 'export-ca' || args.some(arg => arg === '-h' || arg === '--help')) return false;
  const file = optionValue(args, 'inputs-file');
  if (file === undefined) return command === 'repair';
  const schema = read(file)?.document.schema;
  return command === 'repair' ? schema === INPUTS.repair || schema === INPUTS.session : schema === INPUTS.export;
}

const sources = (value: unknown, base: string) => {
  const source = value as { os: boolean; supplied: { id: string; file: string }[]; removeSupplied?: string[] };
  return { ...source, supplied: (source.supplied ?? []).map(entry => ({ id: entry.id,
    file: typeof entry.file === 'string' ? resolve(base, entry.file) : entry.file })) };
};

export async function run(command: Command, args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      target: { type: 'string', multiple: true }, 'inputs-file': { type: 'string' }, offline: { type: 'boolean' },
      resolutions: { type: 'string' }, apply: { type: 'boolean' }, yes: { type: 'boolean' }, 'allow-partial': { type: 'boolean' },
      'no-log': { type: 'boolean' }, json: { type: 'boolean' }, format: { type: 'string' }, output: { type: 'string' } } });
  } catch { process.stderr.write(USAGE[command]); return emit(output, refusal('usage', `The ${command} options are not valid.`), 2); }
  const { values, positionals } = parsed;
  const usage = (reason: string) => { process.stderr.write(USAGE[command]); emit(output, refusal('usage', reason), 2); };
  if (values.yes && !values.apply || values['allow-partial'] && !values.apply) return usage('`--yes` and `--allow-partial` go with `--apply`.');
  const bound: Bound[] = [];
  let request: EnvironmentRequest;
  const inputs = values['inputs-file'] === undefined ? undefined : read(values['inputs-file']);
  if (values['inputs-file'] !== undefined && !inputs)
    return emit(output, refusal('request-unreadable', 'The inputs file could not be read as strict JSON.'), 2);
  if (inputs) bound.push(inputs);
  const base = inputs ? dirname(inputs.path) : process.cwd();
  const network = values.offline ? { network: 'off' as const } : {};
  if (command === 'repair') {
    if (positionals.length !== 1 || !values.target?.length || values.format !== undefined || values.output !== undefined)
      return usage('Name one repair and at least one `--target`.');
    const definition = repairIndex.find(item => item.id === positionals[0]);
    const document = inputs?.document ?? {};
    const supplied = document.inputs && typeof document.inputs === 'object' && !Array.isArray(document.inputs) ?
      Object.fromEntries(Object.entries(document.inputs as Record<string, unknown>).map(([key, value]) =>
        [key, definition?.inputs[key]?.type === 'file' && typeof value === 'string' && !isAbsolute(value) ? resolve(base, value) : value])) : undefined;
    const common = { repair: positionals[0], targets: values.target, ...(document.route === undefined ? {} : { route: document.route }),
      ...(document.sources === undefined ? {} : { sources: sources(document.sources, base) }), ...(supplied === undefined ? {} : { inputs: supplied }),
      ...network };
    if (document.schema === INPUTS.session) {
      const session = document.session as { context?: unknown; applications?: { appPath?: unknown }[] } | undefined;
      request = { schema: 'urn:aihq:core:macos-session-request:0.1.0', ...common, session: session && Array.isArray(session.applications) ?
        { ...session, applications: session.applications.map(app => app && typeof app.appPath === 'string' && !app.appPath.startsWith('/') ?
          { ...app, appPath: resolve(base, app.appPath) } : app) } : session } as unknown as EnvironmentRequest;
    } else request = { schema: 'urn:aihq:core:repair-request:0.1.0', ...common } as unknown as EnvironmentRequest;
    // The document's own fields beyond the request's are left for the schema to name.
    if (inputs) for (const key of Object.keys(inputs.document)) if (!['schema', 'route', 'sources', 'inputs', 'session'].includes(key))
      (request as unknown as Record<string, unknown>)[key] = inputs.document[key];
  } else {
    if (positionals.length || values.target !== undefined || values['allow-partial']) return usage('`export-ca` takes no positional arguments, targets or partial approval.');
    request = { schema: 'urn:aihq:core:export-request:0.1.0', ...(values.format === undefined ? {} : { format: values.format }),
      ...(values.output === undefined ? {} : { output: values.output }),
      ...(inputs?.document.sources === undefined ? {} : { sources: sources(inputs.document.sources, base) }), ...network } as unknown as EnvironmentRequest;
    if (inputs) for (const key of Object.keys(inputs.document)) if (!['schema', 'sources'].includes(key))
      (request as unknown as Record<string, unknown>)[key] = inputs.document[key];
  }
  if (values.resolutions !== undefined) {
    const document = read(values.resolutions);
    if (!document || Object.keys(document.document).length !== 1 || !Array.isArray(document.document.resolutions))
      return emit(output, refusal('request-unreadable', 'The resolutions file holds `{ "resolutions": [...] }`.'), 2);
    (request as { resolutions?: unknown }).resolutions = document.document.resolutions;
    bound.push(document);
  }
  const controls: Pick<PlanControls, 'signal' | 'logging'> = { signal, ...(values['no-log'] ? { logging: 'off' as const } : {}) };
  const preparation = await prepare(request, controls);
  if (!values.apply || !('handle' in preparation) || !preparation.handle)
    return emit(output, 'handle' in preparation ? printable(preparation) : preparation, exitCode(preparation));
  if (!await approved(preparation.review, values.yes === true, signal))
    return emit(output, refusal('approval-required', 'Apply needs `--yes` or an interactive yes.'), 2);
  // Approval covers the documents read for this review; a changed file is a changed input.
  if (bound.some(entry => read(entry.path)?.sha256 !== entry.sha256)) {
    const stale: Run = { schema: RUN, status: 'ok', runId: randomUUID(), completion: 'rejected', code: 'REVIEW_STALE', changed: 'input',
      reason: 'input-file-changed', reviewDigest: preparation.review.reviewDigest, steps: [], members: [], history: { status: 'disabled' } };
    await apply(preparation.handle, { approved: true, origin: 'automation', reviewDigest: '' }, controls);
    return emit(output, stale, exitCode(stale));
  }
  const result = await apply(preparation.handle, { approved: true, origin: values.yes ? 'automation' : 'interactive',
    reviewDigest: preparation.review.reviewDigest, ...(values['allow-partial'] ? { allowPartial: true } : {}) }, controls);
  emit(output, result, exitCode(result));
}
