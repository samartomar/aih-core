import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MACOS_REPAIR_REQUEST_SCHEMA,
  MACOS_REPAIR_INPUTS_SCHEMA,
  MACOS_SESSION_CUSTODY_SCHEMA,
  MACOS_SESSION_PROFILES_SCHEMA,
  MACOS_PREPARED_WORK_SCHEMA,
  MACOS_RUN_RESULT_SCHEMA,
  MACOS_SESSION_VERIFICATION_REQUEST_SCHEMA,
  MACOS_SESSION_VERIFICATION_RESULT_SCHEMA,
  validateMacosRepairRequest,
  validateMacosRepairInputs,
  validateMacosSessionCustody,
  validateMacosSessionProfiles,
  validatePreparedWork13,
  validateRunResult13,
  validateMacosSessionReview,
  validateMacosSessionRun,
  validateMacosSessionVerificationRequest,
  validateMacosSessionVerificationResult
} from '../dist/core/macos-session-contracts.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/macos-session/${name}`, import.meta.url), 'utf8'));

test('the pinned 1.1 schema identifiers are exported', () => {
  assert.equal(MACOS_REPAIR_REQUEST_SCHEMA, 'urn:aihq:core:repair-request:1.1.0');
  assert.equal(MACOS_REPAIR_INPUTS_SCHEMA, 'urn:aihq:core:repair-inputs:1.1.0');
});

test('valid macOS session request and inputs fixtures satisfy their strict schemas', () => {
  const cases = [
    ['repair-request-1.1-terminal.json', validateMacosRepairRequest, MACOS_REPAIR_REQUEST_SCHEMA],
    ['repair-request-1.1-desktop.json', validateMacosRepairRequest, MACOS_REPAIR_REQUEST_SCHEMA],
    ['repair-request-1.1-both.json', validateMacosRepairRequest, MACOS_REPAIR_REQUEST_SCHEMA],
    ['repair-inputs-1.1-desktop.json', validateMacosRepairInputs, MACOS_REPAIR_INPUTS_SCHEMA]
  ];
  for (const [name, validate, schema] of cases) {
    const result = validate(fixture(name));
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.schema, schema);
    assert.deepEqual(result.diagnostics, []);
  }
});

test('the 1.1 validators refuse the immutable 1.0 and unknown schema ids without fallback', () => {
  const legacy = { ...fixture('repair-request-1.1-terminal.json'), schema: 'urn:aihq:core:repair-request:1.0.0' };
  delete legacy.macosSession;
  const legacyResult = validateMacosRepairRequest(legacy);
  assert.equal(legacyResult.valid, false);
  assert.equal(legacyResult.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  assert.equal(legacyResult.diagnostics[0].reason, 'schema-unsupported');
  assert.equal(legacyResult.diagnostics[0].encountered, 'urn:aihq:core:repair-request:1.0.0');
  assert.deepEqual(legacyResult.diagnostics[0].supported, [MACOS_REPAIR_REQUEST_SCHEMA]);

  const unknown = { ...fixture('repair-inputs-1.1-desktop.json'), schema: 'urn:aihq:core:repair-inputs:99.0.0' };
  const unknownResult = validateMacosRepairInputs(unknown);
  assert.equal(unknownResult.valid, false);
  assert.equal(unknownResult.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
});

test('1.1 requests keep the inherited 1.0 route, source and caFile semantics', () => {
  const nativeWithSources = { ...fixture('repair-request-1.1-terminal.json'), sources: { os: true, supplied: [] } };
  const nativeResult = validateMacosRepairRequest(nativeWithSources);
  assert.equal(nativeResult.valid, false);
  assert.equal(nativeResult.diagnostics[0].reason, 'invalid-source-selection');

  const fileWithoutSources = structuredClone(fixture('repair-request-1.1-desktop.json'));
  delete fileWithoutSources.sources;
  assert.equal(validateMacosRepairRequest(fileWithoutSources).valid, false);

  const withCaFile = structuredClone(fixture('repair-request-1.1-desktop.json'));
  withCaFile.repairs[0].inputs.caFile = '/Users/example/inbox/team.pem';
  const caResult = validateMacosRepairRequest(withCaFile);
  assert.equal(caResult.valid, false);
  assert.equal(caResult.diagnostics[0].reason, 'unknown-field');

  const nativeBaseline = structuredClone(fixture('repair-request-1.1-terminal.json'));
  nativeBaseline.repairs[0].inputs.baselineStore = '/Users/example/baseline.jks';
  assert.equal(validateMacosRepairRequest(nativeBaseline).valid, false);
});

test('session selection enforces context, roster, coverage and unique applications', () => {
  const terminalWithApps = structuredClone(fixture('repair-request-1.1-terminal.json'));
  terminalWithApps.macosSession.applications.push(
    { clientId: 'claude', appPath: '/Applications/Claude.app', targets: ['node'], launch: 'finder' });
  const terminalResult = validateMacosRepairRequest(terminalWithApps);
  assert.equal(terminalResult.valid, false);
  assert.equal(terminalResult.diagnostics[0].reason, 'invalid-session-selection');

  const desktopWithoutApps = structuredClone(fixture('repair-request-1.1-desktop.json'));
  desktopWithoutApps.macosSession.applications = [];
  assert.equal(validateMacosRepairRequest(desktopWithoutApps).valid, false);

  const outsideTargets = structuredClone(fixture('repair-request-1.1-desktop.json'));
  outsideTargets.macosSession.applications[0].targets = ['git'];
  const outsideResult = validateMacosRepairRequest(outsideTargets);
  assert.equal(outsideResult.valid, false);
  assert.equal(outsideResult.diagnostics[0].reason, 'invalid-session-selection');

  const uncovered = structuredClone(fixture('repair-request-1.1-desktop.json'));
  uncovered.macosSession.applications[1].targets = ['node'];
  const uncoveredResult = validateMacosRepairRequest(uncovered);
  assert.equal(uncoveredResult.valid, false);
  assert.equal(uncoveredResult.diagnostics[0].reason, 'invalid-session-selection');

  const duplicatePath = structuredClone(fixture('repair-request-1.1-desktop.json'));
  duplicatePath.macosSession.applications[1].appPath = duplicatePath.macosSession.applications[0].appPath;
  const duplicateResult = validateMacosRepairRequest(duplicatePath);
  assert.equal(duplicateResult.valid, false);
  assert.equal(duplicateResult.diagnostics[0].reason, 'invalid-session-selection');

  const unknownClient = structuredClone(fixture('repair-request-1.1-desktop.json'));
  unknownClient.macosSession.applications[0].clientId = 'notepad';
  assert.equal(validateMacosRepairRequest(unknownClient).valid, false);

  const relativePath = structuredClone(fixture('repair-request-1.1-desktop.json'));
  relativePath.macosSession.applications[0].appPath = 'Applications/Claude.app';
  const relativeResult = validateMacosRepairRequest(relativePath);
  assert.equal(relativeResult.valid, false);
  assert.equal(relativeResult.diagnostics[0].reason, 'invalid-session-selection');

  const notAnApp = structuredClone(fixture('repair-request-1.1-desktop.json'));
  notAnApp.macosSession.applications[0].appPath = '/Applications/Claude';
  const notAnAppResult = validateMacosRepairRequest(notAnApp);
  assert.equal(notAnAppResult.valid, false);
  assert.equal(notAnAppResult.diagnostics[0].reason, 'invalid-session-selection');

  const nineApps = structuredClone(fixture('repair-request-1.1-desktop.json'));
  for (let index = 0; index < 8; index += 1)
    nineApps.macosSession.applications.push(
      { clientId: 'claude', appPath: `/Applications/Extra${index}.app`, targets: ['node'], launch: 'finder' });
  assert.equal(validateMacosRepairRequest(nineApps).valid, false);
});

test('session documents reject unknown members, explicit null and hostile values', () => {
  const extra = structuredClone(fixture('repair-request-1.1-desktop.json'));
  extra.macosSession.extra = true;
  const extraResult = validateMacosRepairRequest(extra);
  assert.equal(extraResult.valid, false);
  assert.ok(extraResult.diagnostics.some(d => d.code === 'INPUT_INVALID' && d.reason === 'unknown-field'),
    JSON.stringify(extraResult.diagnostics));

  const nullSession = { ...fixture('repair-request-1.1-terminal.json'), macosSession: null };
  assert.equal(validateMacosRepairRequest(nullSession).valid, false);

  const missingSession = structuredClone(fixture('repair-request-1.1-terminal.json'));
  delete missingSession.macosSession;
  assert.equal(validateMacosRepairRequest(missingSession).valid, false);

  let called = false;
  const accessor = fixture('repair-request-1.1-terminal.json');
  Object.defineProperty(accessor.macosSession, 'hidden', { get() { called = true; return true; }, enumerable: true });
  assert.equal(validateMacosRepairRequest(accessor).valid, false);
  assert.equal(called, false);

  const cyclic = fixture('repair-request-1.1-terminal.json');
  cyclic.macosSession.self = cyclic.macosSession;
  assert.equal(validateMacosRepairRequest(cyclic).valid, false);
});

test('the valid session custody fixture satisfies its strict schema', () => {
  const result = validateMacosSessionCustody(fixture('macos-session-custody-1.0.0.json'));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.schema, MACOS_SESSION_CUSTODY_SCHEMA);
  assert.deepEqual(result.diagnostics, []);
});

test('custody cannot cross-select a family, selection or context', () => {
  for (const [field, value] of [['managementId', 'node-npm-trust'], ['selectionId', 'other'], ['context', 'terminal']]) {
    const document = structuredClone(fixture('macos-session-custody-1.0.0.json'));
    document.entries[0][field] = value;
    assert.equal(validateMacosSessionCustody(document).valid, false, field);
  }
});

test('custody refuses unknown schema ids and preserves entry/row ordering', () => {
  const wrongSchema = { ...fixture('macos-session-custody-1.0.0.json'), schema: 'urn:aihq:core:trust-custody:1.0.0' };
  const schemaResult = validateMacosSessionCustody(wrongSchema);
  assert.equal(schemaResult.valid, false);
  assert.equal(schemaResult.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');

  const duplicate = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  duplicate.entries.push({ ...structuredClone(duplicate.entries[0]), managementId: 'aaa-earlier' });
  const duplicateResult = validateMacosSessionCustody(duplicate);
  assert.equal(duplicateResult.valid, false);
  assert.equal(duplicateResult.diagnostics[0].reason, 'custody-order');

  const unsortedFiles = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  unsortedFiles.entries[0].files.reverse();
  const filesResult = validateMacosSessionCustody(unsortedFiles);
  assert.equal(filesResult.valid, false);
  assert.equal(filesResult.diagnostics[0].reason, 'custody-order');

  const unsortedProfiles = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  unsortedProfiles.entries[0].profileIds.reverse();
  const profilesResult = validateMacosSessionCustody(unsortedProfiles);
  assert.equal(profilesResult.valid, false);
  assert.equal(profilesResult.diagnostics[0].reason, 'custody-order');
});

test('custody enforces presence/null distinction and key identity derivation', () => {
  const nullValue = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  nullValue.entries[0].keys[0].after = { present: true, value: null };
  assert.equal(validateMacosSessionCustody(nullValue).valid, false);

  const presentWithoutValue = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  presentWithoutValue.entries[0].keys[0].before = { present: false, value: '' };
  assert.equal(validateMacosSessionCustody(presentWithoutValue).valid, false);

  const emptyPresent = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  emptyPresent.entries[0].keys[0].after = { present: true, value: '' };
  assert.equal(validateMacosSessionCustody(emptyPresent).valid, true, JSON.stringify(validateMacosSessionCustody(emptyPresent).diagnostics));

  const wrongLabel = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  wrongLabel.entries[0].keys[0].label = 'dev.aihq.trust.NODE_EXTRA_CA_CERTS';
  const labelResult = validateMacosSessionCustody(wrongLabel);
  assert.equal(labelResult.valid, false);
  assert.equal(labelResult.diagnostics[0].reason, 'invalid-session-custody');

  const badKeyName = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  badKeyName.entries[0].keys[0].key = 'NODE-EXTRA-CA-CERTS';
  const keyResult = validateMacosSessionCustody(badKeyName);
  assert.equal(keyResult.valid, false);
  assert.equal(keyResult.diagnostics[0].reason, 'invalid-session-custody');
});

test('custody rejects non-canonical path keys and unsafe embedded requests', () => {
  const aliased = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  aliased.entries[0].files[0].pathKey = '{"segments":[".zprofile"],"home":"/Users/example"}';
  const aliasResult = validateMacosSessionCustody(aliased);
  assert.equal(aliasResult.valid, false);
  assert.equal(aliasResult.diagnostics[0].reason, 'invalid-session-custody');

  const traversal = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  traversal.entries[0].files[0].pathKey = '{"home":"/Users/example","segments":["..","shared"]}';
  const traversalResult = validateMacosSessionCustody(traversal);
  assert.equal(traversalResult.valid, false);
  assert.equal(traversalResult.diagnostics[0].reason, 'invalid-session-custody');

  const strippedSession = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  delete strippedSession.entries[0].request.macosSession;
  const requestResult = validateMacosSessionCustody(strippedSession);
  assert.equal(requestResult.valid, false);
  assert.equal(requestResult.diagnostics[0].reason, 'invalid-session-custody');
});

test('custody document is capped at 1 MiB', () => {
  const padded = structuredClone(fixture('macos-session-custody-1.0.0.json'));
  const files = [];
  for (let index = 0; index < 140; index += 1)
    files.push({
      operationId: `op-${String(index).padStart(4, '0')}`,
      pathKey: `{"home":"/Users/example","segments":["pad-${String(index).padStart(4, '0')}-${'a'.repeat(8000)}"]}`,
      sha256: 'd'.repeat(64)
    });
  padded.entries[0].files = files;
  const result = validateMacosSessionCustody(padded);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].reason, 'strict-json');
});

test('the bundled session profiles module ships an honest empty admission list', async () => {
  const profiles = await import('../dist/harness/macos-session-profiles.mjs');
  assert.equal(profiles.macosSessionProfilesSchema, MACOS_SESSION_PROFILES_SCHEMA);
  assert.equal(profiles.macosSessionProfiles.schema, MACOS_SESSION_PROFILES_SCHEMA);
  assert.equal(profiles.macosSessionProfiles.package.name, '@aihq/core');
  assert.equal(typeof profiles.macosSessionProfiles.package.version, 'string');
  assert.deepEqual(profiles.macosSessionProfiles.profiles, []);
  assert.ok(Object.isFrozen(profiles.macosSessionProfiles));
  const result = validateMacosSessionProfiles(profiles.macosSessionProfiles);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.schema, MACOS_SESSION_PROFILES_SCHEMA);
});

test('session profiles schema enforces exact identity encodings and closed records', () => {
  const profile = {
    id: 'claude-macos-26-arm64-node',
    clientId: 'claude',
    trustCellId: 'claude-macos-26-arm64-node-native',
    launch: 'finder',
    mechanism: 'gui-environment',
    bundleId: 'com.anthropic.claude',
    teamId: 'TEAMID1234',
    cdHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    appVersion: '2.1.285',
    appBuild: '285',
    runtimeSha256: 'b'.repeat(64),
    configurationProfile: 'node-macos-gui-env-v1',
    helperSha256: 'c'.repeat(64),
    environmentKeys: ['NODE_EXTRA_CA_CERTS'],
    relaunch: 'quit-app',
    evidence: { reference: 'dist/harness/acceptance/claude-macos-26-arm64-node.json', sha256: 'd'.repeat(64), subjectSha256: 'e'.repeat(64) }
  };
  const document = { schema: MACOS_SESSION_PROFILES_SCHEMA, package: { name: '@aihq/core', version: '1.0.0-dev.9' }, profiles: [profile] };
  assert.equal(validateMacosSessionProfiles(document).valid, true, JSON.stringify(validateMacosSessionProfiles(document).diagnostics));

  const longCdHash = structuredClone(document);
  longCdHash.profiles[0].cdHash = 'a'.repeat(64);
  assert.equal(validateMacosSessionProfiles(longCdHash).valid, false);

  const upperCdHash = structuredClone(document);
  upperCdHash.profiles[0].cdHash = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
  assert.equal(validateMacosSessionProfiles(upperCdHash).valid, false);

  const nullIdentity = structuredClone(document);
  nullIdentity.profiles[0].teamId = null;
  nullIdentity.profiles[0].cdHash = null;
  assert.equal(validateMacosSessionProfiles(nullIdentity).valid, true, JSON.stringify(validateMacosSessionProfiles(nullIdentity).diagnostics));

  const extraMember = structuredClone(document);
  extraMember.profiles[0].installer = 'brew';
  const extraResult = validateMacosSessionProfiles(extraMember);
  assert.equal(extraResult.valid, false);
  assert.ok(extraResult.diagnostics.some(d => d.reason === 'unknown-field'), JSON.stringify(extraResult.diagnostics));

  const unknownClient = structuredClone(document);
  unknownClient.profiles[0].clientId = 'textedit';
  assert.equal(validateMacosSessionProfiles(unknownClient).valid, false);

  const controlInBundle = structuredClone(document);
  controlInBundle.profiles[0].bundleId = 'com.example.\u0007app';
  assert.equal(validateMacosSessionProfiles(controlInBundle).valid, false);

  const wrongSchema = { ...document, schema: 'urn:aihq:harness:trust-capabilities:1.0.0' };
  const schemaResult = validateMacosSessionProfiles(wrongSchema);
  assert.equal(schemaResult.valid, false);
  assert.equal(schemaResult.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
});

test('session profiles reject duplicate ids and ambiguous matching tuples', () => {
  const base = {
    id: 'profile-one', clientId: 'claude', trustCellId: 'cell-one', launch: 'finder', mechanism: 'app-config',
    bundleId: 'com.example.one', teamId: null, cdHash: null, appVersion: '1.0', appBuild: '100',
    runtimeSha256: 'b'.repeat(64), configurationProfile: 'config-v1', helperSha256: 'c'.repeat(64),
    environmentKeys: [], relaunch: 'quit-app',
    evidence: { reference: 'dist/harness/acceptance/one.json', sha256: 'd'.repeat(64), subjectSha256: 'e'.repeat(64) }
  };
  const document = profiles => ({ schema: MACOS_SESSION_PROFILES_SCHEMA, package: { name: '@aihq/core', version: '1.0.0-dev.9' }, profiles });

  const duplicateId = document([base, { ...structuredClone(base), bundleId: 'com.example.two' }]);
  const idResult = validateMacosSessionProfiles(duplicateId);
  assert.equal(idResult.valid, false);
  assert.equal(idResult.diagnostics[0].reason, 'invalid-session-profiles');

  const ambiguousTuple = document([base, { ...structuredClone(base), id: 'profile-two' }]);
  const tupleResult = validateMacosSessionProfiles(ambiguousTuple);
  assert.equal(tupleResult.valid, false);
  assert.equal(tupleResult.diagnostics[0].reason, 'invalid-session-profiles');

  const distinctTuple = document([base, { ...structuredClone(base), id: 'profile-two', launch: 'dock' }]);
  assert.equal(validateMacosSessionProfiles(distinctTuple).valid, true, JSON.stringify(validateMacosSessionProfiles(distinctTuple).diagnostics));

  const badEnvironmentKey = document([{ ...structuredClone(base), mechanism: 'gui-environment', environmentKeys: ['2INVALID'] }]);
  const keyResult = validateMacosSessionProfiles(badEnvironmentKey);
  assert.equal(keyResult.valid, false);
  assert.equal(keyResult.diagnostics[0].reason, 'invalid-session-profiles');

  const tooMany = document(Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(base), id: `profile-${index}` })));
  assert.equal(validateMacosSessionProfiles(tooMany).valid, false);
});

test('valid 1.3 prepared-work and run-result fixtures satisfy their strict schemas', () => {
  const cases = [
    ['prepared-work-1.3-blocked.json', validatePreparedWork13, MACOS_PREPARED_WORK_SCHEMA],
    ['prepared-work-1.3-desktop.json', validatePreparedWork13, MACOS_PREPARED_WORK_SCHEMA],
    ['run-result-1.3-complete.json', validateRunResult13, MACOS_RUN_RESULT_SCHEMA],
    ['run-result-1.3-desktop.json', validateRunResult13, MACOS_RUN_RESULT_SCHEMA]
  ];
  for (const [name, validate, schema] of cases) {
    const result = validate(fixture(name));
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.schema, schema);
    assert.deepEqual(result.diagnostics, []);
  }
});

test('1.2 and 1.3 review/result formats refuse each other without downgrade', async () => {
  const { validatePreparedWork12, validateRunResult12 } = await import('../dist/core/contracts.js');
  const blocked12 = JSON.parse(readFileSync(new URL('./fixtures/trust-contracts/prepared-work-1.2-blocked.json', import.meta.url), 'utf8'));
  const stale12 = JSON.parse(readFileSync(new URL('./fixtures/trust-contracts/run-result-1.2-stale.json', import.meta.url), 'utf8'));

  const preparedAs13 = validatePreparedWork13(blocked12);
  assert.equal(preparedAs13.valid, false);
  assert.equal(preparedAs13.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  const resultAs13 = validateRunResult13(stale12);
  assert.equal(resultAs13.valid, false);
  assert.equal(resultAs13.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');

  const preparedAs12 = validatePreparedWork12(fixture('prepared-work-1.3-blocked.json'));
  assert.equal(preparedAs12.valid, false);
  assert.equal(preparedAs12.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  const resultAs12 = validateRunResult12(fixture('run-result-1.3-complete.json'));
  assert.equal(resultAs12.valid, false);
  assert.equal(resultAs12.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
});

test('1.3 review keeps inherited 1.2 trust semantics', () => {
  const inherited = structuredClone(fixture('prepared-work-1.3-desktop.json'));
  inherited.inputs.trust.sources.push({
    id: 'supplied:company', kind: 'supplied', adapter: null, scope: 'explicit-source',
    completeness: 'complete', policySha256: null, sourceSha256: 'a'.repeat(64), runtimeVersion: null,
    reason: null, fingerprints: ['b'.repeat(64), 'a'.repeat(64)]
  });
  const orderResult = validatePreparedWork13(inherited);
  assert.equal(orderResult.valid, false);
  assert.equal(orderResult.diagnostics[0].reason, 'source-order');

  const nativeNonNull = structuredClone(fixture('prepared-work-1.3-blocked.json'));
  nativeNonNull.inputs.trust.sourceSetSha256 = 'a'.repeat(64);
  assert.equal(validatePreparedWork13(nativeNonNull).valid, false);

  const legacyDefinition = structuredClone(fixture('prepared-work-1.3-blocked.json'));
  legacyDefinition.inputs.trust.definition.schema = 'urn:aihq:harness:repair:1.1.0';
  assert.equal(validatePreparedWork13(legacyDefinition).valid, false);
});

test('session review pins terminal shape, GUI session identity and admission honesty', () => {
  const rootSession = structuredClone(fixture('prepared-work-1.3-desktop.json'));
  rootSession.inputs.macosSession.session = { uid: 0, domain: 'gui/0', identitySha256: 'e'.repeat(64) };
  const rootResult = validatePreparedWork13(rootSession);
  assert.equal(rootResult.valid, false);
  assert.equal(rootResult.diagnostics[0].reason, 'invalid-session-review');

  const wrongDomain = structuredClone(fixture('prepared-work-1.3-desktop.json'));
  wrongDomain.inputs.macosSession.session = { uid: 501, domain: 'gui/502', identitySha256: 'e'.repeat(64) };
  assert.equal(validatePreparedWork13(wrongDomain).valid, false);

  const terminalSession = structuredClone(fixture('prepared-work-1.3-blocked.json'));
  terminalSession.inputs.macosSession.session = { uid: 501, domain: 'gui/501', identitySha256: 'e'.repeat(64) };
  assert.equal(validatePreparedWork13(terminalSession).valid, false);

  const admittedReason = structuredClone(fixture('prepared-work-1.3-desktop.json'));
  admittedReason.inputs.macosSession.applications[0].reason = 'invented';
  assert.equal(validatePreparedWork13(admittedReason).valid, false);

  const admittedNoProfiles = structuredClone(fixture('prepared-work-1.3-desktop.json'));
  admittedNoProfiles.inputs.macosSession.applications[0].profileIds = [];
  assert.equal(validatePreparedWork13(admittedNoProfiles).valid, false);

  const unavailableNoReason = structuredClone(fixture('prepared-work-1.3-desktop.json'));
  unavailableNoReason.inputs.macosSession.applications[1].reason = null;
  assert.equal(validatePreparedWork13(unavailableNoReason).valid, false);

  const wrongRelaunch = structuredClone(fixture('prepared-work-1.3-desktop.json'));
  wrongRelaunch.inputs.macosSession.applications[1].relaunch = 'quit-app';
  assert.equal(validatePreparedWork13(wrongRelaunch).valid, false);

  const orphanEffect = structuredClone(fixture('prepared-work-1.3-desktop.json'));
  orphanEffect.inputs.macosSession.effects[0].operationId = 'trust/nonexistent';
  const orphanResult = validatePreparedWork13(orphanEffect);
  assert.equal(orphanResult.valid, false);
  assert.equal(orphanResult.diagnostics[0].reason, 'invalid-session-review');
});

test('session run pins configuration/identity and completion joins', () => {
  const passedIncomplete = structuredClone(fixture('run-result-1.3-complete.json'));
  passedIncomplete.completion = 'incomplete';
  passedIncomplete.macosSession.verification = 'passed';
  const passedResult = validateRunResult13(passedIncomplete);
  assert.equal(passedResult.valid, false);
  assert.equal(passedResult.diagnostics[0].reason, 'invalid-session-run');

  const noManagement = structuredClone(fixture('run-result-1.3-desktop.json'));
  noManagement.macosSession.managementId = null;
  const managementResult = validateRunResult13(noManagement);
  assert.equal(managementResult.valid, false);
  assert.equal(managementResult.diagnostics[0].reason, 'invalid-session-run');

  const terminalApps = structuredClone(fixture('run-result-1.3-complete.json'));
  terminalApps.macosSession.applications.push({
    clientId: 'claude', appPath: '/Applications/Claude.app', targets: ['node'], launch: 'finder',
    configuration: 'applied', verification: 'skipped', reason: 'network-off', relaunch: 'none'
  });
  assert.equal(validateRunResult13(terminalApps).valid, false);

  const missingSession = structuredClone(fixture('run-result-1.3-complete.json'));
  delete missingSession.macosSession;
  assert.equal(validateRunResult13(missingSession).valid, false);
});

test('standalone review/run subdocument validators use the 1.3 definitions', () => {
  const review = fixture('prepared-work-1.3-desktop.json').inputs.macosSession;
  const reviewResult = validateMacosSessionReview(review);
  assert.equal(reviewResult.valid, true, JSON.stringify(reviewResult.diagnostics));
  assert.equal(reviewResult.schema, MACOS_PREPARED_WORK_SCHEMA);

  const badReview = structuredClone(review);
  badReview.applications[0].reason = 'invented';
  assert.equal(validateMacosSessionReview(badReview).valid, false);

  const run = fixture('run-result-1.3-desktop.json').macosSession;
  const runResult = validateMacosSessionRun(run);
  assert.equal(runResult.valid, true, JSON.stringify(runResult.diagnostics));
  assert.equal(runResult.schema, MACOS_RUN_RESULT_SCHEMA);

  const badRun = structuredClone(run);
  badRun.configuration = 'applied';
  badRun.managementId = null;
  assert.equal(validateMacosSessionRun(badRun).valid, false);
});

test('the verification request is a narrow closed document', () => {
  const result = validateMacosSessionVerificationRequest(fixture('verification-request-1.0.0.json'));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.schema, MACOS_SESSION_VERIFICATION_REQUEST_SCHEMA);

  const wrongSchema = { ...fixture('verification-request-1.0.0.json'), schema: 'urn:aihq:core:macos-session-verification-result:1.0.0' };
  const schemaResult = validateMacosSessionVerificationRequest(wrongSchema);
  assert.equal(schemaResult.valid, false);
  assert.equal(schemaResult.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');

  for (const extra of [{ pid: 1234 }, { proof: 'a'.repeat(64) }, { url: 'https://example.invalid' }]) {
    const injected = { ...fixture('verification-request-1.0.0.json'), ...extra };
    const injectedResult = validateMacosSessionVerificationRequest(injected);
    assert.equal(injectedResult.valid, false, JSON.stringify(extra));
    assert.equal(injectedResult.diagnostics[0].reason, 'unknown-field');
  }

  assert.equal(validateMacosSessionVerificationRequest({ schema: MACOS_SESSION_VERIFICATION_REQUEST_SCHEMA, managementId: '' }).valid, false);
  assert.equal(validateMacosSessionVerificationRequest({ schema: MACOS_SESSION_VERIFICATION_REQUEST_SCHEMA, managementId: null }).valid, false);
});

test('the verification result fixtures satisfy their strict schema', () => {
  for (const name of ['verification-result-1.0.0-invalid.json', 'verification-result-1.0.0-incomplete.json', 'verification-result-1.0.0-complete.json']) {
    const result = validateMacosSessionVerificationResult(fixture(name));
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.schema, MACOS_SESSION_VERIFICATION_RESULT_SCHEMA);
  }
});

test('invalid verification results retain null identity, platform and empty observations', () => {
  const withPackage = structuredClone(fixture('verification-result-1.0.0-invalid.json'));
  withPackage.package = { name: '@aihq/core', version: '1.0.0-dev.9' };
  const packageResult = validateMacosSessionVerificationResult(withPackage);
  assert.equal(packageResult.valid, false);
  assert.equal(packageResult.diagnostics[0].reason, 'invalid-session-result');

  const withManagement = structuredClone(fixture('verification-result-1.0.0-invalid.json'));
  withManagement.managementId = 'node-npm-trust';
  assert.equal(validateMacosSessionVerificationResult(withManagement).valid, false);

  const withObservation = structuredClone(fixture('verification-result-1.0.0-invalid.json'));
  withObservation.observations.push(structuredClone(fixture('verification-result-1.0.0-complete.json').observations[0]));
  assert.equal(validateMacosSessionVerificationResult(withObservation).valid, false);

  const noDiagnostic = structuredClone(fixture('verification-result-1.0.0-invalid.json'));
  noDiagnostic.diagnostics = [];
  assert.equal(validateMacosSessionVerificationResult(noDiagnostic).valid, false);
});

test('a valid missing-session result retains the requested managementId', () => {
  const missing = fixture('verification-result-1.0.0-incomplete.json');
  assert.equal(validateMacosSessionVerificationResult(missing).valid, true);
  assert.equal(missing.managementId, 'node-npm-trust');
  assert.equal(missing.selectionId, null);
});

test('complete verification requires non-null bindings and joined passing checks', () => {
  const unavailable = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  unavailable.verification = 'unavailable';
  assert.equal(validateMacosSessionVerificationResult(unavailable).valid, false);

  const nullBinding = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  nullBinding.bindingSha256 = null;
  assert.equal(validateMacosSessionVerificationResult(nullBinding).valid, false);

  const failedCheck = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  failedCheck.checks[0].status = 'failed';
  assert.equal(validateMacosSessionVerificationResult(failedCheck).valid, false);

  const withDiagnostic = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  withDiagnostic.diagnostics.push({ code: 'PREREQUISITE_UNAVAILABLE', reason: 'relaunch-required', message: 'x' });
  assert.equal(validateMacosSessionVerificationResult(withDiagnostic).valid, false);

  const orphanCheckId = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  orphanCheckId.observations[0].checkIds = ['nonexistent-check'];
  const orphanResult = validateMacosSessionVerificationResult(orphanCheckId);
  assert.equal(orphanResult.valid, false);
  assert.equal(orphanResult.diagnostics[0].reason, 'invalid-session-result');

  const subjectless = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  subjectless.observations = [];
  assert.equal(validateMacosSessionVerificationResult(subjectless).valid, false);

  // Only successful checks need an observed subject; unavailable evidence stays honest.
  const honestGap = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  honestGap.status = 'incomplete';
  honestGap.verification = 'unavailable';
  honestGap.reason = 'app-trust-unobservable';
  honestGap.observations = [];
  honestGap.checks[0].status = 'unavailable';
  honestGap.checks[0].reason = 'app-trust-unobservable';
  honestGap.configuration = 'uncertain';
  assert.equal(validateMacosSessionVerificationResult(honestGap).valid, true,
    JSON.stringify(validateMacosSessionVerificationResult(honestGap).diagnostics));
});

test('observation identity rules separate terminal from desktop records', () => {
  const desktopMissing = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  desktopMissing.observations[0].context = 'desktop';
  const desktopResult = validateMacosSessionVerificationResult(desktopMissing);
  assert.equal(desktopResult.valid, false);
  assert.equal(desktopResult.diagnostics[0].reason, 'invalid-session-result');

  const terminalWithApp = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  terminalWithApp.observations[0].appPath = '/Applications/Claude.app';
  assert.equal(validateMacosSessionVerificationResult(terminalWithApp).valid, false);

  const desktop = structuredClone(fixture('verification-result-1.0.0-complete.json'));
  desktop.observations[0] = {
    ...desktop.observations[0],
    context: 'desktop', clientId: 'claude', appPath: '/Applications/Claude.app', profileId: 'claude-macos-26-arm64-node',
    applicationIdentitySha256: 'a'.repeat(64), sessionIdentitySha256: 'b'.repeat(64),
    client: { version: '2.1.285', build: '285', backend: 'Node', backendVersion: '24.19.0', applicationId: 'com.anthropic.claude' }
  };
  assert.equal(validateMacosSessionVerificationResult(desktop).valid, true, JSON.stringify(validateMacosSessionVerificationResult(desktop).diagnostics));

  const desktopAfterTerminal = structuredClone(desktop);
  desktopAfterTerminal.observations.push({ ...structuredClone(desktopAfterTerminal.observations[0]), context: 'terminal', clientId: null,
    appPath: null, profileId: null, applicationIdentitySha256: null, sessionIdentitySha256: null,
    client: { version: '24.19.0', build: 'release', backend: 'OpenSSL', backendVersion: '3.0.16', applicationId: null } });
  const orderResult = validateMacosSessionVerificationResult(desktopAfterTerminal);
  assert.equal(orderResult.valid, false);
  assert.equal(orderResult.diagnostics[0].reason, 'invalid-session-result');
});
