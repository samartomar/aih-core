import type { TrustCapabilityCell } from './contracts.mjs';
export declare const REPAIR_FORMAT: 'urn:aihq:core:repair:0.1.0';
export declare const TRUST_CAPABILITIES_FORMAT: 'urn:aihq:core:trust-capabilities:0.1.0';
export declare const MACOS_SESSION_PROFILES_FORMAT: 'urn:aihq:core:macos-session-profiles:0.1.0';
export declare function publicManagementId(id: string): string;
export declare function internalManagementId(id: string): string;
/** One repair definition (`urn:aihq:core:repair:0.1.0`); `managementId` is the repair id. */
export interface RepairDefinition {
  readonly id: string; readonly description: string; readonly schema: 'urn:aihq:core:repair:0.1.0'; readonly scope: 'user';
  readonly managementId: string; readonly materialName: string; readonly candidateDiagnostic?: string;
  readonly variants: readonly { readonly os: string; readonly architectures: readonly string[]; readonly targets: readonly string[];
    readonly network: 'declared' | 'off'; readonly candidate?: 'system-ca' | 'extra-ca'; readonly recipeRef: string; readonly transformId: string }[];
  readonly targets: readonly string[];
  readonly inputs: Readonly<Record<string, { readonly type: 'file' | 'string' | 'boolean' | 'number'; readonly required: boolean;
    readonly description: string; readonly maxLength?: number }>>;
  readonly limits: { readonly sourceBytes: number; readonly certificateBlocks: number; readonly blockBytes: number };
  readonly offlineVerification: readonly { readonly target: string; readonly operationId: string; readonly checkId: string }[];
}
export declare const repairIndex: readonly RepairDefinition[];
export interface TrustCapabilities {
  readonly schema: 'urn:aihq:core:trust-capabilities:0.1.0'; readonly package: { readonly name: '@aihq/core'; readonly version: string };
  readonly cells: readonly TrustCapabilityCell[];
}
export declare const trustCapabilities: TrustCapabilities;
export declare const macosSessionProfiles: Readonly<{ schema: 'urn:aihq:core:macos-session-profiles:0.1.0'; [key: string]: unknown }>;
