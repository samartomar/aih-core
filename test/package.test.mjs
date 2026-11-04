import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build, stop } from 'esbuild';

// Exactly four package entries (contract 3, C32), each with its exact public names. Adding or removing a name, from
// both the JavaScript and the declarations, must update these lists deliberately.
const expectedRuntimeNames = {
  '@aihq/core': ['apply', 'checkFiles', 'inspect', 'list', 'prepare', 'prepareRemoval', 'prepareUpdate', 'resolveStateLocation',
    'verifyClient', 'verifyMacosSession', 'writeSupportReport'],
  '@aihq/core/contracts': ['CLAIMS_SCHEMA', 'REPORT_SCHEMA', 'checkContracts', 'contractSupport', 'createReport', 'deriveChangeIdentity',
    'exportSnapshot', 'getGuidance', 'importSnapshot', 'limits', 'previewAdmission', 'projectClaims', 'readClaimSet', 'refusalCodes',
    'removalClaims', 'renderSupportMarkdown', 'runMemberClaims', 'schemas', 'stateLocation', 'validateChange', 'validateClaimSet',
    'validateFormat', 'validateOrganizationPolicy', 'validateSnapshot'],
  '@aihq/core/harness': ['consumerProfiles', 'exportDefaultNames', 'listTools', 'macosSessionProfiles', 'nativeClientDefinitions',
    'repairIndex', 'selectTool', 'signerRecords', 'targets', 'toolRegistry', 'trustCapabilities', 'trustLimits', 'trustPlatformMatrix',
    'validateNativeTestIdentity', 'validateNativeVerificationDefinition', 'validateToolRegistry'],
  '@aihq/core/harness/runtime': ['detectProjectFacts', 'diagnose', 'discoverTrustSources', 'hashTrustSourceSet', 'inspectToolHost', 'inspectUserToolTrust',
    'parseTrustOutput', 'readGitHubPolicy', 'readLocalPolicy', 'reviewTrustDelta', 'serializeTrustSet']
};
// Contract 4: every format, each at 0.1.0, with one schema and one valid and one invalid fixture.
const expectedFormats = ['change', 'change-request', 'claims', 'export-inputs', 'export-request', 'file-check', 'inspection', 'inventory',
  'macos-session-custody', 'macos-session-inputs', 'macos-session-profiles', 'macos-session-request', 'macos-session-verification-request',
  'macos-session-verification-result', 'native-test-identity', 'native-verification-bundle', 'native-verification-definition',
  'native-verification-request', 'native-verification-result', 'organization', 'package-support', 'plan-request', 'receipt', 'repair',
  'repair-inputs', 'repair-request', 'report', 'review', 'run', 'signer-records', 'tool-registry', 'trust-capabilities', 'trust-custody']
  .map(name => `urn:aihq:core:${name}:0.1.0`).sort();
// Contract 17: nothing removed can be imported from any entry.
const retiredNames = ['renderDelivery', 'renderSelectionDelivery', 'checkCompatibility', 'deliveryMaterialRoot', 'toolBindings',
  'selectBindingCell', 'deriveCellSupport', 'deriveRecipeIdentity', 'recipeOperationKinds', 'authenticateEvidence', 'associateEvidence',
  'verificationKeys', 'verificationPublishers', 'selectVerificationKeys', 'selectVerificationPublishers', 'createTufTrustClient',
  'getTrustSnapshot', 'getVerificationTrust', 'getCatalogIndexTrust', 'getCurrentTrustStatus', 'verifyNativeClient', 'nativeClientIds',
  'nativeVerificationDefinitions', 'parsePolicy', 'validatePolicy', 'validateRecipe', 'validateOrganizationTarget', 'parseOrganizationPolicy',
  'checkFileState', 'listManagedSelections', 'prepareManagedRemoval', 'validateFileStateResult', 'validatePackageSupport',
  'previewOrganizationAdmission', 'previewOrganizationContent', 'previewOrganizationObligations', 'macosRepairIndex'];
const retiredSpecifiers = ['@aihq/core/support', '@aihq/core/report', '@aihq/core/report/schema', '@aihq/core/schemas/recipe/1.0.0.json',
  '@aihq/core/schemas/execution-policy/1.4.0.json', '@aihq/core/fixtures/core/execution-policy/1.0.0/accept.json',
  '@aihq/core/harness/schemas/repair/1.0.0.json', '@aihq/core/harness/run-records/macos-session-not-admitted.json',
  '@aihq/core/dist/core/engine-api.js', '@aihq/core/package.json'];

test('one Core artifact publishes exactly four entries, one schema per format, and repairs with a versioned Harness update', async () => {
  assert.ok(process.env.npm_execpath, 'Run this acceptance with npm test so its npm CLI is known.');
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-core-package-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  const home = join(root, 'home'), project = join(root, 'target'), consumer = join(root, 'consumer');
  for (const path of [home, project, consumer]) mkdirSync(path);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // npm 11 refuses this inherited setting on installs; fixture installs and packs explicitly disable lifecycle scripts below.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  // A separate test invocation must not inherit Node's parent-test marker, which would silently skip its test files.
  delete env.NODE_TEST_CONTEXT;
  const npm = (args, cwd, timeout = 120_000) => {
    const started = Date.now();
    try {
      const output = execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, encoding: 'utf8', timeout, windowsHide: true });
      console.log(`Package fixture command took ${Date.now() - started} ms of ${timeout} ms:`, args.join(' '));
      return output;
    } catch (error) {
      console.error(`Package fixture command failed after ${Date.now() - started} ms of ${timeout} ms:`, args.join(' '));
      console.error(String(error.stdout ?? '').slice(-12_000));
      console.error(String(error.stderr ?? '').slice(-4_000));
      throw error;
    }
  };
  const pack = cwd => JSON.parse(execFileSync(process.execPath, [join(cwd, 'scripts/pack-distribution.mjs'), '--pack-destination', root],
    { cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true }))[0];
  const install = packed => {
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'outside-consumer', private: true, type: 'module',
      dependencies: { '@aihq/core': `file:${join(root, packed.filename)}` } }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer, 300_000);
  };
  const run = (file, extraEnv = {}, timeout = 30_000) => execFileSync(process.execPath, [file],
    { cwd: consumer, env: { ...env, TEST_PROJECT: project, ...extraEnv }, encoding: 'utf8', timeout, windowsHide: true });
  let failure;
  try {
    const packed = pack(packageRoot);
    for (const entry of packed.files) {
      // Bundled dependency sources are part of their reviewed package bytes. Product sources and private notes stay out.
      assert.equal(/^(?:src|test|ai-harness)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|\.scratch)(?:\/|$)/.test(entry.path), false, entry.path);
      assert.ok(/^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|NOTICE|docs\/(?:(?:native-(?:windows|linux)-verification|native-persistence-diagnostics|macos-session-development)\.md|reporting\/(?:CONTRACT|FIELDS|REPRODUCE)\.md)|examples\/reporting\/[A-Za-z0-9._/-]+|node_modules\/(?:@sigstore\/(?:verify|core|bundle|protobuf-specs)|pkijs|asn1js|bytestreamjs|pvutils|pvtsutils|tslib|@noble\/hashes|@anthropic-ai\/sandbox-runtime|@pondwader\/socks5-server|commander|node-forge|zod)\/.*|dist\/.*)$/.test(entry.path), entry.path);
      // Retired modules are not shipped at all (contract 17).
      assert.equal(/^node_modules\/(?:tuf-js|@tufjs)\/|^dist\/harness\/(?:trust-update|delivery|verification-publishers|scan-trust)\.(?:mjs|d\.mts)$|^dist\/core\/internal\/recipeless\.js$|^examples\/templates\/|^docs\/(?:templates|editor-content-candidates)\.md$/.test(entry.path), false, entry.path);
    }
    for (const path of ['dist/harness/native/linux/facility', 'dist/harness/native/linux/facility.c', 'dist/harness/native/linux/build-record.json',
      'dist/harness/native/linux/interop-canary.cs', 'dist/harness/native/linux/interop-canary.exe', 'dist/harness/native/linux/interop-build-record.json',
      'dist/harness/native/linux/runtime-lock.json', 'dist/harness/native/linux/runtime-platform.json', 'dist/harness/native/linux/observer-lock.json',
      'docs/native-linux-verification.md', 'node_modules/@anthropic-ai/sandbox-runtime/package.json', 'node_modules/@pondwader/socks5-server/package.json',
      'node_modules/commander/package.json', 'node_modules/node-forge/package.json', 'node_modules/zod/package.json',
      ...['verify', 'core', 'bundle', 'protobuf-specs'].map(name => `node_modules/@sigstore/${name}/package.json`)])
      assert.ok(packed.files.some(entry => entry.path === path), `The published artifact must carry ${path}.`);
    // The cryptography tree must come from the selected artifact, even without registry access.
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    install(packed);
    const installed = join(consumer, 'node_modules/@aihq/core');
    if (process.platform === 'linux') {
      const { linuxSafePath, createLinuxBaseProfile } = await import(pathToFileURL(join(installed, 'dist/harness/native/linux-profile.mjs')).href);
      const workload = realpathSync(join(installed, 'dist/harness/native/linux-workload.mjs'));
      const facility = realpathSync(join(installed, 'dist/harness/native/linux/facility'));
      assert.equal(linuxSafePath(workload), true);
      assert.equal(linuxSafePath(facility), true);
      const cell = join(root, 'linux-cell');
      const profile = createLinuxBaseProfile({
        cell: { path: cell, home: `${cell}/home`, project: `${cell}/project`, scratch: `${cell}/scratch`, observations: `${cell}/observations` },
        runtime: { node: process.execPath, client: process.execPath, bash: '/usr/bin/bash', env: '/usr/bin/env',
          bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', rg: '/usr/bin/rg', libraries: [], readFiles: [facility] },
        workload, plan: `${cell}/observations/workload.json`, selectedPaths: [`${cell}/project/CLAUDE.md`]
      });
      for (const path of [workload, facility]) assert.equal(profile.filesystem.allowRead.includes(path), true);
    }

    // Journey 13: exactly the four entries and the two bins.
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.exports), ['.', './contracts', './harness', './harness/runtime']);
    assert.deepEqual(manifest.bin, { aih: 'dist/core/cli.js', 'aih-linux-facility': 'dist/harness/native/linux/facility' });
    assert.equal(manifest.dependencies['tuf-js'], undefined);
    assert.deepEqual(manifest.peerDependenciesMeta, { '@aihq/scan': { optional: true } });
    const codeEntries = Object.entries(manifest.exports).map(([key, target]) =>
      ({ specifier: `@aihq/core${key.slice(1)}`, types: readFileSync(join(installed, target.types), 'utf8') }));
    for (const { specifier, types } of codeEntries)
      assert.doesNotMatch(types, /\bexport type \*/, `${specifier} must list its type exports explicitly.`);
    writeFileSync(join(consumer, 'export-names.mjs'), `
      const names = {};
      for (const specifier of ${JSON.stringify(codeEntries.map(entry => entry.specifier))}) names[specifier] = Object.keys(await import(specifier)).sort();
      const retired = {};
      for (const specifier of ${JSON.stringify(retiredSpecifiers)}) {
        try { await import(specifier, specifier.endsWith('.json') ? { with: { type: 'json' } } : undefined); retired[specifier] = 'imported'; }
        catch (error) { retired[specifier] = error.code; }
      }
      process.stdout.write(JSON.stringify({ names, retired }));
    `);
    const { names: runtimeNames, retired } = JSON.parse(run('export-names.mjs'));
    assert.deepEqual(runtimeNames, expectedRuntimeNames);
    for (const name of retiredNames) for (const [specifier, names] of Object.entries(runtimeNames))
      assert.equal(names.includes(name), false, `${specifier} ${name}`);
    for (const [specifier, code] of Object.entries(retired)) assert.equal(code, 'ERR_PACKAGE_PATH_NOT_EXPORTED', specifier);
    // Every value an entry declares exists at runtime and every runtime value is declared; key public types compile.
    writeFileSync(join(consumer, 'export-parity.mts'), codeEntries.map(({ specifier }, index) => {
      const names = runtimeNames[specifier].map(name => JSON.stringify(name)).join(' | ') || 'never';
      return `import * as entry${index} from '${specifier}';
        type Runtime${index} = ${names};
        const undeclared${index}: [Exclude<Runtime${index}, keyof typeof entry${index}>] extends [never] ? 'agree' :
          { entry: '${specifier}'; undeclared: Exclude<Runtime${index}, keyof typeof entry${index}> } = 'agree';
        const absent${index}: [Exclude<keyof typeof entry${index}, Runtime${index}>] extends [never] ? 'agree' :
          { entry: '${specifier}'; absentAtRuntime: Exclude<keyof typeof entry${index}, Runtime${index}> } = 'agree';`;
    }).join('\n'));
    writeFileSync(join(consumer, 'contracts.mts'), `
      import { prepare, apply, list, prepareRemoval, prepareUpdate, checkFiles, inspect, verifyClient, verifyMacosSession, resolveStateLocation } from '@aihq/core';
      import type { PlanRequest, PlanControls, PlanPreparation, Review, Run, Approval, Inventory, ListResult, RemovalResult, UpdateResult,
        ChangeRequest, RepairRequest, ExportRequest, MacosSessionRequest, EnvironmentRequest, InspectionResult, NativeVerificationRequest,
        NativeVerificationResult, FileCheckResult, ResolvedStateLocation, SupportReportResult, ReportFileResult } from '@aihq/core';
      import { schemas, validateFormat, refusalCodes, limits, contractSupport, checkContracts, validateChange, deriveChangeIdentity,
        validateOrganizationPolicy, previewAdmission, stateLocation, getGuidance, createReport } from '@aihq/core/contracts';
      import type { FormatResult, RefusalCode, Limit, Change, PackageSupport, SupportedContract, Organization, StateLocation } from '@aihq/core/contracts';
      import { repairIndex, trustCapabilities, toolRegistry, selectTool, signerRecords, nativeClientDefinitions } from '@aihq/core/harness';
      import type { RepairDefinition, TrustCapabilities, RegistryTool, SignerRecords, NativeClientDefinition } from '@aihq/core/harness';
      import { diagnose, readLocalPolicy, discoverTrustSources } from '@aihq/core/harness/runtime';
      import type { DiagnoseResult, ReadLocalPolicyResult } from '@aihq/core/harness/runtime';
      const repairSchema: 'urn:aihq:core:repair:0.1.0' = repairIndex[0]!.schema;
      const capabilities: 'urn:aihq:core:trust-capabilities:0.1.0' = trustCapabilities.schema;
      const support: 'urn:aihq:core:package-support:0.1.0' = contractSupport.schema;
      const result: FormatResult = validateFormat({});
      const request: RepairRequest = { schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'node-npm-ca', targets: ['npm'] };
      const preparation: Promise<PlanPreparation> = prepare(request);
      // @ts-expect-error An execution policy is not a request this Core reads.
      const policy: PlanRequest = { schema: 'urn:aihq:core:execution-policy:1.0.0' };
      // @ts-expect-error Host controls and Node operations are not part of the portable entry.
      import { prepare as portablePrepare } from '@aihq/core/contracts';
      // @ts-expect-error Retired Catalog renderers are not published.
      import { renderDelivery } from '@aihq/core/harness';
      void [apply, list, prepareRemoval, prepareUpdate, checkFiles, inspect, verifyClient, verifyMacosSession, resolveStateLocation, schemas,
        refusalCodes, limits, checkContracts, validateChange, deriveChangeIdentity, validateOrganizationPolicy, previewAdmission, stateLocation,
        getGuidance, createReport, toolRegistry, selectTool, signerRecords, nativeClientDefinitions, diagnose, readLocalPolicy, discoverTrustSources,
        repairSchema, capabilities, support, result, preparation, policy];
      export type Used = [PlanControls, Review, Run, Approval, Inventory, ListResult, RemovalResult, UpdateResult, ChangeRequest, ExportRequest,
        MacosSessionRequest, EnvironmentRequest, InspectionResult, NativeVerificationRequest, NativeVerificationResult, FileCheckResult,
        ResolvedStateLocation, SupportReportResult, ReportFileResult, RefusalCode, Limit, Change, PackageSupport, SupportedContract, Organization,
        StateLocation, RepairDefinition, TrustCapabilities, RegistryTool, SignerRecords, NativeClientDefinition, DiagnoseResult, ReadLocalPolicyResult];
    `);
    const compilerManifest = createRequire(import.meta.url).resolve('typescript/package.json');
    const compiler = join(dirname(compilerManifest), JSON.parse(readFileSync(compilerManifest, 'utf8')).bin.tsc);
    execFileSync(process.execPath, [compiler, '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2023', 'contracts.mts', 'export-parity.mts'], { cwd: consumer, env, encoding: 'utf8', timeout: 30_000, windowsHide: true });

    // One schema per format: every valid fixture reads `ok`, every invalid one `invalid`, by Core and by a strict JSON Schema reader.
    writeFileSync(join(consumer, 'formats.mjs'), `
      import assert from 'node:assert/strict';
      import { schemas, validateFormat, contractSupport, checkContracts } from '@aihq/core/contracts';
      import { repairIndex, trustCapabilities, macosSessionProfiles, toolRegistry, signerRecords, nativeClientDefinitions } from '@aihq/core/harness';
      import { Ajv2020 } from 'ajv/dist/2020.js';
      const ajv = new Ajv2020({ strict: true, strictTuples: false });
      for (const entry of Object.values(schemas)) ajv.addSchema(entry.schema);
      for (const [id, entry] of Object.entries(schemas)) {
        assert.equal(entry.schema.$id, id);
        assert.deepEqual(validateFormat(entry.fixtures.valid), { status: 'ok', schema: id }, id);
        assert.equal(validateFormat(entry.fixtures.invalid).status, 'invalid', id);
        assert.equal(ajv.validate(id, entry.fixtures.valid), true, id + JSON.stringify(ajv.errors));
        assert.equal(ajv.validate(id, entry.fixtures.invalid), false, id);
      }
      assert.equal(validateFormat({ schema: 'urn:aihq:core:execution-policy:1.0.0' }).status, 'unsupported-version');
      assert.equal(validateFormat({ schema: 'urn:aihq:core:ownership:1.7.0' }).status, 'unsupported-version');
      // The published data reads as its own format.
      for (const value of [...repairIndex, trustCapabilities, macosSessionProfiles, toolRegistry, signerRecords, contractSupport])
        assert.equal(validateFormat(value).status, 'ok', value.schema);
      assert.ok(repairIndex.every(definition => definition.managementId === definition.id));
      assert.deepEqual(repairIndex.map(definition => definition.id), ['node-npm-ca', 'node-os-trust', 'user-tools-ca', 'jvm-ca']);
      assert.ok(nativeClientDefinitions.length > 0);
      // Core's declaration names every format once and addresses its schema and fixtures in \`schemas\`.
      assert.deepEqual(contractSupport.contracts.map(item => item.id).sort(), Object.keys(schemas).sort());
      assert.deepEqual(contractSupport.entries.map(item => item.export), ['@aihq/core', '@aihq/core/contracts', '@aihq/core/harness', '@aihq/core/harness/runtime']);
      const load = (name, address) => {
        const [, id, part] = address.match(/^@aihq\\/core\\/contracts#schemas\\/([^/]+)\\/(.+)$/);
        const entry = schemas[id];
        return new TextEncoder().encode(JSON.stringify(part === 'fixtures/valid' ? entry.fixtures.valid : entry.fixtures.invalid));
      };
      const reader = { schema: 'urn:aihq:core:package-support:0.1.0', package: { name: 'reader', version: '0.1.0' }, entries: [],
        contracts: [{ id: 'urn:aihq:core:review:0.1.0', role: 'accepts', schemaExport: 'reader', versions: ['0.1.0'], fixtures: [] }] };
      const checked = await checkContracts({ declarations: [reader, contractSupport], loadFixture: load,
        readers: { 'urn:aihq:core:review:0.1.0': bytes => ({ accepted: validateFormat(JSON.parse(new TextDecoder().decode(bytes))).status === 'ok' }) } });
      assert.equal(checked.ok, true, JSON.stringify(checked));
      assert.equal(checked.checks.length, 2);
      console.log('formats ' + Object.keys(schemas).length);
    `);
    assert.match(run('formats.mjs'), new RegExp(`formats ${expectedFormats.length}`));
    writeFileSync(join(consumer, 'format-ids.mjs'), "import { schemas } from '@aihq/core/contracts'; process.stdout.write(JSON.stringify(Object.keys(schemas).sort()));");
    assert.deepEqual(JSON.parse(run('format-ids.mjs')), expectedFormats);

    // Native verification records, the verify-client CLI and its 0.1.0 result.
    writeFileSync(join(consumer, 'native-public.mjs'), `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { lstatSync, readFileSync, realpathSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      import { sep } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import { validateFormat } from '@aihq/core/contracts';
      import { nativeClientDefinitions, validateNativeVerificationDefinition } from '@aihq/core/harness';
      for (const definition of nativeClientDefinitions) {
        assert.equal(validateNativeVerificationDefinition(definition).valid, true);
        assert.equal(validateFormat(definition).status, 'ok');
      }
      const binary = fileURLToPath(new URL('./cli.js', import.meta.resolve('@aihq/core')));
      const nativeRoot = new URL('../harness/native/', import.meta.resolve('@aihq/core'));
      const record = JSON.parse(readFileSync(new URL('windows/build-record.json', nativeRoot), 'utf8'));
      assert.equal(record.protocol, 1);
      assert.deepEqual(record.resources.map(row => row.name).sort(), ['facility.cs', 'facility.exe']);
      for (const row of record.resources) {
        const bytes = readFileSync(new URL('windows/' + row.name, nativeRoot));
        assert.equal(bytes.length, row.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
      }
      const linuxRecord = JSON.parse(readFileSync(new URL('linux/build-record.json', nativeRoot), 'utf8'));
      assert.equal(linuxRecord.protocol, 1); assert.equal(linuxRecord.platform, 'linux-x64');
      assert.equal(linuxRecord.build.status, 'ci-reproduced'); assert.equal(linuxRecord.build.independentBuildVerified, true);
      assert.deepEqual(linuxRecord.resources.map(row => row.name).sort(), ['facility', 'facility.c']);
      const interopRecord = JSON.parse(readFileSync(new URL('linux/interop-build-record.json', nativeRoot), 'utf8'));
      assert.equal(interopRecord.purpose, 'synthetic-wsl-execution-canary');
      for (const row of [...linuxRecord.resources, ...interopRecord.resources]) {
        const bytes = readFileSync(new URL('linux/' + row.name, nativeRoot));
        assert.equal(bytes.length, row.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
      }
      const installedRoot = realpathSync.native(fileURLToPath(new URL('../../../', nativeRoot)));
      const { linuxObserverPins, linuxObserverSources } = await import(new URL('linux-sandbox.mjs', nativeRoot));
      const observer = linuxObserverPins(); assert.equal(observer.length, linuxObserverSources.length);
      for (const pin of observer) assert.ok(pin.path.startsWith(installedRoot + sep));
      const { verifyLinuxVendorClosure } = await import(new URL('linux-runtime.mjs', nativeRoot));
      const vendor = verifyLinuxVendorClosure(); assert.equal(vendor.status, 'ready');
      const vendorLock = JSON.parse(readFileSync(new URL('linux/runtime-lock.json', nativeRoot), 'utf8'));
      assert.equal(vendor.treeSha256, vendorLock.treeSha256);
      const nativeRuntime = await import(new URL('runtime.mjs', nativeRoot));
      const facility = await nativeRuntime.lifecycleAvailability('windows-job.v1', 'win32', { deadline: performance.now() + 5000 });
      assert.equal(facility.status, process.platform === 'win32' && process.arch === 'x64' ? 'available' : 'unavailable');
      const linuxFacility = await nativeRuntime.lifecycleAvailability('linux-srt.v1', 'linux', { deadline: performance.now() + 5000 });
      const linuxSupported = process.platform === 'linux' && process.arch === 'x64' && process.getuid() !== 0;
      assert.equal(linuxFacility.status, linuxSupported ? 'available' : 'unavailable', JSON.stringify(linuxFacility));
      if (linuxSupported) assert.notEqual(lstatSync(new URL('linux/facility', nativeRoot)).mode & 0o111, 0);
      // The CLI answers in the 0.1.0 result: refused off an admitted cell; on one, unverified without a test identity.
      const child = spawnSync(process.execPath, [binary, 'verify-client', 'claude', '--json'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      const result = JSON.parse(child.stdout);
      assert.equal(child.status, result.status === 'refused' ? 2 : 1, child.stderr);
      assert.ok(['refused', 'ok'].includes(result.status)); assert.equal(result.client.id, 'claude-code');
      assert.equal(result.verdict, 'unverified'); assert.equal(result.limits.sessionsStarted, 0);
      assert.deepEqual(validateFormat(result), { status: 'ok', schema: 'urn:aihq:core:native-verification-result:0.1.0' });
    `);
    run(join(consumer, 'native-public.mjs'));
    const coreRequire = createRequire(join(installed, 'package.json'));
    const verifierRequire = createRequire(coreRequire.resolve('@sigstore/verify'));
    const bundleRequire = createRequire(verifierRequire.resolve('@sigstore/bundle'));
    const installedVersion = (resolveFrom, name) => JSON.parse(readFileSync(join(dirname(resolveFrom.resolve(name)), '../package.json'), 'utf8')).version;
    for (const [name, expected] of Object.entries({ '@sigstore/verify': '4.1.2', '@sigstore/core': '4.0.1', '@sigstore/bundle': '5.0.0', '@sigstore/protobuf-specs': '0.5.0' })) {
      const resolveFrom = name === '@sigstore/verify' ? coreRequire : verifierRequire;
      assert.ok(resolveFrom.resolve(name).startsWith(join(installed, 'node_modules') + sep), `Bundled resolution of ${name}`);
      assert.equal(installedVersion(resolveFrom, name), expected, `Actual verifier resolution of ${name}`);
    }
    assert.equal(installedVersion(bundleRequire, '@sigstore/protobuf-specs'), '0.5.0');
    // The pinned Linux vendor closure resolves from the artifact's own bundled bytes.
    const srtRequire = createRequire(coreRequire.resolve('@anthropic-ai/sandbox-runtime/package.json'));
    const closureVersion = (resolveFrom, name) => {
      let directory = dirname(resolveFrom.resolve(name));
      for (let depth = 0; depth <= 8; depth += 1) {
        const candidate = join(directory, 'package.json');
        if (existsSync(candidate)) {
          const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
          if (parsed.name === name) return { root: directory, version: parsed.version };
        }
        const up = dirname(directory);
        if (up === directory) break;
        directory = up;
      }
      throw new Error(`Cannot locate the installed ${name} manifest`);
    };
    for (const [name, expected] of Object.entries({ '@anthropic-ai/sandbox-runtime': '0.0.78', '@pondwader/socks5-server': '1.0.10',
      commander: '12.1.0', 'node-forge': '1.4.0', zod: '3.25.76' })) {
      const found = closureVersion(name === '@anthropic-ai/sandbox-runtime' ? coreRequire : srtRequire, name);
      assert.ok(found.root.startsWith(join(installed, 'node_modules') + sep), `Bundled resolution of ${name}`);
      assert.equal(found.version, expected, `Actual Linux vendor closure resolution of ${name}`);
    }
    for (const name of ['@aihq/harness', '@aihq/scan', '@aihq/catalog', 'tuf-js']) assert.equal(existsSync(join(consumer, 'node_modules', name)), false, name);

    // Trust repairs and the certificate export through the public API and CLI.
    copyFileSync(new URL('./fixtures/root-a.pem', import.meta.url), join(consumer, 'ca.pem'));
    copyFileSync(new URL('./fixtures/trust-consumer.mjs', import.meta.url), join(consumer, 'trust-consumer.mjs'));
    const trustHome = join(root, 'trust-home'); mkdirSync(trustHome);
    assert.match(run('trust-consumer.mjs', { HOME: trustHome, USERPROFILE: trustHome }, 180_000), /packed trust public contracts passed/);
    // Installed support guidance interprets stored trust and macOS session results.
    const supportFixtures = join(consumer, 'support-fixtures'); mkdirSync(supportFixtures);
    for (const [directory, names] of [['trust-contracts', ['run-result-1.2-partial', 'run-result-1.2-stale', 'prepared-work-1.2-ready', 'prepared-work-1.2-partial']],
      ['macos-session', ['run-result-1.3-desktop', 'prepared-work-1.3-desktop']]])
      for (const name of names) copyFileSync(new URL(`./fixtures/${directory}/${name}.json`, import.meta.url), join(supportFixtures, `${name}.json`));
    copyFileSync(new URL('./fixtures/support-consumer.mjs', import.meta.url), join(consumer, 'support-consumer.mjs'));
    assert.match(run('support-consumer.mjs'), /packed support families passed/);

    // A change through the API: install, list, check, remove; then the same through the installed `aih` CLI.
    const change = target => ({ schema: 'urn:aihq:core:change-request:0.1.0', mode: 'vibe', scope: 'project', target: { project: target },
      changes: [{ managementId: 'team-guidance', inputs: {}, requires: [], change: { schema: 'urn:aihq:core:change:0.1.0', id: 'team-guidance',
        description: 'Deliver project guidance', inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [],
        operations: [{ id: 'write', purpose: 'Write project guidance', kind: 'file.write', scope: 'project',
          target: { root: 'project', segments: [{ literal: 'TEAM.md' }] }, content: { literal: "Read the project's contribution guide.\n" },
          requires: [], checks: [] }] } }] });
    writeFileSync(join(consumer, 'change.json'), JSON.stringify(change(project)));
    copyFileSync(new URL('./fixtures/plan-fixture.mjs', import.meta.url), join(consumer, 'plan-fixture.mjs'));
    writeFileSync(join(consumer, 'run.mjs'), `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { prepare, apply, list, prepareRemoval, checkFiles, inspect, writeSupportReport } from '@aihq/core';
      import { validateFormat, contractSupport } from '@aihq/core/contracts';
      import { repairIndex } from '@aihq/core/harness';
      import { diagnose } from '@aihq/core/harness/runtime';
      import { ownRequest } from './plan-fixture.mjs';
      const ok = (value, schema) => assert.deepEqual(validateFormat(value), { status: 'ok', schema });
      const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
      const project = process.env.TEST_PROJECT;
      const diagnostic = await diagnose({ requestId: 'packed-diagnostic', targets: ['node'], network: 'off' });
      assert.equal(diagnostic.status, 'completed');
      assert.equal(diagnostic.tools.find(tool => tool.id === 'node').state, 'runnable');
      const inspection = await inspect({ target: 'node', offline: true });
      ok(inspection, 'urn:aihq:core:inspection:0.1.0');
      assert.deepEqual(contractSupport.package, { name: '@aihq/core', version: ${JSON.stringify(version)} });
      assert.equal(typeof writeSupportReport, 'function');
      // An execution policy is not a request this Core reads.
      const older = await prepare({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.0.0' }, target: { project } });
      assert.equal(older.status, 'invalid');
      assert.deepEqual(await prepare({ schema: 'urn:aihq:core:execution-policy:1.4.0' }), { status: 'unsupported-version',
        encountered: 'urn:aihq:core:execution-policy:1.4.0', supported: ['urn:aihq:core:plan-request:0.1.0', 'urn:aihq:core:change-request:0.1.0',
          'urn:aihq:core:repair-request:0.1.0', 'urn:aihq:core:export-request:0.1.0', 'urn:aihq:core:macos-session-request:0.1.0'] });
      // Journey 1 (own content): plan, apply, list as chosen with no data, check files, remove.
      const planned = await prepare(ownRequest(project, { notes: { 'SKILL.md': '# Notes\\n' } }, ['claude-code']));
      assert.equal(planned.status, 'ready', JSON.stringify(planned)); ok(planned.review, 'urn:aihq:core:review:0.1.0');
      const installed = await apply(planned.handle, approve(planned.review));
      assert.equal(installed.completion, 'complete'); ok(installed, 'urn:aihq:core:run:0.1.0');
      const inventory = await list({ target: { project }, scope: 'project' });
      ok(inventory, 'urn:aihq:core:inventory:0.1.0');
      assert.deepEqual(inventory.entries.map(entry => [entry.managementId, entry.origin, entry.data]), [['local-my-skills.skill.notes', 'chosen', null]]);
      const compared = await checkFiles(ownRequest(project, { notes: { 'SKILL.md': '# Notes\\n' } }, ['claude-code']));
      ok(compared, 'urn:aihq:core:file-check:0.1.0');
      // Every receipt Core keeps is the one receipt format.
      const receipts = join(process.env.HOME, '.aih', 'core', 'ownership');
      for (const name of readdirSync(receipts)) ok(JSON.parse(readFileSync(join(receipts, name), 'utf8')), 'urn:aihq:core:receipt:0.1.0');
      const removal = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'local-my-skills.skill.notes' }] });
      assert.equal(removal.status, 'ok', JSON.stringify(removal));
      const removed = await apply(removal.handle, approve(removal.review));
      assert.equal(removed.completion, 'complete'); assert.equal(existsSync(join(project, '.claude')), false);
      // A change.
      const changed = await prepare(JSON.parse(readFileSync('change.json', 'utf8')));
      assert.equal(changed.status, 'ready', JSON.stringify(changed));
      assert.equal((await apply(changed.handle, approve(changed.review))).completion, 'complete');
      const unchanged = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'team-guidance' }] });
      assert.equal((await apply(unchanged.handle, approve(unchanged.review))).completion, 'complete');
      assert.equal(existsSync(join(project, 'TEAM.md')), false);
      // Journey 11 (repair, file route): reviewed and run under its repair id, with its helper bound into the review.
      assert.equal(repairIndex[0].id, 'node-npm-ca');
      const repair = await prepare({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'node-npm-ca', targets: ['npm'],
        sources: { os: false, supplied: [{ id: 'company', file: resolve('ca.pem') }] }, network: 'off' }, { logging: 'off' });
      assert.equal(repair.status, 'ready', JSON.stringify(repair)); ok(repair.review, 'urn:aihq:core:review:0.1.0');
      assert.ok(repair.review.steps.every(step => step.managementId === 'node-npm-ca'));
      assert.deepEqual(repair.review.environment.facts.trust.package, contractSupport.package);
      writeFileSync('baseline-helper.txt', repair.review.environment.facts.trust.helperSha256);
      const repaired = await apply(repair.handle, approve(repair.review), { logging: 'off' });
      assert.equal(repaired.completion, 'complete', JSON.stringify(repaired)); ok(repaired, 'urn:aihq:core:run:0.1.0');
      assert.ok((await list({ target: { project: null }, scope: 'user' })).entries.some(entry => entry.managementId === 'node-npm-ca'));
      const privateSentinel = 'fixture-private-credential-value';
      writeFileSync(join(process.env.HOME, '.gitconfig'), '[credential]\\n\\thelper = ' + privateSentinel + '\\n');
      const gitRepair = await prepare({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'user-tools-ca', targets: ['git'],
        sources: { os: false, supplied: [{ id: 'company', file: resolve('ca.pem') }] }, network: 'off' }, { logging: 'off' });
      assert.ok(gitRepair.review, JSON.stringify(gitRepair));
      assert.equal(JSON.stringify(gitRepair).includes(privateSentinel), false, 'preserved credentials stay private');
      console.log('packed API, Harness runtime, repair and schemas passed');
    `);
    assert.match(run('run.mjs', {}, 90_000), /packed API, Harness runtime, repair and schemas passed/);

    // The portable entries bundle for a browser with no Node globals and no host modules.
    const browser = await build({ absWorkingDir: consumer, stdin: { contents: `
      import { schemas, validateFormat, contractSupport, checkContracts, deriveChangeIdentity, getGuidance, renderSupportMarkdown, refusalCodes, limits,
        stateLocation, validateOrganizationPolicy } from '@aihq/core/contracts';
      import { repairIndex, trustCapabilities, signerRecords, toolRegistry, selectTool, nativeClientDefinitions, validateNativeVerificationDefinition } from '@aihq/core/harness';
      const change = schemas['urn:aihq:core:change:0.1.0'].fixtures.valid;
      globalThis.portable = [Object.keys(schemas).length, Object.values(schemas).every(entry => validateFormat(entry.fixtures.valid).status === 'ok'),
        contractSupport.package.name, repairIndex[0].id, trustCapabilities.schema, signerRecords.schema, selectTool('claude').status,
        nativeClientDefinitions.every(value => validateNativeVerificationDefinition(value).valid), refusalCodes.length > 0, typeof limits,
        stateLocation.root.base, validateOrganizationPolicy({}).status,
        renderSupportMarkdown({ kind: 'inspect', result: null }, { platform: 'linux' }).status, getGuidance({ kind: 'inspect', result: null }, { platform: 'unknown' }).status];
      globalThis.identity = deriveChangeIdentity({ change }).then(result => result.status);
      globalThis.checks = checkContracts({ declarations: [contractSupport], readers: {}, loadFixture: () => 'unavailable' }).then(result => result.ok);`, resolveDir: consumer },
      bundle: true, platform: 'browser', format: 'iife', write: false, metafile: true });
    assert.equal(Object.keys(browser.metafile.inputs).some(name => name.startsWith('node:') ||
      /harness\/(?:runtime|ca|candidate|user-trust|trust)\.mjs$|core\/(?:evidence|internal\/state)|@sigstore\//.test(name)), false);
    const browserGlobals = { TextEncoder, TextDecoder, atob, btoa, crypto: globalThis.crypto };
    runInNewContext(browser.outputFiles[0].text, browserGlobals, { timeout: 5000 });
    assert.deepEqual([...browserGlobals.portable], [expectedFormats.length, true, '@aihq/core', 'node-npm-ca', 'urn:aihq:core:trust-capabilities:0.1.0',
      'urn:aihq:core:signer-records:0.1.0', 'ok', true, true, 'object', 'userHome', 'invalid', 'invalid', 'invalid']);
    assert.equal(await browserGlobals.identity, 'ok');
    assert.equal(await browserGlobals.checks, true);

    // The installed bin: version, help, validation, a change with --no-log, check-files exit codes, list and remove.
    const bin = (args, binEnv = env) => spawnSync(process.execPath, [join(installed, manifest.bin.aih), ...args],
      { cwd: consumer, env: binEnv, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const binVersion = bin(['--version']);
    assert.equal(binVersion.status, 0, binVersion.stdout + binVersion.stderr);
    assert.equal(binVersion.stdout, `@aihq/core ${manifest.version}\n`);
    const help = bin(['help']);
    assert.equal(help.status, 0);
    for (const command of ['install', 'change', 'list', 'remove', 'update', 'repair', 'export-ca', 'inspect', 'check-files', 'verify-client', 'report', 'validate'])
      assert.match(help.stdout, new RegExp(`^aih ${command}\\b`, 'm'), command);
    for (const retiredCommand of ['policy', 'managed', 'verify-macos-session']) {
      const refused = bin([retiredCommand, '--json']);
      assert.equal(refused.status, 2, retiredCommand);
      assert.equal(JSON.parse(refused.stdout).code, 'usage');
    }
    const validDocument = bin(['validate', 'change-request', join(consumer, 'change.json'), '--json']);
    assert.equal(validDocument.status, 0, validDocument.stdout + validDocument.stderr);
    assert.equal(JSON.parse(validDocument.stdout).status, 'ok');
    writeFileSync(join(consumer, 'invalid-plan.json'), JSON.stringify({ schema: 'urn:aihq:core:plan-request:0.1.0' }));
    const invalidDocument = bin(['validate', 'plan-request', join(consumer, 'invalid-plan.json'), '--json']);
    assert.equal(invalidDocument.status, 2, invalidDocument.stdout + invalidDocument.stderr);
    assert.equal(JSON.parse(invalidDocument.stdout).status, 'invalid');
    writeFileSync(join(consumer, 'old-policy.json'), JSON.stringify({ schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [] }));
    assert.equal(bin(['validate', 'execution-policy', join(consumer, 'old-policy.json'), '--json']).status, 2);
    const noLogHome = join(root, 'no-log-home'), noLogProject = join(root, 'no-log-project');
    mkdirSync(noLogHome); mkdirSync(noLogProject);
    const binEnv = { ...env, HOME: noLogHome, USERPROFILE: noLogHome };
    writeFileSync(join(consumer, 'no-log-change.json'), JSON.stringify(change(noLogProject)));
    const noLog = bin(['change', join(consumer, 'no-log-change.json'), '--project', noLogProject, '--apply', '--yes', '--no-log', '--json'], binEnv);
    assert.equal(noLog.status, 0, noLog.stdout + noLog.stderr);
    assert.equal(JSON.parse(noLog.stdout).completion, 'complete');
    assert.ok(readdirSync(join(noLogHome, '.aih/core/ownership')).length > 0);
    assert.equal(existsSync(join(noLogHome, '.aih/core/runs')), false);
    const checkMatch = bin(['check-files', join(consumer, 'no-log-change.json'), '--project', noLogProject, '--json'], binEnv);
    assert.equal(checkMatch.status, 0, checkMatch.stdout + checkMatch.stderr);
    writeFileSync(join(noLogProject, 'TEAM.md'), 'edited after application');
    const checkChanged = bin(['check-files', join(consumer, 'no-log-change.json'), '--project', noLogProject, '--json'], binEnv);
    assert.equal(checkChanged.status, 1, checkChanged.stdout + checkChanged.stderr);
    writeFileSync(join(noLogProject, 'TEAM.md'), "Read the project's contribution guide.\n");
    const listed = bin(['list', '--project', noLogProject, '--scope', 'project', '--json'], binEnv);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).entries.map(entry => entry.managementId), ['team-guidance']);
    const removed = bin(['remove', 'team-guidance', '--scope', 'project', '--project', noLogProject, '--apply', '--yes', '--no-log', '--json'], binEnv);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).completion, 'complete');
    assert.equal(existsSync(join(noLogProject, 'TEAM.md')), false);

    // The installed CLI writes an explicit support Markdown report with a receipt.
    const reportHome = join(root, 'report-home'); mkdirSync(reportHome);
    const reportTarget = join(root, 'packed-inspect-report.md');
    const inspectReport = bin(['inspect', '--offline', '--target', 'node', '--json', '--support-markdown', reportTarget], { ...env, HOME: reportHome, USERPROFILE: reportHome });
    assert.equal(inspectReport.status, 0, inspectReport.stdout + inspectReport.stderr);
    assert.equal(JSON.parse(inspectReport.stdout).package.name, '@aihq/core');
    assert.ok(readFileSync(reportTarget, 'utf8').length > 0);

    // Mutate only this disposable installation, keeping the preparing module instance alive. Changed bundled helper
    // bytes must invalidate the reviewed work.
    writeFileSync(join(consumer, 'stale.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      import { resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import { prepare, apply } from '@aihq/core';
      const p = await prepare({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'node-npm-ca', targets: ['npm'],
        sources: { os: false, supplied: [{ id: 'company', file: resolve('ca.pem') }] }, network: 'off' }, { logging: 'off' });
      assert.equal(p.status, 'ready', JSON.stringify(p));
      const helper = fileURLToPath(new URL('../harness/runtime.mjs', import.meta.resolve('@aihq/core')));
      const original = readFileSync(helper);
      try {
        writeFileSync(helper, Buffer.concat([original, Buffer.from('\\n// changed fixture bytes\\n')]));
        const result = await apply(p.handle, { approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest }, { logging: 'off' });
        assert.equal(result.completion, 'rejected', JSON.stringify(result));
        assert.equal(result.code, 'REVIEW_STALE');
        assert.equal(existsSync(resolve(process.env.HOME, '.npmrc')), false);
      } finally { writeFileSync(helper, original); }
      console.log('changed bundled helper rejected');
    `);
    const staleHome = join(root, 'stale-home'); mkdirSync(staleHome);
    assert.match(run('stale.mjs', { HOME: staleHome, USERPROFILE: staleHome }), /changed bundled helper rejected/);

    // A Harness edit ships in a new Core version built from standalone source.
    const updated = join(root, 'updated-core'); mkdirSync(updated);
    for (const name of ['src', 'scripts', 'docs/reporting', 'examples/reporting']) cpSync(join(packageRoot, name), join(updated, name), { recursive: true });
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE'])
      copyFileSync(join(packageRoot, name), join(updated, name));
    mkdirSync(join(updated, 'test'));
    for (const name of ['harness', 'fixtures']) cpSync(join(packageRoot, 'test', name), join(updated, 'test', name), { recursive: true });
    for (const name of ['repair.test.mjs', 'inspect.test.mjs', 'user-trust.test.mjs', 'approved-process.test.mjs', 'executable-links.test.mjs', 'fixture.mjs'])
      copyFileSync(join(packageRoot, 'test', name), join(updated, 'test', name));
    const nextVersion = version.endsWith('-dev.0') ? version.replace(/-dev\.0$/, '-dev.1') : `${version}-packaging-fixture.1`;
    const nextManifest = JSON.parse(readFileSync(join(updated, 'package.json'), 'utf8'));
    nextManifest.version = nextVersion;
    writeFileSync(join(updated, 'package.json'), JSON.stringify(nextManifest));
    const nextLock = JSON.parse(readFileSync(join(updated, 'package-lock.json'), 'utf8'));
    nextLock.version = nextLock.packages[''].version = nextVersion;
    writeFileSync(join(updated, 'package-lock.json'), JSON.stringify(nextLock));
    const helper = join(updated, 'src/harness/runtime.mjs');
    const originalHelper = readFileSync(helper, 'utf8');
    const changedHelper = originalHelper.replace('Set user npm cafile without changing other npm settings', 'Set user npm cafile and retain unrelated npm settings');
    assert.notEqual(changedHelper, originalHelper);
    writeFileSync(helper, changedHelper);
    mkdirSync(join(updated, 'dist/harness'), { recursive: true });
    writeFileSync(join(updated, 'dist/index.js'), 'obsolete output');
    writeFileSync(join(updated, 'dist/harness/package.json'), '{}');
    npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], updated, 300_000);
    npm(['run', 'typecheck'], updated);
    npm(['run', 'build'], updated);
    assert.equal(existsSync(join(updated, 'dist/index.js')), false);
    assert.equal(existsSync(join(updated, 'dist/harness/package.json')), false);
    try { npm(['test'], updated, 600_000); } catch (error) {
      const lines = String(error.stdout ?? '').split('\n');
      const failing = lines.filter(line => /^\s*✖ /.test(line)).slice(0, 20);
      const failingAt = lines.findIndex(line => line.includes('failing tests:'));
      error.message += '\nnested suite failures:\n' + (failingAt >= 0 ? failing.concat(lines.slice(failingAt + 1, failingAt + 61)) : failing).join('\n');
      throw error;
    }
    const replacement = pack(updated);
    assert.equal(replacement.version, nextVersion);
    install(replacement);
    const updateHome = join(root, 'updated-home'); mkdirSync(updateHome);
    writeFileSync(join(consumer, 'update.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      import { prepare } from '@aihq/core';
      import { contractSupport } from '@aihq/core/contracts';
      const p = await prepare({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'node-npm-ca', targets: ['npm'],
        sources: { os: false, supplied: [{ id: 'company', file: resolve('ca.pem') }] }, network: 'off' }, { logging: 'off' });
      assert.equal(p.status, 'ready', JSON.stringify(p));
      assert.deepEqual(contractSupport.package, { name: '@aihq/core', version: ${JSON.stringify(nextVersion)} });
      assert.deepEqual(p.review.environment.facts.trust.package, contractSupport.package);
      assert.notEqual(p.review.environment.facts.trust.helperSha256, readFileSync('baseline-helper.txt', 'utf8'));
      assert.ok(p.review.steps.some(step => step.sentence === 'Set user npm cafile and retain unrelated npm settings'));
      console.log('new Core artifact delivers changed Harness');
    `);
    assert.match(run('update.mjs', { HOME: updateHome, USERPROFILE: updateHome }), /new Core artifact delivers changed Harness/);
    // Reinstall the original chosen artifact to restore its reproducible bytes.
    const baselineDigest = readFileSync(join(consumer, 'baseline-helper.txt'), 'utf8');
    install(packed);
    const restoredHome = join(root, 'restored-home'), restoredProject = join(root, 'restored-project');
    mkdirSync(restoredHome); mkdirSync(restoredProject);
    writeFileSync(join(consumer, 'change.json'), JSON.stringify(change(restoredProject)));
    assert.match(run('run.mjs', { HOME: restoredHome, USERPROFILE: restoredHome, TEST_PROJECT: restoredProject }, 90_000),
      /packed API, Harness runtime, repair and schemas passed/);
    assert.equal(readFileSync(join(consumer, 'baseline-helper.txt'), 'utf8'), baselineDigest);
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      await stop();
      assert.equal(dirname(realpathSync.native(root)), parent);
      assert.equal(lstatSync(root).isSymbolicLink(), false);
      rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      if (!failure) throw error;
      console.error(`Package fixture cleanup ${error.code ?? 'failed'}; preserving original failure and evidence at ${root}`);
    }
  }
});
