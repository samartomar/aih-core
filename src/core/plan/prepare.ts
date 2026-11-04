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
import { register, type ProgramCheck, type StepRef } from './handles.js';
import { resolveExecutable } from '../internal/approved-process.js';
import { readOwnership } from '../internal/state.js';
import { claimIdentity } from '../internal/recipe-lifecycle.js';
import type { LoweredPlugin } from './steps/types.js';
import { limitValue } from './limits.js';
import type { PlanItemFacts, PluginFacts } from '../internal/custody-items.js';
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
  const selections: ExecutionPolicy['selections'] = [];
  for (const group of groups.values()) {
    const materials: { id: string; path: string; sha256: string; byteLength: number; bytes: Buffer }[] = [];
    const ops: Recipe['operations'] = group.steps.flatMap((step, at): Recipe['operations'] => {
      const lowered = step.lowered;
      if (lowered.kind === 'plugin') return programOperations(lowered, step.index, group, operations);
      const material = { id: `m${String(at).padStart(6, '0')}`, path: `plan/${at}`, sha256: sha256(lowered.bytes),
        byteLength: lowered.bytes.length, bytes: lowered.bytes };
      materials.push(material);
      operations.set(`${group.selectionId}/step-${step.index}`, { step: step.index, managementId: group.managementId });
      return [{ id: `step-${step.index}`, purpose: lowered.sentence, kind: 'file.write', scope: group.scope,
        target: { root: group.scope === 'project' ? 'project' : 'userHome', segments: lowered.path.split('/').map(literal => ({ literal })) },
        material: material.id, ...(lowered.executable ? { mode: 0o755 } : {}), requires: [], checks: [] }];
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
      steps: [...new Set(group.steps.map(step => step.index))].sort((a, b) => a - b),
      ...pluginFacts(group.steps) });
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
  const programCommands = new Map<number, { executable: string; executableSha256: string }[]>();
  const byStep = new Map<number, CheckedStep>(checked.steps.map(step => [step.index, step]));
  for (const operation of engine.review.operations) {
    const ref = operations.get(operation.id);
    if (!ref) continue;
    const step = byStep.get(ref.step)!;
    if (step.lowered.kind === 'plugin') {
      if (operation.effects === 'unavailable' || typeof operation.details.executableSha256 !== 'string')
        return { status: 'refused', code: 'program-unavailable', reason: `Step ${ref.step} runs \`${step.lowered.cli}\`, which this host cannot run.`, step: ref.step };
      const commands = programCommands.get(ref.step) ?? []; programCommands.set(ref.step, commands);
      commands.push({ executable: String(operation.details.executable), executableSha256: operation.details.executableSha256 });
      continue;
    }
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
  // One review step per plugin step: every exact command with its pinned executable, the undo facts and the check.
  const programs = new Map<number, ProgramCheck>();
  for (const step of checked.steps) {
    const lowered = step.lowered;
    if (lowered.kind !== 'plugin' || step.skipped) continue;
    const pinned = programCommands.get(step.index) ?? [];
    let presence: ReviewStep['presenceCheck'] = 'none';
    if (lowered.presenceCheck !== 'none') {
      const executable = resolveExecutable(lowered.presenceCheck.argv[0]!);
      if (!executable) return { status: 'refused', code: 'program-unavailable',
        reason: `Step ${step.index}'s presence check runs \`${lowered.presenceCheck.argv[0]}\`, which this host cannot run.`, step: step.index };
      presence = { ...lowered.presenceCheck, executable: executable.launchPath, executableSha256: executable.sha256 };
      programs.set(step.index, { executable, argv: lowered.presenceCheck.argv, expect: lowered.presenceCheck.expect,
        cwd: lowered.root === 'project' ? project! : home });
    }
    const interrupted = readOwnership(lowered.root === 'project' ? project! : home).value.items?.[
      claimIdentity(lowered.root, lowered.framework, project ?? home)]?.installState === 'interrupted';
    steps.push({ step: step.index, op: step.op, managementId: lowered.framework, sentence: lowered.sentence,
      cantPromise: interrupted ? `${lowered.cantPromise} An earlier run of this install was interrupted, so its effects are uncertain; approving runs it again.` : lowered.cantPromise,
      effect: 'run-program', framework: lowered.framework, cli: lowered.cli, clis: [lowered.cli], plugin: lowered.plugin, commit: lowered.commit,
      contains: lowered.contains, commands: lowered.commands.map((argv, at) => ({ argv, ...pinned[at]! })), undo: lowered.undo,
      presenceCheck: presence, ...(interrupted ? { previous: 'interrupted' as const } : {}) });
  }
  for (const step of checked.steps) if (step.skipped && step.lowered.kind === 'write') for (const managementId of step.lowered.managementIds)
    steps.push({ step: step.index, op: step.op, managementId, sentence: step.lowered.sentence, cantPromise: step.lowered.cantPromise,
      effect: 'skipped', root: step.lowered.root, path: step.lowered.path, ...step.lowered.review });
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
    reviewDigest, partial, operations, ...(programs.size ? { programs } : {}),
    request: { value: input, documentDigest: checked.documentDigest, bytesDigest: checked.bytesDigest } });
  return { status: partial ? 'partial' : 'ready', review, handle };
}

/**
 * A plugin step's commands as engine `process.run` operations, run in order in the request scope's root (the project
 * folder or home). Each command needs the one before it; the engine pins each executable by sha256 at Prepare.
 */
function programOperations(lowered: LoweredPlugin, index: number, group: { selectionId: string; managementId: string; scope: 'project' | 'user' },
    operations: Map<string, StepRef>): Recipe['operations'] {
  return lowered.commands.map((argv, at) => {
    const id = `step-${index}-${at}`;
    operations.set(`${group.selectionId}/${id}`, { step: index, managementId: group.managementId, program: true });
    return { id, purpose: `Runs \`${argv.join(' ')}\``, kind: 'process.run', scope: group.scope,
      executable: { name: argv[0]! }, args: argv.slice(1).map(literal => ({ literal })),
      cwd: { root: group.scope === 'project' ? 'project' : 'userHome', segments: [] }, env: {}, acceptedExitCodes: [0],
      effects: [`The ${lowered.cli} CLI's own plugin command; Core can't show its effects`], requires: at ? [`step-${index}-${at - 1}`] : [], checks: [] };
  });
}
/** The receipt's plugin undo facts for one management id's steps (C54). */
function pluginFacts(steps: CheckedStep[]): { plugins?: PluginFacts[] } {
  const plugins = steps.flatMap(step => step.lowered.kind === 'plugin' && !step.skipped ? [{ step: step.index, cli: step.lowered.cli,
    plugin: step.lowered.plugin, commit: step.lowered.commit, contains: [...step.lowered.contains], undo: step.lowered.undo,
    presenceCheck: step.lowered.presenceCheck }] : []);
  return plugins.length ? { plugins } : {};
}
