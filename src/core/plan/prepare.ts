// Prepare for a plan request (contract 7, 8.1): admit the request, lower its steps into the one existing engine, and
// present the engine's review as a frozen 0.1.0 review whose digest the person approves.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { prepare as prepareEngine, type EngineExtension } from '../recipe-engine.js';
import { canonicalJson, codeUnitCompare } from '../internal/canonical.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState } from '../internal/state.js';
import { checkPlanRequest, type CheckedStep } from './request.js';
import { proveOrigin } from './origin.js';
import { register, type StepRef } from './handles.js';
import { limitValue } from './limits.js';
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
  if (value.catalog !== undefined) {
    const catalog = value.catalog;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || typeof catalog.version !== 'string' ||
        catalog.version.length === 0 || catalog.version.length > 64 ||
        Object.keys(catalog).some(key => !['version', 'renderStep', 'planRecipe'].includes(key)) ||
        catalog.renderStep !== undefined && typeof catalog.renderStep !== 'function' ||
        catalog.planRecipe !== undefined && typeof catalog.planRecipe !== 'function') return undefined;
  }
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

/** The supplied profiles for a group's CLIs and every profile its renders record, by id. */
function profilesOf(supplied: { id: string; version: string | number }[], clis: string[], steps: CheckedStep[]) {
  const ids = new Set([...clis, ...steps.flatMap(step => (step.lowered.profiles ?? []).map(profile => profile.id))]);
  return supplied.filter(profile => ids.has(profile.id)).map(profile => ({ ...profile })).sort((a, b) => codeUnitCompare(a.id, b.id));
}

interface Group { selectionId: string; managementId: string; scope: 'project' | 'user'; steps: CheckedStep[] }

export async function preparePlan(input: unknown, rawControls?: unknown): Promise<PlanPreparation> {
  forgetProvenState();
  const controls = planControls(rawControls);
  if (!controls) return { status: 'invalid', problems: [{ path: '', reason: 'controls', message: 'The plan controls are not valid.' }] };
  if (controls.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  const admitted = await checkPlanRequest(input, controls);
  if ('status' in admitted) return admitted;
  const { checked } = admitted;
  const request = checked.document;
  const proven = await proveOrigin(request, controls);
  if ('status' in proven) return proven;
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
        material: material.id, ...(step.lowered.executable ? { mode: 0o755 } : {}), requires: [], checks: [] };
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
      origin: proven.origin === 'chosen' ? 'chosen' : structuredClone(proven.origin), catalog: controls.catalog?.version ?? null,
      profiles: profilesOf(checked.profiles, clis, group.steps),
      steps: [...new Set(group.steps.map(step => step.index))].sort((a, b) => a - b) });
    selections.push({ id: group.selectionId, managementId: group.managementId, scope: group.scope, configuration: {}, requires: [],
      recipe: { inline: recipe } });
  }
  const resolutions = (request.resolutions ?? []).filter(item => item.choice !== 'skip').flatMap(item => {
    const group = [...groups.values()].find(entry => entry.managementId === item.managementId && entry.steps.some(step => step.index === item.step));
    return group ? [{ selectionId: group.selectionId, operationId: `step-${item.step}`, choice: item.choice as 'replace' | 'adopt',
      observedSha256: item.observedSha256 }] : [];
  });
  const engine = await prepareEngine({ useCase: 'policy', policy: { schema: POLICY, mode: 'vibe', selections },
    target: { project: project ?? home }, ...(resolutions.length ? { resolutions } : {}) }, engineControls(controls),
    undefined, undefined, undefined, undefined, undefined, { supplied, plans });
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
    const step = byStep.get(ref.step as number)!;
    const effect: ReviewStep['effect'] = operation.effects === 'unavailable' ? 'conflict' :
      ['create-file', 'replace-file', 'already-satisfied', 'conflict'].includes(operation.effects) ? operation.effects as ReviewStep['effect'] : 'unchanged';
    steps.push({ step: ref.step, op: step.op, managementId: ref.managementId, sentence: step.lowered.sentence, cantPromise: step.lowered.cantPromise,
      effect,
      root: step.lowered.root, path: step.lowered.path, ...step.lowered.review });
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
      effect: 'skipped', root: step.lowered.root, path: step.lowered.path, ...step.lowered.review });
  steps.sort((a, b) => (a.step as number) - (b.step as number) || codeUnitCompare(a.managementId, b.managementId));
  const { plan: _steps, ...reports } = request.plan;
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'plan', scope: request.scope, target: { project },
    plan: reports, origin: proven.origin, originNote: proven.note, steps, conflicts,
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
