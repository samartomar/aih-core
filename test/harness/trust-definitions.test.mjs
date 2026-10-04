import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { trustRepairIndex, trustLimits, buildTrustCapabilities, validateRepairDefinition11, validateTrustCapabilities,
  selectTrustCell, selectRepairDefinition, buildTrustDefinitions, buildCertificateExportRecipe, resolveTrustRecipeRef, trustTransformIds, trustAdapters,
  exportAdmissionTemplate } from '../../src/harness/trust-definitions.mjs';
import { userToolsRepair } from '../../src/harness/user-trust-definitions.mjs';
import { jvmRepair } from '../../src/harness/jvm-trust-definitions.mjs';

const schema = name => JSON.parse(readFileSync(new URL(`../../src/harness/schemas/${name}.json`, import.meta.url), 'utf8'));
const pkg = { name: '@aihq/core', version: '1.0.0-test' };

test('every shipped 1.1 definition validates structurally and against the published schema', () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema('repair/1.1.0'));
  assert.deepEqual(trustRepairIndex.map(item => item.id), ['node-npm-ca', 'user-tools-ca', 'jvm-ca', 'certificate-export']);
  for (const definition of trustRepairIndex) {
    const result = validateRepairDefinition11(definition);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    assert.equal(validate(definition), true, JSON.stringify(validate.errors));
    assert.ok(definition.variants.length >= 1 && definition.variants.length <= 512);
    assert.deepEqual(definition.trustLimits, trustLimits);
  }
});

test('file variants preserve the 1.0 recipe identities, bindings and management identities', () => {
  const user = trustRepairIndex.find(item => item.id === 'user-tools-ca');
  assert.equal(user.managementId, 'user-tools-trust');
  const userFile = user.variants.filter(v => v.route === 'file');
  assert.deepEqual(userFile.map(v => v.recipeRef), userToolsRepair.variants.map(v => v.recipeRef));
  assert.deepEqual(userFile.map(v => v.configFiles), userToolsRepair.variants.map(v => v.configFiles));
  assert.equal(user.variants.length, userToolsRepair.variants.length * 2);
  assert.equal(Object.hasOwn(user.inputs, 'caFile'), false);
  const jvm = trustRepairIndex.find(item => item.id === 'jvm-ca');
  assert.deepEqual(jvm.variants.filter(v => v.route === 'file').map(v => v.recipeRef), jvmRepair.variants.map(v => v.recipeRef));
  assert.deepEqual(Object.keys(jvm.inputs), ['baselineStore']);
  assert.ok(jvm.variants.filter(v => v.route === 'file').every(v => v.inputIds.join() === 'baselineStore'));
  assert.ok(jvm.variants.filter(v => v.route === 'native').every(v => v.inputIds.length === 0 && v.capabilityIds.length === 0));
  const node = trustRepairIndex.find(item => item.id === 'node-npm-ca');
  assert.equal(node.managementId, 'node-npm-trust');
  assert.ok(node.variants.every(v => v.capabilityIds.length === 0 && ['file', 'native'].includes(v.route)));
  assert.ok(trustRepairIndex.filter(item => item.id !== 'certificate-export').every(item =>
    item.variants.some(v => v.route === 'native') && item.variants.every(v => v.route === 'native' ? v.adapterId === 'repair-native-v1' : true)));
});

test('export definition has null identities, empty targets and one variant per OS/network', () => {
  const exported = trustRepairIndex.find(item => item.id === 'certificate-export');
  assert.equal(exported.managementId, null); assert.equal(exported.materialName, null);
  assert.deepEqual(exported.targets, []);
  assert.equal(exported.variants.length, 6);
  assert.ok(exported.variants.every(v => v.route === 'export' && v.targets.length === 0));
});

test('strict validation rejects unknown keys, duplicates, candidate and unresolvable adapters', () => {
  const base = structuredClone(trustRepairIndex[0]);
  assert.equal(validateRepairDefinition11({ ...base, extra: 1 }).valid, false);
  const duplicate = structuredClone(base); duplicate.variants.push(structuredClone(duplicate.variants[0]));
  assert.ok(validateRepairDefinition11(duplicate).diagnostics.some(d => d.reason === 'variant-duplicate'));
  const candidate = structuredClone(base); candidate.variants[0].candidate = 'system-ca';
  assert.equal(validateRepairDefinition11(candidate).valid, false);
  const adapter = structuredClone(base); adapter.variants[0].adapterId = 'arbitrary-command';
  assert.ok(validateRepairDefinition11(adapter).diagnostics.some(d => d.reason === 'adapter-id'));
  const caFile = structuredClone(base); caFile.inputs.caFile = { type: 'file', required: true, description: 'x' };
  assert.equal(validateRepairDefinition11(caFile).valid, false);
  const limits = structuredClone(base); limits.trustLimits.derBytes += 1;
  assert.equal(validateRepairDefinition11(limits).valid, false);
  const jvm = structuredClone(trustRepairIndex[2]); jvm.variants[0].inputIds = [];
  assert.ok(validateRepairDefinition11(jvm).diagnostics.some(d => d.reason === 'input-ids'));
});

test('selection is by request schema, repair ID and definition schema; 1.0 stays reachable', () => {
  const request = 'urn:aihq:core:repair-request:1.0.0';
  const definition = 'urn:aihq:harness:repair:1.1.0';
  assert.equal(selectRepairDefinition({ requestSchema: request, repairId: 'jvm-ca', definitionSchema: definition }).schema, definition);
  assert.equal(selectRepairDefinition({ requestSchema: request, repairId: 'certificate-export', definitionSchema: definition }), undefined);
  assert.equal(selectRepairDefinition({ requestSchema: 'urn:aihq:core:certificate-export-request:1.0.0',
    repairId: 'certificate-export', definitionSchema: definition }).id, 'certificate-export');
  assert.equal(selectRepairDefinition({ requestSchema: undefined, repairId: 'node-npm-ca',
    definitionSchema: 'urn:aihq:harness:repair:1.0.0' }, [{ id: 'node-npm-ca' }]).id, 'node-npm-ca');
  assert.equal(selectRepairDefinition({ requestSchema: request, repairId: 'node-npm-ca', definitionSchema: 'urn:aihq:harness:repair:1.0.0' }), undefined);
});

test('empty admission metadata reports unavailable without inventing an admitted cell', () => {
  const capabilities = buildTrustCapabilities(pkg);
  assert.deepEqual(capabilities.cells, []);
  const none = buildTrustDefinitions([]);
  assert.equal(validateTrustCapabilities(capabilities, { package: pkg, definitions: none }).valid, true);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema('trust-capabilities/1.0.0'));
  assert.equal(validate(capabilities), true, JSON.stringify(validate.errors));
  const query = { definitionId: 'user-tools-ca', route: 'native', target: 'git', network: 'declared',
    platform: { os: 'win32', release: 'Windows 11 25H2', architecture: 'x64' } };
  assert.deepEqual(selectTrustCell(query, capabilities, none), { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'native-route-unsupported' });
  assert.equal(selectTrustCell({ ...query, route: 'file' }, capabilities, none).reason, 'file-route-unsupported');
  assert.equal(selectTrustCell({ definitionId: 'certificate-export', route: 'export', target: null, network: 'declared',
    format: 'pem', platform: query.platform }, capabilities, none).reason, 'trust-platform-unsupported');
});

const evidence = { reference: 'evidence/trust/a.json', sha256: 'a'.repeat(64), subjectSha256: 'b'.repeat(64) };
const exportCell = (format = 'pem', overrides = {}) => ({ ...exportAdmissionTemplate(format).cell, evidence, ...overrides });
const doc = cells => ({ schema: 'urn:aihq:harness:trust-capabilities:1.0.0', package: pkg, cells });
const reasons = (cells, options = {}) => validateTrustCapabilities(doc(cells), { package: pkg, definitions: buildTrustDefinitions(cells), ...options }).diagnostics.map(d => d.reason);

test('export admission cells validate against the tested matrix and fixed profiles; the template is staged, not admitted', () => {
  const both = [exportCell('pem'), exportCell('pkcs7-der')];
  assert.equal(validateTrustCapabilities(doc(both), { package: pkg, definitions: buildTrustDefinitions(both) }).valid, true);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema('trust-capabilities/1.0.0'));
  assert.equal(validate(doc([exportCell()])), true, JSON.stringify(validate.errors));
  const template = exportAdmissionTemplate('pkcs7-der');
  assert.equal(template.cell.client, null); assert.equal(template.cell.launchContext, 'no-client');
  assert.ok(template.requiredCases.some(item => item.id === 'p7b-custom-store-import' && item.kind === 'positive'));
  assert.deepEqual(new Set(template.requiredCases.map(item => item.kind)), new Set(['positive', 'negative', 'persistence']));
  assert.deepEqual(template.requiredLimitations, ['no-os-fullset-claim', 'no-native-client-claim']);
  assert.equal(exportAdmissionTemplate('pem').requiredCases.some(item => item.id.includes('custom-store')), false);
  assert.equal(exportAdmissionTemplate('jks'), undefined);
});

test('malformed or caller-asserted cells cannot enter: profiles, tuples, platform, projection, client and identity are exact', () => {
  assert.ok(reasons([exportCell('pem', { configurationProfile: 'made-up-v1' })]).includes('profile-unknown'));
  assert.ok(reasons([exportCell('pem', { probeProfile: 'export-p7b-parse-v1' })]).includes('profile-unknown'));
  assert.ok(reasons([exportCell('pem', { probeProfile: 'constructor' })]).includes('profile-unknown'));
  assert.ok(reasons([exportCell('pem', { configurationProfile: '__proto__' })]).includes('profile-unknown'));
  const nativeGit = { ...exportCell(), id: 'native-git', definitionId: 'user-tools-ca', route: 'native', target: 'git',
    client: { version: '2', build: 'b', backend: 'schannel', backendVersion: '10', applicationId: null }, launchContext: 'fresh-cli-user-home' };
  assert.ok(reasons([nativeGit]).includes('profile-unknown'));
  assert.ok(reasons([exportCell('pem', { platform: { os: 'win32', release: 'Windows 10', architecture: 'x64' } })]).includes('platform'));
  assert.ok(reasons([exportCell('pem', { projection: 'macos-effective-server-auth-v1' })]).includes('projection'));
  assert.ok(reasons([exportCell('pem', { route: 'file' })]).includes('route'));
  assert.ok(reasons([exportCell('pem', { target: 'git' })]).includes('target'));
  assert.ok(reasons([exportCell('pem', { client: { version: '1', build: 'b', backend: 'x', backendVersion: '1', applicationId: null } })]).includes('export-cell'));
  assert.ok(reasons([exportCell('pem', { launchContext: 'named-application' })]).includes('export-cell'));
  assert.ok(reasons([exportCell('pem', { definitionId: 'unknown' })]).includes('definition-id'));
  assert.ok(reasons([exportCell('pem', { extra: true })]).includes('unknown-field'));
  assert.ok(reasons([exportCell('pem', { evidence: { ...evidence, reference: '../x' } })]).includes('evidence'));
  assert.ok(reasons([exportCell('pem', { evidence: { ...evidence, sha256: 'A'.repeat(64) } })]).includes('evidence'));
  assert.ok(reasons([exportCell('pem'), exportCell('pem', { id: 'second' })]).includes('cell-ambiguous'));
  assert.ok(reasons([exportCell('pem'), exportCell('pem')]).includes('cell-id'));
  assert.equal(validateTrustCapabilities({ ...doc([exportCell()]), package: { name: '@aihq/core', version: 'other' } }, { package: pkg, definitions: buildTrustDefinitions([exportCell()]) }).valid, false);
  assert.equal(validateTrustCapabilities({ ...doc([exportCell()]), extra: 1 }, { package: pkg, definitions: buildTrustDefinitions([exportCell()]) }).valid, false);
});

test('selection finds exactly one admitted export cell per platform, network and format profile', () => {
  const capabilities = doc([exportCell('pem')]);
  const definitions = buildTrustDefinitions(capabilities.cells);
  const query = { definitionId: 'certificate-export', route: 'export', target: null, network: 'declared', format: 'pem',
    platform: { os: 'win32', release: 'Windows 11 25H2', architecture: 'x64' } };
  assert.equal(selectTrustCell(query, capabilities, definitions).status, 'admitted');
  assert.equal(selectTrustCell({ ...query, format: 'pkcs7-der' }, capabilities, definitions).status, 'unavailable');
  assert.equal(selectTrustCell({ ...query, network: 'off' }, capabilities, definitions).status, 'unavailable');
  assert.equal(selectTrustCell({ ...query, format: 'jks' }, capabilities, definitions).reason, 'trust-format-unavailable');
  assert.equal(selectTrustCell(query, doc([exportCell('pem'), exportCell('pem', { id: 'two', launchContext: 'no-client' })]), buildTrustDefinitions([exportCell('pem'), exportCell('pem', { id: 'two' })])).status, 'unavailable');
});

test('a variant capability must match its definition, route, target, platform and network', () => {
  const capabilities = doc([exportCell('pem')]);
  const definition = structuredClone(trustRepairIndex[3]);
  const variant = { ...definition.variants.find(v => v.os === 'win32' && v.network === 'declared'), capabilityIds: [capabilities.cells[0].id] };
  definition.variants = [variant];
  assert.equal(validateRepairDefinition11(definition, { capabilities }).valid, true);
  definition.variants = [{ ...variant, os: 'linux', recipeRef: 'certificate-export/linux/declared' }];
  assert.equal(validateRepairDefinition11(definition, { capabilities }).valid, false);
  definition.variants = [{ ...variant, network: 'off', recipeRef: 'certificate-export/win32/off' }];
  assert.equal(validateRepairDefinition11(definition, { capabilities }).valid, false);
  definition.variants = [{ ...variant, capabilityIds: ['missing'] }];
  assert.equal(validateRepairDefinition11(definition, { capabilities }).valid, false);
});

test('every adapter, recipe and transform reference resolves to a fixed implementation of the right kind', () => {
  for (const definition of trustRepairIndex) {
    assert.equal(validateRepairDefinition11(definition).valid, true);
    for (const variant of definition.variants) {
      const resolved = resolveTrustRecipeRef(variant.recipeRef);
      assert.equal(resolved.definitionId, definition.id);
      assert.equal(resolved.kind, { file: 'shipped', native: 'native-unavailable', export: 'export-generator' }[variant.route]);
      assert.ok(trustTransformIds.includes(variant.transformId));
      assert.ok(trustAdapters.some(adapter => adapter.id === variant.adapterId));
    }
  }
  assert.equal(resolveTrustRecipeRef('node-npm-ca/win32/node/declared/native/extra'), undefined);
  const tamper = field => { const copy = structuredClone(trustRepairIndex[1]); Object.assign(copy.variants[0], field); return validateRepairDefinition11(copy).diagnostics.map(d => d.reason); };
  assert.ok(tamper({ recipeRef: 'user-tools-ca/nowhere' }).includes('recipe-ref'));
  assert.ok(tamper({ recipeRef: 'node-npm-ca/win32/node/declared' }).includes('recipe-ref'));
  assert.ok(tamper({ transformId: 'node-npm-ca-bindings' }).includes('transform-id'));
  assert.ok(tamper({ adapterId: 'repair-native-v1' }).includes('adapter-id'));
  assert.ok(tamper({ route: 'native' }).includes('recipe-ref'));
});

test('export recipe is a genuine one-write recipe 1.0 with a digest check on the same target', () => {
  const recipe = buildCertificateExportRecipe({ materialId: 'export-material', materialPath: '/tmp/m', outputSegments: ['.aih', 'exports', 'os-ca.pem'],
    sha256: 'c'.repeat(64), byteLength: 10 });
  assert.equal(recipe.schema, 'urn:aihq:core:recipe:1.0.0');
  assert.equal(recipe.operations[0].id, 'write-ca');
  assert.equal(recipe.operations[0].material, 'export-material');
  assert.deepEqual(recipe.checks[0].target, recipe.operations[0].target);
  assert.equal(recipe.checks[0].id, 'export-digest');
  assert.deepEqual(recipe.materials[0].source, { kind: 'local', input: 'generated-export' });
});
