import { distribution } from '../../distribution.mjs';
import type { Diagnostic } from '../types.js';
import type { NativeVerificationResult } from '../native-contracts.js';
import { nativeClients, nativeDiagnostic, ownNativeValue } from './native-input.js';

export type NativeStage = NativeVerificationResult['stages'][number];
const codes = new Set(['INPUT_INVALID', 'SCHEMA_UNSUPPORTED', 'PREREQUISITE_UNAVAILABLE', 'EXECUTION_FAILED', 'CANCELLED', 'INTERNAL_ERROR']);
const validationReasons = new Set(['schema-id', 'request-field', 'controls-field', 'client-id', 'budget-invalid', 'path-invalid', 'binding-invalid', 'strict-json']);
export function emptyNativeResult(request?: unknown, controls?: unknown): NativeVerificationResult {
  const client = ownNativeValue(request, 'client');
  const budget = ownNativeValue(controls, 'budgetMs');
  return {
    schema: 'urn:aihq:core:native-verification-result:1.0.0',
    package: { name: '@aihq/core', version: distribution.version },
    status: 'invalid', verdict: 'unverified', proofScope: 'none',
    admission: ownNativeValue(controls, 'admission') === 'candidate-smoke' ? 'candidate-smoke' : 'admitted',
    client: { id: typeof client === 'string' && (nativeClients as readonly string[]).includes(client) ? client as NativeVerificationResult['client']['id'] : null, observedVersion: null },
    adapter: null, platform: { os: 'unsupported', arch: 'unknown', osRelease: 'unavailable', execution: 'native' },
    content: null, sessions: [], stages: [],
    security: { sandbox: { level: 'not-started', mechanism: null, reason: 'not-started' }, hostSecretIsolation: { outcome: 'unavailable', reason: 'isolation-unobserved' } },
    authority: 'not-evaluated', survivingProcesses: [],
    cleanup: { processes: 'not-created', files: 'not-created', retainedCell: null }, diagnostics: [],
    limits: { budgetMs: typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 1000 && budget <= 600000 ? budget : 180000,
      elapsedMs: 0, sessionsStarted: 0, stagesCompleted: 0, observedBytes: 0, telemetryEvents: 0, rpcMessages: 0, evidenceTruncated: false },
  };
}
export function invalidNativeResult(diagnostics: Diagnostic[], request?: unknown, controls?: unknown): NativeVerificationResult {
  const result = emptyNativeResult(request, controls);
  // CLI parse errors are input: caller-authored diagnostic prose is never echoed.
  result.diagnostics = diagnostics.slice(0, 16).map(value => {
    const code = ownNativeValue(value, 'code'); const reason = ownNativeValue(value, 'reason'); const path = ownNativeValue(value, 'path');
    return nativeDiagnostic(typeof reason === 'string' && validationReasons.has(reason) ? reason : 'request-field',
      typeof code === 'string' && codes.has(code) ? code : 'INPUT_INVALID',
      typeof path === 'string' && /^\/(?:schema|client|configuration|controls)(?:\/[a-zA-Z0-9_-]+)*$/.test(path) ? path : undefined);
  });
  result.limits.evidenceTruncated = diagnostics.length > 16;
  return result;
}
export function appendNativeStage(result: NativeVerificationResult, stage: NativeStage, skipped = false): void {
  if (result.stages.length + result.sessions.reduce((sum, session) => sum + session.stages.length, 0) >= 32) throw Error('native-stage-limit');
  result.stages.push(stage);
  addNativeDiagnostic(result, stage, skipped);
}
export function addNativeDiagnostic(result: NativeVerificationResult, stage: NativeStage, skipped = false): void {
  if (stage.outcome === 'passed' || skipped) return;
  if (result.diagnostics.length >= 16) { result.limits.evidenceTruncated = true; return; }
  const code = stage.reason === 'cancelled' ? 'CANCELLED' : stage.reason === 'native-internal' ? 'INTERNAL_ERROR' :
    stage.outcome === 'failed' ? 'EXECUTION_FAILED' : stage.outcome === 'unsupported' ? 'SCHEMA_UNSUPPORTED' : 'PREREQUISITE_UNAVAILABLE';
  result.diagnostics.push(nativeDiagnostic(stage.reason, code));
}
export function finishNativeResult(result: NativeVerificationResult, started: number, cancelled: boolean): NativeVerificationResult {
  const rows = [...result.stages, ...result.sessions.flatMap(session => session.stages)];
  result.limits.elapsedMs = Math.max(0, Math.round(performance.now() - started));
  result.limits.sessionsStarted = result.sessions.length;
  result.limits.stagesCompleted = rows.length;
  const failed = rows.some(stage => stage.outcome === 'failed');
  const verified = result.sessions.length === 2 && rows.length > 0 && rows.every(stage => stage.outcome === 'passed') &&
    result.cleanup.processes === 'confirmed' && result.cleanup.files === 'removed' && result.security.hostSecretIsolation.outcome === 'passed';
  result.verdict = failed ? 'failed' : verified ? 'verified' : 'unverified';
  result.status = cancelled ? 'cancelled' : result.cleanup.processes === 'unresolved' || result.cleanup.files === 'retained' ? 'incomplete' : failed || verified ? 'complete' : 'incomplete';
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) {
    result.limits.evidenceTruncated = true;
    for (const stage of rows) stage.evidence = { kind: 'none' };
    result.verdict = failed ? 'failed' : 'unverified';
    if (!cancelled) result.status = 'incomplete';
  }
  return result;
}
