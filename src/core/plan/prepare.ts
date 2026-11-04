// Prepare for a plan request (contract 7, 8.1): admit the request, lower its steps into the one existing engine, and
// present the engine's review as a frozen 0.1.0 review whose digest the person approves.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { prepare as prepareEngine, type EngineExtension, type ObservedStep } from '../recipe-engine.js';
import { blockMemberBytes, configMemberBytes, tomlEntryPaths, tomlEntryText } from '../internal/recipe-editors.js';
import { canonicalJson, codeUnitCompare } from '../internal/canonical.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState } from '../internal/state.js';
import { checkPlanRequest, type CheckedStep } from './request.js';
import { register, type StepRef } from './handles.js';
import { limitValue } from './limits.js';
import type { PlanItemFacts } from '../internal/custody-items.js';
import type { Lowered, LoweredMerge } from './steps/types.js';
import type { ExecutionPolicy, Json, Recipe } from '../types.js';
import type { PreparationResult } from '../host-types.js';
import { REVIEW, type PlanControls, type PlanPreparation, type Problem, type Review, type ReviewConflict, type ReviewStep } from './types.js';

export const FAILURE_RULE = 'A failed step stops the rest of its item and every item that depends on it; unrelated items continue.';
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const RECIPE = 'urn:aihq:core:recipe:1.0.0';
const POLICY = 'urn:aihq:core:execution-policy:1.0.0';

/** Validates plan controls; only cancellation and logging reach the engine. */
export function planControls(controls: unknown): PlanControls | undefined {
  if (controls === undefined) return {};
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) return undefined;
  const value = controls as PlanControls;
  if (Object.keys(value).some(key => !['signal', 'logging', 'privateInputs', 'catalog', 'onProgress'].includes(key))) return undefined;
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) return undefined;
  if (value.logging !== undefined && !['on', 'off'].includes(value.logging)) return undefined;
  if (value.catalog !== undefined && (!value.catalog || typeof value.catalog !== 'object' || typeof value.catalog.version !== 'string')) return undefined;
  if (value.onProgress !== undefined && typeof value.onProgress !== 'function') return undefined;
  return value;
}
export const engineControls = (controls: PlanControls) => ({ ...(controls.signal ? { signal: controls.signal } : {}),
  ...(controls.logging ? { logging: controls.logging } : {}) });
export const problemsOf = (result: PreparationResult): Problem[] =>
  result.diagnostics.map(item => ({ path: item.path ?? '', reason: item.reason, message: item.message }));
/** The review digest: the presented review together with the engine review it carries out. */
export const digestOf = (review: Omit<Review, 'reviewDigest'>, engineDigest: string): string =>
  sha256(canonicalJson({ review: review as unknown as Json, engineDigest }));

interface Group { selectionId: string; managementId: string; scope: 'project' | 'user'; steps: CheckedStep[] }

export async function preparePlan(input: unknown, rawControls?: unknown): Promise<PlanPreparation> {
  forgetProvenState();
  const controls = planControls(rawControls);
  if (!controls) return { status: 'invalid', problems: [{ path: '', reason: 'controls', message: 'The plan controls are not valid.' }] };
  if (controls.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  const admitted = checkPlanRequest(input, controls);
  if ('status' in admitted) return admitted;
  const { checked } = admitted;
  const request = checked.document;
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  let project: string | null;
  try { project = typeof request.target.project === 'string' ? projectRoot(request.target.project) : null; }
  catch { return { status: 'invalid', problems: [{ path: '/target/project', reason: 'project', message: 'The project folder is not usable.' }] }; }

  // One selection per management id and scope (C48), its writes in plan order.
  const groups = new Map<string, Group>();
  for (const step of checked.steps) if (!step.skipped) for (const managementId of step.lowered.managementIds) {
    const scope = step.lowered.root === 'project' ? 'project' : 'user';
    if (scope === 'project' && project === null) return { status: 'invalid', problems: [{ path: `/plan/plan/${step.index}/root`,
      reason: 'project', message: 'A project-rooted step needs the request to name its project.' }] };
    const id = `${scope}\0${managementId}`;
    let group = groups.get(id);
    if (!group) groups.set(id, group = { selectionId: `s${groups.size}`, managementId, scope, steps: [] });
    group.steps.push(step);
  }
  const supplied = new Map<string, NonNullable<EngineExtension['supplied']> extends ReadonlyMap<string, infer V> ? V : never>();
  const plans = new Map<string, PlanItemFacts>();
  const operations = new Map<string, StepRef>();
  const merges = new Map<string, { format: 'json' | 'toml' | 'markdown'; segments: string[] }>();
  const selections: ExecutionPolicy['selections'] = [];
  for (const group of groups.values()) {
    const materials: { id: string; path: string; sha256: string; byteLength: number; bytes: Buffer }[] = [];
    const ops: Recipe['operations'] = group.steps.map(step => {
      const id = `step-${step.index}`;
      operations.set(`${group.selectionId}/${id}`, { step: step.index, managementId: group.managementId });
      const lowered = step.lowered;
      const target = { root: group.scope === 'project' ? 'project' as const : 'userHome' as const, segments: lowered.path.split('/').map(literal => ({ literal })) };
      const base = { id, purpose: lowered.sentence, scope: group.scope, target, requires: [], checks: [] };
      if (lowered.kind === 'merge') {
        merges.set(`${group.selectionId}/${id}`, { format: lowered.format, segments: lowered.segments });
        if (lowered.format === 'markdown') return { ...base, kind: 'text.block' as const, blockId: lowered.key, ...markers(lowered.key),
          action: 'set' as const, content: { literal: lowered.entry } };
        return { ...base, kind: 'config.entries' as const, format: lowered.format === 'json' ? 'jsonc' as const : 'toml' as const,
          entries: lowered.format === 'json' ? [{ path: lowered.segments, action: 'set' as const, value: { literal: lowered.entry } }] :
            lowered.leaves!.map(leaf => ({ path: [...lowered.segments, ...leaf.path], action: 'set' as const, value: { literal: leaf.value } })) };
      }
      const material = { id: `m${String(materials.length).padStart(6, '0')}`, path: `plan/${materials.length}`, sha256: sha256(lowered.bytes),
        byteLength: lowered.bytes.length, bytes: lowered.bytes };
      materials.push(material);
      return { ...base, kind: 'file.write' as const, material: material.id, ...(lowered.executable ? { mode: 0o755 } : {}) };
    });
    const recipe: Recipe = { schema: RECIPE, id: 'plan', description: 'Content from a plan request', inputs: {},
      materials: materials.map(({ id, path, sha256: digest, byteLength }) => ({ id, path, sha256: digest, byteLength, source: { kind: 'local', input: 'plan' } })),
      targets: [group.scope], prerequisites: [], operations: ops, checks: [] };
    const owned = materials.map(({ id, path, sha256: digest, byteLength }) => Object.freeze({ id, path, sha256: digest, byteLength }));
    const bytes = new Map(materials.map(material => [material.id, material.bytes]));
    supplied.set(group.selectionId, Object.freeze({ materials: Object.freeze(owned),
      readMaterial: (id: string) => { const found = bytes.get(id); return found ? Buffer.from(found) : undefined; },
      recheck: async () => true }));
    const clis = [...new Set(group.steps.flatMap(step => step.lowered.review.clis ?? []))].sort(codeUnitCompare);
    plans.set(group.selectionId, { items: [group.managementId], clis, data: request.plan.data === null ? null : { ...request.plan.data },
      origin: 'chosen', catalog: controls.catalog?.version ?? null,
      profiles: checked.profiles.filter(profile => clis.includes(profile.id)).sort((a, b) => codeUnitCompare(a.id, b.id)),
      steps: [...new Set(group.steps.map(step => step.index))].sort((a, b) => a - b) });
    selections.push({ id: group.selectionId, managementId: group.managementId, scope: group.scope, configuration: {}, requires: [],
      recipe: { inline: recipe } });
  }
  const resolutions = (request.resolutions ?? []).filter(item => item.choice !== 'skip').flatMap(item => {
    const group = [...groups.values()].find(entry => entry.managementId === item.managementId && entry.steps.some(step => step.index === item.step));
    return group ? [{ selectionId: group.selectionId, operationId: `step-${item.step}`, choice: item.choice as 'replace' | 'adopt',
      observedSha256: item.observedSha256 }] : [];
  });
  const observed = new Map<string, ObservedStep>();
  const engine = await prepareEngine({ useCase: 'policy', policy: { schema: POLICY, mode: 'vibe', selections },
    target: { project: project ?? home }, ...(resolutions.length ? { resolutions } : {}) }, engineControls(controls),
    undefined, undefined, undefined, undefined, undefined,
    { supplied, plans, merges, observe: facts => { observed.set(`${facts.selectionId}/${facts.operationId}`, facts); } });
  if (engine.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  if (!engine.review) {
    if (engine.diagnostics.some(item => item.reason === 'custody-record-limit'))
      return { status: 'refused', code: 'limit-exceeded', reason: 'The receipts this install needs would pass their limit.',
        limit: 'receipt-bytes', value: limitValue('receipt-bytes') };
    return { status: 'invalid', problems: problemsOf(engine) };
  }

  const hints = new Map((engine.resolutionInputs ?? []).map(item => [`${item.selectionId}/${item.operationId}`, item]));
  const chosen = new Map(resolutions.map(item => [`${item.selectionId}/${item.operationId}`, item.choice]));
  const conflicts: ReviewConflict[] = [];
  const steps: ReviewStep[] = [];
  const byStep = new Map<number, CheckedStep>(checked.steps.map(step => [step.index, step]));
  // Codex reads at most 32 KiB of AGENTS.md: the resulting file, your bytes plus every planned block, is checked before any write (C72).
  const guidance = new Map<string, { step: number; path: string; size: number }>();
  for (const operation of engine.review.operations) {
    const ref = operations.get(operation.id);
    if (!ref) continue;
    const step = byStep.get(ref.step)!;
    const lowered = step.lowered;
    const facts = observed.get(operation.id);
    const hint = hints.get(operation.id);
    // Identical bytes Core didn't write are still yours until you choose to adopt them.
    const unresolvedAdopt = operation.effects === 'already-satisfied' && !!hint?.availableChoices.includes('adopt') && !chosen.has(operation.id);
    const conflict = operation.effects === 'conflict' || operation.effects === 'unavailable' || unresolvedAdopt;
    const effect: ReviewStep['effect'] = conflict ? 'conflict' :
      ['create-file', 'replace-file', 'already-satisfied'].includes(operation.effects) ? operation.effects as ReviewStep['effect'] : 'unchanged';
    const replacing = !conflict && chosen.get(operation.id) === 'replace' && effect === 'replace-file';
    const sentence = !replacing ? lowered.sentence : lowered.kind === 'merge' ?
      `${lowered.sentence}, replacing your ${lowered.format === 'markdown' ? 'block' : 'entry'}; your original is kept for restore` :
      `${lowered.sentence}, replacing your file; your original is kept for restore`;
    steps.push({ step: ref.step, op: step.op, managementId: ref.managementId, sentence, cantPromise: lowered.cantPromise, effect,
      root: lowered.root, path: lowered.path, ...lowered.review, ...(lowered.kind === 'merge' ? { entry: presentedEntry(lowered) } : {}) });
    if (lowered.kind === 'merge' && lowered.codexGuidance && !conflict && facts?.after)
      guidance.set(`${lowered.root}\0${lowered.path}`, { step: ref.step, path: lowered.path, size: facts.after.length });
    if (!conflict) continue;
    const before = facts?.before ?? null;
    const reason = facts?.reason;
    const kept = reason === 'managed-content-changed';
    const editor = !!reason && !['existing-content', 'managed-content-changed', 'shared-member', 'overlapping-member'].includes(reason);
    const choices: ReviewConflict['choices'] = kept ? [] : unresolvedAdopt ? ['adopt', 'skip'] :
      editor ? ['skip'] : [...(hint?.availableChoices ?? []), 'skip'];
    const shown = presentExisting(lowered, before);
    conflicts.push({ code: 'STATE_CONFLICT', reason: kept ? 'managed-content-changed' : 'existing-content', managementId: ref.managementId,
      step: ref.step, target: lowered.path, ...(lowered.kind === 'merge' ? { key: lowered.key } : {}),
      observedSha256: before === null ? null : sha256(before), existing: shown.text, redacted: shown.redacted, choices,
      ...(facts?.stale ? { detail: 'resolution-stale' } : editor ? { detail: reason! } : {}) });
  }
  for (const found of guidance.values()) if (found.size > CODEX_GUIDANCE_BYTES)
    return { status: 'refused', code: 'file-too-large-for-client', step: found.step, file: found.path, size: found.size, value: CODEX_GUIDANCE_BYTES,
      reason: `\`${found.path}\` would be ${found.size} bytes with your bytes and the planned blocks; Codex reads at most ${CODEX_GUIDANCE_BYTES}.` };
  for (const step of checked.steps) if (step.skipped) for (const managementId of step.lowered.managementIds)
    steps.push({ step: step.index, op: step.op, managementId, sentence: step.lowered.sentence, cantPromise: step.lowered.cantPromise,
      effect: 'skipped', root: step.lowered.root, path: step.lowered.path, ...step.lowered.review,
      ...(step.lowered.kind === 'merge' ? { entry: presentedEntry(step.lowered) } : {}) });
  steps.sort((a, b) => a.step - b.step || codeUnitCompare(a.managementId, b.managementId));
  const { plan: _steps, ...reports } = request.plan;
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'plan', scope: request.scope, target: { project },
    plan: reports, origin: 'chosen', originNote: request.plan.recipe ? 'origin not proven' : null, steps, conflicts,
    ignoredFiles: checked.ignoredFiles, failureRule: FAILURE_RULE, warnings: [] };
  const reviewDigest = digestOf(body, engine.review.reviewDigest);
  const review = deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review;
  // Unowned content needs the person's choice and a new Prepare: no handle (section 7).
  if (conflicts.some(conflict => conflict.reason === 'existing-content')) return { status: 'blocked', review };
  if (!engine.prepared) return { status: 'blocked', review };
  const partial = engine.status === 'partial' || checked.steps.some(step => step.skipped);
  const handle = register({ engine: engine.prepared, engineDigest: engine.review.reviewDigest, enginePartial: engine.status === 'partial',
    reviewDigest, partial, operations,
    request: { value: input, documentDigest: checked.documentDigest, bytesDigest: checked.bytesDigest } });
  return { status: partial ? 'partial' : 'ready', review, handle };
}

const CODEX_GUIDANCE_BYTES = 32 * 1024;
const REDACTED = '[REDACTED]';
const markers = (key: string) => ({ startMarker: `<!-- aih:begin ${key} -->`, endMarker: `<!-- aih:end ${key} -->` });
const pointerOf = (segments: string[]): string => segments.map(segment => '/' + segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('');
const under = (path: string[], prefix: string[]): boolean => path.length > prefix.length && prefix.every((part, at) => part === path[at]);

/** The planned entry as the review shows it: its known secret slots read `[REDACTED]`. */
function presentedEntry(lowered: LoweredMerge): Json {
  if (lowered.format === 'markdown') return lowered.entry;
  const entry = structuredClone(lowered.entry);
  for (const secret of lowered.secrets) {
    const relative = secret.slice(lowered.segments.length);
    let node: Json = entry;
    for (const [at, segment] of relative.entries()) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, segment)) break;
      if (at === relative.length - 1) node[segment] = REDACTED; else node = node[segment]!;
    }
  }
  return entry;
}

/**
 * A conflict's existing bytes, exactly as they are on disk: the entry at the pointer, the table's text or the marked
 * block for a merge, the whole file for a write. Known secret slots read `[REDACTED]`; the observed digest still binds
 * the real bytes. Bytes that are not text, or a file over 1 MiB, are not presented (`null`).
 */
function presentExisting(lowered: Lowered, before: Buffer | null): { text: string | null; redacted: string[] } {
  if (before === null) return { text: null, redacted: [] };
  try {
    if (lowered.kind === 'write') return { text: before.length <= 1_048_576 ? new TextDecoder('utf-8', { fatal: true }).decode(before) : null, redacted: [] };
    if (lowered.format === 'markdown') {
      const block = blockMemberBytes(before, { blockId: lowered.key, ...markers(lowered.key), action: 'remove' });
      return { text: block?.toString('utf8') ?? null, redacted: [] };
    }
    if (lowered.format === 'toml') {
      const present = new Set(tomlEntryPaths(before, lowered.segments).assignments.map(path => JSON.stringify(path)));
      const hidden = lowered.secrets.filter(path => present.has(JSON.stringify(path)));
      return { text: tomlEntryText(before, lowered.segments, hidden), redacted: hidden.map(pointerOf) };
    }
    const member = configMemberBytes('jsonc', before, lowered.segments);
    if (member === null) return { text: null, redacted: [] };
    let text = member.toString('utf8');
    const tree = parseTree(text);
    const spans = lowered.secrets.filter(path => under(path, lowered.segments)).flatMap(path => {
      const node = tree && findNodeAtLocation(tree, path.slice(lowered.segments.length));
      return node ? [{ path, offset: node.offset, length: node.length }] : [];
    }).sort((a, b) => b.offset - a.offset);
    for (const span of spans) text = text.slice(0, span.offset) + JSON.stringify(REDACTED) + text.slice(span.offset + span.length);
    return { text, redacted: spans.map(span => pointerOf(span.path)).sort(codeUnitCompare) };
  } catch { return { text: null, redacted: [] }; }
}
