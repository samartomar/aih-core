export interface TargetDefinition {
  id: string; label: string; binaries: readonly string[]; configDirs: readonly string[]; origins: readonly string[];
}
export interface SupportedContract {
  readonly id: string; readonly role: 'accepts' | 'produces' | 'both'; readonly schemaExport: string;
}
export type PublicEntry = { readonly export: string; readonly runtime: 'portable' } |
  { readonly export: string; readonly runtime: 'node'; readonly nodeRange: string };
export declare const contractSupport: {
  readonly schema: 'urn:aihq:package-support:1.0.0'; readonly package: { readonly name: string; readonly version: string };
  readonly contracts: readonly SupportedContract[]; readonly entries: readonly PublicEntry[];
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
export interface RepairDefinition11Variant {
  os: 'win32' | 'darwin' | 'linux'; architectures: readonly ('x64' | 'arm64')[]; targets: readonly string[];
  network: 'declared' | 'off'; recipeRef: string; transformId: string; route: 'native' | 'file' | 'export';
  adapterId: string; inputIds: readonly string[]; capabilityIds: readonly string[];
  configFiles?: readonly { operationId: string; target: { root: 'userHome'; segments: readonly { literal: string }[] }; maxBytes: number }[];
  executableBindings?: readonly { name: string; pathInput: string; kind?: 'launcher' }[];
  requiredAbsences?: readonly { target: { root: 'userHome'; segments: readonly { literal: string }[] };
    reason: string; purpose: string }[];
}
export interface RepairDefinition11 {
  id: 'node-npm-ca' | 'user-tools-ca' | 'jvm-ca' | 'certificate-export'; description: string;
  schema: 'urn:aihq:harness:repair:1.1.0'; scope: 'user'; managementId: string | null; materialName: string | null;
  targets: readonly string[];
  inputs: Readonly<Record<string, { type: 'file' | 'string' | 'boolean' | 'number'; required: boolean; description: string; maxLength?: number }>>;
  limits: { sourceBytes: number; certificateBlocks: number; blockBytes: number };
  trustLimits: TrustLimits;
  offlineVerification: readonly { target: string; operationId: string; checkId: string }[];
  variants: readonly RepairDefinition11Variant[];
}
export interface TrustLimits {
  readonly candidateIncidences: 4096; readonly combinedIncidences: 4096; readonly derBytes: 8388608;
  readonly certificateBytes: 65536; readonly suppliedSources: 32; readonly outputBytes: 12582912; readonly custodyBytes: 1048576;
}
export interface TrustCapabilityCell {
  id: string; definitionId: 'node-npm-ca' | 'user-tools-ca' | 'jvm-ca' | 'certificate-export';
  route: 'native' | 'file' | 'export'; target: string | null;
  platform: { os: 'win32' | 'darwin' | 'linux'; release: string; architecture: 'x64' | 'arm64' };
  network: 'declared' | 'off';
  projection: 'windows-effective-server-auth-v1' | 'macos-effective-server-auth-v1' | 'ubuntu-24.04-system-openssl-v1';
  client: { version: string; build: string; backend: string; backendVersion: string; applicationId: string | null } | null;
  configurationProfile: string; probeProfile: string;
  launchContext: 'fresh-cli-user-home' | 'named-application' | 'no-client';
  evidence: { reference: string; sha256: string; subjectSha256: string };
}
export interface TrustCapabilities {
  schema: 'urn:aihq:harness:trust-capabilities:1.0.0'; package: { name: '@aihq/core'; version: string };
  cells: readonly TrustCapabilityCell[];
}
export interface TrustDefinitionDiagnostic { code: 'INPUT_INVALID'; reason: string; message: string; path: string }
export declare const trustRepairIndex: readonly RepairDefinition11[];
export declare const trustLimits: TrustLimits;
export declare const trustAdapters: readonly { id: string; modules: readonly string[] }[];
export declare const trustPlatformMatrix: readonly { os: 'win32' | 'darwin' | 'linux'; release: string; architecture: 'x64' | 'arm64'; projection: string }[];
export declare const consumerProfiles: { readonly pem: 'pem-server-ca-v1'; readonly 'pkcs7-der': 'pkcs7-certificate-import-v1' };
export declare const trustCapabilities: TrustCapabilities;
export declare function selectRepairDefinition(query: { requestSchema?: string; repairId: string; definitionSchema: string }):
  RepairDefinition11 | (typeof repairIndex)[number] | undefined;
export declare function validateRepairDefinition11(value: unknown, options?: {
  adapters?: readonly { id: string }[]; capabilities?: TrustCapabilities; resolveRecipeRef?: (ref: string) => boolean }):
  { valid: boolean; diagnostics: TrustDefinitionDiagnostic[] };
export declare function validateTrustCapabilities(value: unknown, options?: {
  definitions?: readonly RepairDefinition11[]; package?: { name: string; version: string } }):
  { valid: boolean; diagnostics: TrustDefinitionDiagnostic[] };
export declare function selectTrustCell(query: { definitionId: string; route: 'native' | 'file' | 'export'; target?: string | null;
  platform: { os: string; release: string; architecture: string }; network: 'declared' | 'off'; format?: 'pem' | 'pkcs7-der' },
  capabilities: TrustCapabilities | undefined): { status: 'admitted'; cell: TrustCapabilityCell } |
  { status: 'unavailable'; code: 'PREREQUISITE_UNAVAILABLE'; reason: string };
export interface TrustProfile {
  readonly kind: 'configuration' | 'probe'; readonly definitionId: string; readonly route: string; readonly format?: 'pem' | 'pkcs7-der';
  readonly configuration?: string; readonly files: readonly string[]; readonly libraries: boolean;
  readonly requiredCases?: readonly { id: string; kind: 'positive' | 'negative' | 'persistence'; os?: string }[];
  readonly requiredLimitations?: readonly string[];
}
export declare const trustProfiles: Readonly<Record<string, TrustProfile>>;
export declare const trustTransformIds: readonly string[];
export declare function resolveTrustRecipeRef(recipeRef: string):
  { kind: 'shipped' | 'native-unavailable' | 'export-generator'; definitionId: string; route: 'file' | 'native' | 'export' } | undefined;
export declare function exportAdmissionTemplate(format: 'pem' | 'pkcs7-der', platform?: { os: string; release: string; architecture: string; projection: string }):
  { cell: Omit<TrustCapabilityCell, 'evidence'>; requiredCases: { id: string; kind: string; os?: string }[]; requiredLimitations: string[] } | undefined;
export declare function buildCertificateExportRecipe(request: { materialId: string; materialPath: string;
  outputSegments: readonly string[]; sha256: string; byteLength: number }): Record<string, unknown>;
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
export interface VerificationPublisherRecord {
  readonly profile: 'sigstore-public'; readonly identity: string; readonly purposes: readonly ['scan-report'];
  readonly trustedRoot: Readonly<Record<string, unknown>>;
  readonly policy: {
    readonly issuer: string; readonly subjectAlternativeName: string;
    readonly requiredCertificateExtensions: readonly { readonly oid: readonly number[]; readonly valueDerBase64: string }[];
  };
}
export declare const verificationPublishers: readonly VerificationPublisherRecord[];
export declare function validateVerificationPublisherRecords(records: unknown):
  { valid: boolean; diagnostics: VerificationKeyDiagnostic[] };
export declare function selectVerificationPublishers(purpose: string, records?: readonly unknown[]):
  { status: 'selected'; publishers: readonly VerificationPublisherRecord[] } |
  { status: 'invalid'; diagnostics: VerificationKeyDiagnostic[] };
export declare const helperMetadata: {
  readonly repairs: readonly { id: string; helper: string; targets: readonly string[] }[];
  readonly diagnostics: readonly { id: string; kind: string; purpose: string; targets: readonly string[];
    profile: { phaseMs: number; maxActiveProbes: number; localProcessMs: number; networkProcessMs: number;
      networkSocketMs: number; outputBytes: number; checkDetailBytes: number; phaseDetailBytes: number;
      configuredMcpOrigins: number; configuredMcpMs: number } }[];
};
export declare const targets: readonly TargetDefinition[];
