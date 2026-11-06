// aih list [--project <path>] [--scope project|user|both] [--json]      (contract 22)
// Without --project only user scope can be listed; the project is never taken from the working folder.
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { list } from '../index.js';
import { emit, exitCode, refusal } from './common.js';

const USAGE = 'aih list [--project <path>] [--scope project|user|both] [--json]\n';

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: false, strict: true, options: {
      project: { type: 'string' }, scope: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The list options are not valid.'), 2); }
  const { values } = parsed;
  if (values.help) { process.stdout.write(USAGE); return; }
  const project = values.project === undefined ? undefined : isAbsolute(values.project) ? values.project : resolve(values.project);
  const scope = values.scope ?? (project ? 'both' : 'user');
  const result = await list({ target: project ? { project } : {}, scope }, { signal });
  emit(output, result, exitCode(result));
}
