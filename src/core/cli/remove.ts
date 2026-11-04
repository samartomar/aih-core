// aih remove <managementId>... --scope project|user [--project <path>] [--item <item-id> [--switch-off]] [--origin chosen]
//            [--cli <id>]... [--apply [--yes] [--allow-partial]] [--no-log] [--json]      (contract 22)
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { apply, prepareRemoval } from '../index.js';
import { approved, emit, exitCode, printable, progressLine, refusal } from './common.js';
import type { PlanControls } from '../plan/types.js';

const USAGE = 'aih remove <managementId>... --scope project|user [--project <path>] [--item <item-id> [--switch-off]] [--origin chosen] [--cli <id>]... [--apply [--yes] [--allow-partial]] [--no-log] [--json]\n';

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      project: { type: 'string' }, scope: { type: 'string' }, item: { type: 'string' }, 'switch-off': { type: 'boolean' }, origin: { type: 'string' },
      cli: { type: 'string', multiple: true }, apply: { type: 'boolean' }, yes: { type: 'boolean' },
      'allow-partial': { type: 'boolean' }, 'no-log': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The remove options are not valid.'), 2); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(USAGE); return; }
  if (!positionals.length || values.scope === undefined) { process.stderr.write(USAGE); return emit(output, refusal('usage', 'Name the management ids and `--scope`.'), 2); }
  if (values['switch-off'] && !values.item) { process.stderr.write(USAGE); return emit(output, refusal('usage', '`--switch-off` needs `--item`.'), 2); }
  const project = values.project === undefined ? undefined : isAbsolute(values.project) ? values.project : resolve(values.project);
  const removals = positionals.map(managementId => ({ managementId, ...(values.item ? { item: values.item } : {}), ...(values['switch-off'] ? { switchOff: true as const } : {}),
    ...(values.origin ? { origin: values.origin } : {}), ...(values.cli?.length ? { clis: values.cli } : {}) }));
  const controls: PlanControls = { signal, onProgress: progressLine, ...(values['no-log'] ? { logging: 'off' as const } : {}) };
  const preparation = await prepareRemoval({ target: project ? { project } : {}, scope: values.scope, removals }, controls);
  if (!values.apply || !('handle' in preparation) || !preparation.handle || !preparation.review)
    return emit(output, 'handle' in preparation ? printable(preparation) : preparation, exitCode(preparation));
  if (!await approved(preparation.review, values.yes === true, signal))
    return emit(output, refusal('approval-required', 'Apply needs `--yes` or an interactive yes.'), 2);
  const result = await apply(preparation.handle, { approved: true, origin: values.yes ? 'automation' : 'interactive',
    reviewDigest: preparation.review.reviewDigest, ...(values['allow-partial'] ? { allowPartial: true } : {}) }, controls);
  emit(output, result, exitCode(result));
}
