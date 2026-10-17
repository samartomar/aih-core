// Portable support presentation over existing public results. Importing or
// calling these functions performs no host access, process execution,
// network, writes or state lookup.
import type { Diagnostic, ValidationResult } from './types.js';
import { validateProducedPreparedWork, validateProducedRunResult } from './internal/produced-validation.js';
import { deriveGuidance, reasonLabel, subjectLabel } from '../harness/guidance.mjs';
import type { GuidanceFact, GuidanceRequest } from '../harness/guidance.mjs';
import { repairIndex } from '../harness/contracts.mjs';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, jsonOwnEntriesV1, STRICT_JSON_MAX_DEPTH_V1 } from './internal/strict-json.js';
import { canonicalJson } from './internal/canonical.js';
import { HOOK_REASONS, isHookConflict, isHookReason } from './internal/hook-guidance.js';

export type SupportPlatform = 'win32' | 'darwin' | 'linux' | 'unknown';
export interface SupportRepairContext { id: string; targets: string[] }
export type SupportInput =
  | { kind: 'inspect'; result: unknown }
  | { kind: 'prepare'; result: unknown; repair?: SupportRepairContext }
  | { kind: 'run'; result: unknown; repair?: SupportRepairContext };
export interface SupportOptions { platform: SupportPlatform }
export interface GuidanceRepairInput { name: string; type: string; description: string }
export interface GuidanceRepair { id: string; targets: string[]; requiredInputs: GuidanceRepairInput[] }
export interface GuidanceItem {
  id: string;
  target: string;
  reason: string;
  audience: 'developer' | 'administrator';
  summary: string;
  steps: string[];
  evidenceIds: string[];
  repairs: GuidanceRepair[];
}
export interface GuidanceResult { status: 'complete' | 'invalid'; items: GuidanceItem[]; diagnostics: Diagnostic[] }
export interface SupportMarkdownResult { status: 'rendered' | 'invalid'; markdown?: string; diagnostics: Diagnostic[] }

const invalid = (): Diagnostic => ({ code: 'INPUT_INVALID', reason: 'support-input', message: 'Use a supported public result.' });
const unsupported = (): Diagnostic => ({ code: 'SCHEMA_UNSUPPORTED', reason: 'schema-id', message: 'This result format is not supported.' });
type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const oneOf = (value: unknown, choices: readonly string[]): boolean => typeof value === 'string' && choices.includes(value);
const number = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fields = (value: unknown, names: readonly string[]): value is Data => object(value) && names.every(name => typeof value[name] === 'string');
const list = (value: unknown, check: (item: unknown) => boolean): value is Data[] => Array.isArray(value) && value.every(check);
const diagnostics = (value: unknown): value is Data[] => list(value, item => fields(item, ['code', 'reason', 'message']));
const effective = (value: unknown, check: (item: unknown) => boolean): boolean => object(value) && oneOf(value.origin, ['default', 'explicit']) && check(value.value);
const outcomes = ['passed', 'failed', 'unavailable', 'skipped'];

// Inspection results and the Prepare wrapper have no published schema or owning
// validator, so their minimal shape checks stay here. Every prepared review and
// run result is admitted only by the validator that owns its exact schema ID.
function record(value: unknown): boolean {
  return object(value) && (value.status === 'written' ? typeof value.reference === 'string' :
    value.status === 'disabled' ? value.reason === 'logging-off' : value.status === 'failed' &&
      oneOf(value.reason, ['record-limit', 'record-write']) && typeof value.diagnosticId === 'string');
}
function inspectResult(value: Data): boolean {
  return oneOf(value.status, ['complete', 'incomplete', 'invalid', 'cancelled']) && !Object.hasOwn(value, 'schema') &&
    fields(value.package, ['name', 'version']) && list(value.tools, item => fields(item, ['id', 'label', 'state', 'selection'])) &&
    list(value.observations, item => fields(item, ['id', 'target', 'detail'])) &&
    list(value.checks, item => fields(item, ['id', 'target', 'reason', 'detail']) && oneOf(item.outcome, outcomes)) &&
    Array.isArray(value.repairChoices) && diagnostics(value.diagnostics) && strings(value.followUp) &&
    object(value.effectiveOptions) && effective(value.effectiveOptions.targets, item => item === 'detected' || strings(item)) &&
    effective(value.effectiveOptions.network, item => oneOf(item, ['declared', 'off'])) &&
    effective(value.effectiveOptions.probeConfiguredMcp, item => typeof item === 'boolean') && effective(value.effectiveOptions.budgetMs, number) &&
    object(value.limits) && ['budgetMs', 'elapsedMs', 'maxActiveProbes'].every(key => number(value.limits && (value.limits as Data)[key]));
}
/** The Prepare wrapper has no published schema; its review is admitted separately by schema ID. */
function preparationWrapper(value: Data): boolean {
  return oneOf(value.status, ['ready', 'partial', 'blocked', 'invalid', 'cancelled']) && typeof value.runId === 'string' &&
    diagnostics(value.diagnostics) && record(value.record);
}
/**
 * Admission through the validator that owns the exact schema ID. Only an unknown
 * top-level ID is unsupported; a known ID that fails its contract is malformed.
 */
function admit(check: (value: unknown) => ValidationResult, value: unknown): Diagnostic | undefined {
  const result = check(value);
  if (result.valid) return undefined;
  return result.diagnostics.some(item => item.code === 'SCHEMA_UNSUPPORTED' && item.path === '/schema') ? unsupported() : invalid();
}
/** Guidance classification: only policy work carries authored identifiers; other families are Core-defined work. */
const guidanceUseCase = (useCase: unknown): 'policy' | 'repair' => useCase === 'policy' ? 'policy' : 'repair';

/** Count canonical bytes with shared subtrees memoized before recursive assertion/serialization. */
function assertCanonicalBound(value: unknown): void {
  const encoder = new TextEncoder();
  const seen = new WeakMap<object, number>(), active = new WeakSet<object>();
  function size(item: unknown): number {
    if (!object(item) && !Array.isArray(item)) {
      if (item !== null && !['string', 'boolean', 'number'].includes(typeof item)) throw new TypeError('non-JSON value');
      return encoder.encode(JSON.stringify(item)).length;
    }
    const node = item as object;
    if (active.has(node)) throw new TypeError('cyclic input');
    const previous = seen.get(node);
    if (previous !== undefined) return previous;
    active.add(node);
    const entries = Object.entries(node);
    let bytes = 2 + Math.max(0, entries.length - 1);
    for (const [key, child] of entries) {
      bytes += (Array.isArray(node) ? 0 : encoder.encode(JSON.stringify(key)).length + 1) + size(child);
      if (bytes > 1_000_000) throw new TypeError('document byte limit');
    }
    active.delete(node); seen.set(node, bytes); return bytes;
  }
  if (size(value) > 1_000_000) throw new TypeError('document byte limit');
}

interface Adapted { kind: SupportInput['kind']; result: Data; request: GuidanceRequest }
/** Snapshot descriptors before any field read. The live handle is neither read nor cloned. */
function adapt(input: SupportInput, options: SupportOptions): Adapted | Diagnostic {
  try {
    if (!object(input) || !object(options)) return invalid();
    const wrapper = Object.fromEntries(jsonOwnEntriesV1(input, 'support input'));
    const optionData = cloneJsonValueStructureV1(options, 'support options', STRICT_JSON_MAX_DEPTH_V1);
    assertStrictJsonValueV1(optionData, 'support options');
    if (Object.keys(optionData).length !== 1 || !oneOf(optionData.platform, ['win32', 'darwin', 'linux', 'unknown']) ||
        !oneOf(wrapper.kind, ['inspect', 'prepare', 'run']) || !object(wrapper.result) ||
        Object.keys(wrapper).some(key => !['kind', 'result', 'repair'].includes(key)) ||
        (wrapper.kind === 'inspect' && Object.hasOwn(wrapper, 'repair'))) return invalid();
    if (wrapper.kind === 'prepare') {
      const prototype = Object.getPrototypeOf(wrapper.result);
      if (prototype !== Object.prototype && prototype !== null) return invalid();
      const serializable: Data = {};
      for (const key of Reflect.ownKeys(wrapper.result)) {
        const descriptor = Object.getOwnPropertyDescriptor(wrapper.result, key);
        if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) return invalid();
        if (key === 'prepared') continue;
        if (!descriptor.enumerable) return invalid();
        Object.defineProperty(serializable, key, { value: descriptor.value, enumerable: true });
      }
      wrapper.result = serializable;
    }
    const snapshot = cloneJsonValueStructureV1(wrapper, 'support input', STRICT_JSON_MAX_DEPTH_V1);
    assertCanonicalBound(snapshot);
    assertStrictJsonValueV1(snapshot, 'support input');
    if (new TextEncoder().encode(canonicalJson(snapshot)).length > 1_000_000) return invalid();
    const result = snapshot.result as Data;
    const kind = snapshot.kind as SupportInput['kind'];
    // An unknown result format is reported before the remaining wrapper shape.
    const refused = kind === 'run' ? admit(validateProducedRunResult, result) :
      kind === 'prepare' && Object.hasOwn(result, 'review') ? admit(validateProducedPreparedWork, result.review) : undefined;
    if (refused?.code === 'SCHEMA_UNSUPPORTED') return refused;
    if (refused || (kind === 'inspect' && !inspectResult(result)) || (kind === 'prepare' && !preparationWrapper(result))) return invalid();
    const useCase = kind === 'inspect' ? undefined : kind === 'run' ? guidanceUseCase(result.useCase) :
      object(result.review) ? guidanceUseCase(result.review.useCase) : snapshot.repair ? 'repair' : 'policy';
    let repair: SupportRepairContext | undefined;
    if (Object.hasOwn(snapshot, 'repair')) {
      const context = snapshot.repair;
      if (!fields(context, ['id']) || Object.keys(context).length !== 2 || !strings(context.targets) || !context.targets.length ||
          new Set(context.targets).size !== context.targets.length) return invalid();
      const definition = repairIndex.find(entry => entry.id === context.id);
      if (!definition || !definition.variants.some(variant =>
          (optionData.platform === 'unknown' || variant.os === optionData.platform) &&
          variant.targets.length === (context.targets as string[]).length && (context.targets as string[]).every(target => variant.targets.includes(target)))) return invalid();
      repair = { id: context.id as string, targets: context.targets };
    }
    const facts: GuidanceFact[] = [{ kind: 'status', evidenceId: kind === 'run' ? '/completion' : '/status', value: (kind === 'run' ? result.completion : result.status) as string }];
    const each = (value: unknown, visit: (item: Data, index: number) => void) => { if (Array.isArray(value)) value.forEach((item: Data, index) => visit(item, index)); };
    if (kind === 'inspect') {
      each(result.tools, (item, index) => facts.push({ kind: 'tool', evidenceId: `/tools/${index}`, target: item.id as string, state: item.state as string, selection: item.selection as string }));
      each(result.observations, (item, index) => facts.push({ kind: 'observation', evidenceId: `/observations/${index}`, target: item.target as string, id: item.id as string }));
    }
    each(result.checks, (item, index) => facts.push({ kind: 'check', evidenceId: `/checks/${index}`,
      ...(kind === 'inspect' || useCase === 'repair' ? { id: item.id as string } : {}),
      ...(kind === 'inspect' ? { target: item.target as string } : {}), outcome: (kind === 'inspect' ? item.outcome : item.status) as string,
      reason: useCase === 'policy' ? '' : item.reason as string }));
    each(result.diagnostics, (item, index) => facts.push({ kind: 'diagnostic', evidenceId: `/diagnostics/${index}`, code: item.code as string, reason: item.reason as string }));
    if (kind === 'run') each(result.operations, (item, index) => facts.push({ kind: 'operation', evidenceId: `/operations/${index}`,
      ...(useCase === 'repair' ? { id: item.id as string } : {}),
      application: item.application as string, verification: (item.verification as Data).status as string,
      reason: typeof item.reason === 'string' ? item.reason : (item.verification as Data).reason as string }));
    if (kind === 'prepare' && object(result.review)) {
      for (const name of ['conflicts', 'omissions']) each(result.review[name], (item, index) => facts.push({ kind: 'diagnostic', evidenceId: `/review/${name}/${index}`, code: item.code as string, reason: item.reason as string }));
      each(result.review.operations, (item, index) => {
        if (['conflict', 'unavailable'].includes(item.effects as string)) facts.push({ kind: 'operation', evidenceId: `/review/operations/${index}`,
          ...(useCase === 'repair' ? { id: item.id as string } : {}),
          application: 'not-attempted', verification: 'unavailable', scope: item.scope as 'user' | 'project',
          reason: useCase === 'policy' ? item.effects === 'conflict' ? 'conflict' : 'prerequisite-unavailable' : typeof (item.details as Data).reason === 'string' ? (item.details as Data).reason as string : 'prerequisite-unavailable' });
      });
    }
    return { kind, result, request: { kind, platform: optionData.platform, facts, ...(useCase ? { useCase } : {}), ...(repair ? { repair } : {}) } };
  } catch { return invalid(); }
}

/** Generic guidance plus fixed hook-group recovery items; no observed group content is read. */
function derive(adapted: Adapted): GuidanceItem[] {
  const generic = deriveGuidance(adapted.request) as GuidanceItem[];
  const review = adapted.kind === 'prepare' && object(adapted.result.review) ? adapted.result.review : undefined;
  if (!review || !Array.isArray(review.operations)) return generic;
  const specific: GuidanceItem[] = []; const covered = new Set<string>();
  (review.operations as Data[]).forEach((operation, index) => {
    const reason = object(operation.details) ? operation.details.reason : undefined;
    if (operation.kind !== 'hook.group' || operation.effects !== 'conflict' || !isHookReason(reason)) return;
    const guidance = HOOK_REASONS[reason]!;
    covered.add(`/review/operations/${index}`);
    specific.push({ id: 'hook-group-conflict', target: 'policy', reason, audience: 'developer', summary: guidance.summary,
      steps: [...guidance.steps], evidenceIds: [`/review/operations/${index}`], repairs: [] });
  });
  if (!specific.length) return generic;
  (review.conflicts as Data[]).forEach((item, index) => { if (isHookConflict(item)) covered.add(`/review/conflicts/${index}`); });
  (adapted.result.diagnostics as Data[]).forEach((item, index) => { if (isHookConflict(item)) covered.add(`/diagnostics/${index}`); });
  const kept = generic.filter(item => !(item.id === 'diagnostic-review' && item.evidenceIds.some(id => covered.has(id))));
  return [...kept.filter(item => item.audience === 'developer'), ...specific, ...kept.filter(item => item.audience === 'administrator')];
}

export function getGuidance(input: SupportInput, options: SupportOptions): GuidanceResult {
  const adapted = adapt(input, options);
  if ('code' in adapted) return { status: 'invalid', items: [], diagnostics: [adapted] };
  return { status: 'complete', items: derive(adapted), diagnostics: [] };
}

/**
 * All strings that remain after allowlisting are escaped, including shipped metadata.
 * CommonMark backslash escapes keep the raw file reviewable before sharing; control,
 * line-separator and bidirectional-override characters are replaced, not encoded.
 */
function escape(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '\uFFFD')
    .replace(/[&<>"'\\`*_[\]{}()#+.!|~\-]/g, char => `\\${char}`);
}
function identity(value: unknown): string {
  if (!fields(value, ['name', 'version']) || value.name !== '@aihq/core' ||
      !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/.test(value.version as string) ||
      (value.version as string).length > 128) return 'unavailable';
  return `${escape(value.name as string)} ${escape(value.version as string)}`;
}
export function renderSupportMarkdown(input: SupportInput, options: SupportOptions): SupportMarkdownResult {
  const adapted = adapt(input, options);
  if ('code' in adapted) return { status: 'invalid', diagnostics: [adapted] };
  const { kind, result } = adapted;
  const items = derive(adapted);
  // Policy and legacy repair bindings carry the package directly; trust and macOS session bindings carry it under `trust`.
  const bound = (inputs: unknown) => !object(inputs) ? undefined : object(inputs.trust) ? inputs.trust.package : inputs.package;
  const packageData = kind === 'inspect' ? result.package : kind === 'prepare' ?
    object(result.review) ? bound(result.review.inputs) : undefined : bound(result.inputs);
  const checks = Array.isArray(result.checks) ? result.checks as Data[] : [];
  const operations = Array.isArray(result.operations) ? result.operations : object(result.review) && Array.isArray(result.review.operations) ? result.review.operations : [];
  const lines = ['# Support report\n', `Package: ${identity(packageData)}\n`, `Result: ${kind}\n`,
    `Status: ${escape((kind === 'run' ? result.completion : result.status) as string)}\n`,
    `Counts: ${checks.length} checks; ${operations.length} operations; ${(result.diagnostics as unknown[]).length} diagnostics; ${items.length} guidance items.\n`,
    'Application or presence is not verification. Partial, incomplete or cancelled results require review of completed effects and missing verification.\n',
    'Review this report before sharing it. Repair suggestions require a separate fresh preparation, review and explicit authorization.\n'];
  let bytes = new TextEncoder().encode(lines.join('\n')).length;
  let omitted = 0;
  const append = (line: string) => {
    const size = new TextEncoder().encode(`\n${line}`).length;
    if (bytes + size > 256 * 1024 - 256) { omitted++; return; }
    lines.push(line); bytes += size;
  };
  // Guidance precedes potentially large outcome lists, so all returned actions stay together.
  for (const audience of ['developer', 'administrator'] as const) {
    append(`## ${audience === 'developer' ? 'Developer' : 'Administrator'} actions\n`);
    const selected = items.filter(item => item.audience === audience);
    if (!selected.length) append('No actions derived.\n');
    for (const item of selected) {
      append(`### ${escape(item.summary)}\n\n` + item.steps.map((step, index) => `${index + 1}. ${escape(step)}`).join('\n') + '\n' +
        item.repairs.map(repair => `\nRepair suggestion: ${escape(repair.id)}; targets: ${repair.targets.map(escape).join(', ')}.\n` +
          repair.requiredInputs.map(field => `- ${escape(field.name)} (${escape(field.type)}): ${escape(field.description)}`).join('\n')).join(''));
    }
  }
  append('## Check outcomes\n');
  for (const [index, check] of checks.entries()) {
    const target = kind === 'inspect' ? subjectLabel(check.target as string) : undefined;
    const reason = reasonLabel(check.reason as string);
    append(`Check ${index + 1}: ${escape((kind === 'inspect' ? check.outcome : check.status) as string)}; ` +
      `${kind === 'inspect' ? target && reason ? `${escape(target)}; ${escape(reason)}` : 'unrecognized diagnostic' :
        reason ? escape(reason) : 'unrecognized diagnostic'}.\n`);
  }
  if (omitted) lines.push(`\n${omitted} additional report sections were omitted to keep the report within 256 KiB. Review the remaining evidence locally.\n`);
  return { status: 'rendered', markdown: lines.join('\n'), diagnostics: [] };
}
