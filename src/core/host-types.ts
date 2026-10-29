import type { Diagnostic, ExecutionPolicy, GitMaterialProvenance, SelectionMetadata, Json, JsonObject, OrganizationAdvisoryResult, OrganizationFulfillmentResult,
  OrganizationTargetDeclaration } from './types.js';
import type { GitHubPolicySource, LocalPolicySource } from '../harness/runtime.mjs';
import type { AuthenticationTrust, AssociationResult, AssociateEvidenceControls } from './evidence/types.js';
import type { TrustInputs, TrustRunTrust } from './trust-contracts.js';
import type { MacosSessionReview, MacosSessionRun } from './macos-session-contracts.js';
export type { GitHubPolicySource, LocalPolicySource } from '../harness/runtime.mjs';
declare const liveHandle: unique symbol;
export interface PreparedHandle { readonly [liveHandle]: true }
export interface PolicyRequest {
  useCase: 'policy'; policy: ExecutionPolicy; target: { project: string };
  /**
   * Required exactly when `policy.mode` is `enterprise`; selected independently of the policy document. A local source
   * is read offline and needs execution policy 1.4.0, whose review names the file.
   */
  organizationSource?: GitHubPolicySource | LocalPolicySource;
  /**
   * Enterprise only: Catalog-resolved members of the sets organization 1.2.0 selectors name, supplied as data. Without a
   * set's members its selector is `unavailable` and admission fails closed; Core never expands a set.
   */
  organizationSetMembers?: import('./types.js').OrganizationSetMembers[];
  /**
   * Optional caller-declared client and repository for an Enterprise policy. It is reported as declared, never inferred
   * or verified, and is rejected for a Vibe policy.
   */
  organizationTarget?: OrganizationTargetDeclaration;
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
  /**
   * Prepared work 1.7.0: the consumer's current release index, in the inventory's shape. Prepare records each named
   * item's status in it and Apply compares that status again; without an index the status is `unknown`. Core never
   * reads a Catalog or index itself.
   */
  index?: import('./internal/release-index.js').ManagedInventoryIndex;
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
  id: string; purpose: string; kind: 'file.write' | 'config.entries' | 'config.member' | 'text.block' | 'file.remove' | 'process.run' | 'hook.group'; scope: 'project' | 'user';
  effects: 'create-file' | 'replace-file' | 'remove-file' | 'already-satisfied' | 'conflict' | 'opaque-process' | 'unavailable';
  ownership: 'managed' | 'unowned';
  requires: string[]; checks: ReviewCheck[];
  details: { target?: string; content?: string; mode?: number; executable?: string; args?: string[];
    cwd?: string; env?: Record<string, string>; stdinProtected?: boolean; stdin?: string; material?: string;
    materialSha256?: string; materialBytes?: number; executableSha256?: string;
    timeoutMs?: Effective<number>; maxOutputBytes?: Effective<number>; acceptedExitCodes?: number[];
    declaredEffects?: string[]; reason?: string;
    format?: 'json' | 'jsonc' | 'toml' | 'ini' | 'yaml' | 'properties'; entries?: { path: string[]; action: 'set' | 'remove'; value?: string }[];
    blockId?: string; startMarker?: string; endMarker?: string; blockAction?: 'set' | 'remove';
    /** Present exactly for `hook.group` operations (prepared-work 1.1.0). */
    hookGroup?: HookGroupReview;
    /** Prepared work 1.6.0, `config.member`: the array and the one member's canonical JSON (omitted in generated cleanup). */
    member?: { container: string[]; action: 'add' | 'remove'; value?: string };
    /** Prepared work 1.6.0: this edit is the person's OK for one MCP server in `tool`. */
    approval?: { tool: string } };
  /** Prepared work 1.6.0: the selection behind this operation; `null` for generated lifecycle cleanup. */
  selectionId?: string | null;
}
/** UTF-8 bytes and UTF-16 characters, as Catalog measures them. */
export interface ReviewSize { bytes: number; chars: number }
/**
 * Prepared work 1.6.0: one entry per policy selection, in policy order. The item, tool, name, kind and origins repeat
 * the selection's descriptive metadata; the rest is measured from what this preparation will deliver.
 */
export interface PreparedSelection extends Partial<SelectionMetadata> {
  selectionId: string; managementId: string; scope: 'project' | 'user';
  /** Where a referenced recipe from an exact git commit came from; absent for every other source. */
  materialSource?: GitMaterialProvenance;
  /** Each hook command the selection registers, verbatim; private input values are redacted. */
  hookCommands?: string[];
  /** The step the user still takes in the tool, from the shipped binding for the named tool and kind. */
  permissionStep?: string;
  /** Bound recipe inputs by name only; values never appear in a review. */
  inputs: string[];
  /** Delivered files and marker-block text; `alwaysLoaded` needs a kind. Absent when the selection's material was unavailable. */
  deliveredSize?: ReviewSize & { alwaysLoaded?: ReviewSize };
  /** Prepared work 1.7.0, with item metadata: the item's Catalog framework id. */
  framework?: string;
  /** Prepared work 1.7.0, with item metadata: the binding cell the recipe was rendered from and its proof level. */
  layout?: { bindingDigest: string; support: 'native' | 'none' | 'unconfirmed';
    observed: 'recognised' | 'registered' | 'listed-only' | 'delivered' | 'none' };
  /** Prepared work 1.7.0: the picked record, present only when a record passed Core's check against this selection's bytes. */
  scanId?: string;
  coverage?: 'matched' | 'mismatched' | 'unavailable' | 'invalid';
  /** Prepared work 1.7.0, with item metadata: Scan's card summary, computed by Core from the checked record. */
  scanState?: ScanSummary;
}
/** Scan `urn:aihq:scan:item-summary:1.0.0`, following Scan's decision table. */
export interface ScanSummary {
  state: 'verified' | 'not-verified' | 'partial' | 'not-covered' | 'not-scanned' | 'unreadable';
  why?: 'not-authenticated' | 'unchecked' | 'offline' | 'revoked' | 'detector-missing' | 'profile-not-allowed' | 'future-dated' | 'older-than-policy';
  findings: { error: number; warning: number; note: number; unavailable: number };
  suppressed: number; scannedAt: string | null;
}
/**
 * The reviewed binding a `REVIEW_STALE` diagnostic names. Run result 1.4.0 uses the first seven; run result 1.5.0 uses
 * the owner's closed list: `policy`, `index-status`, `scan-state`, `binding` and `target-file`.
 */
export type StaleBinding = 'policy' | 'recipe' | 'target-file' | 'ownership' | 'input' | 'host' | 'trust' |
  'index-status' | 'scan-state' | 'binding';
export interface HookGroupReview {
  container: string[]; groupId: string; selector: { path: (string | number)[]; valueSha256: string }; action: 'set' | 'remove';
  matchedIndex: number | null; memberBeforeSha256: string | null; memberAfterSha256: string | null;
  targetBeforeSha256: string | null; desiredGroup: JsonObject | null;
}
export interface ReviewCheck { id: string; purpose: string; kind: 'file.sha256' | 'process.exit';
  details: ReviewOperation['details'] }
export type OrganizationBinding = {
  source: GitHubPolicySource; resolvedCommit: string; blobId: string; contentDigest: string; policyId: string;
  helper: { id: 'github-policy-reader'; package: { name: string; version: string } };
} | {
  /** A local source is named by its file name only. */
  source: { provider: 'local'; fileName: string }; contentDigest: string; policyId: string;
  helper: { id: 'local-policy-reader'; package: { name: string; version: string } };
};
/** Obligation results for the declared target; a not-fulfilled result never blocks preparation. */
export interface OrganizationObligationsReview {
  target: { basis: 'declared'; client: import('./internal/native-clients.js').NativeClientId; repository?: string };
  fulfillment: (Omit<OrganizationFulfillmentResult, 'status'> & { scope: 'project' | 'user';
    status: Exclude<OrganizationFulfillmentResult['status'], 'not-applicable'> })[];
  advisory: (OrganizationAdvisoryResult & { scope: 'project' | 'user' })[];
}
export interface PreparedReview {
  schema: 'urn:aihq:core:prepared-work:1.0.0' | 'urn:aihq:core:prepared-work:1.1.0' | 'urn:aihq:core:prepared-work:1.2.0' | 'urn:aihq:core:prepared-work:1.3.0' | 'urn:aihq:core:prepared-work:1.4.0' | 'urn:aihq:core:prepared-work:1.5.0' | 'urn:aihq:core:prepared-work:1.6.0' | 'urn:aihq:core:prepared-work:1.7.0'; useCase: 'policy' | 'repair' | 'certificate-export'; mode: 'vibe' | 'enterprise' | 'standalone';
  target: { scope: 'project' | 'user'; project: string };
  inputs: { policySha256: string; package: { name: string; version: string }; organization?: OrganizationBinding } |
    { sourceSha256: string; certificates: string[]; candidateKind?: 'system-ca' | 'extra-ca';
      helperSha256: string; package: { name: string; version: string } } | TrustInputs | MacosPreparedInputs;
  operations: ReviewOperation[];
  /** Prepared work 1.6.0 and 1.7.0 only. */
  selections?: PreparedSelection[];
  /** Prepared work 1.7.0 only: the items the request left out; none of them is selected, by any route. */
  excluded?: { item: import('./types.js').CatalogItemRef; reason: 'excluded-in-request' }[];
  observations: { id: string; reason: string }[];
  conflicts: Diagnostic[]; omissions: Diagnostic[];
  effectiveOptions: { logging: Effective<'on' | 'off'>; inputs: Record<string, { origin: 'default' | 'explicit' | 'private' }> };
  reviewDigest: string;
  evidence?: AssociationResult[];
  /** Present only when the request declared an organization target. */
  organizationObligations?: OrganizationObligationsReview;
}
export interface MacosPreparedInputs {
  trust: Omit<TrustInputs['trust'], 'definition'> & {
    definition: { id: string; schema: 'urn:aihq:harness:repair:1.2.0' }
  };
  macosSession: MacosSessionReview;
}
/**
 * Digest hint for a new reviewed `PolicyRequest.resolutions` entry: the exact target
 * digest this Prepare compared for one authored operation. Not authorization.
 */
export interface ResolutionInput {
  selectionId: string; operationId: string; observedSha256: string | null; availableChoices: ('replace' | 'adopt')[];
}
/**
 * The selection behind one review operation. An authored operation's review `id` is
 * `<selectionId>/<operationId>`; generated lifecycle cleanup (`lifecycle/remove-<n>`) has
 * `selectionId` and `operationId` `null`. Reported beside the review, never inside it or its digest.
 */
export interface OperationSelection { id: string; selectionId: string | null; operationId: string | null }
export interface PreparationResult {
  status: 'ready' | 'partial' | 'blocked' | 'invalid' | 'cancelled';
  runId: string; review?: PreparedReview; prepared?: PreparedHandle;
  diagnostics: Diagnostic[]; record: RecordStatus;
  evidence?: AssociationResult[];
  /** Always present for policy Prepare, in review operation order; omitted for repair. */
  resolutionInputs?: ResolutionInput[];
  /** Always present for policy Prepare: one entry per review operation, in review operation order; omitted for repair. */
  operationSelections?: OperationSelection[];
}
export interface OperationResult {
  id: string; application: 'not-attempted' | 'already-satisfied' | 'applied' | 'failed';
  verification: { status: 'unverified' | 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string };
  reason?: string; effectsUncertain?: boolean;
}
/**
 * Run result 1.4.0: one touched member, checked directly on disk after Apply. `outcome` is what the run did to the
 * member; `check` is what Core found there afterwards. A member the run did not attempt is `kept` and `unchecked`.
 * No digest, previous value or input value is reported.
 */
export interface RunMember {
  operationId: string; selectionId: string | null; managementId: string; scope: 'project' | 'user';
  kind: 'file' | 'text-block' | 'entry-block' | 'entry-pointer' | 'config-entry' | 'config-member' | 'hook-group-member';
  /** The member's file. */
  path: string;
  /** JSON Pointer of a configuration entry or member. */
  pointer?: string;
  blockId?: string;
  groupId?: string;
  /** What the reviewed plan meant for the member: write it, remove (or restore) it, or keep it for another claim. */
  intent: 'write' | 'remove' | 'keep';
  outcome: 'written' | 'claim-removed' | 'restored' | 'kept';
  check: 'present-matching' | 'present-different' | 'absent' | 'unchecked';
}
/**
 * Run result 1.4.0: a `REVIEW_STALE` diagnostic carries `changed` (with reason `binding-changed`) when a reviewed binding
 * changed, or reason `handle-unavailable` / `digest-mismatch`, which are not binding changes.
 */
export interface RunDiagnostic extends Diagnostic { changed?: StaleBinding }
export interface CheckResult { id: string; operationId: string; status: 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string;
  effectsUncertain?: boolean; terminationUnconfirmed?: boolean }
export interface RunResult {
  schema: 'urn:aihq:core:run-result:1.0.0' | 'urn:aihq:core:run-result:1.1.0' | 'urn:aihq:core:run-result:1.2.0' | 'urn:aihq:core:run-result:1.3.0' | 'urn:aihq:core:run-result:1.4.0' | 'urn:aihq:core:run-result:1.5.0'; runId: string; useCase: 'policy' | 'repair' | 'certificate-export';
  completion: 'complete' | 'incomplete' | 'cancelled' | 'rejected';
  inputs?: PreparedReview['inputs'];
  /** `reviewDigest` names the prepared work 1.6.0 review this run applied. */
  authorization?: { origin: Authorization['origin']; allowPartial: Effective<boolean>; reviewDigest?: string };
  effectiveOptions: { logging: Effective<'on' | 'off'> };
  operations: OperationResult[]; checks: CheckResult[]; diagnostics: RunDiagnostic[];
  record: RecordStatus; recovery?: string; followUp: string[];
  evidence?: AssociationResult[];
  trust?: TrustRunTrust;
  macosSession?: MacosSessionRun;
  /** Run result 1.4.0: every member a reviewed file operation touched, with its direct post-apply check. */
  members?: RunMember[];
}
