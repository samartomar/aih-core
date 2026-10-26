// Portable fixture references; bytes are loaded only by the caller's host adapter.
const accepting = new Set([
  "urn:aihq:package-support:1.0.0",
  "urn:aihq:package-support:1.1.0",
  "urn:aihq:core:execution-policy:1.0.0",
  "urn:aihq:core:recipe:1.0.0",
  "urn:aihq:core:execution-policy:1.1.0",
  "urn:aihq:core:recipe:1.1.0",
  "urn:aihq:core:execution-policy:1.2.0",
  "urn:aihq:core:recipe:1.2.0",
  "urn:aihq:core:execution-policy:1.3.0",
  "urn:aihq:core:execution-policy:1.4.0",
  "urn:aihq:core:recipe:1.3.0",
  "urn:aihq:core:recipe:1.4.0",
  "urn:aihq:core:organization-policy:1.0.0",
  "urn:aihq:core:organization-policy:1.1.0",
  "urn:aihq:core:organization-target:1.0.0",
  "urn:aihq:core:organization-target:1.1.0",
  "urn:aihq:harness:tool-registry:1.0.0",
  "urn:aihq:harness:tool-binding:1.0.0",
  "urn:aihq:harness:repair:1.0.0",
  "urn:aihq:harness:repair:1.1.0",
  "urn:aihq:harness:repair:1.2.0",
  "urn:aihq:harness:macos-session-profiles:1.0.0",
  "urn:aihq:harness:trust-capabilities:1.0.0",
  "urn:aihq:harness:native-verification-definition:1.0.0",
  "urn:aihq:core:file-state-result:1.1.0",
  "urn:aihq:core:native-verification-result:1.0.0",
  "urn:aihq:core:macos-session-custody:1.0.0",
  "urn:aihq:core:prepared-work:1.3.0",
  "urn:aihq:core:repair-inputs:1.1.0",
  "urn:aihq:core:repair-request:1.1.0",
  "urn:aihq:core:run-result:1.3.0",
  "urn:aihq:core:macos-session-verification-request:1.0.0",
  "urn:aihq:core:macos-session-verification-result:1.0.0",
  "urn:aihq:core:certificate-export-inputs:1.0.0",
  "urn:aihq:core:certificate-export-request:1.0.0",
  "urn:aihq:core:prepared-work:1.2.0",
  "urn:aihq:core:repair-inputs:1.0.0",
  "urn:aihq:core:repair-request:1.0.0",
  "urn:aihq:core:run-result:1.2.0",
  "urn:aihq:core:trust-custody:1.0.0"
]);
export function describeContract(contract) {
  const prefix = '@aihq/core/fixtures/' + contract.id.slice(9).replaceAll(':', '/');
  const fixtures = [{ export: prefix + '/refuse.json', expect: 'refuse', code: 'INPUT_INVALID' }];
  if (accepting.has(contract.id)) fixtures.unshift({ export: prefix + '/accept.json', expect: 'accept' });
  if (contract.id.startsWith('urn:aihq:core:execution-policy:')) fixtures.push({
    export: '@aihq/core/fixtures/core/execution-policy/2.0.0/refuse.json', expect: 'refuse', code: 'SCHEMA_UNSUPPORTED'
  });
  // Execution policy 1.4.0 also publishes the exact git material source and a moving reference it refuses.
  if (contract.id === 'urn:aihq:core:execution-policy:1.4.0') fixtures.push(
    { export: prefix + '/git-source-accept.json', expect: 'accept' },
    { export: prefix + '/git-source-refuse.json', expect: 'refuse', code: 'INPUT_INVALID' });
  return Object.freeze({ ...contract, versions: Object.freeze([contract.id.split(':').at(-1)]), fixtures: Object.freeze(fixtures.map(Object.freeze)) });
}
