// aih inspect [--target <id>]... [--offline] [--profiles <folder>] [--json]      (contract 10, 22, D110)
// `--profiles` reads every `*.json` file directly in the folder as one Catalog tool profile document.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspect } from '../index.js';
import { emit, readDocument, refusal } from './common.js';

const USAGE = 'aih inspect [--target <id>]... [--offline] [--profiles <folder>] [--json]\n';
const PROFILE_BYTES = 1_000_000;

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: false, strict: true, options: {
      target: { type: 'string', multiple: true }, offline: { type: 'boolean' }, profiles: { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The inspect options are not valid.'), 2); }
  const { values } = parsed;
  if (values.help) { process.stdout.write(USAGE); return; }
  let profiles: unknown[] | undefined;
  if (values.profiles !== undefined) {
    const folder = resolve(values.profiles);
    try {
      const names = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name).sort();
      if (names.length > 256) throw new Error('too-many');
      profiles = names.map(name => readDocument(join(folder, name), PROFILE_BYTES));
    } catch { return emit(output, refusal('request-unreadable', 'The profiles folder could not be read as strict JSON profile files.'), 2); }
  }
  const result = await inspect({ ...(values.target ? { target: values.target } : {}), ...(values.offline ? { offline: true } : {}),
    ...(profiles ? { profiles } : {}) }, { signal });
  emit(output, result, result.status === 'ok' ? result.observation === 'cancelled' ? 130 : 0 : 2);
}
