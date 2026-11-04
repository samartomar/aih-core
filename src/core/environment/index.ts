// Environment work through the shared 0.1.0 review and run (contract 7, 10). A repair, certificate export or macOS
// session request is lowered into its retained preparation, which keeps every source, host, target, custody and
// restoration check it has today; the retained review is then presented as a frozen 0.1.0 review, and its run as a
// 0.1.0 run. The retained trust and export modules are used as they are, so their admitted byte bindings stay intact.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { readRegularFile } from '../internal/fsxn.js';
import { repairIndex } from '../../harness/contracts.mjs';
import { prepareRepair, applyRepair } from '../repair.js';
import { prepareTrust, applyTrust, disposeTrustHandle } from '../trust.js';
import { prepareMacosSession, applyMacosSession, disposeMacosSessionHandle, verifyMacosSession } from '../macos-session.js';
import { forgetProvenState } from '../internal/state.js';
import { nodeRuntimeSupported } from '../internal/node-runtime.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { digestOf as reviewDigestOf, engineControls, planControls } from '../plan/prepare.js';
import { checkEnvironmentRequest, currentDigest, environmentJob, lower, type Checked, type EnvironmentJob, type Lowered } from './request.js';
import type { Diagnostic, Json } from '../types.js';
import type { Authorization, HostControls, PreparationResult, PreparedHandle, RunResult } from '../host-types.js';
import { REVIEW, RUN, type EnvironmentProblem, type EnvironmentReview, type EnvironmentRun, type PlanHandle, type PlanPreparation,
  type Review, type ReviewConflict, type ReviewStep, type Run, type RunStep, type StaleChange } from '../plan/types.js';

export { environmentJob } from './request.js';
export const ENVIRONMENT_FAILURE_RULE = 'A failed or unavailable prerequisite stops the configuration that depends on it; independent work continues only with explicit partial approval.';
export const PROCESS_CANT_PROMISE = 'Core can\'t promise what this program changes beyond its reviewed checks.';

/** Where one review step came from: the retained selection and operation, so resolutions and run steps map back. */
interface StepRef { selectionId: string; operationId: string; managementId: string }
interface State {
  job: EnvironmentJob; kind: Lowered['kind']; inner: PreparedHandle; innerDigest: string; partial: boolean;
  reviewDigest: string; refs: StepRef[]; request: { value: unknown; digest: string };
}
const states = new WeakMap<object, State>();
const issued = new WeakSet<object>();
export const isEnvironmentHandle = (value: unknown): boolean => !!value && typeof value === 'object' && issued.has(value);

const retained = { trust: { prepare: prepareTrust, apply: applyTrust, dispose: disposeTrustHandle },
  repair: { prepare: prepareRepair, apply: applyRepair, dispose: (_handle: PreparedHandle) => {} },
  session: { prepare: prepareMacosSession, apply: applyMacosSession, dispose: disposeMacosSessionHandle } } as const;
const prepareRetained = (lowered: Lowered, controls: HostControls): Promise<PreparationResult> =>
  (retained[lowered.kind].prepare as (request: unknown, controls: HostControls) => Promise<PreparationResult>)(lowered.request, controls);

const publicProblem = (row: Diagnostic): EnvironmentProblem =>
  ({ code: row.code, reason: row.reason, message: row.message, ...(typeof row.path === 'string' ? { path: row.path } : {}) });
const effectOf = (effects: string): ReviewStep['effect'] => effects === 'opaque-process' ? 'opaque-process' :
  effects === 'unavailable' ? 'conflict' : ['create-file', 'replace-file', 'remove-file', 'already-satisfied', 'conflict'].includes(effects) ?
    effects as ReviewStep['effect'] : 'unchanged';
const outputEffect = (effect: string): ReviewStep['effect'] =>
  ({ create: 'create-file', replace: 'replace-file', unchanged: 'unchanged', conflict: 'conflict' } as Record<string, ReviewStep['effect']>)[effect] ?? 'unchanged';
function homePath(path: unknown): string | undefined {
  if (typeof path !== 'string' || !isAbsolute(path)) return undefined;
  const inside = relative(homedir(), path);
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.replaceAll('\\', '/') : undefined;
}
/** The exact existing bytes at a home-relative conflict target, as text; `null` when absent, unreadable or not UTF-8. Trust outputs hold no secrets. */
function existingText(path: string | undefined): string | null {
  if (path === undefined) return null;
  const bytes = readRegularFile(join(homedir(), ...path.split('/')), { maxBytes: 16 * 1_048_576 });
  if (!bytes) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}
interface TrustOutputRow { selectionId: string; operationId: string; managementId: string; path: string; format: string; effect: string }
const trustOutputs = (inputs: unknown): TrustOutputRow[] =>
  ((inputs as { trust?: { outputs?: TrustOutputRow[] } } | undefined)?.trust?.outputs ?? []);

/** The management id of the job's selection: the retained output custody's, else the repair definition's. */
function managementIdOf(checked: Checked, result: PreparationResult): string {
  const outputs = trustOutputs(result.review?.inputs);
  if (outputs[0]?.managementId) return outputs[0].managementId;
  const repair = (checked.request as { repair?: string }).repair;
  return repairIndex.find(definition => definition.id === repair)?.managementId ?? (checked.job === 'export' ? 'certificate-export' : String(repair));
}

/** The review steps and their retained origins: the engine's operations, or the planned outputs when none were prepared. */
function stepsOf(checked: Checked, result: PreparationResult): { steps: ReviewStep[]; refs: StepRef[] } {
  const managementId = managementIdOf(checked, result);
  const steps: ReviewStep[] = []; const refs: StepRef[] = [];
  for (const operation of result.review?.operations ?? []) {
    const at = operation.id.indexOf('/');
    const selectionId = at > 0 ? operation.id.slice(0, at) : (operation.selectionId ?? ''); const operationId = at > 0 ? operation.id.slice(at + 1) : operation.id;
    const path = homePath(operation.details.target);
    steps.push({ step: steps.length, op: operation.kind, managementId, sentence: operation.purpose,
      cantPromise: operation.kind === 'process.run' ? PROCESS_CANT_PROMISE : null, effect: effectOf(operation.effects),
      root: 'user', ...(path === undefined ? {} : { path }) });
    refs.push({ selectionId, operationId, managementId });
  }
  if (!steps.length) for (const row of trustOutputs(result.review?.inputs)) {
    const path = homePath(row.path);
    steps.push({ step: steps.length, op: 'file.write', managementId: row.managementId,
      sentence: `Writes the reviewed ${row.format} certificate output`, cantPromise: null, effect: outputEffect(row.effect),
      root: 'user', ...(path === undefined ? {} : { path }) });
    refs.push({ selectionId: row.selectionId, operationId: row.operationId, managementId: row.managementId });
  }
  return { steps, refs };
}

function presented(checked: Checked, lowered: Lowered, result: PreparationResult): { review: Review; refs: StepRef[] } {
  const { steps, refs } = stepsOf(checked, result);
  const conflicts: ReviewConflict[] = [];
  for (const hint of result.resolutionInputs ?? []) {
    let step = refs.findIndex(ref => ref.selectionId === hint.selectionId && ref.operationId === hint.operationId);
    if (step < 0) {
      // A conflict on an observed value outside the planned outputs (for example an existing environment setting).
      const managementId = managementIdOf(checked, result);
      step = steps.length;
      steps.push({ step, op: 'observation', managementId, sentence: 'Replaces an existing value Core did not write',
        cantPromise: null, effect: 'conflict', root: 'user' });
      refs.push({ selectionId: hint.selectionId, operationId: hint.operationId, managementId });
    }
    conflicts.push({ code: 'STATE_CONFLICT', reason: 'existing-content', managementId: refs[step]!.managementId, step,
      target: steps[step]!.path ?? `${hint.selectionId}/${hint.operationId}`, observedSha256: hint.observedSha256,
      existing: existingText(steps[step]!.path), redacted: [], choices: hint.availableChoices.includes('replace') ? ['replace'] : [] });
  }
  // A conflict with no replacement on offer (bytes Core cannot read back, or custody that disagrees) names its step
  // and is kept, never replaced; one with no step stays a reported problem.
  const rows = trustOutputs(result.review?.inputs);
  const unoffered = conflicts.length ? [] : result.diagnostics.filter(row => row.code === 'STATE_CONFLICT');
  const named = new Set<Diagnostic>();
  for (const row of unoffered) {
    const step = steps.findIndex(entry => entry.effect === 'conflict');
    if (step < 0) continue;
    const output = rows.find(entry => entry.selectionId === refs[step]!.selectionId && entry.operationId === refs[step]!.operationId);
    conflicts.push({ code: 'STATE_CONFLICT', reason: 'managed-content-changed', managementId: refs[step]!.managementId, step,
      target: steps[step]!.path ?? `${refs[step]!.selectionId}/${refs[step]!.operationId}`,
      observedSha256: (output as { beforeSha256?: string | null } | undefined)?.beforeSha256 ?? null,
      existing: existingText(steps[step]!.path), redacted: [], choices: [] });
    named.add(row);
  }
  const unavailable = result.diagnostics.filter(row => !named.has(row) && !(row.code === 'STATE_CONFLICT' && (result.resolutionInputs ?? []).length))
    .map(publicProblem);
  const request = checked.request as { repair?: string; targets?: string[]; route?: 'file' | 'native'; network?: 'declared' | 'off' };
  const environment: EnvironmentReview = { job: checked.job, repair: request.repair ?? null, targets: [...request.targets ?? []],
    route: checked.job === 'export' ? 'export' : lowered.kind === 'repair' ? 'os' : request.route ?? 'file', network: request.network ?? 'declared',
    facts: (result.review?.inputs ?? {}) as unknown as EnvironmentReview['facts'],
    observations: (result.review?.observations ?? []).map(row => ({ id: row.id, reason: row.reason })), unavailable };
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: checked.job, scope: 'user', target: { project: null },
    steps, conflicts, failureRule: ENVIRONMENT_FAILURE_RULE, warnings: [], environment };
  const reviewDigest = reviewDigestOf(body, result.review?.reviewDigest ?? '');
  return { review: deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review, refs };
}

/** Maps reviewed 0.1.0 resolutions onto the retained selections and operations they name. */
async function resolutionsFor(checked: Checked, lowered: Lowered): Promise<{ selectionId: string; operationId: string; choice: 'replace'; observedSha256: string | null }[] | undefined> {
  const wanted = (checked.request as { resolutions?: { managementId: string; step: number; observedSha256: string | null }[] }).resolutions ?? [];
  if (!wanted.length) return [];
  // The same request without its choices is what the person reviewed; its steps name the operations the choices mean.
  const reviewed = await prepareRetained(lowered, { logging: 'off' });
  if (reviewed.prepared) retained[lowered.kind].dispose(reviewed.prepared);
  const { refs } = presented(checked, lowered, reviewed);
  const mapped = [];
  for (const choice of wanted) {
    const ref = refs[choice.step];
    if (!ref || ref.managementId !== choice.managementId) return undefined;
    mapped.push({ selectionId: ref.selectionId, operationId: ref.operationId, choice: 'replace' as const, observedSha256: choice.observedSha256 });
  }
  return mapped;
}

export async function prepareEnvironment(input: unknown, rawControls?: unknown): Promise<PlanPreparation> {
  forgetProvenState();
  const controls = planControls(rawControls);
  if (!controls || controls.privateInputs !== undefined || controls.catalog !== undefined || controls.onProgress !== undefined)
    return { status: 'invalid', problems: [{ path: '', reason: 'controls', message: 'Environment work takes only `signal` and `logging` controls.' }] };
  if (controls.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  const checked = checkEnvironmentRequest(input);
  if ('status' in checked) return checked;
  if (!nodeRuntimeSupported()) return { status: 'refused', code: 'host-unsupported', reason: 'Environment work needs the supported Node runtime.' };
  const lowered = lower(checked);
  const resolutions = await resolutionsFor(checked, lowered);
  if (!resolutions) return { status: 'refused', code: 'resolution-unknown', reason: 'A resolution names no conflict in the reviewed request; prepare again without it.' };
  if (resolutions.length) (lowered.request as { resolutions?: unknown }).resolutions = resolutions;
  const result = await prepareRetained(lowered, engineControls(controls));
  if (result.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  if (result.status === 'invalid') {
    if (result.prepared) retained[lowered.kind].dispose(result.prepared);
    return { status: 'invalid', problems: result.diagnostics.map(row => ({ path: row.path ?? '', reason: row.reason, message: row.message })) };
  }
  const { review, refs } = presented(checked, lowered, result);
  if (result.status === 'blocked' || !result.prepared || !result.review) {
    if (result.prepared) retained[lowered.kind].dispose(result.prepared);
    return { status: 'blocked', review };
  }
  const handle = Object.freeze({}) as PlanHandle;
  states.set(handle, { job: checked.job, kind: lowered.kind, inner: result.prepared, innerDigest: result.review.reviewDigest,
    partial: result.status === 'partial', reviewDigest: review.reviewDigest, refs, request: { value: input, digest: checked.digest } });
  issued.add(handle);
  return { status: result.status === 'partial' ? 'partial' : 'ready', review, handle };
}

const rejected = (reason: string, extra: Partial<Run> = {}): Run => ({ schema: RUN, status: 'ok', runId: randomUUID(), completion: 'rejected',
  reason, reviewDigest: null, steps: [], members: [], history: { status: 'disabled' }, ...extra });
const CHANGED: Record<string, StaleChange> = { policy: 'binding', recipe: 'binding', binding: 'binding', 'target-file': 'target-file',
  ownership: 'ownership', input: 'input', host: 'host', trust: 'host' };

export async function applyEnvironment(handle: unknown, approval: unknown, rawControls?: unknown): Promise<Run> {
  forgetProvenState();
  const state = handle && typeof handle === 'object' ? states.get(handle) : undefined;
  if (state) states.delete(handle as object);
  if (!state) return rejected('handle-unavailable', { code: 'REVIEW_STALE' });
  const dispose = () => retained[state.kind].dispose(state.inner);
  const controls = planControls(rawControls);
  if (!controls || controls.privateInputs !== undefined || controls.catalog !== undefined || controls.onProgress !== undefined) {
    dispose(); return rejected('controls-invalid', { reviewDigest: state.reviewDigest });
  }
  const value = approval as { approved?: unknown; origin?: unknown; reviewDigest?: unknown; allowPartial?: unknown } | null;
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['approved', 'origin', 'reviewDigest', 'allowPartial'].includes(key)) ||
      value.approved !== true || !['interactive', 'automation'].includes(value.origin as string) ||
      value.allowPartial !== undefined && typeof value.allowPartial !== 'boolean') { dispose(); return rejected('approval-required', { reviewDigest: state.reviewDigest }); }
  if (value.reviewDigest !== state.reviewDigest) { dispose(); return rejected('digest-mismatch', { code: 'REVIEW_STALE', reviewDigest: state.reviewDigest }); }
  if (state.partial && value.allowPartial !== true) { dispose(); return rejected('partial-approval-required', { reviewDigest: state.reviewDigest }); }
  if (currentDigest(state.request.value) !== state.request.digest) {
    dispose(); return rejected('binding-changed', { code: 'REVIEW_STALE', changed: 'binding', reviewDigest: state.reviewDigest });
  }
  if (controls.signal?.aborted) { dispose(); return { ...rejected('cancelled', { reviewDigest: state.reviewDigest }), completion: 'cancelled' }; }
  const authorization: Authorization = { reviewDigest: state.innerDigest, approved: true, origin: value.origin as Authorization['origin'],
    ...(state.partial ? { allowPartial: true } : {}) };
  const result = await (retained[state.kind].apply as (handle: PreparedHandle, authorization: Authorization, controls: HostControls) => Promise<RunResult>)(
    state.inner, authorization, engineControls(controls));
  return runOf(result, state);
}

function runOf(result: RunResult, state: State): Run {
  const steps: RunStep[] = result.operations.flatMap(operation => {
    const step = state.refs.findIndex(ref => `${ref.selectionId}/${ref.operationId}` === operation.id);
    return step < 0 ? [] : [{ step, managementId: state.refs[step]!.managementId, application: operation.application,
      verification: { status: operation.verification.status, reason: operation.verification.reason } }];
  });
  const members: Run['members'] = (result.members ?? []).map(member => ({ managementId: member.managementId, scope: member.scope,
    kind: member.kind, path: member.path, ...(member.pointer === undefined ? {} : { pointer: member.pointer }),
    ...(member.blockId === undefined ? {} : { blockId: member.blockId }), intent: member.intent, outcome: member.outcome, check: member.check }));
  const history: Run['history'] = result.record.status === 'written' ? { status: 'recorded' } : result.record.status === 'disabled' ?
    { status: 'disabled' } : { status: 'not-recorded', ...(result.record.reason === 'record-limit' ? { limit: 'history-bytes' } : {}) };
  const environment: EnvironmentRun = { job: state.job,
    outputs: (result.trust?.outputs ?? []) as unknown as EnvironmentRun['outputs'],
    targets: (result.trust?.targets ?? []) as unknown as EnvironmentRun['targets'],
    ...(result.macosSession ? { session: result.macosSession as unknown as NonNullable<EnvironmentRun['session']> } : {}),
    diagnostics: result.diagnostics.map(publicProblem) };
  const run: Run = { schema: RUN, status: 'ok', runId: result.runId, completion: result.completion, reviewDigest: state.reviewDigest,
    steps, members, history, environment };
  if (result.completion === 'rejected') {
    const cause = result.diagnostics.find(item => item.code === 'REVIEW_STALE') ?? result.diagnostics[0];
    if (cause?.code === 'REVIEW_STALE') {
      run.code = 'REVIEW_STALE';
      run.changed = cause.changed ? CHANGED[cause.changed] ?? 'binding' : 'binding';
    }
    run.reason = cause?.reason ?? 'rejected';
  }
  return run;
}

/** Whether `prepare` should take this request on the environment path. */
export const isEnvironmentRequest = (value: unknown): boolean => environmentJob(value) !== undefined;

// The macOS session check (contract 3, 10): `urn:aihq:core:macos-session-verification-request:0.1.0` in, the 0.1.0
// verification result out. The retained check observes the host and custody; it never changes session state, and an
// unsupported host stays `incomplete` with its reason.
export const MACOS_SESSION_VERIFICATION_REQUEST = 'urn:aihq:core:macos-session-verification-request:0.1.0' as const;
export const MACOS_SESSION_VERIFICATION_RESULT = 'urn:aihq:core:macos-session-verification-result:0.1.0' as const;
export const isSessionVerificationRequest = (value: unknown): boolean =>
  !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getOwnPropertyDescriptor(value, 'schema')?.value === MACOS_SESSION_VERIFICATION_REQUEST;
export async function verifyMacosSessionRequest(input: unknown, controls: Pick<HostControls, 'signal' | 'logging'> = {}): Promise<MacosSessionVerificationResult010> {
  // The retained check reads the same fields; its schema field names the retained version it validates.
  const lowered = { ...(input as Record<string, unknown>), schema: 'urn:aihq:core:macos-session-verification-request:1.0.0' };
  const result = await verifyMacosSession(lowered as unknown as Parameters<typeof verifyMacosSession>[0], controls);
  return { ...result, schema: MACOS_SESSION_VERIFICATION_RESULT };
}
export type MacosSessionVerificationResult010 = Omit<Awaited<ReturnType<typeof verifyMacosSession>>, 'schema'> & { schema: typeof MACOS_SESSION_VERIFICATION_RESULT };
