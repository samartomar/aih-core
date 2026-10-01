export interface TargetDefinition {
  id: string; label: string; binaries: readonly string[]; configDirs: readonly string[]; origins: readonly string[];
}
export declare const contractSupport: {
  readonly schema: string; readonly package: { readonly name: string; readonly version: string };
  readonly contracts: readonly string[]; readonly entries: readonly { export: string; runtime: string; nodeRange?: string }[];
};
export declare const repairIndex: readonly { id: string; description: string;
  schema: 'urn:aihq:harness:repair:1.0.0'; scope: 'user'; managementId: string; materialName: string;
  candidateDiagnostic?: string;
  variants: readonly { os: string; architectures: readonly string[]; targets: readonly string[];
    network: 'declared' | 'off'; candidate?: 'system-ca' | 'extra-ca'; recipeRef: string; transformId: string;
    configFiles?: readonly { operationId: string; target: { root: 'userHome'; segments: readonly { literal: string }[] }; maxBytes: number }[];
    executableBindings?: readonly { name: string; pathInput: string; kind?: 'launcher' }[];
    requiredAbsences?: readonly { target: { root: 'userHome'; segments: readonly { literal: string }[] };
      reason: string; purpose: string }[] }[];
  targets: readonly string[]; inputs: Readonly<Record<string, { type: 'file' | 'string' | 'boolean' | 'number';
    required: boolean; description: string; maxLength?: number }>>;
  limits: { sourceBytes: number; certificateBlocks: number; blockBytes: number };
  offlineVerification: readonly { target: string; operationId: string; checkId: string }[] }[];
export interface VerificationKeyRecord {
  keyId: string; algorithm: 'Ed25519'; publicKeySpkiBase64: string; identity: string; purposes: readonly string[];
}
export interface VerificationKeyDiagnostic { code: 'INPUT_INVALID'; reason: string; message: string; path: string }
export declare const verificationKeys: readonly VerificationKeyRecord[];
export declare const verificationKeyPurposes: readonly ['scan-report'];
export declare function validateVerificationKeyRecords(records: unknown):
  Promise<{ valid: boolean; diagnostics: VerificationKeyDiagnostic[] }>;
export declare function selectVerificationKeys(purpose: string, records?: readonly unknown[]):
  Promise<{ status: 'selected'; keys: readonly { identity: string; keyId: string; publicKeySpkiBase64: string }[] } |
    { status: 'invalid'; diagnostics: VerificationKeyDiagnostic[] }>;
export declare const helperMetadata: {
  readonly repairs: readonly { id: string; helper: string; targets: readonly string[] }[];
  readonly diagnostics: readonly { id: string; kind: string; purpose: string; targets: readonly string[];
    profile: { phaseMs: number; maxActiveProbes: number; localProcessMs: number; networkProcessMs: number;
      networkSocketMs: number; outputBytes: number; checkDetailBytes: number; phaseDetailBytes: number;
      configuredMcpOrigins: number; configuredMcpMs: number } }[];
};
export declare const targets: readonly TargetDefinition[];
