#!/usr/bin/env node
// The `aih` command (contract 22): one module per command in src/core/cli/<command>.ts.
import { distribution } from '../distribution.mjs';
import { killTrees } from './internal/approved-process.js';

const USAGE = [
  'aih install <plan-request.json> [--project <path>] [--source <sourceId>=<folder>]... [--apply [--yes] [--allow-partial]] [--json]',
  'aih change <change-request.json> [--project <path>] [--material-root <id>=<folder>]... [--apply [--yes] [--allow-partial]] [--json]',
  'aih list [--project <path>] [--scope project|user|both] [--json]',
  'aih remove <managementId>... --scope project|user [--project <path>] [--item <item-id>] [--origin chosen] [--cli <id>]... [--apply [--yes] [--allow-partial]] [--json]',
  'aih update <plan-request.json | change-request.json> --scope project|user [--project <path>] [--management-id <id>]... [--source <sourceId>=<folder>]... [--apply [--yes] [--allow-partial]] [--json]',
  'aih repair <repair-id> --target <id>... [--inputs-file <json>] [--offline] [--apply [--yes]] [--json]',
  'aih export-ca [--format pem|pkcs7-der] [--output <path>] [--apply [--yes]] [--json]',
  'aih inspect [--target <id>] [--offline] [--profiles <folder>] [--json]',
  'aih check-files <plan-request.json | change-request.json> [--project <path>] [--source <sourceId>=<folder>]... [--json]',
  'aih verify-client <tool> [--json]',
  'aih report --output <new-directory> [--json]',
  'aih validate <change|change-request|organization|plan-request> <file> [--json]',
  '     Enterprise options: --mode enterprise --org-repository <owner/repo> --org-path <path> --org-ref <ref> | --org-file <path>',
  '     Common: --no-log, --resolutions <file>, --private-input <name>=<ENV>',
  'aih --version [--json]    Print the installed package version.',
  'aih help | aih <command> --help    Show usage.'
].join('\n') + '\n';

const commands: Record<string, () => Promise<{ run(args: string[], signal: AbortSignal): Promise<void> }>> = {
  install: () => import('./cli/install.js'),
  change: () => import('./cli/change.js'),
  list: () => import('./cli/list.js'),
  remove: () => import('./cli/remove.js'),
  update: () => import('./cli/update.js'),
  inspect: () => import('./cli/inspect.js'),
  'check-files': () => import('./cli/check-files.js'),
  'verify-client': () => import('./cli/verify-client.js'),
  report: () => import('./cli/report.js'),
  validate: async () => { const module = await import('./cli/validate.js'); return { run: (args: string[]) => module.run(args) }; },
  repair: async () => { const module = await import('./cli/environment.js'); return { run: (args, signal) => module.run('repair', args, signal) }; },
  'export-ca': async () => { const module = await import('./cli/environment.js'); return { run: (args, signal) => module.run('export-ca', args, signal) }; }
};

// Commands whose module prints no usage of its own; the others answer `<command> --help` themselves.
const OWN_HELP_ABSENT = ['repair', 'export-ca', 'report', 'validate'];
const controller = new AbortController();
// The first Ctrl-C cancels the run through its signal: Core stops what it started and the result says `cancelled`. A
// second one ends at once, after killing every program Core started.
let interrupts = 0;
process.on('SIGINT', () => {
  if (interrupts++ === 0) { controller.abort(); return; }
  killTrees();
  process.exit(130);
});
const [command, ...args] = process.argv.slice(2);
const json = args.includes('--json');
if (command === '--version' || command === '-V') {
  if (args.some(arg => arg !== '--json')) { process.stderr.write(USAGE); process.exitCode = 2; }
  else if (json) process.stdout.write(JSON.stringify({ name: distribution.name, version: distribution.version }) + '\n');
  else process.stdout.write(`${distribution.name} ${distribution.version}\n`);
} else if (command === undefined || command === 'help' || command === '--help' || command === '-h' ||
    OWN_HELP_ABSENT.includes(command) && args.some(arg => arg === '--help' || arg === '-h')) {
  process.stdout.write(USAGE);
} else if (Object.hasOwn(commands, command)) {
  await (await commands[command]!()).run(args, controller.signal);
} else {
  process.stderr.write(USAGE);
  process.stdout.write(JSON.stringify({ status: 'refused', code: 'usage', reason: `\`${command}\` is not an aih command.` }) + '\n');
  process.exitCode = 2;
}
