export interface AnnexDescriptor { id: string; mediaType: string; sha256: string; byteLength: number; }
export interface ArtifactAnnex extends AnnexDescriptor {
  bytesBase64: string;
}
export interface Artifact {
  schema: "urn:aihq:scan:artifact:1.0.0";
  scanId: string;
  report: {
    schema: string;
    mediaType: "application/json";
    sha256: string;
    byteLength: number;
    bytesBase64: string;
  };
  annexes: ArtifactAnnex[];
  attestation?: SigstoreBundle;
}
export interface ArtifactStatement {
  _type: "https://in-toto.io/Statement/v1";
  subject: [{ name: "scan-report"; digest: { sha256: string } }];
  predicateType: "urn:aihq:scan:artifact-attestation:1.0.0";
  predicate: {
    scanId: string;
    reportSchema: string;
    reportByteLength: number;
    annexManifestSha256: string;
  };
}
// Wire protocol members are validated against the upstream bundle field definitions
// before conversion. The nested witness records remain upstream JSON data.
export interface SigstoreBundle {
  mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json";
  verificationMaterial: {
    certificate?: { rawBytes: string };
    publicKey?: { hint: string };
    tlogEntries?: Record<string, unknown>[];
    timestampVerificationData?: { rfc3161Timestamps?: { signedTimestamp: string }[] };
  };
  dsseEnvelope: {
    payloadType: string;
    payload: string;
    signatures: { keyid?: string; sig: string }[];
  };
}
export interface VerificationKey {
  readonly identity: string;
  readonly keyId: string;
  readonly publicKeySpkiBase64: string;
}
export interface VerificationPublisher {
  readonly profile: "sigstore-public";
  readonly identity: string;
  readonly purposes: readonly ["scan-report"];
  readonly trustedRoot: Readonly<Record<string, unknown>>;
  readonly policy: {
    readonly issuer: string;
    readonly subjectAlternativeName: string;
    readonly requiredCertificateExtensions: readonly { readonly oid: readonly number[]; readonly valueDerBase64: string }[];
  };
}
export interface AuthenticationTrust {
  readonly keys: readonly VerificationKey[];
  readonly publishers: readonly VerificationPublisher[];
}
export type AssociationReason =
  | "not-supplied"
  | "not-requested"
  | "unavailable"
  | "unsupported-artifact"
  | "malformed"
  | "id-mismatch"
  | "byte-mismatch"
  | "unsigned"
  | "unknown-producer"
  | "untrusted-key"
  | "invalid-signature"
  | "resource-limit";
export interface AssociationResult {
  scanId?: string;
  status: "skipped" | "authenticated" | "unverifiable";
  reason?: AssociationReason;
  producerIdentity?: string;
  keyId?: string;
  reportRead?: "supported" | "unsupported" | "not-requested";
}
export interface ValidatedArtifact {
  artifact: Artifact;
  reportBytes: Uint8Array;
  annexManifestSha256: string;
}
export interface EvidenceAssociation {
  schema: 'urn:aihq:scan:evidence-association:1.0.0';
  scanId: string;
  location: { kind: 'file'; path: string } | { kind: 'https'; url: string };
}
export interface AssociateEvidenceInput {
  association?: EvidenceAssociation;
  acquire?: boolean;
  trust?: AuthenticationTrust;
}
export interface AssociateEvidenceControls {
  signal?: AbortSignal;
  authentication?: { kind: 'none' } | { kind: 'bearer'; token: string };
}
