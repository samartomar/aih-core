// aih report --output <new-directory> [--target <id>]... [--offline] [--json]
// aih report --output <new-directory> --snapshot <report.json> [--json]                         (contract 22)
// Writes one `urn:aihq:core:report:0.1.0` report.json only; the consuming application renders it.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readRegularFile } from '../internal/fsxn.js';
import { emit, refusal } from './common.js';

const USAGE = 'aih report --output <new-directory> [--target <id>]... [--offline] [--json]\n' +
  'aih report --output <new-directory> --snapshot <report.json> [--json]\n';

export async function run(args: string[], signal: AbortSignal): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: false, strict: true, options: { output: { type: 'string' }, snapshot: { type: 'string' },
      target: { type: 'string', multiple: true }, offline: { type: 'boolean' }, json: { type: 'boolean' } } });
  } catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The report options are not valid.'), 2); }
  const { values } = parsed;
  if (!values.output || values.snapshot !== undefined && (values.target || values.offline)) {
    process.stderr.write(USAGE);
    return emit(output, refusal('usage', 'Choose one new output directory and either fresh offline targets or one supplied report.'), 2);
  }
  let snapshotJson: string | undefined;
  if (values.snapshot !== undefined) {
    const bytes = readRegularFile(resolve(values.snapshot), { maxBytes: 1_000_000 });
    if (!bytes) return emit(output, refusal('request-unreadable', 'The supplied report could not be read.'), 2);
    try { snapshotJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return emit(output, refusal('request-unreadable', 'The supplied report is not UTF-8 text.'), 2); }
  }
  const { runReportCommand, ReportCommandError } = await import('../../harness/report-command.mjs');
  try {
    emit(output, await runReportCommand({ output: values.output, format: '0.1.0', ...(snapshotJson === undefined ? {} : { snapshotJson }),
      ...(values.target === undefined ? {} : { targets: values.target }) }, { signal }), 0);
  } catch (error) {
    if (!(error instanceof ReportCommandError)) throw error;
    if (error.code === 'INCOMPLETE') return emit(output, { status: 'refused', code: 'output-unavailable', reason: error.reason }, 1);
    emit(output, error.code === 'CANCELLED' ? refusal('cancelled', 'The report was cancelled.') : refusal('usage', error.reason), error.code === 'CANCELLED' ? 130 : 2);
  }
}
