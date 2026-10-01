// Portable Scan report reading and complete presentation modeling.
// No Node built-ins: safe for the browser bundle. All output is plain data;
// renderers must insert values with DOM textContent (never innerHTML).
import { readArtifact, readReport } from '@aihq/scan/read';
import { schemas, limitCeilings } from '@aihq/scan/contracts';

export const readScanReport = bytes => readReport(bytes);
export const readScanArtifact = bytes => readArtifact(bytes);

export function readScanBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) return readReport(bytes);
  if (bytes.byteLength > limitCeilings.maxArtifactBytes) return readArtifact(bytes);
  // This peek chooses a reader only. The public reader still validates the
  // original bytes, including strict JSON, identities, limits and integrity.
  let schema;
  try { schema = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.schema; }
  catch { return readReport(bytes); }
  return typeof schema === 'string' && schema.startsWith('urn:aihq:scan:artifact:')
    ? readArtifact(bytes) : readReport(bytes);
}

const leaf = (label, value) => ({ label, value: String(value) });
const group = (label, children) => ({ label, children });
const record = (label, value) =>
  group(label, Object.entries(value).map(([key, entry]) => leaf(key, entry)));
const textList = (label, values) =>
  values.length ? group(label, values.map((value, index) => leaf(`#${index + 1}`, value))) : leaf(label, '(none)');
const json = value => JSON.stringify(value);

const field = (label, value) => value.state === 'present'
  ? leaf(label, typeof value.value === 'object' ? json(value.value) : value.value)
  : leaf(label, `unavailable (${value.reason}): ${value.detail}`);

const diagnostic = (entry, index) => group(`diagnostic #${index + 1}`, [
  leaf('code', entry.code),
  leaf('detail', entry.detail),
  ...(entry.detectorId !== undefined ? [leaf('detectorId', entry.detectorId)] : []),
  ...(entry.path !== undefined ? [leaf('path', entry.path)] : [])
]);
const diagnostics = entries =>
  entries.length ? group('diagnostics', entries.map(diagnostic)) : leaf('diagnostics', '(none)');

const capture = value => group('capture', [
  leaf('profile', value.profile),
  leaf('captureSha256', value.captureSha256),
  group('entries', value.entries.map((entry, index) => record(`entry #${index + 1}`, entry)))
]);

const source = value => group('source', [
  leaf('kind', value.kind),
  ...(value.kind === 'git' ? [leaf('repository', value.repository), leaf('commit', value.commit)] : []),
  capture(value.capture)
]);

const requestedDetector = (value, index) => group(`requested detector #${index + 1}`, [
  leaf('detectorId', value.detectorId),
  leaf('profileId', value.profileId === null ? '(unresolved)' : value.profileId),
  leaf('configuration', json(value.configuration)),
  leaf('configurationSha256', value.configurationSha256)
]);

const finding = (value, index) => group(`finding #${index + 1}`, [
  leaf('rawOccurrenceFingerprint', value.rawOccurrenceFingerprint),
  leaf('multiplicity', value.multiplicity),
  field('rule', value.rule),
  field('severity', value.severity),
  field('message', value.message),
  field('location', value.location),
  field('supportingEvidence', value.supportingEvidence)
]);

const observation = (value, index) => group(`observation #${index + 1}`, [
  leaf('observationId', value.observationId),
  leaf('origin', value.origin),
  ...(value.fromScanId !== undefined ? [leaf('fromScanId', value.fromScanId)] : []),
  group('body', [
    leaf('format', value.body.format),
    leaf('startedAt', value.body.startedAt),
    leaf('completedAt', value.body.completedAt),
    record('producer', value.body.producer),
    group('input', [
      leaf('detectorId', value.body.input.detectorId),
      leaf('detectorVersion', value.body.input.detectorVersion),
      leaf('adapterSha256', value.body.input.adapterSha256),
      leaf('rulesSha256', value.body.input.rulesSha256),
      leaf('configurationSha256', value.body.input.configurationSha256),
      leaf('profileId', value.body.input.profileId),
      leaf('profileSha256', value.body.input.profileSha256),
      record('platform', value.body.input.platform),
      leaf('scopeKind', value.body.input.scopeKind),
      textList('targetPaths', value.body.input.targetPaths),
      group('entries', value.body.input.entries.map((entry, entryIndex) =>
        record(`entry #${entryIndex + 1}`, entry)))
    ]),
    textList('coveredPaths', value.body.coverage.coveredPaths),
    group('findings', value.body.findings.map(finding)),
    value.body.gaps.length
      ? group('gaps', value.body.gaps.map((gap, gapIndex) => group(`gap #${gapIndex + 1}`, [
        leaf('reason', gap.reason), leaf('detail', gap.detail)])))
      : leaf('gaps', '(none)'),
    textList('annexIds', value.body.annexIds)
  ])
]);

const detectorResult = (value, index) => group(`detector result #${index + 1}`, [
  leaf('detectorId', value.detectorId),
  leaf('outcome', value.outcome),
  group('coverage', [
    textList('coveredPaths', value.coverage.coveredPaths),
    textList('excludedPaths', value.coverage.excludedPaths),
    textList('uncoveredPaths', value.coverage.uncoveredPaths),
    leaf('complete', value.coverage.complete)
  ]),
  group('observations', value.observations.map(observation)),
  diagnostics(value.diagnostics)
]);

const reportNode = report => group('report', [
  leaf('schema', report.schema),
  record('producer', report.producer),
  leaf('createdAt', report.createdAt),
  leaf('completion', report.completion),
  source(report.source),
  group('selection', [
    textList('paths', report.selection.paths),
    textList('excludedPaths', report.selection.excludedPaths)
  ]),
  group('requestedDetectors', report.requestedDetectors.map(requestedDetector)),
  group('results', report.results.map(detectorResult)),
  group('annexes', report.annexes.map((annex, index) => record(`annex #${index + 1}`, annex))),
  record('effectiveLimits', report.effectiveLimits),
  diagnostics(report.diagnostics)
]);

// Turns a ReadReportResult/ReadArtifactResult into a complete plain-data
// presentation: every supported field preserved, and unsupported or malformed
// input made explicit with encountered/supported contract ids and diagnostics.
// Authenticity here is Scan's reading status only; Core authentication is a
// separate host concern and is never implied by a supported reading.
export function presentReport(result) {
  if (result.status === 'unsupported-report') {
    return {
      kind: 'unsupported',
      scanId: result.scanId,
      encountered: result.reportSchema,
      supported: [schemas.report]
    };
  }
  if (result.status === 'invalid') {
    return { kind: 'invalid', diagnostics: result.diagnostics.map(entry => ({ ...entry })) };
  }
  return {
    kind: 'supported',
    scanId: result.scanId,
    authenticity: result.authenticity,
    annexBytes: result.annexBytes,
    report: reportNode(result.report)
  };
}
