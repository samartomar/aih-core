import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authenticateEvidence } from '@aihq/core';
import { selectVerificationKeys, selectVerificationPublishers } from '@aihq/core/harness';
import { presentReport, readScanArtifact, readScanReport, readScanBytes } from '../src/report-view.js';

function rows(node, parents = []) {
  const path = [...parents, node.label];
  return node.children ? node.children.flatMap(child => rows(child, path)) : [`${path.join(' > ')}: ${node.value}`];
}

export async function verifyReports() {
  const displayed = [];
  for (const file of ['display.scan.json', 'updated.scan.json']) {
    const read = await readScanArtifact(readFileSync(file));
    assert.equal(read.status, 'read', JSON.stringify(read));
    const view = presentReport(read);
    assert.equal(view.kind, 'supported');
    assert.equal(view.authenticity, 'unchecked');
    assert.equal(view.annexBytes, 'checked');
    const text = rows(view.report).join('\n');
    for (const required of ['partial', 'succeeded', 'failed', 'refused', 'cancelled',
      'unavailable', 'not-provided', 'Synthetic detector did not supply this field.',
      'excluded.txt', 'SKILL.md', 'synthetic-display-gap', 'annexIds',
      '<img src=x onerror="globalThis.injected=true">', 'synthetic-display-only']) {
      assert.ok(text.includes(required), `Dropped display detail: ${required}`);
    }
    assert.match(text, file === 'display.scan.json' ? /origin: fresh/ : /origin: reused/);
    const findings = read.report.results.flatMap(result => result.observations).flatMap(observation => observation.body.findings);
    assert.equal(findings.length, 1);
    displayed.push({ scanId: read.scanId, completion: read.report.completion, findings: findings.length,
      outcomes: read.report.results.map(result => result.outcome), authenticity: view.authenticity });
  }
  assert.notEqual(displayed[0].scanId, displayed[1].scanId);
  const unsupported = presentReport(await readScanReport(readFileSync('unsupported.report.json')));
  assert.equal(unsupported.kind, 'unsupported');
  assert.equal(unsupported.encountered, 'urn:aihq:scan:report:99.0.0');
  assert.deepEqual(unsupported.supported, ['urn:aihq:scan:report:1.0.0']);
  const malformed = presentReport(await readScanReport(readFileSync('malformed.report.json')));
  assert.equal(malformed.kind, 'invalid');
  assert.ok(malformed.diagnostics.length);
  assert.equal(presentReport(await readScanBytes(readFileSync('tampered.scan.json'))).kind, 'invalid');

  const bytes = readFileSync('production.scan.json');
  const read = await readScanArtifact(bytes);
  assert.equal(read.status, 'read');
  const keys = await selectVerificationKeys('scan-report');
  const publishers = selectVerificationPublishers('scan-report');
  assert.equal(keys.status, 'selected');
  assert.equal(publishers.status, 'selected');
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  try {
    globalThis.fetch = async () => { networkCalls++; throw new Error('Authentication must remain offline'); };
    const result = await authenticateEvidence({ bytes, expectedScanId: read.scanId,
      trust: { keys: keys.keys, publishers: publishers.publishers } });
    assert.equal(result.status, 'authenticated', JSON.stringify(result));
    assert.equal(result.reportRead, 'not-requested');
    assert.equal(networkCalls, 0);
    return { displayed, unsupported, malformed: malformed.kind,
      production: { scanId: read.scanId, status: result.status, reportRead: result.reportRead, networkCalls } };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
