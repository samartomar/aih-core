// aih update <plan-request.json | change-request.json> --scope project|user [--project <path>] [--management-id <id>]...
//            [--source <sourceId>=<folder>]... [--material-root <id>=<folder>]... [--resolutions <file>]
//            [--apply [--yes] [--allow-partial]] [--private-input <name>=<ENV>]... [--no-log] [--json]      (contract 22)
// The request is the complete new plan or change; Core never looks for updates itself. `--management-id` names the
// receipts an unproven plan or a change replaces (C52). The project is never taken from the working folder.
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { apply, prepareUpdate } from '../index.js';
import { approved, emit, exitCode, printable, privateInputMappings, progressLine, readDocument, refusal } from './common.js';
import { catalogNode, catalogReader } from './install.js';
import type { PlanControls, PlanRequest } from '../plan/types.js';
import type { ChangeControls } from '../change/prepare.js';

const USAGE = 'aih update <plan-request.json | change-request.json> --scope project|user [--project <path>] [--management-id <id>]... [--source <sourceId>=<folder>]... [--material-root <id>=<folder>]... [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--private-input <name>=<ENV>]... [--no-log] [--json]\n';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      project: { type: 'string' }, scope: { type: 'string' }, 'management-id': { type: 'string', multiple: true },
      source: { type: 'string', multiple: true }, 'material-root': { type: 'string', multiple: true }, resolutions: { type: 'string' },
      apply: { type: 'boolean' }, yes: { type: 'boolean' }, 'allow-partial': { type: 'boolean' }, 'no-log': { type: 'boolean' },
      'private-input': { type: 'string', multiple: true }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The update options are not valid.'), 2); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(USAGE); return; }
  if (positionals.length !== 1 || values.scope === undefined) { process.stderr.write(USAGE); return emit(output, refusal('usage', 'Name exactly one request file and `--scope`.'), 2); }
  if ((values.yes || values['allow-partial']) && !values.apply) { process.stderr.write(USAGE); return emit(output, refusal('usage', '`--yes` and `--allow-partial` need `--apply`.'), 2); }
  let request: PlanRequest & { changes?: unknown };
  try { request = readDocument(positionals[0]!, 16 * 1_048_576) as unknown as PlanRequest; }
  catch { return emit(output, refusal('request-unreadable', 'The request file could not be read as strict JSON.'), 2); }
  const change = typeof request.schema === 'string' && request.schema.startsWith('urn:aihq:core:change-request:');
  const project = values.project === undefined ? undefined : isAbsolute(values.project) ? values.project : resolve(values.project);
  if (project !== undefined) request.target = { ...(request.target && typeof request.target === 'object' ? request.target : {}), project };
  if (values.resolutions !== undefined) {
    try {
      const document = readDocument(values.resolutions, 1_000_000);
      if (Object.keys(document).length !== 1 || !Array.isArray(document.resolutions)) throw new Error('resolutions');
      request.resolutions = document.resolutions as PlanRequest['resolutions'];
    } catch { return emit(output, refusal('request-unreadable', 'The resolutions file holds `{ "resolutions": [...] }`.'), 2); }
  }
  if (values['management-id']?.some(id => !ID.test(id))) return emit(output, refusal('usage', '`--management-id` names a management id.'), 2);
  const privateInputs = privateInputMappings(values['private-input']);
  if (!privateInputs) return emit(output, refusal('usage', '`--private-input` is `<name>.<input>=<ENV>` naming a set environment variable, once per input.'), 2);
  let controls: PlanControls | ChangeControls;
  if (change) {
    if (values.source?.length) return emit(output, refusal('usage', '`--source` reads plan sources; a change takes `--material-root`.'), 2);
    const roots: Record<string, string> = Object.create(null);
    for (const spec of values['material-root'] ?? []) {
      const at = spec.indexOf('=');
      const id = spec.slice(0, at), folder = spec.slice(at + 1);
      if (at < 1 || !folder || Object.hasOwn(roots, id)) return emit(output, refusal('usage', '`--material-root` is `<id>=<folder>`, once per id.'), 2);
      roots[id] = isAbsolute(folder) ? folder : resolve(folder);
    }
    controls = { signal, ...(values['no-log'] ? { logging: 'off' as const } : {}), ...(Object.keys(privateInputs).length ? { privateInputs } : {}),
      ...(Object.keys(roots).length ? { materialRoots: roots } : {}) };
  } else {
    if (values['material-root']?.length) return emit(output, refusal('usage', '`--material-root` reads change material; a plan takes `--source`.'), 2);
    if (values.source?.length) {
      const catalog = await catalogNode();
      if (!catalog) return emit(output, refusal('catalog-required', 'Reading `--source` folders needs @aihq/catalog installed beside this CLI.'), 2);
      for (const spec of values.source) {
        const at = spec.indexOf('=');
        const id = spec.slice(0, at), folder = spec.slice(at + 1);
        if (at < 1 || !folder) return emit(output, refusal('usage', '`--source` is `<sourceId>=<folder>`.'), 2);
        let read: { status: string; files?: { path: string; bytes?: Uint8Array }[] };
        try { read = await catalog.readLocalSource(isAbsolute(folder) ? folder : resolve(folder)); }
        catch { return emit(output, refusal('source-missing', `The source folder for \`${id}\` could not be read.`), 2); }
        if (read.status !== 'ok' || !Array.isArray(read.files))
          return emit(output, refusal('source-missing', `The Catalog could not read the source folder for \`${id}\` (${read.status}).`), 2);
        const files = new Map(read.files.map(file => [file.path, file.bytes]));
        for (const entry of Array.isArray(request.files) ? request.files : [])
          if (entry && entry.sourceId === id && files.get(entry.sourcePath) instanceof Uint8Array) entry.bytes = files.get(entry.sourcePath)!;
      }
    }
    const catalog = await catalogReader();
    controls = { signal, onProgress: progressLine, ...(values['no-log'] ? { logging: 'off' as const } : {}),
      ...(Object.keys(privateInputs).length ? { privateInputs } : {}), ...(catalog ? { catalog } : {}) };
  }
  const managementIds = values['management-id'];
  const preparation = await prepareUpdate({ target: project ? { project } : {}, scope: values.scope as 'project' | 'user',
    updates: [{ ...(managementIds?.length ? { managementIds } : {}), request: request as never }] }, controls);
  if (!values.apply || !('handle' in preparation) || !preparation.handle || !preparation.review)
    return emit(output, 'handle' in preparation ? printable(preparation) : preparation, exitCode(preparation as never));
  if (!await approved(preparation.review, values.yes === true, signal))
    return emit(output, refusal('approval-required', 'Apply needs `--yes` or an interactive yes.'), 2);
  const result = await apply(preparation.handle, { approved: true, origin: values.yes ? 'automation' : 'interactive',
    reviewDigest: preparation.review.reviewDigest, ...(values['allow-partial'] ? { allowPartial: true } : {}) }, controls);
  emit(output, result, exitCode(result));
}
