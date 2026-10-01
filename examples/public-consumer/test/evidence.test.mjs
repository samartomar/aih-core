import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVerificationKeys, selectVerificationPublishers } from '@aihq/core/harness';
import { disposableHome, disposableProject, inlinePolicyText } from './helpers.mjs';
import { createHost } from '../src/host.js';

const FIXTURE = process.env.SCAN_ARTIFACT_FIXTURE;
const SCAN_ID = 'scan:sha256:fd5e886dc290901110d82ec45e2f444b8fa1b2c05f1bbe7028cbbb4e880bc4dd';

disposableHome();

async function harnessTrust() {
  const keys = await selectVerificationKeys('scan-report');
  const publishers = selectVerificationPublishers('scan-report');
  assert.equal(keys.status, 'selected', JSON.stringify(keys));
  assert.equal(publishers.status, 'selected', JSON.stringify(publishers));
  return { trust: { keys: keys.keys, publishers: publishers.publishers }, publishers: publishers.publishers };
}

function policyWithEvidence(scanId) {
  const policy = JSON.parse(inlinePolicyText());
  policy.evidence = [{
    schema: 'urn:aihq:scan:evidence-association:1.0.0',
    scanId,
    location: { kind: 'file', path: FIXTURE }
  }];
  return JSON.stringify(policy);
}

test('Core authenticates the retained production report through Harness-selected trust', async t => {
  if (!FIXTURE) return t.skip('SCAN_ARTIFACT_FIXTURE not supplied');
  const { trust, publishers } = await harnessTrust();
  const host = createHost({ projectRoot: disposableProject() });
  const prepared = await host.prepareSession({
    policyText: policyWithEvidence(SCAN_ID),
    controls: { evidence: { acquire: true, trust } }
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const [association] = prepared.review.evidence;
  assert.equal(association.status, 'authenticated');
  assert.equal(association.scanId, SCAN_ID);
  assert.equal(association.reportRead, 'not-requested');
  assert.equal(association.producerIdentity, publishers[0].identity);
});

test('unverifiable evidence is reported honestly and does not gate preparation', async t => {
  if (!FIXTURE) return t.skip('SCAN_ARTIFACT_FIXTURE not supplied');
  const { trust } = await harnessTrust();
  const host = createHost({ projectRoot: disposableProject() });
  const prepared = await host.prepareSession({
    policyText: policyWithEvidence(`scan:sha256:${'0'.repeat(64)}`),
    controls: { evidence: { acquire: true, trust } }
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const [association] = prepared.review.evidence;
  assert.equal(association.status, 'unverifiable');
  assert.equal(association.reason, 'id-mismatch');
});

test('evidence acquisition defaults off and stays skipped, never a setup gate', async t => {
  if (!FIXTURE) return t.skip('SCAN_ARTIFACT_FIXTURE not supplied');
  const host = createHost({ projectRoot: disposableProject() });
  const prepared = await host.prepareSession({ policyText: policyWithEvidence(SCAN_ID) });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const [association] = prepared.review.evidence;
  assert.equal(association.status, 'skipped');
  assert.equal(association.reason, 'not-requested');
});
