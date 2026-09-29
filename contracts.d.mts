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
    network: 'declared' | 'off'; candidate?: 'system-ca' | 'extra-ca'; recipeRef: string; transformId: string }[];
  targets: readonly string[]; inputs: Readonly<Record<string, { type: 'file' | 'string' | 'boolean' | 'number';
    required: boolean; description: string; maxLength?: number }>>;
  limits: { sourceBytes: number; certificateBlocks: number; blockBytes: number };
  offlineVerification: readonly { target: string; operationId: string; checkId: string }[] }[];
export declare const verificationKeys: readonly never[];
export declare const helperMetadata: {
  readonly repairs: readonly { id: string; helper: string; targets: readonly string[] }[];
  readonly diagnostics: readonly { id: string; kind: string; purpose: string; targets: readonly string[];
    profile: { phaseMs: number; maxActiveProbes: number; localProcessMs: number; networkProcessMs: number;
      networkSocketMs: number; outputBytes: number; checkDetailBytes: number; phaseDetailBytes: number;
      configuredMcpOrigins: number; configuredMcpMs: number } }[];
};
export declare const targets: readonly TargetDefinition[];
