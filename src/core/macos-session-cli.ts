import { parseArgs } from 'node:util';
import { verifyMacosSession } from './macos-session.js';

const usage = 'aih verify-macos-session --management-id <id> [--no-log] [--json]\n';
export async function runMacosSessionCli(args: string[], signal: AbortSignal): Promise<void> {
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
      'management-id': { type: 'string' }, 'no-log': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
    } });
    if (values.help && !positionals.length && Object.keys(values).every(key => key === 'help' || key === 'json')) {
      process.stdout.write(usage); return;
    }
    if (positionals.length || !values['management-id'] || values.help) throw new Error('cli-options');
    const result = await verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:1.0.0',
      managementId: values['management-id'] }, { signal, ...(values['no-log'] ? { logging: 'off' as const } : {}) });
    if (values.json) process.stdout.write(JSON.stringify(result) + '\n');
    else process.stdout.write(`Configuration: ${result.configuration}\nVerification: ${result.verification}\nReason: ${result.reason}\n`);
    process.exitCode = { complete: 0, incomplete: 1, invalid: 2, cancelled: 130 }[result.status];
  } catch {
    process.stdout.write(JSON.stringify({ status: 'invalid', diagnostics: [{ code: 'INPUT_INVALID', reason: 'cli-options',
      message: 'Use a management ID and the documented observation options.' }] }) + '\n');
    process.exitCode = 2;
  }
}
