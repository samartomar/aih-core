// aih inspect [--target <id>]... [--offline] [--profiles <folder>] [--support-markdown <path>] [--json]
// (contract 10, 22, D110). `--profiles` reads every `*.json` file directly in the folder as one Catalog tool profile
// document. Without `--json`, the human next actions derived from the result go to stderr; stdout keeps the result.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspect } from '../index.js';
import { getGuidance } from '../support.js';
import { writeSupportReport } from '../support-report.js';
import { formatGuidanceText } from '../internal/guidance-text.js';
import { emit, readDocument, refusal } from './common.js';

const USAGE = 'aih inspect [--target <id>]... [--offline] [--profiles <folder>] [--support-markdown <path>] [--json]\n';
const PROFILE_BYTES = 1_000_000;
const platform = process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'unknown';
/** Printed paths never carry control, line-separator or bidirectional formatting characters into the terminal. */
const unprintable = (code: number): boolean => code <= 0x1f || code >= 0x7f && code <= 0x9f || code === 0x2028 || code === 0x2029 ||
  code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
const printablePath = (value: string): string => [...value].map(char => unprintable(char.codePointAt(0)!) ?
  '\\u' + char.codePointAt(0)!.toString(16).padStart(4, '0') : char).join('');

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: false, strict: true, options: {
      target: { type: 'string', multiple: true }, offline: { type: 'boolean' }, profiles: { type: 'string' },
      'support-markdown': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch {
    // A requested support report is never written for a refused command line.
    process.stderr.write(args.some(arg => /^--support-markdown(?:=|$)/.test(arg)) ? 'Support report not written: input-rejected\n' : USAGE);
    return emit(output, refusal('usage', 'The inspect options are not valid.'), 2);
  }
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
  const code = result.status === 'ok' ? result.observation === 'cancelled' ? 130 : 0 : 2;
  emit(output, result, code);
  if (result.status !== 'ok') return;
  if (!output.json) {
    try {
      const guidance = getGuidance({ kind: 'inspect', result }, { platform });
      const text = guidance.status === 'complete' ? formatGuidanceText(guidance.items) : '';
      if (text) process.stderr.write(text);
    } catch { /* Guidance never changes the result. */ }
  }
  const target = values['support-markdown'];
  if (target === undefined) return;
  const fail = (reason: string) => { process.stderr.write(`Support report not written: ${reason}\n`); if (code === 0) process.exitCode = 1; };
  if (signal.aborted || result.observation === 'cancelled') return fail('cancelled');
  try {
    const report = await writeSupportReport({ kind: 'inspect', result }, { platform, path: resolve(target), signal });
    if (report.status === 'written' && report.path) process.stderr.write(`Support report written: ${printablePath(report.path)}\n`);
    else fail(report.diagnostics[0]?.reason ?? report.status);
  } catch { fail('failed'); }
}
