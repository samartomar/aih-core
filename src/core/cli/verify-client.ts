// aih verify-client <tool> (contract 3, 14.1, 22): explicit native verification of one tool, as a
// `native-verification-result:0.1.0`. The tool is named by registry id or alias; its own parsing keeps
// verification's closed options separate from repair authority.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readRegularFileWithStats } from '../internal/fsxn.js';
import { parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import { invalidNativeResult } from '../internal/native-result.js';
import { findTool } from '../../harness/tool-registry.mjs';
import { verifyClient, NATIVE_VERIFICATION_REQUEST, NATIVE_VERIFICATION_RESULT, type NativeVerificationControls010,
  type NativeVerificationResult010 } from '../verify-client.js';

const usage = 'aih verify-client <tool> [--configuration <request-json-file>]\n' +
  '  [--host-bindings <host-json-file>] [--sandbox-root <absolute-path>]\n' +
  '  [--budget-ms <1000..600000>] [--max-turns <total-turns>]\n' +
  '  [--max-estimated-cost-usd <total-usd>] [--candidate-smoke] [--json]\n' +
  'The tool is a registry id or alias. Both finite limits are required to launch. Estimated cost can overshoot; it is not a billing cap.\n';
const examples = 'Examples:\n  aih verify-client claude-code --json\n' +
  '  aih verify-client claude-code --candidate-smoke --host-bindings dedicated-test.json --json\n';
const diagnostic = (reason: string) => ({ code: 'INPUT_INVALID', reason,
  message: 'Choose a supported client and explicit bounded verification inputs.' });

function readInput(file: string): Record<string, unknown> {
  const captured = readRegularFileWithStats(resolve(file), { maxBytes: 65_536 });
  if (!captured || captured.identity.nlink !== 1n) throw new Error('strict-json');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(captured.contents);
  return parseStrictJsonObjectV1(text, 'native verification input') as Record<string, unknown>;
}
/** A CLI parse failure, in the 0.1.0 result shape; caller-authored text is never echoed. */
function invalid(reason: string, controls: NativeVerificationControls010): NativeVerificationResult010 {
  const { schema: _schema, package: distribution, status: _status, ...rest } = invalidNativeResult([diagnostic(reason)], undefined, controls);
  return { schema: NATIVE_VERIFICATION_RESULT, package: distribution, status: 'invalid', completion: null, ...rest };
}
/** Exit codes (14.1): 2 refused or invalid, 130 cancelled, 0 only a complete verified check, otherwise 1. */
function emit(result: NativeVerificationResult010, json: boolean): void {
  process.exitCode = result.status !== 'ok' ? 2 : result.completion === 'cancelled' ? 130 :
    result.completion === 'complete' && result.verdict === 'verified' ? 0 : 1;
  if (json) { process.stdout.write(JSON.stringify(result) + '\n'); return; }
  const lines = [result.status === 'refused' ? `Native verification: refused/${result.code}: ${result.reason}`
    : `Native verification: ${result.status}${result.completion ? `/${result.completion}` : ''}/${result.verdict}`,
  `Tool: ${result.client.id ?? 'unknown'}; proof scope: ${result.proofScope}; admission: ${result.admission}`,
  `Isolation: ${result.security.sandbox.level}; host secrets: ${result.security.hostSecretIsolation.outcome}`];
  for (const stage of [...result.stages, ...result.sessions.flatMap(session => session.stages)])
    lines.push(`${stage.id}${stage.session === null ? '' : ` (session ${stage.session})`}: ${stage.outcome}/${stage.reason}`);
  for (const item of result.diagnostics) lines.push(`${item.code}/${item.reason}: ${item.message}`);
  lines.push(result.stages.some(stage => stage.outcome === 'restricted') ||
    result.sessions.some(session => session.stages.some(stage => stage.outcome === 'restricted')) ?
    'Ask IT or your administrator to review the effective managed restriction.' :
    'Review the selected configuration, dedicated test identity and supported native cell prerequisites.');
  process.stdout.write(lines.join('\n') + '\n');
}

export async function run(argv: string[], signal: AbortSignal): Promise<void> {
  let json = argv.includes('--json');
  let controls: NativeVerificationControls010 = { signal };
  let reason = 'request-field';
  try {
    const args = [...argv];
    for (let index = 0; index < args.length; index++) if (['--budget-ms', '--max-turns', '--max-estimated-cost-usd'].includes(args[index]!) && /^-\d/.test(args[index + 1] ?? '')) {
      args[index] = `${args[index]}=${args[index + 1]}`; args.splice(index + 1, 1);
    }
    const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, strict: true, tokens: true,
      options: { configuration: { type: 'string' }, 'host-bindings': { type: 'string' },
        'sandbox-root': { type: 'string' }, 'budget-ms': { type: 'string' }, 'max-turns': { type: 'string' }, 'max-estimated-cost-usd': { type: 'string' },
        'candidate-smoke': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    json = values.json ?? false;
    const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error('duplicate flag');
    if (values.help) {
      if (positionals.length > 1 || Object.keys(values).some(key => !['help', 'json'].includes(key)))
        throw new Error('conflicting help');
      process.stdout.write(usage + examples); process.exitCode = 0; return;
    }
    if (positionals.length !== 1) throw new Error('client required');
    // An alias selects its tool; an unknown name goes through as asked and is refused `tool-unknown`.
    const tool = findTool(positionals[0])?.tool.id ?? positionals[0]!;
    let request: Record<string, unknown> = { schema: NATIVE_VERIFICATION_REQUEST, client: tool };
    if (values['candidate-smoke']) controls.admission = 'candidate-smoke';
    if (values['sandbox-root'] !== undefined) controls.sandboxRoot = values['sandbox-root'];
    if (values['budget-ms'] !== undefined) {
      controls.budgetMs = /^[0-9]+$/.test(values['budget-ms']) ? Number(values['budget-ms']) : NaN;
    }
    if (values['max-turns'] !== undefined)
      controls.maxTurns = /^[0-9]+$/.test(values['max-turns']) ? Number(values['max-turns']) : NaN;
    if (values['max-estimated-cost-usd'] !== undefined)
      controls.maxEstimatedCostUsd = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(values['max-estimated-cost-usd']) ? Number(values['max-estimated-cost-usd']) : NaN;
    reason = 'strict-json';
    if (values.configuration !== undefined) {
      request = readInput(values.configuration);
      if (request.client !== tool) { reason = 'client-id'; throw new Error('client mismatch'); }
    }
    if (values['host-bindings'] !== undefined) {
      const bindings = readInput(values['host-bindings']);
      if (Object.keys(bindings).some(key => !['testIdentity', 'configurationSources'].includes(key))) {
        reason = 'controls-field'; throw new Error('host bindings');
      }
      controls = { ...controls, ...bindings };
    }
    emit(await verifyClient(request, controls), json);
  } catch {
    emit(invalid(reason, controls), json);
  }
}
