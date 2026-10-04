import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustRepairIndex, buildTrustCapabilities, buildTrustDefinitions, selectTrustCell, validateTrustCapabilities,
  validateRepairDefinition11, getTrustFileIntegration } from '../../src/harness/trust-definitions.mjs';
import { trustCellRecords } from '../../src/harness/trust-capabilities.mjs';
import * as trust from '../../src/harness/trust.mjs';

const pkg = { name: '@aihq/core', version: '1.0.0-test' };
const capabilities = buildTrustCapabilities(pkg, trustCellRecords);
const windows = { os: 'win32', release: 'Windows 11 25H2', architecture: 'x64' };
const exportQuery = (format, network, platform = windows) => ({ definitionId: 'certificate-export', route: 'export', target: null, network, format, platform });
const exportDefinition = trustRepairIndex.find(item => item.id === 'certificate-export');

test('admitted Windows export cells are named by exactly the matching export variants', () => {
  assert.ok(trustCellRecords.length > 0);
  for (const variant of exportDefinition.variants) {
    const expected = variant.os === 'win32'
      ? trustCellRecords.filter(cell => cell.network === variant.network).map(cell => cell.id).sort() : [];
    assert.deepEqual([...variant.capabilityIds].sort(), expected, `${variant.os}/${variant.network}`);
  }
  assert.equal(exportDefinition.variants.find(v => v.os === 'win32' && v.network === 'declared').capabilityIds.length, 2);
});

test('no repair variant, native or file, names an admitted cell', () => {
  for (const definition of trustRepairIndex.filter(item => item.id !== 'certificate-export'))
    assert.ok(definition.variants.every(variant => variant.capabilityIds.length === 0), definition.id);
  for (const target of ['node', 'git', 'gradle']) {
    for (const route of ['native', 'file']) {
      const id = target === 'node' ? 'node-npm-ca' : target === 'git' ? 'user-tools-ca' : 'jvm-ca';
      assert.equal(selectTrustCell({ definitionId: id, route, target, network: 'declared', platform: windows }, capabilities).status, 'unavailable');
    }
  }
});

test('selection requires the chosen variant to name the matching cell', () => {
  for (const [format, network] of [['pem', 'declared'], ['pem', 'off'], ['pkcs7-der', 'declared'], ['pkcs7-der', 'off']]) {
    const selected = selectTrustCell(exportQuery(format, network), capabilities);
    assert.equal(selected.status, 'admitted', `${format}/${network}`);
    assert.equal(selected.cell.id, `export-${format === 'pem' ? 'pem' : 'p7b'}-win32-${network}`);
  }
  // The same tuple matches a cell, but a definition set whose variant does not name it must not admit it.
  const unassociated = buildTrustDefinitions([]);
  const rejected = selectTrustCell(exportQuery('pem', 'declared'), capabilities, unassociated);
  assert.equal(rejected.status, 'unavailable');
  assert.equal(rejected.code, 'PREREQUISITE_UNAVAILABLE');
  assert.equal(rejected.reason, 'trust-configuration-unavailable');
  // Other platforms, formats and routes stay unavailable; nothing is inferred from the Windows cells.
  assert.equal(selectTrustCell(exportQuery('pem', 'declared', { os: 'linux', release: 'Ubuntu 24.04 LTS', architecture: 'x64' }), capabilities).status, 'unavailable');
  assert.equal(selectTrustCell(exportQuery('pem', 'declared', { os: 'darwin', release: 'macOS 26', architecture: 'arm64' }), capabilities).status, 'unavailable');
  assert.equal(selectTrustCell({ ...exportQuery('pem', 'declared'), route: 'native' }, capabilities).reason, 'native-route-unsupported');
});

test('package admission rejects a cell its definition variants do not name', () => {
  assert.equal(validateTrustCapabilities(capabilities, { package: pkg }).valid, true);
  const orphan = { ...trustCellRecords[0], id: 'export-pem-win32-orphan' };
  const diagnostics = validateTrustCapabilities(buildTrustCapabilities(pkg, [...trustCellRecords, orphan]), { package: pkg }).diagnostics;
  assert.ok(diagnostics.some(item => item.reason === 'cell-unassociated'), JSON.stringify(diagnostics));
  const missing = trustCellRecords.slice(1);
  assert.ok(validateTrustCapabilities(buildTrustCapabilities(pkg, missing), { package: pkg }).diagnostics.some(item => item.reason === 'cell-unassociated'));
});

test('definitions validate against the shipped capabilities, and association follows the cells', () => {
  for (const definition of trustRepairIndex) assert.equal(validateRepairDefinition11(definition, { capabilities }).valid, true, definition.id);
  const bare = buildTrustDefinitions([]).find(item => item.id === 'certificate-export');
  assert.ok(bare.variants.every(variant => variant.capabilityIds.length === 0));
  assert.equal(validateRepairDefinition11(exportDefinition, { capabilities: buildTrustCapabilities(pkg, []) }).valid, false);
});

test('file integration is supplied-file PEM for Node/npm only; everything else is truthfully unavailable', () => {
  assert.deepEqual(getTrustFileIntegration('node-npm-ca', ['node']), { status: 'supported', format: 'pem', includeNodeBundled: false });
  assert.deepEqual(getTrustFileIntegration('node-npm-ca', ['npm']), { status: 'supported', format: 'pem', includeNodeBundled: true });
  assert.deepEqual(getTrustFileIntegration('node-npm-ca', ['node', 'npm']), { status: 'supported', format: 'pem', includeNodeBundled: true });
  const unavailable = { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'file-route-unsupported' };
  for (const [id, targets] of [['user-tools-ca', ['git']], ['jvm-ca', ['maven']], ['certificate-export', []], ['unknown', ['node']],
    ['node-npm-ca', []], ['node-npm-ca', ['git']], ['node-npm-ca', ['node', 'node']], ['node-npm-ca', 'node'], ['node-npm-ca', undefined], ['__proto__', ['node']]])
    assert.deepEqual(getTrustFileIntegration(id, targets), unavailable, `${id} ${JSON.stringify(targets)}`);
  assert.equal(trust.getTrustFileIntegration, getTrustFileIntegration);
});
