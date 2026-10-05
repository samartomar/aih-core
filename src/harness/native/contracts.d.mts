export type NativeClientId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'windsurf' | 'opencode' | 'kimi' | 'kiro' | 'antigravity' | 'zed';
export type NativeMember = { path: string; sha256: string; byteLength: number };
export type NativeTreeFile = { root: 'home' | 'project'; path: string; member: NativeMember };
export type NativeVerificationDefinition = {
  schema: 'urn:aihq:harness:native-verification-definition:1.0.0' | 'urn:aihq:harness:native-verification-definition:1.1.0';
  id: string; client: NativeClientId; state: 'candidate' | 'admitted';
  platform: { os: 'win32' | 'linux' | 'darwin'; arch: 'x64' | 'arm64'; execution: 'native' | 'wsl2'; osRelease: string };
  clientVersions: string[]; executableNames: string[]; runtimeMembers: NativeMember[];
  versionArgv: string[]; sessionArgv: string[]; parserId: string; identityAdapterId: 'claude-oauth-otel.v1';
  credentialDestination: { root: 'home'; path: string };
  guardrails: NativeTreeFile[]; guardrailsSha256: string;
  lifecycleId: 'windows-job.v1' | 'posix-group.v1' | 'linux-srt.v1';
  isolation: { mechanism: 'none' | 'client-native' | 'vendor-runtime'; observerId: string | null; documentation: string[] };
  evidenceSha256: string | null;
};
export type NativeTestIdentity = {
  schema: 'urn:aihq:harness:native-test-identity:1.0.0'; id: string; client: 'claude';
  adapterId: 'claude-oauth-otel.v1'; purpose: 'dedicated-native-test';
  expected: { accountUuid: string; organizationId: string };
  credential: { path: 'oauth.json'; sha256: string; byteLength: number };
};
export type NativeValidationDiagnostic = { code: 'INPUT_INVALID'; reason: string; message: string; path: string };
export type NativeValidationResult = { valid: boolean; diagnostics: NativeValidationDiagnostic[] };
export type NativeBundledFixture = {
  id: string; client: NativeClientId; adapterId: string; proofScope: 'bundled-mechanism'; archiveSha256: null;
  manifestSha256: string; outputTree: NativeTreeFile[]; outputTreeSha256: string;
  guardrails: NativeTreeFile[]; guardrailsSha256: string;
  instructions: { root: 'home' | 'project'; path: string; sha256: string; evidence: 'native' | 'marker'; markerSha256?: string }[];
  server: { name: string; transport: 'stdio'; runtime: NativeMember[]; evidenceAdapterId: string;
    observation: 'native' | 'recorder'; recorder?: NativeMember; toolNames: string[]; queryTool: string;
    queryArguments: Record<string, unknown>; challenge: { mode: 'argument'; field: string } | { mode: 'rpc-id' };
    expectedResultSha256: string; expectedAnswer: string };
};

export const nativeClientIds: readonly NativeClientId[];
export const nativeBounds: Readonly<Record<string, number>>;
export const nativeRunStageIds: readonly string[];
export const nativeSessionStageIds: readonly string[];
export const nativeStageReasons: readonly string[];
export const nativeParserIds: readonly string[];
export const nativeIdentityAdapterIds: readonly string[];
export const nativeLifecycleIds: readonly string[];
export const nativeEvidenceAdapterIds: readonly string[];
export const nativeVerificationDefinitions: readonly Readonly<NativeVerificationDefinition>[];
export const bundledNativeFixtures: readonly Readonly<NativeBundledFixture>[];
export function validateNativeVerificationDefinition(value: unknown): NativeValidationResult;
export function validateNativeTestIdentity(value: unknown): NativeValidationResult;
