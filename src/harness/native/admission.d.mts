export type NativeForwarderDiagnostics = Readonly<{ accepted: number; connected: number; refused: number; capped: number }>;
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
      'accountMissing' | 'accountDifferent' | 'organizationMissing' | 'organizationDifferent' | 'outsideWindow', number>>;
    identityByEvent: Readonly<Record<'accountPresent' | 'accountMatches' | 'organizationPresent' | 'organizationMatches', number>>;
    firstMatchingEventIndex: number | null;
    ignored: number; matched: number; duplicates: number; wrongSession: number; conflict: boolean;
  }>;
  proxy: Readonly<Record<'apiAnthropic' | 'claudeAi' | 'platformClaude' | 'consoleAnthropic' | 'otherAnthropic' | 'collector' | 'other',
    Readonly<{ allowed: number; denied: number }>>> | null;
  forwarder: NativeForwarderDiagnostics | null;
  result: Readonly<{ seen: boolean; isError: boolean | null; subtype: 'none' | 'success' | 'error_max_turns' | 'error_during_execution' | 'other';
    errorClass: 'none' | 'authentication' | 'forbidden' | 'rate-limit' | 'overloaded' | 'network' | 'other' }>;
}>;
export function publishNativeDiagnostics(input: Record<string, unknown>): void;
export function publishNativeAdmission(input: Record<string, unknown>): void;
