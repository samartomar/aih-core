import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificationPublishers, selectVerificationPublishers } from '../../dist/harness/contracts.mjs';

test('maintained production publishers select as independent frozen trust without host effects', () => {
  const selected = selectVerificationPublishers('scan-report');
  assert.equal(selected.status, 'selected', JSON.stringify(selected));
  assert.equal(selected.publishers.length, 1);
  const publisher = selected.publishers[0];
  assert.equal(publisher.identity, 'aihq-scan-production-candidate');
  assert.equal(publisher.policy.subjectAlternativeName,
    'https://github.com/samartomar/aih-scan/.github/workflows/scan-report-publisher.yml@refs/heads/main');
  assert.equal(publisher.policy.requiredCertificateExtensions.length, 10);
  assert.ok(Object.isFrozen(verificationPublishers));
  assert.ok(Object.isFrozen(publisher.trustedRoot.certificateAuthorities[0].certChain.certificates));
  assert.deepEqual(selectVerificationPublishers('scan-report', []), { status: 'selected', publishers: [] });
});

test('publisher selection refuses ambiguous or oversized trust and never evaluates accessors', () => {
  const record = () => structuredClone(verificationPublishers[0]);
  const badOid = record(); badOid.policy.requiredCertificateExtensions.push(badOid.policy.requiredCertificateExtensions[0]);
  const badArc = record(); badArc.policy.requiredCertificateExtensions[0].oid = [1, 50];
  const hugeDer = record(); hugeDer.policy.requiredCertificateExtensions[0].valueDerBase64 = 'A'.repeat(6000);
  const hugeRoots = record(); hugeRoots.trustedRoot.tlogs = Array(65).fill(hugeRoots.trustedRoot.tlogs[0]);
  const hugeCertificate = record(); hugeCertificate.trustedRoot.certificateAuthorities[0].certChain.certificates[0].rawBytes = 'A'.repeat(44000);
  let getterCalls = 0;
  const accessor = record(); Object.defineProperty(accessor, 'identity', { enumerable: true, get() { getterCalls++; return 'accessor'; } });
  const extra = record(); extra.policy.glob = '*';
  const unicodeLabel = record(); unicodeLabel.identity = '界'.repeat(86);
  const cycle = record(); cycle.trustedRoot.circular = cycle;
  for (const records of [[badOid], [badArc], [hugeDer], [hugeRoots], [hugeCertificate], [accessor], [extra], [unicodeLabel], [cycle], Array(33).fill(record())])
    assert.equal(selectVerificationPublishers('scan-report', records).status, 'invalid');
  assert.equal(getterCalls, 0);
  const historical = record(); historical.policy.subjectAlternativeName += '-historical';
  const selected = selectVerificationPublishers('scan-report', [record(), historical]);
  assert.equal(selected.status, 'selected');
  historical.policy.issuer = 'changed after selection';
  assert.equal(selected.publishers[1].policy.issuer, 'https://token.actions.githubusercontent.com');
});
