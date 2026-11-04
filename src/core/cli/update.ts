// aih update <plan-request.json | change-request.json> --scope project|user [--project <path>] [--management-id <id>]...
//            [--source <sourceId>=<folder>]... [--material-root <id>=<folder>]... [--resolutions <file>]
//            [--apply [--yes] [--allow-partial]] [--private-input <name>=<ENV>]... [--no-log] [--json]      (contract 22)
// The request is the complete new plan or change; Core never looks for updates itself. `--management-id` names the
// receipts an unproven plan or a change replaces (C52). The project is never taken from the working folder.
import { isAbsolute, resolve } from 'node:path';
import { prepareUpdate } from '../index.js';
import { applyFlagsHold, applyReviewed, emit, enterpriseOptions, ORGANIZATION_OPTIONS, ORGANIZATION_USAGE, parseCommand, PRIVATE_INPUT_OPTION, privateInputsOption,
  progressLine, readDocument, readResolutions, refusal, RESOLUTIONS_OPTION, RESOLUTIONS_UNREADABLE, usageRefusal } from './common.js';
import { catalogNode, catalogReader } from './install.js';
import type { PlanControls, PlanRequest } from '../plan/types.js';
import type { ChangeControls } from '../change/prepare.js';

const USAGE = `aih update <plan-request.json | change-request.json> --scope project|user [--project <path>] [--management-id <id>]... [--source <sourceId>=<folder>]... [--material-root <id>=<folder>]... [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--private-input <name>=<ENV>]... ${ORGANIZATION_USAGE} [--no-log] [--json]\n`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const parsed = parseCommand(args, 'update', USAGE, { project: { type: 'string' }, scope: { type: 'string' }, 'management-id': { type: 'string', multiple: true },
    source: { type: 'string', multiple: true }, 'material-root': { type: 'string', multiple: true }, ...RESOLUTIONS_OPTION, ...PRIVATE_INPUT_OPTION,
    ...ORGANIZATION_OPTIONS });
  if (!parsed) return;
  const { output, values, positionals } = parsed;
  const enterprise = enterpriseOptions(output, USAGE, values);
  if (!enterprise) return;
  if (positionals.length !== 1 || values.scope === undefined) return usageRefusal(output, USAGE, 'Name exactly one request file and `--scope`.');
  if (!applyFlagsHold(output, USAGE, values)) return;
  let request: PlanRequest & { changes?: unknown };
  try { request = readDocument(positionals[0]!, 16 * 1_048_576) as unknown as PlanRequest; }
  catch { return emit(output, refusal('request-unreadable', 'The request file could not be read as strict JSON.'), 2); }
  if (enterprise.mode) (request as { mode?: string }).mode = enterprise.mode;
  const change = typeof request.schema === 'string' && request.schema.startsWith('urn:aihq:core:change-request:');
  const project = values.project === undefined ? undefined : isAbsolute(values.project) ? values.project : resolve(values.project);
  if (project !== undefined) request.target = { ...(request.target && typeof request.target === 'object' ? request.target : {}), project };
  if (values.resolutions !== undefined) {
    const resolutions = readResolutions(values.resolutions);
    if (!resolutions) return emit(output, refusal('request-unreadable', RESOLUTIONS_UNREADABLE), 2);
    request.resolutions = resolutions as PlanRequest['resolutions'];
  }
  if (values['management-id']?.some(id => !ID.test(id))) return emit(output, refusal('usage', '`--management-id` names a management id.'), 2);
  const privateInputs = privateInputsOption(output, values['private-input'], '<name>.<input>=<ENV>');
  if (!privateInputs) return;
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
  Object.assign(controls, { ...(enterprise.organization ? { organization: enterprise.organization } : {}), ...(enterprise.authentication ? { authentication: enterprise.authentication } : {}) });
  const managementIds = values['management-id'];
  const preparation = await prepareUpdate({ target: project ? { project } : {}, scope: values.scope as 'project' | 'user',
    updates: [{ ...(managementIds?.length ? { managementIds } : {}), request: request as never }] }, controls);
  await applyReviewed(output, preparation, values, signal, controls);
}
