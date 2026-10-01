import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { presentReport, readScanArtifact, readScanReport, readScanBytes } from '../src/report-view.js';

const FIXTURE = process.env.SCAN_ARTIFACT_FIXTURE;

function rows(node, path = []) {
  const here = [...path, node.label];
  if (node.children) return node.children.flatMap(child => rows(child, here));
  return [`${here.join(' › ')}: ${node.value}`];
}
function flatRows(presentation) {
  return presentation.report ? rows(presentation.report) : [];
}
function primitives(value, into = []) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) into.push(String(value));
  else if (Array.isArray(value)) value.forEach(entry => primitives(entry, into));
  else if (typeof value === 'object') Object.entries(value).forEach(([key, entry]) => {
    if (key !== 'state') primitives(entry, into);
  });
  return into;
}

test('a real supported artifact presents complete report details, escaped as plain text rows', async t => {
  if (!FIXTURE) return t.skip('SCAN_ARTIFACT_FIXTURE not supplied');
  const result = await readScanArtifact(new Uint8Array(readFileSync(FIXTURE)));
  assert.equal(result.status, 'read', JSON.stringify(result.diagnostics));
  const presentation = presentReport(result);
  assert.equal(presentation.kind, 'supported');
  assert.equal(presentation.scanId, 'scan:sha256:fd5e886dc290901110d82ec45e2f444b8fa1b2c05f1bbe7028cbbb4e880bc4dd');
  assert.equal(presentation.authenticity, 'unchecked');
  const text = flatRows(presentation).join('\n');
  for (const expected of [
    'detector.aih-native', 'succeeded', 'fresh', 'sarif-not-interpreted', 'SKILL.md',
    'aih-source-capture-1', 'annex.549d59b3d5f5a1d7ec7b2f23c3d9b9b57c27da72358ed94c7a57ad0bf342a6bb',
    'in-process-native-v1', 'no-effect-or-qualification-authority'
  ]) assert.ok(text.includes(expected), `missing ${expected}`);
});

test('every primitive value of a rich report survives presentation, including unavailable fields and reused origins', () => {
  const report = {
    schema: 'urn:aihq:scan:report:1.0.0',
    producer: { name: '@aihq/scan', version: '0.5.0' },
    createdAt: '2026-10-01T00:00:00.000Z',
    source: { kind: 'git', repository: 'https://example.invalid/repo.git', commit: 'abc123',
      capture: { profile: 'aih-source-capture-1', captureSha256: 'f'.repeat(64), entries: [
        { kind: 'directory', path: 'src' },
        { kind: 'file', path: 'src/a.js', sha256: 'a'.repeat(64), byteLength: 12 }
      ] } },
    selection: { paths: ['src/a.js'], excludedPaths: [] },
    requestedDetectors: [
      { detectorId: 'detector.failed', profileId: 'p1', configuration: { deep: true }, configurationSha256: 'b'.repeat(64) },
      { detectorId: 'detector.rich', profileId: 'p2', configuration: {}, configurationSha256: 'c'.repeat(64) }
    ],
    results: [
      { detectorId: 'detector.failed', outcome: 'failed', observations: [],
        coverage: { coveredPaths: [], excludedPaths: [], uncoveredPaths: ['src/a.js'], complete: false },
        diagnostics: [{ code: 'DETECTOR_FAILED', detail: 'adapter crashed', detectorId: 'detector.failed' }] },
      { detectorId: 'detector.rich', outcome: 'succeeded',
        observations: [{
          observationId: 'observation:sha256:dddd', origin: 'reused', fromScanId: 'scan:sha256:prior',
          body: {
            format: 'aih-observation-v1',
            input: { detectorId: 'detector.rich', detectorVersion: 'v1', adapterSha256: '1'.repeat(64),
              rulesSha256: '2'.repeat(64), configurationSha256: 'c'.repeat(64), profileId: 'p2',
              profileSha256: '3'.repeat(64),
              platform: { os: 'win32', architecture: 'x64', relevantFactsSha256: '4'.repeat(64) },
              scopeKind: 'selected-closure', targetPaths: ['src/a.js'],
              entries: [{ kind: 'file', path: 'src/a.js', sha256: 'a'.repeat(64), byteLength: 12 }] },
            startedAt: '2026-09-30T23:59:00.000Z', completedAt: '2026-09-30T23:59:30.000Z',
            producer: { name: '@aihq/scan', version: '0.5.0' },
            coverage: { coveredPaths: ['src/a.js'] },
            findings: [{
              rawOccurrenceFingerprint: 'fp-1', multiplicity: 2,
              rule: { state: 'unavailable', reason: 'rule-not-declared', detail: 'the adapter declared no rule' },
              severity: { state: 'present', value: { level: 'warning', vendorSeverity: 'MEDIUM' } },
              message: { state: 'present', value: 'Use <b>caution</b> & "quotes" here' },
              location: { state: 'present', value: { path: 'src/a.js', fileSha256: 'a'.repeat(64), startLine: 3 } },
              supportingEvidence: { state: 'present', value: { annexId: 'annex.rich', ordinal: 0 } }
            }],
            gaps: [{ reason: 'partial-coverage', detail: 'one file skipped' }],
            annexIds: ['annex.rich']
          }
        }],
        coverage: { coveredPaths: ['src/a.js'], excludedPaths: [], uncoveredPaths: [], complete: true },
        diagnostics: [] }
    ],
    completion: 'partial',
    annexes: [{ id: 'annex.rich', mediaType: 'application/vnd.sarif+json', sha256: '5'.repeat(64), byteLength: 99 }],
    effectiveLimits: { maxSourceEntries: 1, maxSourceBytes: 2, maxRequestBytes: 3, maxReportBytes: 4,
      maxAnnexBytes: 5, maxDecodedArtifactBytes: 6, maxArtifactBytes: 7, maxStatementBytes: 8,
      detectorTimeoutMs: 9 },
    diagnostics: [{ code: 'ASSESSMENT_PARTIAL', detail: 'one detector failed' }]
  };
  const presentation = presentReport({ status: 'read', scanId: 'scan:sha256:rich', report,
    authenticity: 'unchecked', annexBytes: 'checked' });
  assert.equal(presentation.kind, 'supported');
  const text = flatRows(presentation).join('\n');
  for (const primitive of primitives(report)) {
    assert.ok(text.includes(primitive), `dropped report value: ${primitive}`);
  }
  assert.ok(text.includes('reused') && text.includes('scan:sha256:prior'));
});

test('an unsupported report generation reports encountered and supported contract ids', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ schema: 'urn:aihq:scan:report:2.0.0' }));
  const result = await readScanReport(bytes);
  assert.equal(result.status, 'unsupported-report');
  const presentation = presentReport(result);
  assert.equal(presentation.kind, 'unsupported');
  assert.equal(presentation.encountered, 'urn:aihq:scan:report:2.0.0');
  assert.deepEqual(presentation.supported, ['urn:aihq:scan:report:1.0.0']);
});

test('malformed report bytes present invalid diagnostics, not a crash', async () => {
  const result = await readScanReport(new TextEncoder().encode('{not json'));
  assert.equal(result.status, 'invalid');
  const presentation = presentReport(result);
  assert.equal(presentation.kind, 'invalid');
  assert.ok(presentation.diagnostics.length > 0);
});

test('a tampered artifact stays invalid instead of being reinterpreted as an unsupported report', async t => {
  if (!FIXTURE) return t.skip('SCAN_ARTIFACT_FIXTURE not supplied');
  const artifact = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  artifact.report.sha256 = '0'.repeat(64);
  const result = await readScanBytes(new TextEncoder().encode(JSON.stringify(artifact)));
  assert.equal(result.status, 'invalid');
  assert.equal(presentReport(result).kind, 'invalid');
  const future = await readScanBytes(new TextEncoder().encode(JSON.stringify({ schema: 'urn:aihq:scan:report:99.0.0' })));
  assert.equal(future.status, 'unsupported-report');
  assert.equal(future.reportSchema, 'urn:aihq:scan:report:99.0.0');
});
