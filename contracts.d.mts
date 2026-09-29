export interface TargetDefinition {
  id: string; label: string; binaries: readonly string[]; configDirs: readonly string[]; origins: readonly string[];
}
export declare const contractSupport: {
  readonly schema: string; readonly package: { readonly name: string; readonly version: string };
  readonly contracts: readonly string[]; readonly entries: readonly { export: string; runtime: string; nodeRange?: string }[];
};
export declare const repairIndex: readonly never[];
export declare const verificationKeys: readonly never[];
export declare const helperMetadata: {
  readonly diagnostics: readonly { id: string; kind: string; purpose: string; targets: readonly string[];
    profile: { phaseMs: number; maxActiveProbes: number; localProcessMs: number; networkProcessMs: number;
      networkSocketMs: number; outputBytes: number; checkDetailBytes: number; phaseDetailBytes: number;
      configuredMcpOrigins: number; configuredMcpMs: number } }[];
};
export declare const targets: readonly TargetDefinition[];
