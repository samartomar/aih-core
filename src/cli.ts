#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { parsePolicy } from './contracts.js';
import { prepare, apply } from './index.js';
import { readRegularFile } from './internal/fsxn.js';
import { sha256 } from './internal/host-files.js';
import type { HostControls, PreparationResult, RunResult } from './host-types.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
let json = process.argv.includes('--json');
function emit(result: unknown, code: number): void {
  process.stdout.write(JSON.stringify(result, null, json ? undefined : 2) + '\n');
  process.exitCode = code;
}
function refused(code: string, reason: string): void {
  emit({ status: 'invalid', diagnostics: [{ code, reason,
    message: 'Check the policy, target and explicit approval options.' }] }, code === 'CANCELLED' ? 130 : 2);
}
function exitCode(result: PreparationResult | RunResult): number {
  if ('completion' in result) return ({ complete: 0, incomplete: 1, rejected: 2, cancelled: 130 })[result.completion];
  return ({ ready: 0, partial: 1, blocked: 1, invalid: 2, cancelled: 130 })[result.status];
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    project: { type: 'string' }, apply: { type: 'boolean' }, yes: { type: 'boolean' },
    'allow-partial': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    'private-input': { type: 'string', multiple: true }
  } });
  json = values.json ?? false;
  if (values.help) {
    process.stdout.write('aih policy <policy.json> [--project <path>] [--apply --yes] [--allow-partial] [--private-input <selection.input>=<env-name>] [--json]\n');
  } else if (positionals.length !== 2 || positionals[0] !== 'policy' || values.yes && !values.apply || values['allow-partial'] && !values.apply) {
    refused('INPUT_INVALID', 'cli-options');
  } else {
    const file = resolve(positionals[1]!);
    const bytes = readRegularFile(file, { maxBytes: 1_000_000 });
    if (!bytes) throw new Error('policy-file');
    const parsed = parsePolicy(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!parsed.valid || !parsed.document) emit({ status: 'invalid', diagnostics: parsed.diagnostics }, 2);
    else {
      const controls: HostControls = { signal: controller.signal, privateInputs: Object.create(null) };
      for (const mapping of values['private-input'] ?? []) {
        const match = /^([A-Za-z0-9][A-Za-z0-9_%-]*)\.([A-Za-z0-9][A-Za-z0-9_%-]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(mapping);
        if (!match || process.env[match[3]!] === undefined) throw new Error('private-input');
        const selectionId = decodeURIComponent(match[1]!); const inputId = decodeURIComponent(match[2]!);
        if (![selectionId, inputId].every(id => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) throw new Error('private-input');
        const selection = controls.privateInputs![selectionId] ??= Object.create(null);
        if (Object.hasOwn(selection, inputId)) throw new Error('private-input');
        selection[inputId] = process.env[match[3]!]!;
      }
      const p = await prepare({ useCase: 'policy', policy: parsed.document, target: { project: resolve(values.project ?? process.cwd()) } }, controls);
      if (!values.apply || !p.prepared || !p.review) emit(p, exitCode(p));
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
          if (!current || sha256(current) !== sha256(bytes)) refused('REVIEW_STALE', 'policy-file-changed');
          else {
            const result = await apply(p.prepared, { reviewDigest: p.review.reviewDigest, approved: true,
              origin: values.yes ? 'automation' : 'interactive',
              ...(values['allow-partial'] === undefined ? {} : { allowPartial: values['allow-partial'] })
            }, { signal: controller.signal });
            emit(result, exitCode(result));
          }
        }
      }
    }
  }
} catch {
  refused(controller.signal.aborted ? 'CANCELLED' : 'INPUT_INVALID', controller.signal.aborted ? 'cancelled' : 'cli-input');
}
