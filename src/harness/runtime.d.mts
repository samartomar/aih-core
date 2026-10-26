/** Certificate PEM text one applied persisted value gives a new process; `effect` is the descriptor's, `node` or `npm`. */
export interface PersistedTrustEntry { effect: string; certificates: string[] }
/** Applied persisted material, or `'unavailable'` when the caller could not read its persisted configuration. */
export type PersistedTrust = PersistedTrustEntry[] | 'unavailable';
export interface DiagnoseRequest {
  requestId: string; targets?: string[]; network?: 'declared' | 'off'; probeConfiguredMcp?: boolean; project?: string;
  /**
   * Opt-in: in-process Node TLS probes trust only the bundled roots (plus system roots when a new process would
   * enable them) and these entries, never this process's own start-time trust; `'unavailable'` reports those
   * checks unavailable. An applied `npm` entry replaces the roots for the `npm` target.
   */
  persistedTrust?: PersistedTrust;
}
export interface DiagnoseControls { signal?: AbortSignal; budgetMs?: number }
export interface DiagnoseResult {
  requestId: string; helper: { name: string; version: string }; status: 'completed' | 'cancelled' | 'invalid' | 'unavailable';
  tools: { id: string; label: string; state: string; selection: string; config?: string }[];
  observations: { id: string; target: string; detail: string }[];
  checks: { id: string; target: string; outcome: 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string; detail: string }[];
  diagnostics: { code: string; reason: string; message: string }[];
  repairChoices: { target: string; kind: 'manual-guidance'; reason: string; guidance: string }[];
  limits: { budgetMs: number; elapsedMs: number; maxActiveProbes: number };
}
export declare function validDiagnosticTargets(value: unknown): boolean;
export declare function diagnose(request: DiagnoseRequest, controls?: DiagnoseControls): Promise<DiagnoseResult>;
export interface CaDiagnostic { code: 'INPUT_INVALID'; reason: string; message: string; block?: number; offset?: number }
export type SuppliedCaResult = { valid: false; diagnostics: CaDiagnostic[]; assessedBlocks: number; assessmentLimit?: string } |
  { valid: true; diagnostics: []; assessedBlocks: number; duplicates: number;
    certificates: { fingerprint: string; subject: string; validFrom: string; validTo: string; pem: string }[];
    material: string; evaluatedAt: string };
export declare function validateSuppliedCa(bytes: Uint8Array, options?: { now?: number }): SuppliedCaResult;
export declare function composeExistingTrust(existing: Uint8Array | undefined, additions: string,
  options?: { includeNodeDefaults?: boolean }): string | undefined;
export declare function validateBaselineStore(bytes: Uint8Array):
  { valid: true; fingerprints: string[] } | { valid: false; reason: string; message: string };
export declare function parseJvmTrustStore(bytes: Uint8Array):
  { status: 'parsed'; certificates: import('./trust.mjs').ParsedCertificate[] } | { status: 'invalid'; reason: string };
export interface PersistedConfigurationMember {
  readonly id: 'node-extra-ca-certs' | 'npm-cafile'; readonly repair: string; readonly managementId: string;
  readonly materialName: string; readonly targets: readonly string[]; readonly effect: 'node' | 'npm';
  readonly member: { readonly path: string; readonly kind: 'block'; readonly blockId: string;
    readonly startMarker: string; readonly endMarker: string };
  /** The block content this repair renders for a managed material path; undefined when the path is unsupported. */
  content(materialPath: string): string | undefined;
}
/** Managed user configuration the shipped Node/npm CA repair persists on this platform; reads no host state. */
export declare function persistedConfigurationMembers(): readonly PersistedConfigurationMember[];
export declare function getRepairRecipe(recipeRef: string): object | undefined;
/** Definition-owned migration assessment; does not read or mutate custody. */
export declare function managedRepairRemovalNeedsReconciliation(request: {
  managementId: string; scope: 'project' | 'user'; platform: string; members: { kind: string; path: string }[];
}): boolean;
export declare function assessRepairCandidate(request: { id: string; inputs: Record<string, string | boolean | number> },
  controls?: { signal?: AbortSignal; budgetMs?: number }): Promise<
    { kind: 'unresolved'; reason: string; probes: number; elapsedMs?: number } |
    { kind: 'system-ca'; origins: string[]; probes: number; elapsedMs: number } |
    { kind: 'extra-ca'; origins: string[]; certs: { fingerprint: string; pem: string }[];
      probes: number; elapsedMs: number }>;
export declare function renderRepair(request: { id: string; variantRef: string;
  bundlePath?: string; bundleSha256?: string; fingerprints?: string[]; origins?: string[];
  baselineStoreSha256?: string; baselineStoreBase64?: string;
  configSnapshots?: Record<string, Uint8Array>; executablePaths?: Record<string, string> }):
  { status: 'invalid' | 'blocked'; diagnostics: { code: string; reason: string; message: string }[] } |
  { status: 'completed'; bindings: Record<string, string>; privateBindings?: Record<string, string> };
/** Render client configuration from the complete Core-composed trust set. */
export declare function renderTrustFileRepair(request: {
  id: 'node-npm-ca' | 'user-tools-ca' | 'jvm-ca'; variantRef: string;
  targets: string[]; offline: boolean; bundle: Uint8Array; bundlePath: string; bundleSha256: string;
  fingerprints: string[]; configSnapshots: Record<string, Uint8Array>;
  executablePaths: Record<string, string>; baselineStore?: Uint8Array;
}):
  { status: 'invalid' | 'blocked'; diagnostics: { code: string; reason: string; message: string }[] } |
  { status: 'completed'; bindings: Record<string, string>; privateBindings: Record<string, string>;
    recipe?: object;
    outputs?: { operationId: string; format: 'jks'; bytes: Uint8Array; sha256: string;
      fingerprints: string[]; baselineSha256: string }[] };
export declare function prepareRepairDefinition(request: { id: string; variantRef: string;
  targets: string[]; files: Record<string, Uint8Array>;
  configSnapshots?: Record<string, Uint8Array>;
  executablePaths?: Record<string, string>;
  ordinaryInputs?: Record<string, string | boolean | number>; existing?: Uint8Array;
  candidate?: { kind: 'system-ca'; origins: string[] } | { kind: 'extra-ca'; origins: string[];
    certs: { fingerprint: string; pem: string }[] };
  managedPath?: string; offline?: boolean; validateOnly?: boolean }):
  { status: 'invalid' | 'blocked'; assessedBlocks?: number; assessmentLimit?: string;
    diagnostics: { code: string; reason: string; message: string; block?: number; offset?: number; guidance?: string }[] } |
  { status: 'completed'; fingerprints: string[]; evaluatedAt: string; count: number; duplicates: number;
    bundle?: string; bindings?: Record<string, string>; privateBindings?: Record<string, string> };
export declare function repairObservationRequests(request: { id: string; targets: string[]; variantRef?: string }):
  { id: string; operationId: string; executable: string; args: string[]; timeoutMs: number; maxOutputBytes: number }[];
export declare function assessRepairObservations(request: { id: string; managedPath: string; variantRef?: string;
  observations: { id: string; output: string }[] }):
  { id: string; operationId: string; raw: string; expectedRaw: string; conflict: boolean;
    observedValue: string | null; reason: string }[];
export { discoverTrustSources, parseTrustOutput, serializeTrustSet, reviewTrustDelta, hashTrustSourceSet,
  canonicalTrustJson, detectTrustPlatform, verifyTrustAdmissionEvidence, getTrustFileIntegration } from './trust.mjs';
export type { TrustSourceKind, TrustAdapterIdentity, TrustSourceReview, TrustDiscoveryDiagnostic, TrustCertificateFact,
  TrustDiscovery, SuppliedSnapshot, ParsedCertificate, CertificateReview } from './trust.mjs';
export declare function getTrustRecipe(recipeRef: string, bindings?: { materialId: string; materialPath: string;
  outputSegments: readonly string[]; sha256: string; byteLength: number }):
  { status: 'recipe'; recipe: object } | { status: 'unavailable'; code: 'PREREQUISITE_UNAVAILABLE'; reason: 'native-route-unsupported' } |
  { status: 'invalid'; code: 'INPUT_INVALID'; reason: 'repair-bindings' } | undefined;
export interface GitHubPolicySource {
  provider: 'github'; repository: { owner: string; name: string }; path: string;
  revision: { kind: 'commit' | 'branch' | 'tag'; value: string };
}
export interface GitHubPolicyReaderControls {
  authentication?: { kind: 'none' } | { kind: 'bearer'; token: string };
  signal?: AbortSignal;
}
export interface GitHubPolicyReaderIdentity { id: 'github-policy-reader'; package: { name: string; version: string } }
export interface GitHubPolicyReaderAccounting { requests: number; responseBytes: number }
export type ReadGitHubPolicyResult =
  | { status: 'read'; source: GitHubPolicySource; resolvedCommit: string; blobId: string; bytes: Uint8Array;
      contentDigest: string; retrievedAt: string;
      helper: GitHubPolicyReaderIdentity; accounting: GitHubPolicyReaderAccounting }
  | { status: 'invalid' | 'unavailable' | 'cancelled'; code: 'INPUT_INVALID' | 'AUTHORITY_UNAVAILABLE' | 'CANCELLED';
      reason: 'source-invalid' | 'authentication-required-or-denied' | 'source-missing-or-inaccessible' | 'rate-limited' |
        'network-failed' | 'deadline' | 'request-count' | 'response-bytes' | 'source-not-regular-file' | 'response-invalid' | 'cancelled';
      message: string; source?: GitHubPolicySource; retryAfterSeconds?: number;
      helper: GitHubPolicyReaderIdentity; accounting: GitHubPolicyReaderAccounting };
export declare function readGitHubPolicy(source: unknown, controls?: GitHubPolicyReaderControls): Promise<ReadGitHubPolicyResult>;
/** A caller-selected local organization document: an absolute path to a regular file, read offline. */
export interface LocalPolicySource { provider: 'local'; path: string }
export interface LocalPolicyReaderIdentity { id: 'local-policy-reader'; package: { name: string; version: string } }
export type ReadLocalPolicyResult =
  | { status: 'read'; source: LocalPolicySource; bytes: Uint8Array; contentDigest: string; helper: LocalPolicyReaderIdentity }
  | { status: 'invalid' | 'unavailable' | 'cancelled'; code: 'INPUT_INVALID' | 'AUTHORITY_UNAVAILABLE' | 'CANCELLED';
      reason: 'source-invalid' | 'source-missing-or-inaccessible' | 'source-not-regular-file' | 'response-bytes' | 'cancelled';
      message: string; source?: LocalPolicySource; helper: LocalPolicyReaderIdentity };
/** Reads one bounded local organization document without network access; links and non-regular files are refused. */
export declare function readLocalPolicy(source: unknown, controls?: { signal?: AbortSignal }): Promise<ReadLocalPolicyResult>;
export { inspectToolHost } from './tool-host.mjs';
export type { ToolHostItemReference, ToolHostItem, ToolHostRequest, ToolHostControls, ToolHostCopy, ToolHostBlocker,
  ToolHostWarning, ToolHostUnchecked, ToolHostItemResult, ToolHostLimits, ToolHostResult } from './tool-host.mjs';
export { renderMacosSessionLaunchAgent,
  observeMacosGuiSession, observeMacosApplication, readMacosGuiDomainKey } from './macos-session-public.mjs';
export type { MacosSessionLaunchAgentIntent, MacosSessionLaunchAgent,
  MacosSessionControls, MacosGuiSessionObservation, MacosApplicationRequest, MacosApplicationObservation,
  MacosGuiKeyRequest, MacosGuiKeyRead } from './macos-session.mjs';
