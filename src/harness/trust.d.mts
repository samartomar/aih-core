export type TrustSourceKind = 'os' | 'supplied' | 'node-bundled' | 'jvm-baseline';
export interface TrustAdapterIdentity { id: string; version: string; sha256: string }
export interface TrustSourceReview {
  id: string; kind: TrustSourceKind; adapter: TrustAdapterIdentity | null;
  scope: 'effective-current-user' | 'explicit-source' | 'runtime-bundled' | 'selected-jvm-baseline';
  completeness: 'complete' | 'incomplete' | 'unavailable';
  policySha256: string | null; sourceSha256: string | null; runtimeVersion: string | null; reason: string | null;
  fingerprints: string[];
}
export interface TrustDiscoveryDiagnostic {
  code: 'INPUT_INVALID' | 'PREREQUISITE_UNAVAILABLE' | 'SOURCE_LIMIT'; reason: string; message: string; sourceId?: string;
}
export interface TrustCertificateFact {
  fingerprint: string; subject: string; issuer: string; notBefore: string; notAfter: string;
  sources: string[]; excludedFrom: string[]; reasons: string[];
}
export interface TrustDiscovery {
  status: 'ready' | 'blocked' | 'invalid' | 'cancelled';
  diagnostics: TrustDiscoveryDiagnostic[];
  sources: TrustSourceReview[];
  certificates: TrustCertificateFact[];
  suitableFingerprints: string[];
  sourceSetSha256: string | null;
  /** Private DER bytes keyed by fingerprint; present only when ready. Never place in public output. */
  der: ReadonlyMap<string, Uint8Array>;
  binding: { adapter: TrustAdapterIdentity | null; policySha256: string | null; osObservationSha256: string | null };
}
export interface SuppliedSnapshot {
  id: string; bytes: Uint8Array; origin: 'explicit' | 'retained'; admittedSha256?: string;
}
export declare function discoverTrustSources(request: {
  sources: { os: boolean; supplied: readonly SuppliedSnapshot[]; baseline?: { bytes: Uint8Array } };
  network: 'declared' | 'off'; includeNodeBundled?: boolean; now?: number; signal?: AbortSignal;
}, controls?: { signal?: AbortSignal }): Promise<TrustDiscovery>;
export interface ParsedCertificate {
  fingerprint: string; der: Uint8Array; subject: string; issuer: string; notBefore: string; notAfter: string; ca: boolean;
  extendedKeyUsage: string[] | null;
}
export declare function parseTrustOutput(bytes: Uint8Array, format: 'pem' | 'pkcs7-der', options?: { maxBytes?: number }):
  { status: 'parsed'; certificates: ParsedCertificate[] } | { status: 'invalid'; reason: string };
export declare function serializeTrustSet(request: { format: 'pem' | 'pkcs7-der'; certificates: readonly { der: Uint8Array }[] }):
  Promise<{ status: 'serialized'; bytes: Uint8Array; sha256: string; fingerprints: string[]; certificateCount: number;
    consumerProfile: 'pem-server-ca-v1' | 'pkcs7-certificate-import-v1' } |
  { status: 'unavailable'; code: 'PREREQUISITE_UNAVAILABLE' | 'SOURCE_LIMIT';
    reason: 'trust-format-unavailable' | 'trust-output-empty' | 'source-limit' }>;
export interface CertificateReview {
  fingerprint: string; subject: string; issuer: string; notBefore: string; notAfter: string;
  beforeSources: string[]; afterSources: string[];
  disposition: 'added' | 'removed' | 'retained' | 'provenance-changed' | 'excluded'; reasons: string[];
}
export declare function reviewTrustDelta(request: { discovery: TrustDiscovery;
  prior?: { sources?: readonly { id: string; fingerprints: readonly string[] }[]; output?: { certificates: readonly ParsedCertificate[] } } }):
  CertificateReview[];
export declare function hashTrustSourceSet(rows: readonly TrustSourceReview[]): string;
export declare function canonicalTrustJson(value: unknown): string;
export declare function detectTrustPlatform(): { os: string; architecture: string; release: string | null; projection: string | null };
export declare function verifyTrustAdmissionEvidence(request: { packageRoot: string; capabilities: unknown; definitions?: readonly unknown[] }):
  { valid: boolean; diagnostics: { code: string; reason: string; message: string; path?: string }[] };
export declare function buildCertificateExportRecipe(request: { materialId: string; materialPath: string;
  outputSegments: readonly string[]; sha256: string; byteLength: number }): Record<string, unknown>;
export declare function trustCellSubjectSha256(cell: Record<string, unknown>, packageRoot: string): string | null;
export declare const trustLibraryPackages: readonly string[];
export declare function hashTrustLibraries(request: { packageRoot: string }):
  { status: 'hashed'; packages: { name: string; version: string | null; sha256: string }[]; sha256: string } |
  { status: 'unavailable'; reason: 'trust-library-unavailable' | 'trust-library-unbounded'; name: string };
export declare function getTrustFileIntegration(definitionId: string, targets: readonly string[]):
  { status: 'supported'; format: 'pem'; includeNodeBundled: boolean; baseline?: 'jks';
    outputs?: readonly { operationId: string; name: string; format: 'jks' }[] } |
  { status: 'unavailable'; code: 'PREREQUISITE_UNAVAILABLE'; reason: 'file-route-unsupported' };
export declare const acceptanceRecordSchema: 'aih.trust.acceptance.v1';
export declare const trustHelperFiles: readonly string[];
