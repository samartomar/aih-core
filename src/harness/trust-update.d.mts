import type { VerificationKeyRecord, VerificationPublisherRecord } from './contracts.mjs';
export interface TrustSnapshot {
  readonly catalogTufRootBase64?: string;
  readonly verificationKeys: readonly VerificationKeyRecord[];
  readonly verificationPublishers: readonly VerificationPublisherRecord[];
  readonly scanEvidencePolicies: readonly Readonly<Record<string, unknown>>[];
  readonly revocations: readonly { readonly kind: 'key' | 'publisher'; readonly id: string }[];
}
export declare function getTrustSnapshot(): TrustSnapshot;
export declare function getVerificationTrust(snapshot?: TrustSnapshot): Promise<{
  readonly keys: readonly { identity: string; keyId: string; publicKeySpkiBase64: string }[];
  readonly publishers: readonly VerificationPublisherRecord[];
}>;

export interface TufTrustClientOptions {
  readonly root: Uint8Array;
  readonly metadataBaseUrl: string;
  readonly targetBaseUrl: string;
  readonly targetPath: string;
  readonly cacheDir: string;
}
export declare function createTufTrustClient(options: TufTrustClientOptions): {
  update(): Promise<TrustSnapshot>;
};
export declare function getCurrentTrustStatus(snapshot?: TrustSnapshot,
  identity?: { keyId?: string; publisherIdentity?: string }): 'current' | 'revoked' | 'unknown';
export declare function getCatalogIndexTrust(snapshot?: TrustSnapshot): 'none' | { readonly tufRoot: Uint8Array };
