import type { Diagnostic, ExecutionPolicy, Json, JsonObject } from './types.js';
import type { GitHubPolicySource } from '../harness/runtime.mjs';
import type { AuthenticationTrust, AssociationResult, AssociateEvidenceControls } from './evidence/types.js';
import type { TrustInputs, TrustRunTrust } from './trust-contracts.js';
export type { GitHubPolicySource } from '../harness/runtime.mjs';
declare const liveHandle: unique symbol;
export interface PreparedHandle { readonly [liveHandle]: true }
export interface PolicyRequest {
  useCase: 'policy'; policy: ExecutionPolicy; target: { project: string };
  /** Required exactly when `policy.mode` is `enterprise`; selected independently of the policy document. */
  organizationSource?: GitHubPolicySource;
  resolutions?: { selectionId: string; operationId: string; choice: 'replace' | 'adopt'; observedSha256: string | null }[];
}
export interface HostControls {
  signal?: AbortSignal;
  logging?: 'on' | 'off';
  privateInputs?: Record<string, Record<string, Json>>;
  materialRoots?: Record<string, string>;
  /** Used only to read the organization source; never serialized into reviews, state, history or diagnostics. */
  authentication?: { kind: 'none' } | { kind: 'bearer'; token: string };
  /** Explicit optional evidence acquisition and independently selected trust. Defaults to no acquisition. */
  evidence?: { acquire?: boolean; trust?: AuthenticationTrust; authentication?: AssociateEvidenceControls['authentication'] };
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
  id: string; purpose: string; kind: 'file.write' | 'config.entries' | 'text.block' | 'file.remove' | 'process.run' | 'hook.group'; scope: 'project' | 'user';
  effects: 'create-file' | 'replace-file' | 'remove-file' | 'already-satisfied' | 'conflict' | 'opaque-process' | 'unavailable';
  ownership: 'managed' | 'unowned';
  requires: string[]; checks: ReviewCheck[];
  details: { target?: string; content?: string; mode?: number; executable?: string; args?: string[];
    cwd?: string; env?: Record<string, string>; stdinProtected?: boolean; stdin?: string; material?: string;
    materialSha256?: string; materialBytes?: number; executableSha256?: string;
    timeoutMs?: Effective<number>; maxOutputBytes?: Effective<number>; acceptedExitCodes?: number[];
    declaredEffects?: string[]; reason?: string;
    format?: 'json' | 'jsonc' | 'toml'; entries?: { path: string[]; action: 'set' | 'remove'; value?: string }[];
    blockId?: string; startMarker?: string; endMarker?: string; blockAction?: 'set' | 'remove';
    /** Present exactly for `hook.group` operations (prepared-work 1.1.0). */
    hookGroup?: HookGroupReview };
}
export interface HookGroupReview {
  container: string[]; groupId: string; selector: { path: (string | number)[]; valueSha256: string }; action: 'set' | 'remove';
  matchedIndex: number | null; memberBeforeSha256: string | null; memberAfterSha256: string | null;
  targetBeforeSha256: string | null; desiredGroup: JsonObject | null;
}
export interface ReviewCheck { id: string; purpose: string; kind: 'file.sha256' | 'process.exit';
  details: ReviewOperation['details'] }
export interface OrganizationBinding {
  source: GitHubPolicySource; resolvedCommit: string; blobId: string; contentDigest: string; policyId: string;
  helper: { id: 'github-policy-reader'; package: { name: string; version: string } };
}
export interface PreparedReview {
  schema: 'urn:aihq:core:prepared-work:1.0.0' | 'urn:aihq:core:prepared-work:1.1.0' | 'urn:aihq:core:prepared-work:1.2.0'; useCase: 'policy' | 'repair' | 'certificate-export'; mode: 'vibe' | 'enterprise' | 'standalone';
  target: { scope: 'project' | 'user'; project: string };
  inputs: { policySha256: string; package: { name: string; version: string }; organization?: OrganizationBinding } |
    { sourceSha256: string; certificates: string[]; candidateKind?: 'system-ca' | 'extra-ca';
      helperSha256: string; package: { name: string; version: string } } | TrustInputs;
  operations: ReviewOperation[];
  observations: { id: string; reason: string }[];
  conflicts: Diagnostic[]; omissions: Diagnostic[];
  effectiveOptions: { logging: Effective<'on' | 'off'>; inputs: Record<string, { origin: 'default' | 'explicit' | 'private' }> };
  reviewDigest: string;
  evidence?: AssociationResult[];
}
/**
 * Digest hint for a new reviewed `PolicyRequest.resolutions` entry: the exact target
 * digest this Prepare compared for one authored operation. Not authorization.
 */
export interface ResolutionInput {
  selectionId: string; operationId: string; observedSha256: string | null; availableChoices: ('replace' | 'adopt')[];
}
export interface PreparationResult {
  status: 'ready' | 'partial' | 'blocked' | 'invalid' | 'cancelled';
  runId: string; review?: PreparedReview; prepared?: PreparedHandle;
  diagnostics: Diagnostic[]; record: RecordStatus;
  evidence?: AssociationResult[];
  /** Always present for policy Prepare, in review operation order; omitted for repair. */
  resolutionInputs?: ResolutionInput[];
}
export interface OperationResult {
  id: string; application: 'not-attempted' | 'already-satisfied' | 'applied' | 'failed';
  verification: { status: 'unverified' | 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string };
  reason?: string; effectsUncertain?: boolean;
}
export interface CheckResult { id: string; operationId: string; status: 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string;
  effectsUncertain?: boolean; terminationUnconfirmed?: boolean }
export interface RunResult {
  schema: 'urn:aihq:core:run-result:1.0.0' | 'urn:aihq:core:run-result:1.1.0' | 'urn:aihq:core:run-result:1.2.0'; runId: string; useCase: 'policy' | 'repair' | 'certificate-export';
  completion: 'complete' | 'incomplete' | 'cancelled' | 'rejected';
  inputs?: PreparedReview['inputs'];
  authorization?: { origin: Authorization['origin']; allowPartial: Effective<boolean> };
  effectiveOptions: { logging: Effective<'on' | 'off'> };
  operations: OperationResult[]; checks: CheckResult[]; diagnostics: Diagnostic[];
  record: RecordStatus; recovery?: string; followUp: string[];
  evidence?: AssociationResult[];
  trust?: TrustRunTrust;
}
