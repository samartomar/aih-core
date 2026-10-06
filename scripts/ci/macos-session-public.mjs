// Copy beside the installed package. This gate uses only public package entries.
import assert from 'node:assert/strict';
import { prepare, verifyMacosSession } from '@aihq/core';
import { contractSupport, validateMacosRepairRequest, validateMacosSessionVerificationResult } from '@aihq/core/contracts';
import { contractSupport as harnessSupport, macosSessionProfiles, macosRepairIndex, validateRepairDefinition12 } from '@aihq/core/harness';
import * as runtime from '@aihq/core/harness/runtime';

const coreSchemas = [
  ['repair-request', '1.1.0'], ['repair-inputs', '1.1.0'], ['prepared-work', '1.3.0'], ['run-result', '1.3.0'],
  ['macos-session-custody', '1.0.0'], ['macos-session-verification-request', '1.0.0'], ['macos-session-verification-result', '1.0.0']
];
const harnessSchemas = [['repair', '1.2.0'], ['macos-session-profiles', '1.0.0']];
for (const [module, schemas, support] of [['core', coreSchemas, contractSupport], ['harness', harnessSchemas, harnessSupport]]) {
  for (const [name, version] of schemas) {
    const schema = (await import(`@aihq/core/${module === 'harness' ? 'harness/' : ''}schemas/${name}/${version}.json`, { with: { type: 'json' } })).default;
    assert.equal(schema.$id, `urn:aihq:${module}:${name}:${version}`);
    assert.ok(support.contracts.some(row => row.id === schema.$id), schema.$id);
  }
}
assert.equal(macosSessionProfiles.profiles.length, 0);
for (const definition of macosRepairIndex) assert.equal(validateRepairDefinition12(definition).valid, true, definition.id);
for (const name of ['applyMacosGuiDomainKey', 'macosSessionBootstrap', 'macosSessionBootout', 'runMacosSessionLoginReplay', 'evaluateMacosSessionVerification'])
  assert.equal(Object.hasOwn(runtime, name), false, `Unadmitted capability exposed: ${name}`);
const invalid = await verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:1.0.0', managementId: 'node-npm-trust', pid: 1 }, { logging: 'off' });
assert.equal(invalid.status, 'invalid'); assert.equal(invalid.managementId, null);
assert.equal(validateMacosSessionVerificationResult(invalid).valid, true);
const request = { schema: 'urn:aihq:core:repair-request:1.1.0', useCase: 'repair', route: 'file', network: 'off',
  repairs: [{ id: 'node-npm-ca', targets: ['node'], inputs: {} }], sources: { os: false, supplied: [{ id: 'team', file: '/aih-missing/ca.pem' }] },
  macosSession: { context: 'terminal', applications: [] } };
assert.equal(validateMacosRepairRequest(request).valid, true);
if (process.platform !== 'darwin') {
  const blocked = await prepare(request, { logging: 'off' });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.diagnostics[0].reason, 'session-platform-unsupported');
}
await assert.rejects(import('@aihq/core/src/harness/macos-session.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log(JSON.stringify({ status: 'passed', package: contractSupport.package, schemaExports: 9,
  profiles: 0, unadmittedMutationExports: 0, callerProcessProofRejected: true, platform: process.platform }, null, 2));
