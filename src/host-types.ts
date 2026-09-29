import type { Diagnostic, ExecutionPolicy, Json } from './types.js';
declare const liveHandle: unique symbol;
export interface PreparedHandle { readonly [liveHandle]: true }
export interface PolicyRequest { useCase: 'policy'; policy: ExecutionPolicy; target: { project: string } }
export interface HostControls {
  signal?: AbortSignal;
  logging?: 'on' | 'off';
  privateInputs?: Record<string, Record<string, Json>>;
}
export interface Authorization {
  reviewDigest: string;
  approved: true;
  origin: 'interactive' | 'automation';
  allowPartial?: boolean;
}
export interface Effective<T> { value: T; origin: 'default' | 'explicit' }
export type RecordStatus = { status: 'written'; reference: string } | { status: 'disabled'; reason: 'logging-off' } |
  { status: 'failed'; reason: 'record-limit' | 'record-write'; diagnosticId: string };
export interface ReviewOperation {
  id: string; purpose: string; kind: 'file.write'; scope: 'project';
  effects: 'create-file' | 'already-satisfied' | 'conflict';
  ownership: 'managed' | 'unowned';
  requires: string[]; checks: never[];
  details: { target: string; content: string; mode: number };
}
export interface PreparedReview {
  schema: 'urn:aihq:core:prepared-work:1.0.0'; useCase: 'policy'; mode: 'vibe';
  target: { scope: 'project'; project: string };
  inputs: { policySha256: string; package: { name: string; version: string } };
  operations: ReviewOperation[];
  observations: { id: string; reason: string }[];
  conflicts: Diagnostic[]; omissions: Diagnostic[];
  effectiveOptions: { logging: Effective<'on' | 'off'>; inputs: Record<string, { origin: 'default' | 'explicit' | 'private' }> };
  reviewDigest: string;
}
export interface PreparationResult {
  status: 'ready' | 'partial' | 'blocked' | 'invalid' | 'cancelled';
  runId: string; review?: PreparedReview; prepared?: PreparedHandle;
  diagnostics: Diagnostic[]; record: RecordStatus;
}
export interface OperationResult {
  id: string; application: 'not-attempted' | 'already-satisfied' | 'applied' | 'failed';
  verification: { status: 'unverified'; reason: 'no-supplied-check' };
  reason?: string; effectsUncertain?: boolean;
}
export interface RunResult {
  schema: 'urn:aihq:core:run-result:1.0.0'; runId: string; useCase: 'policy';
  completion: 'complete' | 'incomplete' | 'cancelled' | 'rejected';
  inputs?: PreparedReview['inputs'];
  authorization?: { origin: Authorization['origin']; allowPartial: Effective<boolean> };
  effectiveOptions: { logging: Effective<'on' | 'off'> };
  operations: OperationResult[]; checks: never[]; diagnostics: Diagnostic[];
  record: RecordStatus; recovery?: string; followUp: string[];
}
