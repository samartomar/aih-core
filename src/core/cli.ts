#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { repairIndex, selectVerificationKeys, selectVerificationPublishers } from '../harness/contracts.mjs';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { contractSupport, parseOrganizationPolicy, parsePolicy, validateRecipe } from './contracts.js';
import { prepare, apply, inspect, checkFileState, listManagedSelections, prepareManagedRemoval } from './index.js';
import { invalidFileStateResult } from './file-state.js';
import type { FileStateControls, FileStateRequest } from './file-state-types.js';
import { readRegularFile } from './internal/fsxn.js';
import { sha256 } from './internal/host-files.js';
import { parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { getGuidance, type SupportInput, type SupportPlatform } from './support.js';
import { formatGuidanceText } from './internal/guidance-text.js';
import { writeSupportReport } from './support-report.js';
import type { HostControls, PreparationResult, RunResult } from './host-types.js';
import type { PolicyRequest } from './host-types.js';
import type { RepairRequest } from './repair.js';
import type { ManagedRemovalRequest, ManagedRemovalPreparationResult } from './managed-removal.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
let json = process.argv.includes('--json');
function emit(result: unknown, code: number): void {
  process.stdout.write(JSON.stringify(result, null, json ? undefined : 2) + '\n');
  process.exitCode = code;
}
function refused(code: string, reason: string, message = 'Check the policy, target and explicit approval options.'): void {
  emit({ status: 'invalid', diagnostics: [{ code, reason,
    message }] }, code === 'CANCELLED' ? 130 : 2);
  // A refusal is not a public result; a requested report is never written for it.
  if (process.argv.some(arg => arg === '--support-markdown' || arg.startsWith('--support-markdown=')))
    stderr.write(`Support report not written: ${({ CANCELLED: 'cancelled', APPROVAL_REQUIRED: 'approval-required',
      REVIEW_STALE: 'review-stale' } as Record<string, string>)[code] ?? 'input-rejected'}\n`);
}
const usage = {
  report: 'aih report --output <new-directory> [--target <id>]... [--offline] [--demo] [--json]\n' +
    'aih report --output <new-directory> --snapshot <report.json> [--demo] [--json]\n',
  inspect: 'aih inspect [--target <id>] [--offline] [--probe-configured-mcp] [--project <path>] [--support-markdown <path>] [--json]\n',
  policy: 'aih policy <policy.json> [--project <path>] [--org-repository <owner/repo> --org-path <path> --org-ref <branch:name|tag:name|commit:sha> [--org-token-env <NAME>]] [--evidence] [--apply --yes] [--allow-partial] [--private-input <selection.input>=<env-name>] [--material-root <id>=<absolute-path>] [--resolutions <strict-json-file>] [--no-log] [--support-markdown <path>] [--json]\n',
  repair: 'aih repair <published-id> --target <published-target> --inputs-file <json> [--offline] [--resolutions <strict-json-file>] [--apply --yes] [--allow-partial] [--no-log] [--support-markdown <path>] [--json]\n',
  validate: 'aih validate <execution-policy|organization-policy|recipe> <file> [--json]\n',
  'check-files': 'aih check-files <policy.json> [--project <path>] [--material-root <id>=<absolute-path>] [--private-input <selection.input>=<env-name>] [--budget-ms <integer>] [--json]\n',
  managed: 'aih managed <list|remove> [options]\n'
};
const examples: Record<keyof typeof usage, string> = {
  report: 'Examples:\n  aih report --output local-report --json\n  aih report --snapshot saved-report.json --output replay --json\n',
  inspect: 'Examples:\n  aih inspect --json\n  aih inspect --target node --target npm --offline --json\n  aih inspect --target node --offline --json --support-markdown inspection-report.md\n',
  policy: 'Examples:\n  aih policy policy.json --project /absolute/project --json\n  aih policy policy.json --project /absolute/project --apply\n  aih policy policy.json --project /absolute/project --apply --yes --no-log --json\n  aih policy policy.json --project /absolute/project --json --support-markdown policy-report.md\n',
  repair: 'Examples:\n  aih repair node-npm-ca --target node --target npm --inputs-file repair-inputs.json --json\n  aih repair node-npm-ca --target node --target npm --inputs-file repair-inputs.json --apply --no-log\n  aih repair node-npm-ca --target node --inputs-file repair-inputs.json --json --support-markdown repair-report.md\n',
  validate: 'Examples:\n  aih validate execution-policy policy.json\n  aih validate recipe recipe.json --json\n',
  'check-files': 'Examples:\n  aih check-files policy.json --json\n  aih check-files policy.json --project /absolute/project --json\n  aih check-files policy.json --material-root team=/absolute/materials --budget-ms 30000 --json\n',
  managed: 'Examples:\n  aih managed list --json\n  aih managed remove team-guidance --scope project --mode vibe --json\n'
};
const managedUsage = {
  list: 'aih managed list [--project <path>] [--scope project|user|both] [--budget-ms <1..120000>] [--json]\n',
  remove: 'aih managed remove <managementId> --scope project|user --mode vibe|enterprise [--project <path>] [--org-repository <owner/repo> --org-path <path> --org-ref <branch:name|tag:name|commit:sha> [--org-token-env <NAME>]] [--apply --yes] [--allow-partial] [--no-log] [--json]\n'
};
const managedExamples = {
  list: 'Examples:\n  aih managed list --json\n  aih managed list --scope project --project /absolute/project --json\n',
  remove: 'Examples:\n  aih managed remove team-guidance --scope project --mode vibe --json\n  aih managed remove team-guidance --scope project --mode vibe --apply --yes --json\n'
};
const commands = Object.keys(usage) as (keyof typeof usage)[];
function exitCode(result: PreparationResult | RunResult): number {
  if ('completion' in result) return ({ complete: 0, incomplete: 1, rejected: 2, cancelled: 130 })[result.completion];
  // Required authority failure or denial is a rejection, not merely blocked work.
  if (result.status === 'blocked' && result.diagnostics.some(item => item.code.startsWith('AUTHORITY_'))) return 2;
  return ({ ready: 0, partial: 1, blocked: 1, invalid: 2, cancelled: 130 })[result.status];
}

let supportMarkdown: string | undefined;
const supportPlatform: SupportPlatform =
  process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'unknown';
/** Printed paths never carry control or bidirectional formatting characters into the terminal. */
const escapeReportPath = (value: string): string =>
  value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202A-\u202E\u2066-\u2069]/g,
    char => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`);
/**
 * Optional report export and non-JSON next actions after the one final result
 * an invocation emitted. Never throws, never changes stdout, and preserves the
 * operation exit code except that a failed export turns a successful 0 into 1.
 */
async function supportReport(input: SupportInput, operationCode: number): Promise<void> {
  if (!json && (input.kind === 'inspect' || 'repair' in input)) {
    try {
      const guidance = getGuidance(input, { platform: supportPlatform });
      const text = guidance.status === 'complete' ? formatGuidanceText(guidance.items) : '';
      if (text) stderr.write(text);
    } catch { /* Guidance never changes the operation result. */ }
  }
  if (supportMarkdown === undefined) return;
  const fail = (reason: string): void => {
    stderr.write(`Support report not written: ${reason}\n`);
    if (operationCode === 0) process.exitCode = 1;
  };
  const result = input.result as { status?: unknown; completion?: unknown } | null;
  // Never begin an export after the operation itself was cancelled.
  if (controller.signal.aborted || result?.status === 'cancelled' || result?.completion === 'cancelled')
    return fail('cancelled');
  try {
    const report = await writeSupportReport(input,
      { platform: supportPlatform, path: resolve(supportMarkdown), signal: controller.signal });
    if (report.status === 'written' && report.path) stderr.write(`Support report written: ${escapeReportPath(report.path)}\n`);
    else fail(report.diagnostics[0]?.reason ?? report.status);
  } catch { fail('failed'); }
}

try {
  const cliArgs = process.argv.slice(2);
  // parseArgs treats a separate negative number as an option; keep it attached
  // so managed list can report the documented budget-ms diagnostic.
  if (cliArgs[0] === 'managed' && cliArgs[1] === 'list')
    for (let index = 2; index < cliArgs.length; index++) if (cliArgs[index] === '--budget-ms') {
      const next = cliArgs[index + 1];
      if (next === undefined || next.startsWith('--')) cliArgs[index] = '--budget-ms=';
      else if (next.startsWith('-')) { cliArgs[index] = `--budget-ms=${next}`; cliArgs.splice(index + 1, 1); }
    }
  const { values, positionals } = parseArgs({ args: cliArgs, allowPositionals: true, strict: true, options: {
    project: { type: 'string' }, apply: { type: 'boolean' }, yes: { type: 'boolean' },
    'allow-partial': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' }, 'no-log': { type: 'boolean' },
    'private-input': { type: 'string', multiple: true },
    'material-root': { type: 'string', multiple: true }, 'resolutions': { type: 'string' },
    target: { type: 'string', multiple: true }, offline: { type: 'boolean' },
    'inputs-file': { type: 'string' },
    output: { type: 'string' }, snapshot: { type: 'string' }, demo: { type: 'boolean' },
    'probe-configured-mcp': { type: 'boolean' },
    'support-markdown': { type: 'string' },
    evidence: { type: 'boolean' },
    'org-repository': { type: 'string' }, 'org-path': { type: 'string' }, 'org-ref': { type: 'string' }, 'org-token-env': { type: 'string' },
    'budget-ms': { type: 'string' }, scope: { type: 'string' }, mode: { type: 'string' }
  } });
  const organizationFlags = ['org-repository', 'org-path', 'org-ref', 'org-token-env'] as const;
  const hasOrganizationFlags = organizationFlags.some(name => values[name] !== undefined);
  const acceptsOnly = (allowed: readonly string[]) => Object.keys(values).every(name => allowed.includes(name));
  json = values.json ?? false;
  const command = commands.find(name => name === positionals[0]);
  const helpWord = positionals[0] === 'help';
  const hasReportFlags = values.output !== undefined || values.snapshot !== undefined || values.demo !== undefined;
  const managedHelpWord = positionals[0] === 'managed' && positionals[1] === 'help';
  const onlyJson = !Object.keys(values).some(name => name !== 'json');
  const helpFlags = Object.keys(values).every(name => name === 'help' || name === 'json');
  const logging = values['no-log'] ? { logging: 'off' as const } : {};
  supportMarkdown = values['support-markdown'];
  // Version, help and validate answer before any target, network, history or state access.
  if (hasReportFlags && command !== 'report') {
    refused('INPUT_INVALID','cli-options');
  } else if (values.version) {
    if (positionals.length || Object.keys(values).some(name => name !== 'version' && name !== 'json')) refused('INPUT_INVALID', 'cli-options');
    else if (json) emit({ name: contractSupport.package.name, version: contractSupport.package.version }, 0);
    else process.stdout.write(`${contractSupport.package.name} ${contractSupport.package.version}\n`);
  } else if (helpWord || values.help || managedHelpWord) {
    // Existing commands have historically accepted their ordinary arguments with --help.
    const legacyHelp = values.help === true && positionals[0] !== 'managed' && !helpWord &&
      values.scope === undefined && values.mode === undefined;
    const subject = helpWord ? positionals.slice(1) : managedHelpWord ?
      ['managed', ...positionals.slice(2)] : positionals;
    const validSubject = legacyHelp || subject.length === 0 || subject.length === 1 && commands.includes(subject[0] as keyof typeof usage) ||
      subject.length === 2 && subject[0] === 'managed' && ['list', 'remove'].includes(subject[1]!);
    if ((!legacyHelp && !helpFlags) || !validSubject || (helpWord || managedHelpWord) && !onlyJson) refused('INPUT_INVALID', 'cli-options');
    else if (subject[0] === 'managed' && subject.length === 2)
      process.stdout.write(managedUsage[subject[1] as keyof typeof managedUsage] + managedExamples[subject[1] as keyof typeof managedExamples]);
    else if (subject.length === 1 && commands.includes(subject[0] as keyof typeof usage) || legacyHelp && command) {
      const topic = (legacyHelp ? command : subject[0]) as keyof typeof usage;
      process.stdout.write(usage[topic] + (topic === 'managed' ? managedUsage.list + managedUsage.remove + examples.managed : examples[topic]));
    } else process.stdout.write(commands.map(name => usage[name]).join('') +
      'aih --version | -V [--json]    Print the installed package version.\n' +
      'aih help [<command>] | aih <command> --help | -h    Show usage and examples.\n' +
      '--no-log (policy, repair and managed remove) turns routine history off for Prepare and Apply.\n');
  } else if (positionals[0] === 'report') {
    // Acquisition or import only: no repair, policy, upload or service is reachable from this branch.
    const reportMessage = 'Choose one new output directory and either fresh offline targets or one supplied snapshot file.';
    if (positionals.length !== 1 || !values.output || Object.keys(values).some(name => !['output','snapshot','target','offline','demo','json'].includes(name)) || values.snapshot !== undefined && (values.target || values.offline)) refused('INPUT_INVALID', 'cli-options', reportMessage);
    else {
      let snapshotJson: string | undefined; let unreadable: string | undefined;
      if (values.snapshot !== undefined) {
        const bytes = readRegularFile(resolve(values.snapshot), { maxBytes: 1_000_000 });
        if (!bytes) unreadable = 'snapshot-unreadable';
        else try { snapshotJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { unreadable = 'snapshot-invalid'; }
      }
      if (unreadable) refused('INPUT_INVALID', unreadable, reportMessage);
      else {
        // Report rendering and diagnostics load only for this command.
        const { runReportCommand, ReportCommandError } = await import('../harness/report-command.mjs');
        try {
          emit(await runReportCommand({ output: values.output, ...(snapshotJson === undefined ? {} : { snapshotJson }),
            ...(values.target === undefined ? {} : { targets: values.target }), ...(values.demo ? { demo: true } : {}) },
          { signal: controller.signal }), 0);
        } catch (error) {
          if (!(error instanceof ReportCommandError)) throw error;
          if (error.code === 'INCOMPLETE') emit({ status: 'incomplete', diagnostics: [{ code: 'EXECUTION_FAILED', reason: error.reason,
            message: 'The diagnostic did not complete; no report was written.' }] }, 1);
          else refused(error.code, error.reason, reportMessage);
        }
      }
    }
  } else if (positionals[0] === 'validate') {
    const kind = ['execution-policy', 'organization-policy', 'recipe'].find(name => name === positionals[1]);
    if (positionals.length !== 3 || !kind || !onlyJson) refused('INPUT_INVALID', 'cli-options');
    else {
      const bytes = readRegularFile(resolve(positionals[2]!), { maxBytes: 1_000_000 });
      if (!bytes) throw new Error('validate-file');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      let result: { valid: boolean; schema?: string; diagnostics: unknown[] };
      if (kind === 'execution-policy') result = parsePolicy(text);
      else if (kind === 'organization-policy') result = parseOrganizationPolicy(text);
      else {
        try { result = validateRecipe(parseStrictJsonObjectV1(text, 'recipe')); }
        catch { result = { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] }; }
      }
      emit({ status: result.valid ? 'valid' : 'invalid', kind, ...(result.schema ? { schema: result.schema } : {}),
        diagnostics: result.diagnostics }, result.valid ? 0 : 2);
    }
  } else if (positionals[0] === 'managed' && positionals[1] === 'list') {
    if (positionals.length !== 2 || !acceptsOnly(['project', 'scope', 'budget-ms', 'json']))
      refused('INPUT_INVALID', 'cli-options');
    else {
      const rawBudget = values['budget-ms'];
      const budgetMs = rawBudget === undefined ? undefined : /^[0-9]+$/.test(rawBudget) ? Number(rawBudget) : 0;
      const result = await listManagedSelections({ target: { project: resolve(values.project ?? process.cwd()) },
        scope: (values.scope ?? 'both') as 'project' | 'user' | 'both' },
      { signal: controller.signal, ...(budgetMs === undefined ? {} : { budgetMs }) });
      emit(result, ({ complete: 0, incomplete: 1, invalid: 2, cancelled: 130 })[result.status]);
    }
  } else if (positionals[0] === 'managed' && positionals[1] === 'remove') {
    if (positionals.length !== 3 || !acceptsOnly(['project', 'scope', 'mode', 'org-repository', 'org-path',
      'org-ref', 'org-token-env', 'apply', 'yes', 'allow-partial', 'no-log', 'json']) ||
      values.yes && !values.apply || values['allow-partial'] && !values.apply)
      refused('INPUT_INVALID', 'cli-options');
    else {
      const remove = async () => {
        let organizationSource: ManagedRemovalRequest['organizationSource'];
        if (values.mode === 'enterprise') {
          const repository = /^([^/\s]+)\/([^/\s]+)$/.exec(values['org-repository'] ?? '');
          const revision = /^(branch|tag|commit):(.+)$/s.exec(values['org-ref'] ?? '');
          if (!repository || !revision || !values['org-path']) {
            refused('INPUT_INVALID', 'cli-options'); return;
          }
          organizationSource = { provider: 'github', repository: { owner: repository[1]!, name: repository[2]! },
            path: values['org-path'], revision: { kind: revision[1] as 'branch' | 'tag' | 'commit', value: revision[2]! } };
        } else if (hasOrganizationFlags) { refused('INPUT_INVALID', 'cli-options'); return; }
        const controls: HostControls = { signal: controller.signal, ...logging };
        if (values['org-token-env'] !== undefined) {
          const name = values['org-token-env'];
          const token = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? process.env[name] : undefined;
          if (!token) { refused('INPUT_INVALID', 'cli-options'); return; }
          controls.authentication = { kind: 'bearer', token };
        }
        const result = await prepareManagedRemoval({ target: { project: resolve(values.project ?? process.cwd()) },
          managementId: positionals[2]!, scope: values.scope as ManagedRemovalRequest['scope'],
          mode: values.mode as ManagedRemovalRequest['mode'],
          ...(organizationSource === undefined ? {} : { organizationSource }) }, controls);
        const wrapperCode = (value: ManagedRemovalPreparationResult) => ({
          absent: 0, retained: 1, 'reconcile-required': 1,
          unavailable: value.diagnostics.some(item => item.code.startsWith('AUTHORITY_')) ? 2 : 1,
          invalid: 2, cancelled: 130,
          prepared: value.preparation ? exitCode(value.preparation) : 1
        })[value.disposition];
        if (result.disposition !== 'prepared' || !values.apply || !result.preparation?.prepared || !result.preparation.review) {
          const projection = result.preparation ? (({ prepared: _handle, ...safe }) =>
            ({ ...result, preparation: safe }))(result.preparation) : result;
          emit(projection, wrapperCode(result));
          return;
        }
        const preparation = result.preparation;
        let approved = values.yes === true;
        if (!approved && stdin.isTTY && stderr.isTTY) {
          stderr.write(JSON.stringify(preparation.review, null, 2) + '\n');
          const prompt = createInterface({ input: stdin, output: stderr });
          try { approved = /^y(?:es)?$/i.test((await prompt.question('Apply this reviewed work? [y/N] ', { signal: controller.signal })).trim()); }
          finally { prompt.close(); }
        }
        if (!approved) { refused('APPROVAL_REQUIRED', 'explicit-approval'); return; }
        const run = await apply(preparation.prepared!, { reviewDigest: preparation.review!.reviewDigest,
          approved: true, origin: values.yes ? 'automation' : 'interactive',
          ...(values['allow-partial'] === undefined ? {} : { allowPartial: values['allow-partial'] }) }, controls);
        emit(run, exitCode(run));
      };
      await remove();
    }
  } else if (positionals.length === 1 && positionals[0] === 'inspect' &&
      !values.apply && !values.yes && !values['allow-partial'] && !values['private-input']?.length &&
      !values['material-root']?.length && !values.resolutions && !values['inputs-file'] && !hasOrganizationFlags && !values.evidence && !values['no-log'] &&
      values['budget-ms'] === undefined && values.scope === undefined && values.mode === undefined) {
    const result = await inspect({
      ...(values.target === undefined ? {} : { targets: values.target }),
      ...(values.offline ? { network: 'off' as const } : {}),
      ...(values['probe-configured-mcp'] ? { probeConfiguredMcp: true } : {}),
      ...(values.project ? { project: resolve(values.project) } : {})
    }, { signal: controller.signal });
    const code = ({ complete: 0, incomplete: 1, invalid: 2, cancelled: 130 })[result.status];
    emit(result, code);
    await supportReport({ kind: 'inspect', result }, code);
  } else if (positionals[0] === 'repair') {
    const definition = repairIndex.find(item => item.id === positionals[1]);
    if (positionals.length !== 2 || !definition || !values['inputs-file'] ||
        !values.target?.length || values.target.some(id => !definition.targets.includes(id)) ||
        values.project || values['probe-configured-mcp'] || values['private-input']?.length || hasOrganizationFlags || values.evidence ||
        values['material-root']?.length || values['budget-ms'] !== undefined || values.scope !== undefined || values.mode !== undefined || values.yes && !values.apply ||
        values['allow-partial'] && !values.apply) refused('INPUT_INVALID', 'cli-options');
    else {
      const inputPath = resolve(values['inputs-file']);
      const input = readRegularFile(inputPath, { maxBytes: 1_000_000 });
      if (!input) throw new Error('inputs-file');
      const document = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input), 'repair inputs');
      const selected = document[definition.id];
      if (Object.keys(document).length !== 1 || !selected || typeof selected !== 'object' || Array.isArray(selected) ||
          Object.keys(selected).some(key => !Object.hasOwn(definition.inputs, key)) ||
          Object.entries(definition.inputs).some(([key, declaration]) => declaration.required &&
            !Object.hasOwn(selected, key)))
        throw new Error('inputs-file');
      const inputs = Object.fromEntries(Object.entries(selected).map(([key, value]) =>
        [key, definition.inputs[key]?.type === 'file' && typeof value === 'string' ? resolve(value) : value])) as RepairRequest['repairs'][0]['inputs'];
      const request: RepairRequest = { useCase: 'repair', repairs: [{ id: definition.id,
        targets: values.target, inputs }],
        ...(values.offline ? { network: 'off' } : {}) };
      let resolutionsPath: string | undefined; let resolutionsDigest: string | undefined;
      if (values.resolutions) {
        resolutionsPath = resolve(values.resolutions);
        const bytes = readRegularFile(resolutionsPath, { maxBytes: 1_000_000 });
        if (!bytes) throw new Error('resolutions-file');
        const parsed = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 'resolutions');
        if (Object.keys(parsed).length !== 1 || !Array.isArray(parsed.resolutions)) throw new Error('resolutions-file');
        request.resolutions = parsed.resolutions as RepairRequest['resolutions'];
        resolutionsDigest = sha256(bytes);
      }
      const p = await prepare(request, { signal: controller.signal, ...logging });
      // Report context only; duplicate CLI targets must not make a real result unexportable.
      const repairContext = { id: definition.id, targets: [...new Set(values.target!)] };
      if (!values.apply || !p.prepared || !p.review) {
        const code = exitCode(p);
        emit(p, code);
        await supportReport({ kind: 'prepare', result: p, repair: repairContext }, code);
      }
      else {
        let approved = values.yes === true;
        if (!approved && stdin.isTTY && stderr.isTTY) {
          stderr.write(JSON.stringify(p.review, null, 2) + '\n');
          const prompt = createInterface({ input: stdin, output: stderr });
          try { approved = /^y(?:es)?$/i.test((await prompt.question('Apply this reviewed work? [y/N] ', { signal: controller.signal })).trim()); }
          finally { prompt.close(); }
        }
        if (!approved) refused('APPROVAL_REQUIRED', 'explicit-approval');
        else {
          const current = readRegularFile(inputPath, { maxBytes: 1_000_000 });
          const currentResolutions = resolutionsPath ? readRegularFile(resolutionsPath, { maxBytes: 1_000_000 }) : undefined;
          if (!current || sha256(current) !== sha256(input) ||
              resolutionsPath && (!currentResolutions || sha256(currentResolutions) !== resolutionsDigest))
            refused('REVIEW_STALE', 'input-file-changed');
          else {
            const result = await apply(p.prepared, { reviewDigest: p.review.reviewDigest, approved: true,
              origin: values.yes ? 'automation' : 'interactive',
              ...(values['allow-partial'] === undefined ? {} : { allowPartial: values['allow-partial'] })
            }, { signal: controller.signal, ...logging });
            const code = exitCode(result);
            emit(result, code);
            await supportReport({ kind: 'run', result, repair: repairContext }, code);
          }
        }
      }
    }
  } else if (positionals[0] === 'check-files') {
    // Presence, not truthiness: an empty `--resolutions=` is still a forbidden option.
    if (positionals.length !== 2 || values.apply || values.yes || values['allow-partial'] || values.resolutions !== undefined ||
        values.evidence || hasOrganizationFlags || values['no-log'] || values.target !== undefined || values.offline ||
        values['inputs-file'] !== undefined || values['probe-configured-mcp'] || values['support-markdown'] !== undefined ||
        values.scope !== undefined || values.mode !== undefined ||
        (values['budget-ms'] !== undefined && !/^[0-9]{1,6}$/.test(values['budget-ms']))) {
      refused('INPUT_INVALID', 'cli-options');
    } else {
      const file = resolve(positionals[1]!);
      const bytes = readRegularFile(file, { maxBytes: 1_000_000 });
      if (!bytes) throw new Error('policy-file');
      let document: unknown;
      try {
        document = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 'policy');
      } catch {
        emit(invalidFileStateResult([{ code: 'INPUT_INVALID', reason: 'strict-json',
          message: 'Expected bounded, plain strict JSON data.' }]), 2);
        document = undefined;
      }
      if (document !== undefined) {
        const controls: FileStateControls = { signal: controller.signal };
        if (values['budget-ms'] !== undefined) controls.budgetMs = Number(values['budget-ms']);
        if (values['material-root']?.length) {
          const roots: Record<string, string> = Object.create(null);
          for (const mapping of values['material-root']) {
            const split = mapping.indexOf('='); const id = mapping.slice(0, split); const root = mapping.slice(split + 1);
            if (split < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !isAbsolute(root) ||
                Object.hasOwn(roots, id)) throw new Error('material-root');
            roots[id] = root;
          }
          controls.materialRoots = roots;
        }
        if (values['private-input']?.length) {
          const inputs: Record<string, Record<string, string>> = Object.create(null);
          for (const mapping of values['private-input']) {
            const match = /^([A-Za-z0-9][A-Za-z0-9_%-]*)\.([A-Za-z0-9][A-Za-z0-9_%-]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(mapping);
            if (!match || process.env[match[3]!] === undefined) throw new Error('private-input');
            const selectionId = decodeURIComponent(match[1]!); const inputId = decodeURIComponent(match[2]!);
            if (![selectionId, inputId].every(id => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) throw new Error('private-input');
            // Only the named variable is read; its value is held in memory and never printed.
            const selection = inputs[selectionId] ??= Object.create(null);
            if (Object.hasOwn(selection, inputId)) throw new Error('private-input');
            selection[inputId] = process.env[match[3]!]!;
          }
          controls.privateInputs = inputs;
        }
        const result = await checkFileState({ policy: document as FileStateRequest['policy'],
          target: { project: resolve(values.project ?? process.cwd()) } }, controls);
        emit(result, result.status === 'invalid' ? 2 : result.status === 'cancelled' ? 130 :
          result.status === 'complete' && result.fileState === 'match' ? 0 : 1);
      }
    }
  } else if (positionals.length !== 2 || positionals[0] !== 'policy' || values.target || values.offline || values['inputs-file'] ||
      values['probe-configured-mcp'] || values['budget-ms'] !== undefined || values.scope !== undefined || values.mode !== undefined ||
      values.yes && !values.apply || values['allow-partial'] && !values.apply) {
    refused('INPUT_INVALID', 'cli-options');
  } else {
    const file = resolve(positionals[1]!);
    const bytes = readRegularFile(file, { maxBytes: 1_000_000 });
    if (!bytes) throw new Error('policy-file');
    const parsed = parsePolicy(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!parsed.valid || !parsed.document) {
      emit({ status: 'invalid', diagnostics: parsed.diagnostics }, 2);
      // A CLI-built bare invalid object is not a public result; nothing is exported.
      if (supportMarkdown !== undefined) stderr.write('Support report not written: input-rejected\n');
    }
    else {
      const sourceFlags = ['org-repository', 'org-path', 'org-ref'] as const;
      let organizationSource: PolicyRequest['organizationSource'];
      if (parsed.document.mode === 'enterprise') {
        if (sourceFlags.some(name => !values[name])) throw new Error('organization-flags');
        const repository = /^([^/\s]+)\/([^/\s]+)$/.exec(values['org-repository']!);
        const revision = /^(branch|tag|commit):(.+)$/s.exec(values['org-ref']!);
        if (!repository || !revision) throw new Error('organization-flags');
        organizationSource = { provider: 'github', repository: { owner: repository[1]!, name: repository[2]! },
          path: values['org-path']!, revision: { kind: revision[1] as 'branch' | 'tag' | 'commit', value: revision[2]! } };
      } else if (hasOrganizationFlags) throw new Error('organization-flags');
      const controls: HostControls = { signal: controller.signal, privateInputs: Object.create(null), ...logging };
      if (values.evidence) {
        const keys = await selectVerificationKeys('scan-report');
        const publishers = selectVerificationPublishers('scan-report');
        controls.evidence = { acquire: true, trust: {
          keys: keys.status === 'selected' ? keys.keys : [],
          publishers: publishers.status === 'selected' ? publishers.publishers : []
        } };
      }
      if (values['org-token-env'] !== undefined) {
        // Only the named variable is read; its value is held in memory for Prepare and Apply and never printed.
        const name = values['org-token-env'];
        const token = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? process.env[name] : undefined;
        if (!token) throw new Error('organization-token');
        controls.authentication = { kind: 'bearer', token };
      }
      if (values['material-root']?.length) controls.materialRoots = Object.create(null);
      for (const mapping of values['material-root'] ?? []) {
        const split = mapping.indexOf('='); const id = mapping.slice(0, split); const root = mapping.slice(split + 1);
        if (split < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !isAbsolute(root) ||
            Object.hasOwn(controls.materialRoots!, id)) throw new Error('material-root');
        controls.materialRoots![id] = root;
      }
      for (const mapping of values['private-input'] ?? []) {
        const match = /^([A-Za-z0-9][A-Za-z0-9_%-]*)\.([A-Za-z0-9][A-Za-z0-9_%-]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(mapping);
        if (!match || process.env[match[3]!] === undefined) throw new Error('private-input');
        const selectionId = decodeURIComponent(match[1]!); const inputId = decodeURIComponent(match[2]!);
        if (![selectionId, inputId].every(id => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) throw new Error('private-input');
        const selection = controls.privateInputs![selectionId] ??= Object.create(null);
        if (Object.hasOwn(selection, inputId)) throw new Error('private-input');
        selection[inputId] = process.env[match[3]!]!;
      }
      let resolutions: PolicyRequest['resolutions']; let resolutionsFile: string | undefined; let resolutionsDigest: string | undefined;
      if (values.resolutions) {
        resolutionsFile = resolve(values.resolutions);
        const input = readRegularFile(resolutionsFile, { maxBytes: 1_000_000 });
        if (!input) throw new Error('resolutions-file');
        const parsedResolutions = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input), 'resolutions');
        if (Object.keys(parsedResolutions).length !== 1 || !Array.isArray(parsedResolutions.resolutions)) throw new Error('resolutions-file');
        resolutions = parsedResolutions.resolutions as PolicyRequest['resolutions']; resolutionsDigest = sha256(input);
      }
      const p = await prepare({ useCase: 'policy', policy: parsed.document, target: { project: resolve(values.project ?? process.cwd()) },
        ...(resolutions ? { resolutions } : {}), ...(organizationSource ? { organizationSource } : {}) }, controls);
      if (!values.apply || !p.prepared || !p.review) {
        const code = exitCode(p);
        emit(p, code);
        await supportReport({ kind: 'prepare', result: p }, code);
      }
      else {
        let approved = values.yes === true;
        if (!approved && stdin.isTTY && stderr.isTTY) {
          stderr.write(JSON.stringify(p.review, null, 2) + '\n');
          const prompt = createInterface({ input: stdin, output: stderr });
          try { approved = /^y(?:es)?$/i.test((await prompt.question('Apply this reviewed work? [y/N] ', { signal: controller.signal })).trim()); }
          finally { prompt.close(); }
        }
        if (!approved) refused('APPROVAL_REQUIRED', 'explicit-approval');
        else {
          const current = readRegularFile(file, { maxBytes: 1_000_000 });
          const currentResolutions = resolutionsFile ? readRegularFile(resolutionsFile, { maxBytes: 1_000_000 }) : undefined;
          if (!current || sha256(current) !== sha256(bytes) || resolutionsFile && (!currentResolutions || sha256(currentResolutions) !== resolutionsDigest))
            refused('REVIEW_STALE', 'input-file-changed');
          else {
            const result = await apply(p.prepared, { reviewDigest: p.review.reviewDigest, approved: true,
              origin: values.yes ? 'automation' : 'interactive',
              ...(values['allow-partial'] === undefined ? {} : { allowPartial: values['allow-partial'] })
            }, { signal: controller.signal, ...logging, ...(controls.authentication ? { authentication: controls.authentication } : {}),
              ...(controls.evidence ? { evidence: controls.evidence } : {}) });
            const code = exitCode(result);
            emit(result, code);
            await supportReport({ kind: 'run', result }, code);
          }
        }
      }
    }
  }
} catch {
  refused(controller.signal.aborted ? 'CANCELLED' : 'INPUT_INVALID', controller.signal.aborted ? 'cancelled' : 'cli-input');
}
