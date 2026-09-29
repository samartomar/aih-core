import type { Diagnostic, ExecutionPolicy, Json } from './types.js';
declare const liveHandle: unique symbol;
export interface PreparedHandle { readonly [liveHandle]: true }
export interface PolicyRequest {
  useCase: 'policy'; policy: ExecutionPolicy; target: { project: string };
  resolutions?: { selectionId: string; operationId: string; choice: 'replace' | 'adopt'; observedSha256: string | null }[];
}
export interface HostControls {
  signal?: AbortSignal;
  logging?: 'on' | 'off';
  privateInputs?: Record<string, Record<string, Json>>;
  materialRoots?: Record<string, string>;
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
  id: string; purpose: string; kind: 'file.write' | 'config.entries' | 'text.block' | 'file.remove' | 'process.run'; scope: 'project' | 'user';
  effects: 'create-file' | 'replace-file' | 'remove-file' | 'already-satisfied' | 'conflict' | 'opaque-process' | 'unavailable';
  ownership: 'managed' | 'unowned';
  requires: string[]; checks: ReviewCheck[];
  details: { target?: string; content?: string; mode?: number; executable?: string; args?: string[];
    cwd?: string; env?: Record<string, string>; stdinProtected?: boolean; stdin?: string; material?: string;
    materialSha256?: string; materialBytes?: number; executableSha256?: string;
    timeoutMs?: Effective<number>; maxOutputBytes?: Effective<number>; acceptedExitCodes?: number[];
    declaredEffects?: string[]; reason?: string;
    format?: 'json' | 'jsonc' | 'toml'; entries?: { path: string[]; action: 'set' | 'remove'; value?: string }[];
    blockId?: string; startMarker?: string; endMarker?: string; blockAction?: 'set' | 'remove' };
}
export interface ReviewCheck { id: string; purpose: string; kind: 'file.sha256' | 'process.exit';
  details: ReviewOperation['details'] }
export interface PreparedReview {
  schema: 'urn:aihq:core:prepared-work:1.0.0'; useCase: 'policy' | 'repair'; mode: 'vibe' | 'standalone';
  target: { scope: 'project' | 'user'; project: string };
  inputs: { policySha256: string; package: { name: string; version: string } } |
    { sourceSha256: string; certificates: string[]; helperSha256: string; package: { name: string; version: string } };
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
  verification: { status: 'unverified' | 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string };
  reason?: string; effectsUncertain?: boolean;
}
export interface CheckResult { id: string; operationId: string; status: 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string;
  effectsUncertain?: boolean; terminationUnconfirmed?: boolean }
export interface RunResult {
  schema: 'urn:aihq:core:run-result:1.0.0'; runId: string; useCase: 'policy' | 'repair';
  completion: 'complete' | 'incomplete' | 'cancelled' | 'rejected';
  inputs?: PreparedReview['inputs'];
  authorization?: { origin: Authorization['origin']; allowPartial: Effective<boolean> };
  effectiveOptions: { logging: Effective<'on' | 'off'> };
  operations: OperationResult[]; checks: CheckResult[]; diagnostics: Diagnostic[];
  record: RecordStatus; recovery?: string; followUp: string[];
}
