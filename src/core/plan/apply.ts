// Apply for a 0.1.0 review (contract 7, 14.1): check the exact approval, re-check the request the review was made
// from, then let the engine re-check and carry out its reviewed steps. Never throws for a stale or lost handle.
import { randomUUID } from 'node:crypto';
import { apply as applyEngine } from '../recipe-engine.js';
import { forgetProvenState } from '../internal/state.js';
import { take, type HandleState } from './handles.js';
import { engineControls, planControls } from './prepare.js';
import { requestDigests } from './request.js';
import { changeControls } from '../change/prepare.js';
import type { RunResult } from '../host-types.js';
import { RUN, type Run, type RunMember, type RunStep, type StaleChange } from './types.js';

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
  if (controls.signal?.aborted) return { ...rejected('cancelled', { reviewDigest: state.reviewDigest }), completion: 'cancelled' };
  const result = await applyEngine(state.engine, { reviewDigest: state.engineDigest, approved: true, origin: value.origin as 'interactive' | 'automation',
    ...(state.enginePartial ? { allowPartial: true } : {}) }, engineControls(controls));
  return runOf(result, state);
}

export function runOf(result: RunResult, state: HandleState): Run {
  const steps: RunStep[] = result.operations.flatMap(operation => {
    const ref = state.operations.get(operation.id);
    return ref ? [{ step: ref.step, managementId: ref.managementId, application: operation.application,
      verification: { status: operation.verification.status, reason: operation.verification.reason },
      ...(operation.effectsUncertain ? { effectsUncertain: true } : {}) }] : [];
  });
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
