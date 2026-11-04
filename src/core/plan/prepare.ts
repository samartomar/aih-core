// Prepare for a plan request (contract 7, 8.1): admit the request, lower its steps into the one existing engine, and
// present the engine's review as a frozen 0.1.0 review whose digest the person approves.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { prepare as prepareEngine, type EngineExtension } from '../recipe-engine.js';
import { canonicalJson, codeUnitCompare } from '../internal/canonical.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState, readOwnership } from '../internal/state.js';
import { checkPlanRequest, type CheckedStep } from './request.js';
import { register, type StepRef } from './handles.js';
import { limitValue } from './limits.js';
import { acquisition } from './acquire/effect.js';
import { probe } from './acquire/download.js';
import { discoverInterpreter } from './acquire/interpreter.js';
import { FALLBACK_REASONS, type AcquireFacts, type InstalledInterpreter } from './acquire/types.js';
import type { PlanItemFacts } from '../internal/custody-items.js';
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

  // AI setups (8.1, C36, C46): a download this host's trust rejects is refused now, naming the repair; a Python tool's
  // installed interpreter inside its range is found now, so the review shows both branches.
  const installed = new Map<number, InstalledInterpreter | null>();
  const probed = new Map<string, 'ok' | 'tls-untrusted'>();
  for (const step of checked.steps) {
    const spec = step.lowered.acquire;
    if (!spec || step.skipped) continue;
    for (const item of [spec.artifact, ...spec.closure, ...(spec.interpreter ? [spec.interpreter.fallback] : [])]) {
      const origin = new URL(item.url).origin;
      if (!probed.has(origin)) probed.set(origin, await probe(item.url, controls.signal));
      if (controls.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
      if (probed.get(origin) === 'tls-untrusted') return { status: 'refused', code: 'tls-untrusted', step: step.index, repair: 'node-npm-ca',
        reason: `Step ${step.index} downloads from ${origin}, whose certificate this machine does not trust. Run the \`node-npm-ca\` repair, then Prepare again.` };
    }
    if (spec.interpreter) installed.set(step.index, await discoverInterpreter(spec.interpreter.range, controls.signal));
  }
  const acquired = new Map<number, AcquireFacts>();
  const effects = new Map<string, { run(signal?: AbortSignal): Promise<{ status: 'passed' | 'failed' | 'cancelled'; reason: string; effectsUncertain: boolean; facts?: Json }> }>();
  // Acquisition progress goes to the Apply call's `onProgress` (C38), which Apply sets here.
  const sink: { onProgress?: (event: Json) => void } = {};
  const progress = (event: Json) => { try { sink.onProgress?.(event); } catch { /* a caller's progress handler never stops the run */ } };
  // Interpreter facts an earlier install recorded, kept when the same AI setup is already in place.
  const recorded = new Map<string, NonNullable<PlanItemFacts['aiSetup']>>();
  if (checked.steps.some(step => step.lowered.acquire)) for (const item of Object.values(readOwnership(home).value.items ?? {}))
    if (item.scope === 'user' && item.plan?.aiSetup) recorded.set(item.managementId, item.plan.aiSetup);
  // Items that depend on another planned item (Catalog `dependencies`, or the MCP item that starts an AI setup's
  // executable) are not attempted when it fails (C60).
  const dependencies = new Map<string, Set<string>>();
  const needs = (id: string, on: string) => { const set = dependencies.get(id) ?? new Set<string>(); set.add(on); dependencies.set(id, set); };
  for (const content of request.contents as unknown as { items?: { id?: unknown; dependencies?: unknown; aiSetup?: { mcpItem?: unknown } }[] }[])
    for (const item of Array.isArray(content.items) ? content.items : []) {
      if (!item || typeof item.id !== 'string') continue;
      for (const dependency of Array.isArray(item.dependencies) ? item.dependencies : []) if (typeof dependency === 'string') needs(item.id, dependency);
      if (typeof item.aiSetup?.mcpItem === 'string') needs(item.aiSetup.mcpItem, item.id);
    }

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
  const selections: ExecutionPolicy['selections'] = [];
  for (const group of groups.values()) {
    const materials: { id: string; path: string; sha256: string; byteLength: number; bytes: Buffer }[] = [];
    const ops: Recipe['operations'] = group.steps.map((step, at) => {
      const material = { id: `m${String(at).padStart(6, '0')}`, path: `plan/${at}`, sha256: sha256(step.lowered.bytes),
        byteLength: step.lowered.bytes.length, bytes: step.lowered.bytes };
      materials.push(material);
      operations.set(`${group.selectionId}/step-${step.index}`, { step: step.index, managementId: group.managementId });
      return { id: `step-${step.index}`, purpose: step.lowered.sentence, kind: 'file.write', scope: group.scope,
        target: { root: group.scope === 'project' ? 'project' : 'userHome', segments: step.lowered.path.split('/').map(literal => ({ literal })) },
        material: material.id, ...(step.lowered.executable ? { mode: 0o755 } : {}),
        // A failed step makes the rest of its item's steps not attempted (C60).
        requires: at === 0 ? [] : [`step-${group.steps[at - 1]!.index}`], checks: [] };
    });
    for (const step of group.steps) if (step.lowered.acquire) {
      const run = acquisition(step.lowered.acquire, home, installed.get(step.index) ?? null, progress);
      effects.set(`${group.selectionId}/step-${step.index}`, { async run(signal) {
        const outcome = await run.run(signal);
        if (outcome.status === 'passed' && outcome.facts) acquired.set(step.index, outcome.facts as unknown as AcquireFacts);
        return outcome;
      } });
    }
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
      steps: [...new Set(group.steps.map(step => step.index))].sort((a, b) => a - b),
      ...(group.scope === 'user' && recorded.has(group.managementId) && group.steps.some(step => step.lowered.acquire) ?
        { aiSetup: { ...recorded.get(group.managementId)! } } : {}) });
    const requires = [...groups.values()].filter(other => other.managementId !== group.managementId &&
      dependencies.get(group.managementId)?.has(other.managementId)).map(other => other.selectionId);
    selections.push({ id: group.selectionId, managementId: group.managementId, scope: group.scope, configuration: {}, requires,
      recipe: { inline: recipe } });
  }
  const resolutions = (request.resolutions ?? []).filter(item => item.choice !== 'skip').flatMap(item => {
    const group = [...groups.values()].find(entry => entry.managementId === item.managementId && entry.steps.some(step => step.index === item.step));
    return group ? [{ selectionId: group.selectionId, operationId: `step-${item.step}`, choice: item.choice as 'replace' | 'adopt',
      observedSha256: item.observedSha256 }] : [];
  });
  const engine = await prepareEngine({ useCase: 'policy', policy: { schema: POLICY, mode: 'vibe', selections },
    target: { project: project ?? home }, ...(resolutions.length ? { resolutions } : {}) }, engineControls(controls),
    undefined, undefined, undefined, undefined, undefined, { supplied, plans, ...(effects.size ? { effects } : {}) });
  if (engine.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  if (!engine.review) {
    if (engine.diagnostics.some(item => item.reason === 'custody-record-limit'))
      return { status: 'refused', code: 'limit-exceeded', reason: 'The receipts this install needs would pass their limit.',
        limit: 'receipt-bytes', value: limitValue('receipt-bytes') };
    return { status: 'invalid', problems: problemsOf(engine) };
  }

  const hints = new Map((engine.resolutionInputs ?? []).map(item => [`${item.selectionId}/${item.operationId}`, item]));
  const conflicts: ReviewConflict[] = [];
  const steps: ReviewStep[] = [];
  const byStep = new Map<number, CheckedStep>(checked.steps.map(step => [step.index, step]));
  for (const operation of engine.review.operations) {
    const ref = operations.get(operation.id);
    if (!ref) continue;
    const step = byStep.get(ref.step)!;
    const effect: ReviewStep['effect'] = operation.effects === 'unavailable' ? 'conflict' :
      ['create-file', 'replace-file', 'already-satisfied', 'conflict'].includes(operation.effects) ? operation.effects as ReviewStep['effect'] : 'unchanged';
    steps.push({ step: ref.step, op: step.op, managementId: ref.managementId, sentence: step.lowered.sentence, cantPromise: step.lowered.cantPromise,
      effect,
      root: step.lowered.root, path: step.lowered.path, ...step.lowered.review, ...acquireReview(step, installed) });
    if (operation.effects === 'conflict') {
      const hint = hints.get(operation.id);
      const replaceable = !!hint && hint.availableChoices.length > 0;
      conflicts.push({ code: 'STATE_CONFLICT', reason: replaceable ? 'existing-content' : 'managed-content-changed', managementId: ref.managementId,
        step: ref.step, target: step.lowered.path, observedSha256: hint?.observedSha256 ?? null,
        choices: replaceable ? [...hint!.availableChoices, 'skip'] : [] });
    }
  }
  for (const step of checked.steps) if (step.skipped) for (const managementId of step.lowered.managementIds)
    steps.push({ step: step.index, op: step.op, managementId, sentence: step.lowered.sentence, cantPromise: step.lowered.cantPromise,
      effect: 'skipped', root: step.lowered.root, path: step.lowered.path, ...step.lowered.review, ...acquireReview(step, installed) });
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
    reviewDigest, partial, operations, acquired, progress: sink,
    request: { value: input, documentDigest: checked.documentDigest, bytesDigest: checked.bytesDigest } });
  return { status: partial ? 'partial' : 'ready', review, handle };
}

/** An AI setup's review facts (C46): what it downloads, and for a Python tool both interpreter branches. */
function acquireReview(step: CheckedStep, installed: Map<number, InstalledInterpreter | null>): Pick<ReviewStep, 'acquire' | 'interpreter'> {
  const spec = step.lowered.acquire;
  if (!spec) return {};
  const found = installed.get(step.index) ?? null;
  return { acquire: { aiSetup: spec.aiSetup, version: spec.version, cell: spec.cell, kind: spec.kind, qualification: `sha256:${spec.qualification}`,
    artifact: { file: spec.artifact.file, sha256: spec.artifact.sha256 }, into: `${spec.into}/`, members: spec.members.length, closure: spec.closure.length },
  ...(spec.interpreter ? { interpreter: {
    installed: found ? { path: found.path, version: found.version, note: 'in range, not qualified' as const } : null,
    range: spec.interpreter.range,
    fallback: { version: spec.interpreter.fallback.version, file: spec.interpreter.fallback.file, sha256: spec.interpreter.fallback.sha256 },
    switchesOn: found ? FALLBACK_REASONS.filter(reason => reason !== 'none-found') : ['none-found'] } } : {}) };
}
