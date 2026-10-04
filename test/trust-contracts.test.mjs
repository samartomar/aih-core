import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateTrustRepairRequest,
  validateTrustRepairInputs,
  validateCertificateExportRequest,
  validateCertificateExportInputs,
  validatePreparedWork12,
  validateRunResult12,
  validateTrustCustody,
  contractSupport
} from '../dist/core/contracts.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/trust-contracts/${name}`, import.meta.url), 'utf8'));
const sha = character => character.repeat(64);

test('the published trust/export fixtures satisfy their strict schemas', () => {
  const cases = [
    ['repair-request-native.json', validateTrustRepairRequest],
    ['repair-request-file.json', validateTrustRepairRequest],
    ['repair-request-jvm-file.json', validateTrustRepairRequest],
    ['certificate-export-request.json', validateCertificateExportRequest],
    ['certificate-export-request-p7b.json', validateCertificateExportRequest],
    ['repair-inputs-native.json', validateTrustRepairInputs],
    ['repair-inputs-file.json', validateTrustRepairInputs],
    ['certificate-export-inputs.json', validateCertificateExportInputs],
    ['prepared-work-1.2-ready.json', validatePreparedWork12],
    ['prepared-work-1.2-blocked.json', validatePreparedWork12],
    ['prepared-work-1.2-partial.json', validatePreparedWork12],
    ['run-result-1.2-complete.json', validateRunResult12],
    ['run-result-1.2-partial.json', validateRunResult12],
    ['run-result-1.2-stale.json', validateRunResult12],
    ['run-result-1.2-blocked.json', validateRunResult12],
    ['trust-custody-1.0.0.json', validateTrustCustody]
  ];
  for (const [name, validate] of cases) {
    const result = validate(fixture(name));
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(typeof result.schema, 'string');
    assert.deepEqual(result.diagnostics, []);
  }
});

test('contractSupport publishes all seven pinned trust schemas and their roles', () => {
  const expected = {
    'urn:aihq:core:repair-request:1.0.0': 'accepts',
    'urn:aihq:core:repair-inputs:1.0.0': 'accepts',
    'urn:aihq:core:certificate-export-request:1.0.0': 'accepts',
    'urn:aihq:core:certificate-export-inputs:1.0.0': 'accepts',
    'urn:aihq:core:prepared-work:1.2.0': 'produces',
    'urn:aihq:core:run-result:1.2.0': 'produces',
    'urn:aihq:core:trust-custody:1.0.0': 'both'
  };
  for (const [id, role] of Object.entries(expected)) {
    const entry = contractSupport.contracts.find(candidate => candidate.id === id);
    assert.ok(entry, `missing contractSupport entry for ${id}`);
    assert.equal(entry.role, role, id);
    assert.match(entry.schemaExport, /^@aihq\/core\/schemas\/[a-z-]+\/\d+\.\d+\.\d+\.json$/);
  }
  // Immutable legacy schemas stay published unchanged.
  assert.ok(contractSupport.contracts.some(candidate => candidate.id === 'urn:aihq:core:prepared-work:1.1.0'));
  assert.ok(contractSupport.contracts.some(candidate => candidate.id === 'urn:aihq:core:run-result:1.1.0'));
  for (const [id, schemaExport] of [
    ['urn:aihq:harness:repair:1.1.0', '@aihq/core/harness/schemas/repair/1.1.0.json'],
    ['urn:aihq:harness:trust-capabilities:1.0.0', '@aihq/core/harness/schemas/trust-capabilities/1.0.0.json']
  ]) assert.deepEqual(contractSupport.contracts.find(entry => entry.id === id), { id, role: 'accepts', schemaExport });
});

test('unknown schema ids are refused without fallback', () => {
  const unknown = { ...fixture('certificate-export-request.json'), schema: 'urn:aihq:core:certificate-export-request:99.0.0' };
  const result = validateCertificateExportRequest(unknown);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  assert.equal(result.diagnostics[0].reason, 'schema-unsupported');
  const notRequest = validateCertificateExportRequest(fixture('trust-custody-1.0.0.json'));
  assert.equal(notRequest.valid, false);
  assert.equal(notRequest.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
});

test('objects reject unknown members, optional null and hostile values', () => {
  for (const [validate, document] of [
    [validateCertificateExportRequest, { ...fixture('certificate-export-request.json'), extra: true }],
    [validateCertificateExportInputs, { ...fixture('certificate-export-inputs.json'), extra: true }],
    [validateTrustRepairRequest, { ...fixture('repair-request-native.json'), extra: true }],
    [validateTrustRepairInputs, { ...fixture('repair-inputs-native.json'), extra: true }],
    [validateCertificateExportRequest, { ...fixture('certificate-export-request.json'),
      sources: { os: true, supplied: [], extra: true } }]
  ]) {
    const result = validate(document);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.code === 'INPUT_INVALID' && d.reason === 'unknown-field'),
      JSON.stringify(result.diagnostics));
  }
  assert.equal(validateCertificateExportRequest({ ...fixture('certificate-export-request.json'), format: null }).valid, false);
  assert.equal(validateCertificateExportInputs({
    schema: 'urn:aihq:core:certificate-export-inputs:1.0.0',
    sources: { os: true, supplied: [] },
    unsafe: 1e999
  }).valid, false);
  let called = false;
  const accessor = fixture('certificate-export-request.json');
  Object.defineProperty(accessor, 'hidden', { get() { called = true; return true; }, enumerable: true });
  assert.equal(validateCertificateExportRequest(accessor).valid, false);
  assert.equal(called, false);
  const cyclic = fixture('certificate-export-request.json');
  cyclic.self = cyclic;
  assert.equal(validateCertificateExportRequest(cyclic).valid, false);
});

test('repair request semantics enforce route/source and caFile rules', () => {
  const nativeWithSources = { ...fixture('repair-request-native.json'), sources: { os: true, supplied: [] } };
  const nativeResult = validateTrustRepairRequest(nativeWithSources);
  assert.equal(nativeResult.valid, false);
  assert.equal(nativeResult.diagnostics[0].reason, 'invalid-source-selection');

  const fileWithoutSources = structuredClone(fixture('repair-request-file.json'));
  delete fileWithoutSources.sources;
  const fileResult = validateTrustRepairRequest(fileWithoutSources);
  assert.equal(fileResult.valid, false);
  assert.equal(fileResult.diagnostics[0].reason, 'invalid-source-selection');

  const withCaFile = structuredClone(fixture('repair-request-file.json'));
  withCaFile.repairs[0].inputs.caFile = '/home/example/inbox/team.pem';
  const caResult = validateTrustRepairRequest(withCaFile);
  assert.equal(caResult.valid, false);
  assert.equal(caResult.diagnostics[0].reason, 'unknown-field');

  const duplicate = structuredClone(fixture('repair-request-file.json'));
  duplicate.sources.supplied.push({ id: 'team', file: '/home/example/inbox/team-2.pem' });
  assert.equal(validateTrustRepairRequest(duplicate).valid, false);

  const addAndRemove = structuredClone(fixture('repair-request-file.json'));
  addAndRemove.sources.removeSupplied = ['team'];
  assert.equal(validateTrustRepairRequest(addAndRemove).valid, false);

  const nativeBaseline = structuredClone(fixture('repair-request-native.json'));
  nativeBaseline.repairs[0].inputs.baselineStore = '/home/example/baseline.jks';
  assert.equal(validateTrustRepairRequest(nativeBaseline).valid, false);
});

test('export requests enforce the format/extension binding', () => {
  const mismatch = { ...fixture('certificate-export-request.json'), format: 'pkcs7-der', output: '.aih/exports/os-ca.pem' };
  const result = validateCertificateExportRequest(mismatch);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].reason, 'format-path-mismatch');
  const upper = { ...fixture('certificate-export-request.json'), output: '.aih/exports/os-ca.PEM' };
  assert.equal(validateCertificateExportRequest(upper).valid, false);
  const matching = { ...fixture('certificate-export-request.json'), format: 'pkcs7-der', output: '.aih/exports/os-ca.p7b' };
  assert.equal(validateCertificateExportRequest(matching).valid, true);
});

test('prepared-work 1.2 ties route, definition, source set and row order together', () => {
  const nativeNonNull = structuredClone(fixture('prepared-work-1.2-blocked.json'));
  nativeNonNull.inputs.trust.sourceSetSha256 = sha('a');
  assert.equal(validatePreparedWork12(nativeNonNull).valid, false);

  const definitionMismatch = structuredClone(fixture('prepared-work-1.2-ready.json'));
  definitionMismatch.inputs.trust.definition.id = 'node-npm-ca';
  assert.equal(validatePreparedWork12(definitionMismatch).valid, false);

  const exportWithTargets = structuredClone(fixture('prepared-work-1.2-ready.json'));
  exportWithTargets.inputs.trust.targets.push(structuredClone(fixture('prepared-work-1.2-blocked.json').inputs.trust.targets[0]));
  assert.equal(validatePreparedWork12(exportWithTargets).valid, false);

  const extraMember = structuredClone(fixture('prepared-work-1.2-ready.json'));
  extraMember.inputs.trust.extra = true;
  assert.equal(validatePreparedWork12(extraMember).valid, false);

  const nullOptional = structuredClone(fixture('prepared-work-1.2-ready.json'));
  nullOptional.inputs.trust.certificates[0].reasons = null;
  assert.equal(validatePreparedWork12(nullOptional).valid, false);

  const unsorted = structuredClone(fixture('prepared-work-1.2-ready.json'));
  unsorted.inputs.trust.sources[0].fingerprints.reverse();
  const orderResult = validatePreparedWork12(unsorted);
  assert.equal(orderResult.valid, false);
  assert.equal(orderResult.diagnostics[0].reason, 'source-order');

  const missingRowField = structuredClone(fixture('prepared-work-1.2-ready.json'));
  delete missingRowField.inputs.trust.certificates[0].afterSources;
  assert.equal(validatePreparedWork12(missingRowField).valid, false);
});

test('run-result 1.2 always carries the trust branch and trust-only inputs', () => {
  const withoutTrust = structuredClone(fixture('run-result-1.2-stale.json'));
  delete withoutTrust.trust;
  assert.equal(validateRunResult12(withoutTrust).valid, false);

  const nullInputs = { ...fixture('run-result-1.2-stale.json'), inputs: null };
  assert.equal(validateRunResult12(nullInputs).valid, false);

  const legacyInputs = structuredClone(fixture('run-result-1.2-complete.json'));
  legacyInputs.inputs = { package: { name: '@aihq/core', version: '1.0.0-dev.6' } };
  assert.equal(validateRunResult12(legacyInputs).valid, false);

  const unknownTargetVerification = structuredClone(fixture('run-result-1.2-partial.json'));
  unknownTargetVerification.trust.targets[0].verification = 'invented';
  assert.equal(validateRunResult12(unknownTargetVerification).valid, false);

  const unresolvedObservation = structuredClone(fixture('run-result-1.2-partial.json'));
  delete unresolvedObservation.trust.targets[0].policyObservationSha256;
  assert.equal(validateRunResult12(unresolvedObservation).valid, false);
});

test('custody enforces source/file rules and entry ordering', () => {
  const wrongOwner = structuredClone(fixture('trust-custody-1.0.0.json'));
  wrongOwner.entries[0].sources[1].id = 'os';
  assert.equal(validateTrustCustody(wrongOwner).valid, false);
  const wrongKind = structuredClone(fixture('prepared-work-1.2-ready.json'));
  wrongKind.inputs.trust.sources[0].kind = 'supplied';
  assert.equal(validatePreparedWork12(wrongKind).valid, false);
  const duplicateAlias = structuredClone(fixture('trust-custody-1.0.0.json'));
  duplicateAlias.entries.push({ ...structuredClone(duplicateAlias.entries[0]), managementId: 'ca-export-aaa' });
  const orderResult = validateTrustCustody(duplicateAlias);
  assert.equal(orderResult.valid, false);
  assert.equal(orderResult.diagnostics[0].reason, 'custody-order');

  const osWithPrivateFile = structuredClone(fixture('trust-custody-1.0.0.json'));
  osWithPrivateFile.entries[0].sources[0].privateFile = '/home/example/inbox/team.pem';
  assert.equal(validateTrustCustody(osWithPrivateFile).valid, false);

  const suppliedWithoutPrivateFile = structuredClone(fixture('trust-custody-1.0.0.json'));
  suppliedWithoutPrivateFile.entries[0].sources[1].privateFile = null;
  assert.equal(validateTrustCustody(suppliedWithoutPrivateFile).valid, false);

  const unsortedFingerprints = structuredClone(fixture('trust-custody-1.0.0.json'));
  unsortedFingerprints.entries[0].sources[0].fingerprints.reverse();
  const fingerprintResult = validateTrustCustody(unsortedFingerprints);
  assert.equal(fingerprintResult.valid, false);
  assert.equal(fingerprintResult.diagnostics[0].reason, 'source-order');
});
