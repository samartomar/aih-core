// aih change <change-request.json> [--project <path>] [--material-root <id>=<folder>]... [--private-input <managementId>.<input>=<ENV>]...
//            [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--no-log] [--json]      (contract 22)
// The project is never taken from the working folder. A secret value is read only from the named environment variable.
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { apply, prepare } from '../index.js';
import { approved, emit, exitCode, organizationFrom, ORGANIZATION_OPTIONS, ORGANIZATION_USAGE, printable, readDocument, refusal } from './common.js';
import type { ChangeControls, ChangeRequest } from '../change/prepare.js';

const USAGE = `aih change <change-request.json> [--project <path>] [--material-root <id>=<folder>]... [--private-input <managementId>.<input>=<ENV>]... [--resolutions <file>] [--apply [--yes] [--allow-partial]] ${ORGANIZATION_USAGE} [--no-log] [--json]\n`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      project: { type: 'string' }, 'material-root': { type: 'string', multiple: true }, 'private-input': { type: 'string', multiple: true },
      resolutions: { type: 'string' }, apply: { type: 'boolean' }, yes: { type: 'boolean' }, 'allow-partial': { type: 'boolean' },
      'no-log': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, ...ORGANIZATION_OPTIONS } });
  } catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The change options are not valid.'), 2); }
  const enterprise = organizationFrom(parsed.values);
  if (enterprise === 'usage') { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The Enterprise options name `--mode enterprise` and one organization source.'), 2); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(USAGE); return; }
  if (positionals.length !== 1) { process.stderr.write(USAGE); return emit(output, refusal('usage', 'Name exactly one change request file.'), 2); }
  if ((values.yes || values['allow-partial']) && !values.apply) { process.stderr.write(USAGE); return emit(output, refusal('usage', '`--yes` and `--allow-partial` need `--apply`.'), 2); }
  let request: ChangeRequest;
  try { request = readDocument(positionals[0]!, 16 * 1_048_576) as unknown as ChangeRequest; }
  catch { return emit(output, refusal('request-unreadable', 'The change request file could not be read as strict JSON.'), 2); }
  if (values.project !== undefined) request.target = { ...(request.target ?? {}), project: isAbsolute(values.project) ? values.project : resolve(values.project) };
  if (values.resolutions !== undefined) {
    try {
      const document = readDocument(values.resolutions, 1_000_000);
      if (Object.keys(document).length !== 1 || !Array.isArray(document.resolutions)) throw new Error('resolutions');
      request.resolutions = document.resolutions as ChangeRequest['resolutions'];
    } catch { return emit(output, refusal('request-unreadable', 'The resolutions file holds `{ "resolutions": [...] }`.'), 2); }
  }
  if (enterprise.mode) request.mode = enterprise.mode;
  const controls: ChangeControls = { signal, ...(values['no-log'] ? { logging: 'off' as const } : {}), ...(enterprise.organization ? { organization: enterprise.organization } : {}), ...(enterprise.authentication ? { authentication: enterprise.authentication } : {}) };
  if (values['material-root']?.length) {
    const roots: Record<string, string> = Object.create(null);
    for (const spec of values['material-root']) {
      const at = spec.indexOf('=');
      const id = spec.slice(0, at), folder = spec.slice(at + 1);
      if (at < 1 || !ID.test(id) || !folder || Object.hasOwn(roots, id)) return emit(output, refusal('usage', '`--material-root` is `<id>=<folder>`, once per id.'), 2);
      roots[id] = isAbsolute(folder) ? folder : resolve(folder);
    }
    controls.materialRoots = roots;
  }
  if (values['private-input']?.length) {
    const inputs: Record<string, Record<string, string>> = Object.create(null);
    for (const mapping of values['private-input']) {
      // `<managementId>.<input>=<ENV>`; a dot inside either id is written `%2E`.
      const match = /^([A-Za-z0-9][A-Za-z0-9_%-]*)\.([A-Za-z0-9][A-Za-z0-9_%-]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(mapping);
      let managementId = '', input = '';
      try { managementId = decodeURIComponent(match?.[1] ?? ''); input = decodeURIComponent(match?.[2] ?? ''); } catch { /* reported below */ }
      if (!match || !ID.test(managementId) || !ID.test(input) || process.env[match[3]!] === undefined || Object.hasOwn(inputs[managementId] ?? {}, input))
        return emit(output, refusal('usage', '`--private-input` is `<managementId>.<input>=<ENV>` naming a set environment variable.'), 2);
      (inputs[managementId] ??= Object.create(null))[input] = process.env[match[3]!]!;
    }
    controls.privateInputs = inputs;
  }
  const preparation = await prepare(request, controls);
  if (!values.apply || !('handle' in preparation) || !preparation.handle)
    return emit(output, 'review' in preparation ? printable(preparation) : preparation, exitCode(preparation));
  if (!await approved(preparation.review, values.yes === true, signal))
    return emit(output, refusal('approval-required', 'Apply needs `--yes` or an interactive yes.'), 2);
  const result = await apply(preparation.handle, { approved: true, origin: values.yes ? 'automation' : 'interactive',
    reviewDigest: preparation.review.reviewDigest, ...(values['allow-partial'] ? { allowPartial: true } : {}) }, controls);
  emit(output, result, exitCode(result));
}
