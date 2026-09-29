#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { repairIndex } from '@aihq/harness/contracts';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { parsePolicy } from './contracts.js';
import { prepare, apply, inspect } from './index.js';
import { readRegularFile } from './internal/fsxn.js';
import { sha256 } from './internal/host-files.js';
import { parseStrictJsonObjectV1 } from './internal/strict-json.js';
import type { HostControls, PreparationResult, RunResult } from './host-types.js';
import type { PolicyRequest } from './host-types.js';
import type { RepairRequest } from './repair.js';

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
    'private-input': { type: 'string', multiple: true },
    'material-root': { type: 'string', multiple: true }, 'resolutions': { type: 'string' },
    target: { type: 'string', multiple: true }, offline: { type: 'boolean' },
    'inputs-file': { type: 'string' },
    'probe-configured-mcp': { type: 'boolean' }
  } });
  json = values.json ?? false;
  if (values.help) {
    process.stdout.write('aih inspect [--target <id>] [--offline] [--probe-configured-mcp] [--project <path>] [--json]\n' +
      'aih policy <policy.json> [--project <path>] [--apply --yes] [--allow-partial] [--private-input <selection.input>=<env-name>] [--material-root <id>=<absolute-path>] [--resolutions <strict-json-file>] [--json]\n' +
      'aih repair <published-id> --target <published-target> --inputs-file <json> [--offline] [--resolutions <strict-json-file>] [--apply --yes] [--allow-partial] [--json]\n');
  } else if (positionals.length === 1 && positionals[0] === 'inspect' &&
      !values.apply && !values.yes && !values['allow-partial'] && !values['private-input']?.length &&
      !values['material-root']?.length && !values.resolutions && !values['inputs-file']) {
    const result = await inspect({
      ...(values.target === undefined ? {} : { targets: values.target }),
      ...(values.offline ? { network: 'off' as const } : {}),
      ...(values['probe-configured-mcp'] ? { probeConfiguredMcp: true } : {}),
      ...(values.project ? { project: resolve(values.project) } : {})
    }, { signal: controller.signal });
    emit(result, ({ complete: 0, incomplete: 1, invalid: 2, cancelled: 130 })[result.status]);
  } else if (positionals[0] === 'repair') {
    const definition = repairIndex.find(item => item.id === positionals[1]);
    if (positionals.length !== 2 || !definition || !values['inputs-file'] ||
        !values.target?.length || values.target.some(id => !definition.targets.includes(id)) ||
        values.project || values['probe-configured-mcp'] || values['private-input']?.length ||
        values['material-root']?.length || values.yes && !values.apply ||
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
      const p = await prepare(request, { signal: controller.signal });
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
          const current = readRegularFile(inputPath, { maxBytes: 1_000_000 });
          const currentResolutions = resolutionsPath ? readRegularFile(resolutionsPath, { maxBytes: 1_000_000 }) : undefined;
          if (!current || sha256(current) !== sha256(input) ||
              resolutionsPath && (!currentResolutions || sha256(currentResolutions) !== resolutionsDigest))
            refused('REVIEW_STALE', 'input-file-changed');
          else { const result = await apply(p.prepared, { reviewDigest: p.review.reviewDigest, approved: true,
            origin: values.yes ? 'automation' : 'interactive',
            ...(values['allow-partial'] === undefined ? {} : { allowPartial: values['allow-partial'] })
          }, { signal: controller.signal }); emit(result, exitCode(result)); }
        }
      }
    }
  } else if (positionals.length !== 2 || positionals[0] !== 'policy' || values.target || values.offline || values['inputs-file'] ||
      values['probe-configured-mcp'] || values.yes && !values.apply || values['allow-partial'] && !values.apply) {
    refused('INPUT_INVALID', 'cli-options');
  } else {
    const file = resolve(positionals[1]!);
    const bytes = readRegularFile(file, { maxBytes: 1_000_000 });
    if (!bytes) throw new Error('policy-file');
    const parsed = parsePolicy(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!parsed.valid || !parsed.document) emit({ status: 'invalid', diagnostics: parsed.diagnostics }, 2);
    else {
      const controls: HostControls = { signal: controller.signal, privateInputs: Object.create(null) };
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
        ...(resolutions ? { resolutions } : {}) }, controls);
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
          const currentResolutions = resolutionsFile ? readRegularFile(resolutionsFile, { maxBytes: 1_000_000 }) : undefined;
          if (!current || sha256(current) !== sha256(bytes) || resolutionsFile && (!currentResolutions || sha256(currentResolutions) !== resolutionsDigest))
            refused('REVIEW_STALE', 'input-file-changed');
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
