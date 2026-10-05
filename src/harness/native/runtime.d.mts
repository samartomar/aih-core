import type { NativeBundledFixture, NativeClientId, NativeMember, NativeVerificationDefinition } from './contracts.mjs';

export * from './contracts.mjs';
/** Internal composition used only with the fixed installed exports by Core. */
export function createNativeRuntime(module: typeof import('./runtime.mjs'), dependencies: {
  readPinned: typeof import('../../core/internal/native-material.js').nativeReadPinned;
  Stop: typeof import('../../core/internal/native-input.js').NativeStop;
}): import('../../core/internal/native-session.js').NativeRuntime;

export type NativePlatform = { os: 'win32' | 'linux' | 'darwin' | 'unsupported'; arch: string; osRelease: string; execution: 'native' | 'wsl2' };
export type NativeStageOutcome = 'passed' | 'failed' | 'unsupported' | 'restricted' | 'unavailable';
export type NativeStageEvidence = { kind: 'none' } | { kind: 'digest'; sha256: string } | { kind: 'counts'; count: number } | { kind: 'match'; matched: boolean };
export type NativeSessionRow = { id: string; session: 1 | 2; outcome: NativeStageOutcome; reason: string; evidence: NativeStageEvidence };

export function parseStrictJson(text: string, maxDepth?: number): unknown;
export function canonicalJson(value: unknown): string;
export function sha256(bytes: Uint8Array | string): string;
export function configurationDigest(digests: { outputTreeSha256: string; guardrailsSha256: string }): string;
export function definitionIdentity(definition: NativeVerificationDefinition): { id: string; sha256: string };

export type ResolvedFixture = {
  outcome: 'selected'; id: string; client: NativeClientId; proofScope: 'bundled-mechanism'; archiveSha256: null;
  manifestSha256: string; outputTreeSha256: string; guardrailsSha256: string; adapterId: string;
  instructions: NativeBundledFixture['instructions']; server: NativeBundledFixture['server'];
  files: { root: 'home' | 'project'; path: string; key: string; sha256: string; byteLength: number; bytes: Buffer }[];
  outputPaths: { root: 'home' | 'project'; path: string }[]; guardrailPaths: { root: 'home' | 'project'; path: string }[];
};
export function resolveBundledFixture(client: NativeClientId): ResolvedFixture | { outcome: 'unsupported'; reason: 'client-unsupported' };
export function verifyFixtureMaterials(resolved: ResolvedFixture): { ok: true } | { ok: false; reason: 'fixture-bytes-mismatch' };

export function observeNativePlatform(overrides?: { platform?: string; arch?: string; release?: string }): NativePlatform;
export type CellSelection =
  | { outcome: 'selected'; definition: NativeVerificationDefinition; adapter: { id: string; sha256: string } }
  | { outcome: 'unsupported'; reason: 'client-unsupported' | 'platform-unsupported' | 'cell-not-admitted'; missing?: string };
export function selectNativeCell(input: { client: NativeClientId; admission: 'admitted' | 'candidate-smoke'; platform: NativePlatform;
  definitions?: readonly NativeVerificationDefinition[] }): CellSelection;
export function matchClientVersion(definition: NativeVerificationDefinition, observed: string | null):
  { outcome: 'matched' } | { outcome: 'unsupported'; reason: 'version-unsupported' } | { outcome: 'unavailable'; reason: 'version-unreadable' };
export function parseClaudeVersionOutput(text: unknown): string | null;

export type OwnedCell = { basename: string; path: string; parent: string; home: string; project: string; scratch: string;
  credentials: string; observation: string; identity: { dev: bigint; ino: bigint } };
export function createOwnedCell(input?: { parent?: string }): { status: 'created'; cell: OwnedCell } | { status: 'unavailable'; reason: 'sandbox-root-unavailable' };
export function stageCellFiles(cell: OwnedCell, files: { root: 'home' | 'project'; path: string; bytes: Uint8Array }[]):
  { status: 'staged' } | { status: 'unavailable'; reason: 'material-path-unsafe' | 'staging-unavailable' };
export function observeCellConfiguration(cell: OwnedCell, expectation: { outputPaths: { root: string; path: string }[];
  guardrailPaths: { root: string; path: string }[]; outputTreeSha256: string; guardrailsSha256: string }):
  { status: 'unchanged' | 'changed'; stagedConfigurationDigest: string; observedConfigurationDigest: string | null; unexpectedLoadingFiles: number };
export function removeOwnedCell(cell: OwnedCell, state: { processesConfirmed: boolean }):
  { files: 'removed'; reason: null; retainedCell: null } | { files: 'retained'; reason: 'termination-unresolved' | 'cleanup-unresolved'; retainedCell: string };

export type CapturedIdentity = { status: 'captured'; manifestId: string; credential: Buffer; recheck(): Promise<boolean> };
export function captureTestIdentity(input: { provisionedRoot: string; manifestSha256: string; expected: { accountUuid: string; organizationId: string } }):
  Promise<CapturedIdentity | { status: 'unavailable'; reason: 'authentication-unavailable' | 'identity-binding-invalid' }>;
export function stageCredential(cell: OwnedCell, definition: NativeVerificationDefinition, captured: CapturedIdentity):
  { status: 'staged' } | { status: 'unavailable'; reason: 'authentication-channel-unsupported' | 'staging-unavailable' };
export function validateClaudeOAuthFile(bytes: Uint8Array): { valid: boolean };

export type PinnedExecutable = { status: 'pinned'; path: string; sha256: string; byteLength: number };
export function pinExecutable(input: { names: string[]; pathEnv: string; platform: string }): Promise<PinnedExecutable | { status: 'unavailable'; reason: 'client-absent' }>;
export function revalidateExecutable(pin: PinnedExecutable): Promise<{ ok: true } | { ok: false; reason: 'executable-changed' }>;
export function lifecycleAvailability(lifecycleId: string, os: string): { status: 'available' } | { status: 'unavailable'; reason: 'platform-unsupported'; missing?: string };
export type LifecycleHandle = { pid: number; birth: string | null; stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream;
  exited: Promise<{ code: number | null; signal: string | null }>; track(): Promise<void>;
  terminate(options?: { graceMs?: number; deadlineMs?: number }): Promise<{ processes: 'confirmed' | 'unresolved';
    survivors: { pid: number; role: 'client' | 'server' | 'recorder' | 'helper' }[]; elapsedMs: number }> };
export function startLifecycle(input: { lifecycleId: string; os: string; file: string; argv: string[]; cwd: string; env: Record<string, string> }):
  Promise<{ status: 'started'; handle: LifecycleHandle } | { status: 'unavailable'; reason: 'platform-unsupported' | 'session-launch-failed' }>;

export type EvidenceChannel = { endpoint: string; token: string; challenge: string; close(): Promise<{ frames: unknown[]; bytes: number;
  connections: number; rejectedFrames: number; peer: 'none' | 'authenticated' | 'unavailable' | 'rejected'; violation: null | 'limit-exceeded' | 'frame-invalid' }>;
  snapshot(): Awaited<ReturnType<EvidenceChannel['close']>> };
export function startEvidenceChannel(input: { directory: string; isOwnedServer: (identity: { pid: number; birth: string }) => boolean; plan?: RecorderPlan | null }): Promise<EvidenceChannel>;

export type RecorderPlan = { attestTool: string | null; markers: string[]; queryTool: string; queryArguments: Record<string, unknown>; challengeField: string | null; toolNames: string[] };
export type RecorderMaterial = { root: 'project'; path: string; memberPath: string; bytes: Buffer; sha256: string; byteLength: number };
export const recorderId: 'aihq.stdio-recorder.v1';
export function recorderMaterial(): RecorderMaterial;
export function recorderPlan(input: { server: NativeBundledFixture['server']; instructions: NativeBundledFixture['instructions'] }): RecorderPlan | null;
export function recorderCommand(input: { command: string; args: string[] }): { command: 'node'; args: string[] };
export type ServerEvidenceSpec = { attestTool: string; queryTool: string; toolNames: string[]; markerSha256: string | null; expectedResultSha256: string };
export type ServerEvaluation = { initialize: boolean; discovery: 'complete' | 'missing'; attestation: 'not-required' | 'attested' | 'missing' | 'mismatch';
  ambiguousBeforeAttestation: boolean; query: 'answered' | 'result-mismatch' | 'challenge-mismatch' | 'refused' | 'missing';
  queryResultSha256: string | null; unrequestedCalls: number; rejectedCalls: number; rejectedQueryCalls: number };
export function evaluateServerEvidence(frames: unknown[], spec: ServerEvidenceSpec): ServerEvaluation;
export function serverEvidenceSpec(resolved: ResolvedFixture): ServerEvidenceSpec;

export type ClaudeStreamOptions = { serverName: string; attestTool: string; queryTool: string; expectedAnswer: string; markerSha256: string;
  challenge: string; maxBytes?: number; maxRecordBytes?: number };
export type ClaudeStreamObservation = { status: 'ok' | 'limit-exceeded' | 'malformed'; bytes: number; records: number; sessionId: string | null;
  sessionIdConsistent: boolean; serverStatus: string | null; visibleSelectedTools: string[]; toolsListed: boolean; builtinTools: string[];
  permissionMode: string | null; attestationReturned: boolean; answerReturned: boolean; resultSubtype: string | null; resultIsError: boolean | null;
  unselectedTools: number; unselectedToolUses: { name: string; permitted: boolean; beforeAttestation: boolean }[] };
export function createClaudeStreamParser(options: ClaudeStreamOptions): { push(chunk: Uint8Array | string): void; snapshot(): ClaudeStreamObservation; finish(): ClaudeStreamObservation };
export function claudeStreamOptions(resolved: ResolvedFixture, challenge: string): ClaudeStreamOptions;
export function claudePrompt(challenge: string): string;
export function claudeSessionsAreFresh(first: string | null, second: string | null): boolean;
export function buildClaudeEnvironment(input: { platform: string; hostEnv: Record<string, string | undefined>; homeDir: string; scratchDir: string;
  runtimeDirs: string[]; telemetry: { endpoint: string; token: string }; evidence: { endpoint: string; token: string } }): Record<string, string>;
export function observeClaudeManagedSettings(options?: { platform?: string; directory?: string }):
  { outcome: 'restricted' | 'file-sources-clear' | 'unreadable'; limitations: string[] };
export const claudeDeniedBuiltins: readonly string[];
export const fixtureServerName: string;

export type TelemetryOutcome = { outcome: 'passed' | 'unavailable'; reason: string;
  counts: { requests: number; events: number; matched: number; wrongSession: number; duplicates: number; ignored: number }; bytes: number };
export function createClaudeCollector(input: { sessionId?: string | null; expected: { accountUuid: string; organizationId: string }; bodyTimeoutMs?: number }): {
  token: string; endpoint: string; start(): Promise<{ endpoint: string; token: string }>; bindSession(id: string | null): void; cancel(): Promise<void>;
  snapshot(input: { launchedAtMs: number; closedAtMs: number }): TelemetryOutcome;
  drain(input: { launchedAtMs: number; closedAtMs: number; timeoutMs?: number }): Promise<TelemetryOutcome> };

export function evaluateClaudeSession(input: { sessionIndex: 1 | 2; previousSessionId: string | null; stream: ClaudeStreamObservation;
  managed: { outcome: string }; telemetry: TelemetryOutcome | null;
  server: { channel: { peer: string; violation: string | null } | null; evaluation: ServerEvaluation };
  toolNames: string[]; deniedBuiltins: readonly string[] }): { rows: NativeSessionRow[]; proceed: boolean; notes: string[] };
