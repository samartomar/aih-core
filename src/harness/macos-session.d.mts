// Public contract for the bounded macOS session Harness helpers.
// Node-only: these helpers observe the host or run fixed literal /bin/launchctl argv.
// Every helper separates 'passed' from 'unavailable'/'skipped'; missing native
// provenance is unavailable, never a UID/PID guess or a claimed success.

export type MacosSessionCode =
  | 'INPUT_INVALID' | 'PREREQUISITE_UNAVAILABLE' | 'STATE_CONFLICT' | 'REVIEW_STALE';

export interface MacosSessionBudgets {
  readonly commandMs: 10000;
  readonly commandBytes: 65536;
  readonly phaseMs: 60000;
  readonly cleanupMs: 15000;
}

export declare const macosSessionBudgets: MacosSessionBudgets;

/** Finite selected trust family keys that may be managed in the GUI domain. */
export declare const macosSessionTrustKeys: readonly string[];

/* ------------------------------------------------------------------ launch agent */

export interface MacosSessionLaunchAgentIntent {
  key: string;
  helperPath: string;
  runtimePath: string;
  recordPath: string;
  helperSha256: string;
  runtimeSha256: string;
  bindingSha256: string;
  sessionIdentitySha256: string;
  desired: { present: boolean; value: string | null };
}

export interface MacosSessionLaunchAgent {
  status: 'rendered';
  key: string; label: string; plistFileName: string;
  argv: readonly string[];
  plist: string; plistSha256: string;
}

export declare function renderMacosSessionLaunchAgent(intent: unknown): MacosSessionLaunchAgent |
  { status: 'invalid'; code: 'INPUT_INVALID'; reason: string };

/* ------------------------------------------------------------------- OS boundary */

export interface MacosSessionRunResult {
  status: 'ok' | 'error' | 'timeout' | 'output-limit' | 'unavailable';
  code?: number | null;
  stdout?: string;
  stderr?: string;
  reason?: string;
}

export interface MacosSessionControls { signal?: AbortSignal }

/* ------------------------------------------------------------- GUI session identity */

export type MacosGuiSessionObservation =
  | { status: 'observed'; uid: number; domain: string; consoleUid: number;
      managerName: 'Aqua'; bootSessionUuid: string; identitySha256: string;
      loginSessionDistinguished: false }
  | { status: 'unavailable'; code: 'PREREQUISITE_UNAVAILABLE'; reason: string };

export declare function observeMacosGuiSession(controls?: MacosSessionControls,
  environment?: unknown): Promise<MacosGuiSessionObservation>;

/* -------------------------------------------------------------- application identity */

export interface MacosApplicationRequest {
  clientId: string; appPath: string; targets: readonly string[]; launch: 'finder' | 'dock';
}

export type MacosApplicationObservation =
  | { status: 'observed'; clientId: string; appPath: string; appPathKey: string;
      bundleId: string | null; version: string | null; build: string | null;
      teamId: string | null; cdHash: string | null; signatureVerified: boolean;
      executableSha256: string | null; infoPlistSha256: string;
      applicationIdentitySha256: string; device: number; inode: number }
  | { status: 'unavailable'; code: 'PREREQUISITE_UNAVAILABLE'; reason: string };

export declare function observeMacosApplication(request: MacosApplicationRequest,
  controls?: MacosSessionControls, environment?: unknown): Promise<MacosApplicationObservation>;

/* --------------------------------------------------------------- GUI domain key I/O */

export interface MacosGuiKeyRequest { key: string; uid: number }

export type MacosGuiKeyRead =
  | { status: 'present'; key: string; value: string }
  | { status: 'unavailable'; code: 'PREREQUISITE_UNAVAILABLE';
      reason: string };

export declare function readMacosGuiDomainKey(request: MacosGuiKeyRequest,
  controls?: MacosSessionControls, environment?: unknown): Promise<MacosGuiKeyRead>;

export interface MacosGuiKeyIntent {
  key: string; label: string;
  desired: { present: boolean; value: string | null };
  owned: { have: boolean; present: boolean; value: string | null };
  bindingSha256: string; sessionIdentitySha256: string;
}

export interface MacosGuiKeyMutation {
  status: 'applied' | 'unchanged' | 'conflict' | 'unavailable';
  key: string; label: string;
  before: { present: boolean; value: string | null } | null;
  after: { present: boolean; value: string | null } | null;
  verified: boolean; readback: 'match' | 'mismatch' | 'ambiguous' | 'not-run';
  reason: string;
}

export declare function applyMacosGuiDomainKey(intent: MacosGuiKeyIntent,
  controls?: MacosSessionControls, environment?: unknown): Promise<MacosGuiKeyMutation>;

/* --------------------------------------------------------- bootstrap / bootout / replay */

export interface MacosSessionBootstrapRequest {
  key: string; label: string; plistPath: string; uid: number;
}

export type MacosSessionRegistration =
  | { status: 'registered'; label: string; domain: string }
  | { status: 'removed'; label: string; domain: string }
  | { status: 'disabled'; code: 'PREREQUISITE_UNAVAILABLE'; reason: 'session-persistence-disabled' }
  | { status: 'conflict'; code: 'STATE_CONFLICT'; reason: 'session-ownership-conflict' }
  | { status: 'unavailable'; code: 'PREREQUISITE_UNAVAILABLE'; reason: string };

export declare function macosSessionBootstrap(request: MacosSessionBootstrapRequest,
  controls?: MacosSessionControls, environment?: unknown): Promise<MacosSessionRegistration>;

export declare function macosSessionBootout(request: Pick<MacosSessionBootstrapRequest, 'key' | 'label' | 'uid'>,
  controls?: MacosSessionControls, environment?: unknown): Promise<MacosSessionRegistration>;

export interface MacosSessionReplayIntent extends MacosGuiKeyIntent {
  uid: number; recordPath: string; helperSha256: string; phaseStartedAtMs: number;
}

export interface MacosSessionReplayResult {
  status: 'applied' | 'unchanged' | 'conflict' | 'unavailable';
  key: string; label: string; reason: string;
  before: { present: boolean; value: string | null } | null;
  after: { present: boolean; value: string | null } | null;
  verified: boolean;
  recovery: { key: string; label: string; bindingSha256: string;
    sessionIdentitySha256: string; desired: MacosGuiKeyIntent['desired'];
    owned: MacosGuiKeyIntent['owned']; phaseMs: 60000; commandMs: 10000;
    commandBytes: 65536; cleanupMs: 15000; operations: readonly string[] };
}

export declare function runMacosSessionLoginReplay(intent: MacosSessionReplayIntent,
  controls?: MacosSessionControls, environment?: unknown): Promise<MacosSessionReplayResult>;

export declare function createMacosSessionRecoveryContext(intent: MacosSessionReplayIntent): MacosSessionReplayResult['recovery'];

/* ------------------------------------------------------------------- verification */

export interface MacosSessionVerificationIntent {
  profiles: readonly { id: string; clientId: string; bundleId: string; launch: 'finder' | 'dock' }[];
  clientId: string; appPath: string; profileId: string; launch: 'finder' | 'dock';
  network: 'declared' | 'off';
  /** Host-computed binding over package/profile/helper/app/backend/OS/probe/session/process-birth. */
  bindingSha256: string;
  launchObservation: { available: boolean; context: 'finder' | 'dock' | null } | null;
  trustProbe: { available: boolean; outcome: 'passed' | 'failed' | null } | null;
}

export interface MacosSessionVerificationDecision {
  status: 'passed' | 'failed' | 'unavailable' | 'incomplete';
  reason: string;
  launchContext: 'observed' | 'launch-context-unobservable';
  appTrust: 'passed' | 'failed' | 'app-trust-unobservable' | 'skipped';
  profileId: string | null;
  bindingSha256: string | null;
}

export declare function evaluateMacosSessionVerification(intent: MacosSessionVerificationIntent): MacosSessionVerificationDecision;
