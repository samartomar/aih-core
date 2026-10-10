export type NativeForwarderDiagnostics = Readonly<{ accepted: number; connected: number; refused: number; capped: number }>;
export type NativePersistenceDiagnostics = Readonly<{
  schema: 'aih.native.diagnostics.v1'; event: 'native-persistence-diagnostics'; recordId: string;
  runSha256: string | null; phase: 'persistence'; stage: 'before-session-2' | 'after-session-2';
  class: 'pins' | 'configuration-facts' | 'selected-member' | 'unexpected-entry' | 'state-tree-entry' | 'inspected-state' | 'read-failure' | 'limit';
  items: readonly Readonly<{ root: 'home' | 'project'; depth: number; kind: 'file' | 'dir' | 'other'; token: string; parent: string | null }>[];
  truncated: boolean;
  inspectedDiagnosis: Readonly<{ reason: 'unknown-global-key' | 'unknown-project-key' | 'grant-content' | 'value-shape' | 'malformed-json' | 'oversized' | 'not-record' | 'read-failure'; token: string | null }> | null;
}>;
export function publishNativePersistenceDiagnostics(input: Record<string, unknown>): void;
export type NativeAuthenticationProofKind = 'telemetry-identity' | 'provisioning-bound-session';
export type NativeSessionDiagnostics = Readonly<{
  schema: 'aih.native.diagnostics.v1'; event: 'native-session-diagnostics'; recordId: string;
  runSha256: string | null; phase: 'session'; index: 1 | 2;
  definition: 'claude-win32-x64-2.1.285' | 'claude-linux-x64-wsl2-srt-2.1.285' | null;
  collector: Readonly<{
    requests: number; accepted: number;
    rejected: Readonly<Record<'auth' | 'method' | 'path' | 'contentType' | 'contentEncoding' | 'size' | 'parse' | 'other', number>>;
    contentTypes: Readonly<Record<'json' | 'protobuf' | 'other' | 'none', number>>;
    contentEncodings: Readonly<Record<'none' | 'gzip' | 'other', number>>;
    events: number; eventNames: Readonly<Record<'apiRequest' | 'apiError' | 'userPrompt' | 'assistantResponse' | 'toolResult' | 'toolDecision' | 'other', number>>;
    apiRequestRejected: Readonly<Record<'missingRequestId' | 'notSuccess' | 'missingSession' | 'wrongSession' |
      'outsideWindow', number>>;
    apiRequestIdentity: Readonly<Record<'accountAbsent' | 'organizationAbsent' | 'accountDifferent' | 'organizationDifferent' | 'invalidAttribute', number>>;
    qualifyingSuccesses: Readonly<Record<'telemetryIdentity' | 'provisioningBound', number>>;
    boundSessionEvents: number;
    authenticationProofKind: NativeAuthenticationProofKind | null;
    identityByEvent: Readonly<Record<'accountPresent' | 'accountMatches' | 'organizationPresent' | 'organizationMatches', number>>;
    firstMatchingEventIndex: number | null;
    ignored: number; matched: number; duplicates: number; wrongSession: number; conflict: boolean;
  }>;
  proxy: Readonly<Record<'apiAnthropic' | 'claudeAi' | 'platformClaude' | 'consoleAnthropic' | 'otherAnthropic' | 'collector' | 'other',
    Readonly<{ allowed: number; denied: number }>>> | null;
  runnerWarnings: number | null;
  forwarder: NativeForwarderDiagnostics | null;
  init: Readonly<{ serverStatus: 'connected' | 'pending' | 'failed' | 'needs-auth' | 'disabled' | 'absent' | 'other' | 'unobserved' }>;
  result: Readonly<{ seen: boolean; isError: boolean | null; subtype: 'none' | 'success' | 'error_max_turns' | 'error_during_execution' | 'other';
    errorClass: import('./runtime.mjs').NativeErrorClass }>;
}>;
export function publishNativeDiagnostics(input: Record<string, unknown>): void;
export function publishNativeAdmission(input: Record<string, unknown>): void;
export type NativePlatformDrift = Readonly<{
  schema: 'aih.native.diagnostics.v1'; event: 'native-platform-drift'; recordId: string; runSha256: string | null;
  definition: 'claude-linux-x64-wsl2-srt-2.1.285'; table: 'roles' | 'libraries' | 'readFiles';
  key: 'bash' | 'env' | 'bwrap' | 'socat' | 'rg' | 'which' | number | null;
  remedy: 'recapture-platform-record';
}>;
export function publishNativePlatformDrift(input: Record<string, unknown>): void;
