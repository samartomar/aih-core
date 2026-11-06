// aih check-files <plan-request.json | change-request.json> [--project <path>] [--source <sourceId>=<folder>]...
//                 [--material-root <id>=<folder>]... [--json]      (contract 10, 14.1, 22)
// Read-only: nothing is written, recorded, downloaded or run. Plan sources are read with the Catalog installed beside
// this CLI, as `aih install` does.
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { checkFiles } from '../file-check.js';
import { catalogNode, catalogReader } from './install.js';
import { emit, readDocument, refusal } from './common.js';

const USAGE = 'aih check-files <plan-request.json | change-request.json> [--project <path>] [--source <sourceId>=<folder>]... [--material-root <id>=<folder>]... [--json]\n';
const absolute = (path: string) => isAbsolute(path) ? path : resolve(path);

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      project: { type: 'string' }, source: { type: 'string', multiple: true }, 'material-root': { type: 'string', multiple: true },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The check-files options are not valid.'), 2); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(USAGE); return; }
  if (positionals.length !== 1) { process.stderr.write(USAGE); return emit(output, refusal('usage', 'Name exactly one request file.'), 2); }
  let request: Record<string, unknown> & { target?: Record<string, unknown>; files?: { sourceId?: unknown; sourcePath?: unknown; bytes?: Uint8Array }[] };
  try { request = readDocument(positionals[0]!, 16 * 1_048_576); }
  catch { return emit(output, refusal('request-unreadable', 'The request file could not be read as strict JSON.'), 2); }
  if (values.project !== undefined)
    request.target = { ...(request.target && typeof request.target === 'object' ? request.target : {}), project: absolute(values.project) };
  if (values.source?.length) {
    const catalog = await catalogNode();
    if (!catalog) return emit(output, refusal('catalog-required', 'Reading `--source` folders needs @aihq/catalog installed beside this CLI.'), 2);
    for (const spec of values.source) {
      const at = spec.indexOf('=');
      const id = spec.slice(0, at), folder = spec.slice(at + 1);
      if (at < 1 || !folder) return emit(output, refusal('usage', '`--source` is `<sourceId>=<folder>`.'), 2);
      let read;
      try { read = await catalog.readLocalSource(absolute(folder)); }
      catch { return emit(output, refusal('source-missing', `The source folder for \`${id}\` could not be read.`), 2); }
      if (read.status !== 'ok' || !Array.isArray(read.files))
        return emit(output, refusal('source-missing', `The Catalog could not read the source folder for \`${id}\` (${read.status}).`), 2);
      const files = new Map(read.files.map(file => [file.path, file.bytes]));
      for (const entry of Array.isArray(request.files) ? request.files : [])
        if (entry && entry.sourceId === id && files.get(entry.sourcePath as string) instanceof Uint8Array) entry.bytes = files.get(entry.sourcePath as string)!;
    }
  }
  const materialRoots: Record<string, string> = {};
  for (const spec of values['material-root'] ?? []) {
    const at = spec.indexOf('=');
    if (at < 1 || at === spec.length - 1) return emit(output, refusal('usage', '`--material-root` is `<id>=<folder>`.'), 2);
    materialRoots[spec.slice(0, at)] = absolute(spec.slice(at + 1));
  }
  const catalog = await catalogReader();
  const result = await checkFiles(request, { signal, ...(catalog ? { catalog } : {}), ...(Object.keys(materialRoots).length ? { materialRoots } : {}) });
  const code = result.status !== 'ok' ? (result.status === 'refused' && result.code === 'cancelled' ? 130 : 2) :
    result.observation === 'cancelled' ? 130 : result.observation === 'complete' && result.fileState === 'match' ? 0 : 1;
  emit(output, result, code);
}
