// aih remove <managementId>... --scope project|user [--project <path>] [--item <item-id>] [--resolutions <file>] [--origin chosen]
//            [--cli <id>]... [--apply [--yes] [--allow-partial]] [--private-input <item>.<input>=<ENV>]... [--no-log] [--json]      (contract 22)
import { isAbsolute, resolve } from 'node:path';
import { prepareRemoval } from '../index.js';
import { applyReviewed, emit, enterpriseOptions, ORGANIZATION_OPTIONS, ORGANIZATION_USAGE, parseCommand, PRIVATE_INPUT_OPTION, privateInputsOption, progressLine,
  readResolutions, refusal, RESOLUTIONS_OPTION, RESOLUTIONS_UNREADABLE, usageRefusal } from './common.js';
import type { PlanControls } from '../plan/types.js';

const USAGE = `aih remove <managementId>... --scope project|user [--project <path>] [--item <item-id>] [--resolutions <file>] [--origin chosen] [--cli <id>]... [--apply [--yes] [--allow-partial]] [--private-input <item>.<input>=<ENV>]... ${ORGANIZATION_USAGE} [--no-log] [--json]\n`;

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const parsed = parseCommand(args, 'remove', USAGE, { project: { type: 'string' }, scope: { type: 'string' }, item: { type: 'string' },
    origin: { type: 'string' }, cli: { type: 'string', multiple: true }, ...RESOLUTIONS_OPTION, ...PRIVATE_INPUT_OPTION, ...ORGANIZATION_OPTIONS });
  if (!parsed) return;
  const { output, values, positionals } = parsed;
  const enterprise = enterpriseOptions(output, USAGE, values);
  if (!enterprise) return;
  if (!positionals.length || values.scope === undefined) return usageRefusal(output, USAGE, 'Name the management ids and `--scope`.');
  const project = values.project === undefined ? undefined : isAbsolute(values.project) ? values.project : resolve(values.project);
  const removals = positionals.map(managementId => ({ managementId, ...(values.item ? { item: values.item } : {}),
    ...(values.origin ? { origin: values.origin } : {}), ...(values.cli?.length ? { clis: values.cli } : {}) }));
  // A one-item entry's choice (`remove-plugin`, `switch-off`) is a resolution for a second preparation (contract 7, 12).
  const resolutions = values.resolutions === undefined ? undefined : readResolutions(values.resolutions);
  if (values.resolutions !== undefined && !resolutions) return emit(output, refusal('request-unreadable', RESOLUTIONS_UNREADABLE), 2);
  const privateInputs = privateInputsOption(output, values['private-input']);
  if (!privateInputs) return;
  const controls: PlanControls = { signal, onProgress: progressLine, ...(values['no-log'] ? { logging: 'off' as const } : {}), ...(Object.keys(privateInputs).length ? { privateInputs } : {}),
    ...(enterprise.organization ? { organization: enterprise.organization } : {}), ...(enterprise.authentication ? { authentication: enterprise.authentication } : {}) };
  const preparation = await prepareRemoval({ target: project ? { project } : {}, scope: values.scope, removals, ...(resolutions ? { resolutions } : {}), ...(enterprise.mode ? { mode: enterprise.mode } : {}) }, controls);
  await applyReviewed(output, preparation, values, signal, controls);
}
