import { X509Certificate } from 'node:crypto';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { PolicyError, toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import { validateBundle } from './bundle.js';
import { validateArtifact } from './artifact.js';
import { selectTrust } from './trust.js';
import type { AssociationReason, AssociationResult, AuthenticationTrust } from './types.js';
import { ArtifactError, artifactLimits, decoded, invalid, object, validScanId } from './validation.js';
export async function authenticateEvidence(input: {
  bytes: Uint8Array;
  expectedScanId: string;
  trust: AuthenticationTrust;
}): Promise<AssociationResult> {
  let scanId: string | undefined;
  const refuse = (reason: AssociationReason): AssociationResult => ({
    ...(scanId ? { scanId } : {}),
    status: "unverifiable",
    reason,
  });
  try {
    const supplied = object(input, ["bytes", "expectedScanId", "trust"]);
    const expectedScanId = validScanId(supplied.expectedScanId);
    // Bound and validate selected trust before touching certificates in a bundle.
    const selected = selectTrust(supplied.trust);
    const validated = await validateArtifact(supplied.bytes as Uint8Array);
    scanId = validated.artifact.scanId;
    if (scanId !== expectedScanId) return refuse("id-mismatch");
    const bundle = validated.artifact.attestation;
    if (!bundle) return refuse("unsigned");
    const { bundle: boundedBundle } = validateBundle(bundle);
    const entity = toSignedEntity(bundleFromJSON(boundedBundle));
    if (boundedBundle.verificationMaterial.publicKey) {
      const hint = boundedBundle.verificationMaterial.publicKey.hint;
      const key = selected.keys.get(hint);
      const record = selected.trust.keys.find((value) => value.keyId === hint);
      if (!key || !record) return refuse("untrusted-key");
      try {
        const trust = toTrustMaterial(TrustedRoot.fromJSON({}), (selectedHint) => {
          if (selectedHint !== hint) invalid();
          return { publicKey: key, validFor: () => true };
        });
        new Verifier(trust, { tlogThreshold: 0, ctlogThreshold: 0, timestampThreshold: 0 }).verify(
          entity,
        );
      } catch {
        return refuse("invalid-signature");
      }
      return {
        scanId,
        status: "authenticated",
        producerIdentity: record.identity,
        keyId: hint,
        reportRead: "not-requested",
      };
    }
    const certBytes = decoded(
      boundedBundle.verificationMaterial.certificate?.rawBytes,
      artifactLimits.certificate,
    );
    const certificate = new X509Certificate(certBytes);
    if (
      certificate.publicKey.asymmetricKeyType !== "ec" ||
      certificate.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      return refuse("invalid-signature");
    if (selected.trust.publishers.length === 0) return refuse("unknown-producer");
    const matches = new Set<string>();
    let failure: AssociationReason = "unknown-producer";
    let policyMismatch = false;
    for (const publisher of selected.trust.publishers) {
      try {
        const verifier = new Verifier(
          toTrustMaterial(TrustedRoot.fromJSON(publisher.trustedRoot)),
          { tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 },
        );
        // Upstream treats even strings as patterns. Escape our validated literal
        // policy internally, then also compare the verified identity literally.
        const exactSan = new RegExp(
          `^${publisher.policy.subjectAlternativeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        );
        const signer = verifier.verify(entity, {
          subjectAlternativeName: exactSan,
          extensions: { issuer: publisher.policy.issuer },
          oids: publisher.policy.requiredCertificateExtensions.map((extension) => ({
            oid: { id: [...extension.oid] },
            value: Buffer.from(decoded(extension.valueDerBase64, 4096)),
          })),
        });
        if (
          signer.identity?.subjectAlternativeName !== publisher.policy.subjectAlternativeName ||
          signer.identity?.extensions?.issuer !== publisher.policy.issuer
        ) {
          policyMismatch = true;
          continue;
        }
        matches.add(publisher.identity);
      } catch (error) {
        if (error instanceof PolicyError) policyMismatch = true;
        else failure = "invalid-signature";
      }
    }
    if (matches.size === 1)
      return {
        scanId,
        status: "authenticated",
        producerIdentity: [...matches][0],
        reportRead: "not-requested",
      };
    // A cryptographically verified identity-policy refusal must not be hidden
    // by an unrelated historical root that cannot verify this certificate.
    return refuse(matches.size > 1 || policyMismatch ? "unknown-producer" : failure);
  } catch (error) {
    if (error instanceof ArtifactError) return refuse(error.reason);
    if (error instanceof Error && "code" in error && error.code === "resource-limit")
      return refuse("resource-limit");
    return refuse("malformed");
  }
}
