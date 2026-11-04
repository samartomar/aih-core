// aih install <plan-request.json> [--project <path>] [--source <sourceId>=<folder>]... [--resolutions <file>]
//             [--apply [--yes] [--allow-partial]] [--no-log] [--json]      (contract 22)
// Source bytes are read with `readLocalSource` from the Catalog installed beside this CLI; without it, `--source` is
// refused `catalog-required`. The project is never taken from the working folder.
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { apply, prepare } from '../index.js';
import { approved, emit, exitCode, printable, progressLine, readDocument, refusal } from './common.js';
import type { PlanControls, PlanRequest } from '../plan/types.js';

const USAGE = 'aih install <plan-request.json> [--project <path>] [--source <sourceId>=<folder>]... [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--no-log] [--json]\n';
interface LocalSource { status: string; files?: { path: string; bytes?: Uint8Array }[] }

async function catalogNode(): Promise<{ readLocalSource(path: string): Promise<LocalSource> | LocalSource } | undefined> {
  try {
    const specifier = '@aihq/catalog/node';
    const module = await import(specifier) as { readLocalSource?: unknown };
    return typeof module.readLocalSource === 'function' ? module as never : undefined;
  } catch { return undefined; }
}

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      project: { type: 'string' }, source: { type: 'string', multiple: true }, resolutions: { type: 'string' },
      apply: { type: 'boolean' }, yes: { type: 'boolean' }, 'allow-partial': { type: 'boolean' }, 'no-log': { type: 'boolean' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The install options are not valid.'), 2); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(USAGE); return; }
  if (positionals.length !== 1) { process.stderr.write(USAGE); return emit(output, refusal('usage', 'Name exactly one plan request file.'), 2); }
  let request: PlanRequest;
  try { request = readDocument(positionals[0]!, 16 * 1_048_576) as unknown as PlanRequest; }
  catch { return emit(output, refusal('request-unreadable', 'The plan request file could not be read as strict JSON.'), 2); }
  if (values.project !== undefined) {
    if (!request.target || typeof request.target !== 'object') request.target = {};
    request.target = { ...request.target, project: isAbsolute(values.project) ? values.project : resolve(values.project) };
  }
  if (values.resolutions !== undefined) {
    try {
      const document = readDocument(values.resolutions, 1_000_000);
      if (Object.keys(document).length !== 1 || !Array.isArray(document.resolutions)) throw new Error('resolutions');
      request.resolutions = document.resolutions as PlanRequest['resolutions'];
    } catch { return emit(output, refusal('request-unreadable', 'The resolutions file holds `{ "resolutions": [...] }`.'), 2); }
  }
  if (values.source?.length) {
    const catalog = await catalogNode();
    if (!catalog) return emit(output, refusal('catalog-required', 'Reading `--source` folders needs @aihq/catalog installed beside this CLI.'), 2);
    for (const spec of values.source) {
      const at = spec.indexOf('=');
      const id = spec.slice(0, at), folder = spec.slice(at + 1);
      if (at < 1 || !folder) return emit(output, refusal('usage', '`--source` is `<sourceId>=<folder>`.'), 2);
      let read: LocalSource;
      try { read = await catalog.readLocalSource(isAbsolute(folder) ? folder : resolve(folder)); }
      catch { return emit(output, refusal('source-missing', `The source folder for \`${id}\` could not be read.`), 2); }
      if (read.status !== 'ok' || !Array.isArray(read.files))
        return emit(output, refusal('source-missing', `The Catalog could not read the source folder for \`${id}\` (${read.status}).`), 2);
      const files = new Map(read.files.map(file => [file.path, file.bytes]));
      for (const entry of Array.isArray(request.files) ? request.files : [])
        if (entry && entry.sourceId === id && files.get(entry.sourcePath) instanceof Uint8Array) entry.bytes = files.get(entry.sourcePath)!;
    }
  }
  const controls: PlanControls = { signal, onProgress: progressLine, ...(values['no-log'] ? { logging: 'off' as const } : {}) };
  const preparation = await prepare(request, controls);
  if (!values.apply || !('handle' in preparation) || !preparation.handle)
    return emit(output, 'handle' in preparation ? printable(preparation) : preparation, exitCode(preparation));
  if (!await approved(preparation.review, values.yes === true, signal))
    return emit(output, refusal('approval-required', 'Apply needs `--yes` or an interactive yes.'), 2);
  const result = await apply(preparation.handle, { approved: true, origin: values.yes ? 'automation' : 'interactive',
    reviewDigest: preparation.review.reviewDigest, ...(values['allow-partial'] ? { allowPartial: true } : {}) }, controls);
  emit(output, result, exitCode(result));
}
