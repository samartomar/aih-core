// Apply for a 0.1.0 review (contract 7, 14.1): check the exact approval, re-check the request the review was made
// from, then let the engine re-check and carry out its reviewed steps. Never throws for a stale or lost handle.
import { randomUUID } from 'node:crypto';
import { apply as applyEngine } from '../recipe-engine.js';
import { forgetProvenState } from '../internal/state.js';
import { take, type HandleState, type ProgramCheck } from './handles.js';
import { runApprovedProcess } from '../internal/approved-process.js';
import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { projectRoot } from '../internal/host-files.js';
import { removeAcquiredFolder } from './acquire/effect.js';
import { MANIFEST } from './acquire/types.js';
import { engineControls, planControls } from './prepare.js';
import { requestDigests } from './request.js';
import { privateInputsHold } from './inputs.js';
import { changeControls } from '../change/prepare.js';
import type { RunResult } from '../host-types.js';
import { RUN, type PlanControls, type Run, type RunMember, type RunStep, type StaleChange } from './types.js';

const rejected = (reason: string, extra: Partial<Run> = {}): Run => ({ schema: RUN, status: 'ok', runId: randomUUID(), completion: 'rejected',
  reason, reviewDigest: null, steps: [], members: [], history: { status: 'disabled' }, ...extra });
const stale = (changed: StaleChange, reviewDigest: string): Run =>
  rejected('binding-changed', { code: 'REVIEW_STALE', changed, reviewDigest });
/** The engine's reviewed bindings, named from the 0.1.0 closed list. */
const CHANGED: Record<string, StaleChange> = { policy: 'binding', recipe: 'binding', binding: 'binding', 'index-status': 'binding',
  'scan-state': 'binding', 'target-file': 'target-file', ownership: 'ownership', input: 'input', host: 'host', trust: 'host' };

export async function applyPlan(handle: unknown, approval: unknown, rawControls?: unknown): Promise<Run> {
  forgetProvenState();
  // A change request's own controls (material roots) are accepted too; Apply reads only cancellation and logging.
  const controls = planControls(rawControls) ?? changeControls(rawControls);
  const state = take(handle);
  if (!state) return rejected('handle-unavailable', { code: 'REVIEW_STALE' });
  if (!controls) return rejected('controls-invalid', { reviewDigest: state.reviewDigest });
  const value = approval as { approved?: unknown; origin?: unknown; reviewDigest?: unknown; allowPartial?: unknown } | null;
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['approved', 'origin', 'reviewDigest', 'allowPartial'].includes(key)) ||
      value.approved !== true || !['interactive', 'automation'].includes(value.origin as string) ||
      value.allowPartial !== undefined && typeof value.allowPartial !== 'boolean') return rejected('approval-required', { reviewDigest: state.reviewDigest });
  if (value.reviewDigest !== state.reviewDigest) return rejected('digest-mismatch', { code: 'REVIEW_STALE', reviewDigest: state.reviewDigest });
  if (state.partial && value.allowPartial !== true) return rejected('partial-approval-required', { reviewDigest: state.reviewDigest });
  if (state.request) {
    const now = requestDigests(state.request.value);
    if (!now || now.documentDigest !== state.request.documentDigest || now.bytesDigest !== state.request.bytesDigest)
      return stale('binding', state.reviewDigest);
  }
  // Exact private-input changes invalidate the approval: Apply's values, or the object Prepare read when it passes none.
  if (state.privateInputs && !privateInputsHold(state.privateInputs, controls.privateInputs)) return stale('input', state.reviewDigest);
  if (state.progress && controls.onProgress) state.progress.onProgress = controls.onProgress;
  if (controls.signal?.aborted) return { ...rejected('cancelled', { reviewDigest: state.reviewDigest }), completion: 'cancelled' };
  const origin = value.origin as 'interactive' | 'automation';
  // A removal's plugin commands run first; the receipt is released only after every one of them ran and no presence
  // check still lists its plugin, so a failed removal keeps the undo facts for another try.
  let before: Run | undefined;
  if (state.before) {
    const programs = state.before;
    const pseudo = { ...state, operations: programs.operations };
    before = programs.engine ? runOf(await applyEngine(programs.engine, { reviewDigest: programs.engineDigest, approved: true, origin },
      engineControls(controls), undefined, progress(controls, pseudo)), pseudo) : { ...rejected('none', { reviewDigest: state.reviewDigest }), completion: 'complete' };
    for (const ref of programs.unremovable) {
      const step: RunStep = { step: ref.step, managementId: ref.managementId, application: 'not-attempted',
        verification: { status: 'unverified', reason: 'no-remove-command' } };
      programSteps.add(step); before.steps.push(step);
    }
    before.steps.sort((a, b) => (a.step as number) - (b.step as number));
    await checkPresence(before, programs.programs, 'absent', controls);
    const held = before.steps.some(step => programStep(step) && step.verification.reason !== 'no-remove-command' &&
      (step.application !== 'applied' || step.verification.status === 'failed'));
    if (before.completion === 'rejected' || before.completion === 'cancelled' || held) {
      const skipped: RunStep[] = [...new Map([...state.operations.values()].map(ref => [`${ref.step}\0${ref.managementId}`, ref])).values()]
        .map(ref => ({ step: ref.step, managementId: ref.managementId, application: 'not-attempted' as const,
          verification: { status: 'not-checked', reason: 'not-attempted' } }));
      return { ...before, completion: before.completion === 'complete' ? 'incomplete' : before.completion, reviewDigest: state.reviewDigest,
        steps: [...before.steps, ...skipped].sort((a, b) => (a.step as number) - (b.step as number)) };
    }
  }
  const result = await applyEngine(state.engine, { reviewDigest: state.engineDigest, approved: true, origin: value.origin as 'interactive' | 'automation',
    // Plan work never stops at a failed step: its item and dependants are not attempted, unrelated items continue (C60).
    ...(state.enginePartial || state.request ? { allowPartial: true } : {}) }, engineControls(controls), undefined, progress(controls, state));
  const run = runOf(result, state);
  removeReleasedSetups(run);
  if (!state.before) await checkPresence(run, state.programs ?? new Map(), 'present', controls);
  if (before) {
    run.steps = [...before.steps, ...run.steps].sort((a, b) => (a.step as number) - (b.step as number));
    if (run.completion === 'complete' && before.completion !== 'complete') run.completion = 'incomplete';
  }
  return run;
}

/** `onProgress` events for program steps: each command's start and finish, by plan step. */
export function progress(controls: PlanControls, state: HandleState) {
  const report = controls.onProgress;
  if (!report) return undefined;
  return (operationId: string, phase: 'start' | 'finish', application?: string) => {
    const ref = state.operations.get(operationId);
    if (ref) report({ step: ref.step, managementId: ref.managementId, operation: operationId.slice(operationId.indexOf('/') + 1), phase,
      ...(application ? { application } : {}) });
  };
}

/**
 * The plugin presence check after the CLI's own commands (C56): only a declared readback decides. `present` after an
 * install, `absent` after a removal, verifies the step; the opposite fails it. A check that cannot run fails it too.
 * Exit status or output alone never verify anything; without a declared check the step stays unverified.
 */
export async function checkPresence(run: Run, programs: ReadonlyMap<number, ProgramCheck>, wanted: 'present' | 'absent',
    controls: PlanControls, only?: (step: RunStep) => boolean): Promise<void> {
  for (const step of run.steps) {
    if (run.completion === 'cancelled' || run.completion === 'rejected') break;
    if (!programStep(step) || only && !only(step)) continue;
    if (step.application !== 'applied') continue;
    const check = programs.get(step.step as number);
    if (!check) { step.verification = { status: 'unverified', reason: 'no-presence-check' }; continue; }
    if (controls.signal?.aborted) { run.completion = 'cancelled'; break; }
    controls.onProgress?.({ step: step.step, managementId: step.managementId, operation: 'presence-check', phase: 'start' });
    const outcome = await runApprovedProcess({ executable: check.executable, args: check.argv.slice(1), cwd: check.cwd, env: {},
      timeoutMs: 60_000, maxOutputBytes: 1_048_576, acceptedExitCodes: [0], capture: true, ...(controls.signal ? { signal: controls.signal } : {}) });
    let found: 'present' | 'absent' | undefined;
    if (outcome.status === 'passed' && outcome.stdout)
      found = outcome.stdout.toString('utf8').split(/\r?\n/).some(line => line.trim() === check.expect) ? 'present' : 'absent';
    step.verification = found === undefined ? { status: 'failed', reason: outcome.status === 'cancelled' ? 'cancelled' : `check-${outcome.reason}` } :
      found === wanted ? { status: 'passed', reason: found } : { status: 'failed', reason: `readback-${found}` };
    controls.onProgress?.({ step: step.step, managementId: step.managementId, operation: 'presence-check', phase: 'finish',
      verification: step.verification.status });
    if (outcome.status === 'cancelled') { run.completion = 'cancelled'; break; }
  }
  if (run.completion === 'complete' && run.steps.some(step => programStep(step) && step.verification.status === 'failed')) run.completion = 'incomplete';
}
const programSteps = new WeakSet<RunStep>();
const programStep = (step: RunStep): boolean => programSteps.has(step);

export function runOf(result: RunResult, state: HandleState): Run {
  // One run step per plan step and management id; a plugin step's several commands make one step.
  const steps: RunStep[] = [];
  const byStep = new Map<string, { step: RunStep; applications: string[] }>();
  for (const operation of result.operations) {
    const ref = state.operations.get(operation.id);
    if (!ref) continue;
    const key = `${ref.step}\0${ref.managementId}`;
    let entry = byStep.get(key);
    if (!entry) {
      const facts = state.acquired?.get(ref.step as number);
      entry = { step: { step: ref.step, managementId: ref.managementId, application: operation.application,
        verification: { status: operation.verification.status, reason: operation.verification.reason },
        ...(operation.application === 'failed' && operation.reason ? { reason: operation.reason } : {}),
        ...(facts?.branch && facts.interpreter ? { interpreter: { branch: facts.branch, path: facts.interpreter.path, version: facts.interpreter.version,
          fallback: facts.fallback, fallbackReason: facts.fallbackReason } } : {}) }, applications: [] };
      byStep.set(key, entry); steps.push(entry.step);
      if (ref.program) programSteps.add(entry.step);
    }
    entry.applications.push(operation.application);
    if (operation.effectsUncertain) entry.step.effectsUncertain = true;
  }
  for (const { step, applications } of byStep.values()) {
    if (applications.length < 2) continue;
    step.application = applications.includes('failed') ? 'failed' : applications.every(item => item === 'not-attempted') ? 'not-attempted' :
      applications.every(item => item === 'already-satisfied') ? 'already-satisfied' : applications.includes('not-attempted') ? 'failed' : 'applied';
    if (step.application === 'failed' && applications.includes('applied')) step.effectsUncertain = true;
  }
  for (const step of steps) if (programStep(step) && step.application !== 'applied')
    step.verification = { status: 'not-checked', reason: step.application === 'failed' ? 'application-failed' : 'not-attempted' };
  const members: RunMember[] = (result.members ?? []).map(member => ({ managementId: member.managementId, scope: member.scope,
    kind: member.kind, path: member.path, ...(member.pointer === undefined ? {} : { pointer: member.pointer }),
    ...(member.blockId === undefined ? {} : { blockId: member.blockId }), intent: member.intent, outcome: member.outcome, check: member.check }));
  const history: Run['history'] = result.record.status === 'written' ? { status: 'recorded' } : result.record.status === 'disabled' ?
    { status: 'disabled' } : { status: 'not-recorded', ...(result.record.reason === 'record-limit' ? { limit: 'history-bytes' } : {}) };
  const run: Run = { schema: RUN, status: 'ok', runId: result.runId, completion: result.completion, reviewDigest: state.reviewDigest,
    steps, members, history };
  if (result.completion === 'rejected') {
    const cause = result.diagnostics.find(item => item.code === 'REVIEW_STALE') ?? result.diagnostics[0];
    if (cause?.code === 'REVIEW_STALE') {
      run.code = 'REVIEW_STALE';
      if (cause.changed) run.changed = CHANGED[cause.changed] ?? 'binding';
    }
    run.reason = cause?.reason ?? 'rejected';
  }
  return run;
}

/** An AI setup folder goes with its marker: once a run removed the last claim's marker, the acquired files go too (C28). */
function removeReleasedSetups(run: Run): void {
  const pattern = new RegExp(`^(\\.aihq/ai-setup/[^/]+/[^/]+/[^/]+)/${MANIFEST.replace('.', '\\.')}$`);
  let home: string;
  try { home = projectRoot(homedir()); } catch { return; }
  for (const member of run.members) {
    if (member.scope !== 'user' || member.intent !== 'remove' || member.check !== 'absent') continue;
    const into = pattern.exec((isAbsolute(member.path) ? relative(home, member.path) : member.path).replaceAll('\\', '/'))?.[1];
    if (into) try { removeAcquiredFolder(home, into); } catch { /* left for the person; list no longer claims it */ }
  }
}
