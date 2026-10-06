// Public contract for the bundled macOS session admission profiles.
// Data only: importing performs no host observation. An empty profiles list is
// honest absence of admission until native evidence satisfies the admission contract.

export interface MacosSessionProfileEvidence {
  reference: string;
  sha256: string;
  subjectSha256: string;
}

export interface MacosSessionProfile {
  id: string;
  clientId: 'claude' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'windsurf'
    | 'opencode' | 'kimi' | 'kiro' | 'antigravity' | 'zed';
  trustCellId: string;
  launch: 'finder' | 'dock';
  mechanism: 'app-config' | 'gui-environment';
  bundleId: string;
  teamId: string | null;
  cdHash: string | null;
  appVersion: string;
  appBuild: string;
  runtimeSha256: string;
  configurationProfile: string;
  helperSha256: string;
  environmentKeys: readonly string[];
  relaunch: 'quit-app' | 'logout-login';
  evidence: MacosSessionProfileEvidence;
}

export declare const macosSessionProfilesSchema: 'urn:aihq:harness:macos-session-profiles:1.0.0';

export declare const macosSessionProfiles: Readonly<{
  schema: typeof macosSessionProfilesSchema;
  package: Readonly<{ name: string; version: string }>;
  profiles: readonly MacosSessionProfile[];
}>;
