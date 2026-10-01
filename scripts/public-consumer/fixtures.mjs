// Copied into the isolated consumer; all product imports resolve installed exports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScan, prepareArtifact } from '@aihq/scan/host';
import { readArtifact, readReport } from '@aihq/scan/read';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// These fixtures contain only JSON-safe integers and ASCII keys. The producer
// and reader independently validate their canonical identities and all fields.
const canonical = value => JSON.stringify(sorted(value));
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}

export async function createDisplayFixtures(directory) {
  const source = join(directory, 'scan-source');
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), '# Display fixture\nSynthetic material for consumer acceptance.\n');
  writeFileSync(join(source, 'excluded.txt'), 'Explicitly excluded fixture\n');
  const result = await runScan({
    schema: 'urn:aihq:scan:request:1.0.0', source: { kind: 'local', path: source },
    selection: { paths: 'all', excludedPaths: [] },
    detectors: [{ detectorId: 'detector.aih-native', configuration: {} }],
  });
  assert.equal(result.status, 'assessment', JSON.stringify(result));
  const report = structuredClone(result.report);
  const native = report.results.find(entry => entry.detectorId === 'detector.aih-native');
  assert.equal(native.outcome, 'succeeded', JSON.stringify(native));
  const observation = native.observations[0];
  // The native whole-source producer intentionally refuses exclusions. This
  // synthetic presentation fixture models a supported detector that accepts them.
  report.selection.excludedPaths = ['excluded.txt'];
  native.coverage.excludedPaths = ['excluded.txt'];
  native.coverage.coveredPaths = ['SKILL.md'];
  observation.body.coverage.coveredPaths = ['SKILL.md'];
  observation.body.input.targetPaths = ['SKILL.md'];
  const location = observation.body.input.entries.find(entry => entry.path === 'SKILL.md');
  const unavailable = { state: 'unavailable', reason: 'not-provided', detail: 'Synthetic detector did not supply this field.' };
  observation.body.findings = [{
    rawOccurrenceFingerprint: `raw-occurrence-v1:${hash('synthetic-display-finding')}`, multiplicity: 2,
    rule: { state: 'present', value: { nativeRuleId: 'demo.display', name: 'Synthetic display finding' } },
    severity: unavailable,
    message: { state: 'present', value: '<img src=x onerror="globalThis.injected=true"> & synthetic finding' },
    location: { state: 'present', value: { path: location.path, fileSha256: location.sha256, startLine: 1 } },
    supportingEvidence: observation.body.annexIds.length
      ? { state: 'present', value: { annexId: observation.body.annexIds[0], ordinal: 0 } } : unavailable,
  }];
  observation.body.gaps.push({ reason: 'synthetic-display-gap', detail: 'Fixture deliberately represents incomplete evidence.' });
  observation.observationId = `observation:sha256:${hash(Buffer.concat([
    Buffer.from('aih.scan.observation.v1\0'), Buffer.from(canonical(observation.body)),
  ]))}`;
  for (const outcome of ['failed', 'refused', 'cancelled']) {
    const detectorId = `detector.demo-${outcome}`;
    report.requestedDetectors.push({ detectorId, profileId: 'demo.v1', configuration: {}, configurationSha256: hash('{}') });
    report.results.push({ detectorId, outcome, observations: [], coverage: {
      coveredPaths: [], excludedPaths: [...report.selection.excludedPaths],
      uncoveredPaths: report.selection.paths.filter(path => !report.selection.excludedPaths.includes(path)), complete: false,
    }, diagnostics: [{ code: `demo-${outcome}`, detail: `Synthetic ${outcome} outcome <script>unsafe()</script>`, detectorId }] });
  }
  report.requestedDetectors.sort((a, b) => a.detectorId.localeCompare(b.detectorId));
  report.results.sort((a, b) => a.detectorId.localeCompare(b.detectorId));
  report.completion = 'partial';
  report.diagnostics.push({ code: 'synthetic-display-only', detail: 'Unsigned synthetic UI fixture; no security assessment or authenticity claim.' });
  const annexes = result.annexes.map(annex => ({ id: annex.id, bytes: Buffer.from(annex.bytesBase64, 'base64') }));
  const reportRead = await readReport(Buffer.from(canonical(report)));
  assert.equal(reportRead.status, 'read', JSON.stringify(reportRead));
  const first = await prepareArtifact({ report, annexes });
  writeFileSync(join(directory, 'display.scan.json'), first.bytes);
  const tampered = structuredClone(first.artifact);
  tampered.report.sha256 = '0'.repeat(64);
  writeFileSync(join(directory, 'tampered.scan.json'), canonical(tampered));
  assert.equal((await readArtifact(readFileSync(join(directory, 'tampered.scan.json')))).status, 'invalid');
  const next = structuredClone(report);
  next.createdAt = new Date(Date.parse(report.createdAt) + 1000).toISOString();
  const reused = next.results.find(entry => entry.detectorId === native.detectorId).observations[0];
  reused.origin = 'reused';
  reused.fromScanId = first.scanId;
  const second = await prepareArtifact({ report: next, annexes });
  assert.notEqual(first.scanId, second.scanId);
  writeFileSync(join(directory, 'updated.scan.json'), second.bytes);
  writeFileSync(join(directory, 'unsupported.report.json'), canonical({ schema: 'urn:aihq:scan:report:99.0.0' }));
  writeFileSync(join(directory, 'malformed.report.json'), '{');
  for (const file of ['display.scan.json', 'updated.scan.json'])
    assert.equal((await readArtifact(readFileSync(join(directory, file)))).status, 'read');
  assert.equal((await readReport(readFileSync(join(directory, 'unsupported.report.json')))).status, 'unsupported-report');
  return { firstScanId: first.scanId, updatedScanId: second.scanId, unsignedSynthetic: true };
}
