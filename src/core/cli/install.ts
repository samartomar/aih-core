// aih install <plan-request.json> [--project <path>] [--source <sourceId>=<folder>]... [--artifacts <dir>] [--resolutions <file>]
//             [--apply [--yes] [--allow-partial]] [--private-input <item>.<input>=<ENV>]... [--no-log] [--json]      (contract 22)
// Source bytes are read with `readLocalSource` from the Catalog installed beside this CLI; without it, `--source` is
// refused `catalog-required`. Its `/reader` (`renderStep`, `planRecipe`) is passed as `controls.catalog` for render
// steps and recipe proofs. The project is never taken from the working folder.
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegularFile } from '../internal/fsxn.js';
import { parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import { prepare } from '../index.js';
import { ARTIFACTS_OPTION, ARTIFACTS_USAGE, artifactsControl, applyReviewed, emit, enterpriseOptions, ORGANIZATION_OPTIONS, ORGANIZATION_USAGE, parseCommand, PRIVATE_INPUT_OPTION, privateInputsOption, progressLine,
  readDocument, readResolutions, refusal, RESOLUTIONS_OPTION, RESOLUTIONS_UNREADABLE, usageRefusal } from './common.js';
import type { CatalogControls, PlanControls, PlanRequest } from '../plan/types.js';

const USAGE = `aih install <plan-request.json> [--project <path>] [--source <sourceId>=<folder>]... ${ARTIFACTS_USAGE} [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--private-input <item>.<input>=<ENV>]... ${ORGANIZATION_USAGE} [--no-log] [--json]\n`;
interface LocalSource { status: string; files?: { path: string; bytes?: Uint8Array }[] }

export async function catalogNode(): Promise<{ readLocalSource(path: string): Promise<LocalSource> | LocalSource } | undefined> {
  try {
    const specifier = '@aihq/catalog/node';
    const module = await import(specifier) as { readLocalSource?: unknown };
    return typeof module.readLocalSource === 'function' ? module as never : undefined;
  } catch { return undefined; }
}

/**
 * The Catalog reader installed beside this CLI, as `controls.catalog` (C51): its `renderStep` and `planRecipe`, and the
 * version from that package's own `package.json`. Absent, unreadable or without a version, none is passed, and a plan
 * that needs one is refused `catalog-required` by Prepare.
 */
export async function catalogReader(): Promise<CatalogControls | undefined> {
  try {
    const specifier = '@aihq/catalog/reader';
    const module = await import(specifier) as { renderStep?: unknown; planRecipe?: unknown };
    if (typeof module.renderStep !== 'function' && typeof module.planRecipe !== 'function') return undefined;
    let folder = dirname(fileURLToPath(import.meta.resolve(specifier)));
    for (let depth = 0; depth < 16; depth += 1, folder = dirname(folder)) {
      const bytes = readRegularFile(join(folder, 'package.json'), { maxBytes: 1_000_000 });
      if (!bytes) { if (dirname(folder) === folder) break; continue; }
      const manifest = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'package.json');
      if (manifest.name !== '@aihq/catalog') { if (dirname(folder) === folder) break; continue; }
      if (typeof manifest.version !== 'string' || !manifest.version || manifest.version.length > 64) return undefined;
      return { version: manifest.version,
        ...(typeof module.renderStep === 'function' ? { renderStep: module.renderStep as CatalogControls['renderStep'] } : {}),
        ...(typeof module.planRecipe === 'function' ? { planRecipe: module.planRecipe as CatalogControls['planRecipe'] } : {}) };
    }
    return undefined;
  } catch { return undefined; }
}

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const parsed = parseCommand(args, 'install', USAGE, { project: { type: 'string' }, source: { type: 'string', multiple: true },
    ...RESOLUTIONS_OPTION, ...PRIVATE_INPUT_OPTION, ...ORGANIZATION_OPTIONS, ...ARTIFACTS_OPTION });
  if (!parsed) return;
  const { output, values, positionals } = parsed;
  const enterprise = enterpriseOptions(output, USAGE, values);
  if (!enterprise) return;
  if (positionals.length !== 1) return usageRefusal(output, USAGE, 'Name exactly one plan request file.');
  let request: PlanRequest;
  try { request = readDocument(positionals[0]!, 16 * 1_048_576) as unknown as PlanRequest; }
  catch { return emit(output, refusal('request-unreadable', 'The plan request file could not be read as strict JSON.'), 2); }
  if (enterprise.mode) request.mode = enterprise.mode;
  if (values.project !== undefined) {
    if (!request.target || typeof request.target !== 'object') request.target = {};
    request.target = { ...request.target, project: isAbsolute(values.project) ? values.project : resolve(values.project) };
  }
  if (values.resolutions !== undefined) {
    const resolutions = readResolutions(values.resolutions);
    if (!resolutions) return emit(output, refusal('request-unreadable', RESOLUTIONS_UNREADABLE), 2);
    request.resolutions = resolutions as PlanRequest['resolutions'];
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
  const catalog = await catalogReader();
  const privateInputs = privateInputsOption(output, values['private-input']);
  if (!privateInputs) return;
  const controls: PlanControls = { signal, onProgress: progressLine, ...(values['no-log'] ? { logging: 'off' as const } : {}), ...(Object.keys(privateInputs).length ? { privateInputs } : {}), ...(catalog ? { catalog } : {}),
    ...artifactsControl(values.artifacts), ...(enterprise.organization ? { organization: enterprise.organization } : {}), ...(enterprise.authentication ? { authentication: enterprise.authentication } : {}) };
  await applyReviewed(output, await prepare(request, controls), values, signal, controls);
}
