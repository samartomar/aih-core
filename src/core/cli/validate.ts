// aih validate <change|change-request|organization|plan-request> <file> [--json]      (contract 22)
// Reads one 0.1.0 document read-only: exit 0 for `ok`, 2 for `invalid` or `unsupported-version`.
import { parseArgs } from 'node:util';
import { validateChange } from '../change/validate.js';
import { validateFormat } from '../plan/formats.js';
import { CHANGE_REQUEST } from '../change/validate.js';
import { emit, readDocument, refusal } from './common.js';
import { validateOrganization } from '../enterprise/organization.js';

export const kinds = ['change', 'change-request', 'organization', 'plan-request'];
const PLAN_REQUEST = 'urn:aihq:core:plan-request:0.1.0';
const USAGE = 'aih validate <change|change-request|organization|plan-request> <file> [--json]\n';

export async function run(args: string[]): Promise<void> {
  const output = { json: args.includes('--json') };
  let parsed;
  try { parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: 'boolean' } } }); }
  catch { process.stderr.write(USAGE); return emit(output, refusal('usage', 'The validate options are not valid.'), 2); }
  const [kind, file, ...rest] = parsed.positionals;
  if (!kind || !kinds.includes(kind) || !file || rest.length) { process.stderr.write(USAGE); return emit(output, refusal('usage', 'Name the kind and one file.'), 2); }
  let document: Record<string, unknown>;
  try { document = readDocument(file, kind === 'change-request' || kind === 'plan-request' ? 16 * 1_048_576 : 1_000_000); }
  catch { return emit(output, refusal('request-unreadable', 'The file could not be read as strict JSON.'), 2); }
  let result: { status: string; [field: string]: unknown };
  if (kind === 'change') result = validateChange(document);
  else if (kind === 'organization') result = validateOrganization(document);
  else if (kind === 'plan-request') result = typeof document.schema === 'string' && document.schema !== PLAN_REQUEST ?
    { status: 'unsupported-version', encountered: document.schema, supported: [PLAN_REQUEST] } : validateFormat(document);
  else if (typeof document.schema === 'string' && document.schema !== CHANGE_REQUEST)
    result = { status: 'unsupported-version', encountered: document.schema, supported: [CHANGE_REQUEST] };
  else {
    result = validateFormat(document);
    // Each inline change is read with its own semantic rules too.
    if (result.status === 'ok' && Array.isArray(document.changes)) {
      const problems = (document.changes as { change?: unknown }[]).flatMap((entry, index) => {
        if (!entry.change) return [];
        const read = validateChange(entry.change);
        return read.status === 'ok' ? [] : read.status === 'invalid' ? read.problems.map(problem => ({ ...problem, path: `/changes/${index}/change${problem.path}` })) :
          [{ path: `/changes/${index}/change/schema`, reason: 'unsupported-version', message: `\`${read.encountered}\` is not a change format this Core reads.` }];
      });
      if (problems.length) result = { status: 'invalid', problems };
    }
  }
  emit(output, result, result.status === 'ok' ? 0 : 2);
}
