import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readRegularFileWithStats } from './internal/fsxn.js';
import { parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { verifyNativeClient, invalidNativeVerificationResult, type NativeVerificationControls } from './native-verification.js';
import type { NativeVerificationResult } from './native-contracts.js';

const usage = 'aih verify-client <client-id> [--configuration <request-json-file>]\n' +
  '  [--host-bindings <host-json-file>] [--sandbox-root <absolute-path>]\n' +
  '  [--budget-ms <1000..600000>] [--candidate-smoke] [--json]\n';
const examples = 'Examples:\n  aih verify-client claude --json\n' +
  '  aih verify-client claude --candidate-smoke --host-bindings dedicated-test.json --json\n';
const diagnostic = (reason: string) => ({ code: 'INPUT_INVALID', reason,
  message: 'Choose a supported client and explicit bounded verification inputs.' });

function readInput(file: string): Record<string, unknown> {
  const captured = readRegularFileWithStats(resolve(file), { maxBytes: 65_536 });
  if (!captured || captured.identity.nlink !== 1n) throw new Error('strict-json');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(captured.contents);
  return parseStrictJsonObjectV1(text, 'native verification input') as Record<string, unknown>;
}
function emit(result: NativeVerificationResult, json: boolean): void {
  process.exitCode = result.status === 'invalid' ? 2 : result.status === 'cancelled' ? 130 :
    result.status === 'complete' && result.verdict === 'verified' ? 0 : 1;
  if (json) process.stdout.write(JSON.stringify(result) + '\n');
  else {
    const lines = [`Native verification: ${result.status}/${result.verdict}`,
      `Proof scope: ${result.proofScope}; admission: ${result.admission}`,
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
}

/** Dedicated parsing keeps verification's closed options separate from repair authority. */
export async function runNativeClientCli(argv: string[], signal: AbortSignal): Promise<void> {
  let json = argv.includes('--json');
  let request: unknown;
  let controls: NativeVerificationControls = { signal };
  let reason = 'request-field';
  try {
    const args = [...argv];
    for (let index = 0; index < args.length; index++) if (args[index] === '--budget-ms' && /^-\d/.test(args[index + 1] ?? '')) {
      args[index] = `--budget-ms=${args[index + 1]}`; args.splice(index + 1, 1);
    }
    const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, strict: true, tokens: true,
      options: { configuration: { type: 'string' }, 'host-bindings': { type: 'string' },
        'sandbox-root': { type: 'string' }, 'budget-ms': { type: 'string' },
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
    request = { schema: 'urn:aihq:core:native-verification-request:1.0.0', client: positionals[0] };
    if (values['candidate-smoke']) controls.admission = 'candidate-smoke';
    if (values['sandbox-root'] !== undefined) controls.sandboxRoot = values['sandbox-root'];
    if (values['budget-ms'] !== undefined) {
      controls.budgetMs = /^[0-9]+$/.test(values['budget-ms']) ? Number(values['budget-ms']) : NaN;
    }
    reason = 'strict-json';
    if (values.configuration !== undefined) {
      request = readInput(values.configuration);
      if ((request as Record<string, unknown>).client !== positionals[0]) {
        reason = 'client-id'; throw new Error('client mismatch');
      }
    }
    if (values['host-bindings'] !== undefined) {
      const bindings = readInput(values['host-bindings']);
      if (Object.keys(bindings).some(key => !['testIdentity', 'configurationSources'].includes(key))) {
        reason = 'controls-field'; throw new Error('host bindings');
      }
      controls = { ...controls, ...bindings };
    }
    emit(await verifyNativeClient(request, controls), json);
  } catch {
    emit(invalidNativeVerificationResult([diagnostic(reason)], request, controls), json);
  }
}
