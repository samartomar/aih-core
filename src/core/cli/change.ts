// aih change <change-request.json> [--project <path>] [--material-root <id>=<folder>]... [--private-input <managementId>.<input>=<ENV>]...
//            [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--no-log] [--json]      (contract 22)
// The project is never taken from the working folder. A secret value is read only from the named environment variable.
import { isAbsolute, resolve } from 'node:path';
import { prepare } from '../index.js';
import { applyFlagsHold, applyReviewed, emit, enterpriseOptions, ORGANIZATION_OPTIONS, ORGANIZATION_USAGE, parseCommand, PRIVATE_INPUT_OPTION, readDocument,
  readResolutions, refusal, RESOLUTIONS_OPTION, RESOLUTIONS_UNREADABLE, usageRefusal } from './common.js';
import type { ChangeControls, ChangeRequest } from '../change/prepare.js';

const USAGE = `aih change <change-request.json> [--project <path>] [--material-root <id>=<folder>]... [--private-input <managementId>.<input>=<ENV>]... [--resolutions <file>] [--apply [--yes] [--allow-partial]] ${ORGANIZATION_USAGE} [--no-log] [--json]\n`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const parsed = parseCommand(args, 'change', USAGE, { project: { type: 'string' }, 'material-root': { type: 'string', multiple: true },
    ...PRIVATE_INPUT_OPTION, ...RESOLUTIONS_OPTION, ...ORGANIZATION_OPTIONS });
  if (!parsed) return;
  const { output, values, positionals } = parsed;
  const enterprise = enterpriseOptions(output, USAGE, values);
  if (!enterprise) return;
  if (positionals.length !== 1) return usageRefusal(output, USAGE, 'Name exactly one change request file.');
  if (!applyFlagsHold(output, USAGE, values)) return;
  let request: ChangeRequest;
  try { request = readDocument(positionals[0]!, 16 * 1_048_576) as unknown as ChangeRequest; }
  catch { return emit(output, refusal('request-unreadable', 'The change request file could not be read as strict JSON.'), 2); }
  if (values.project !== undefined) request.target = { ...(request.target ?? {}), project: isAbsolute(values.project) ? values.project : resolve(values.project) };
  if (values.resolutions !== undefined) {
    const resolutions = readResolutions(values.resolutions);
    if (!resolutions) return emit(output, refusal('request-unreadable', RESOLUTIONS_UNREADABLE), 2);
    request.resolutions = resolutions as ChangeRequest['resolutions'];
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
  await applyReviewed(output, await prepare(request, controls), values, signal, controls);
}
