import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { build, stop } from 'esbuild';

// This gate consumes explicitly selected artifacts. It neither chooses package
// versions nor changes the Core runtime dependency graph.
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]?.slice(2), value = process.argv[index + 1];
  assert.ok(['core', 'catalog', 'catalog-baseline', 'scan', 'output'].includes(name) && value && !options[name],
    'Usage: npm run verify:public-consumer -- --core <tgz> --catalog <tgz> --catalog-baseline <tgz> --scan <tgz> --output <new-directory>');
  options[name] = resolve(value);
}
for (const name of ['core', 'catalog', 'catalog-baseline', 'scan', 'output']) assert.ok(options[name], `Missing --${name}`);
assert.ok(process.env.npm_execpath, 'Run through npm run verify:public-consumer so the selected npm CLI is explicit.');
const source = fileURLToPath(new URL('../', import.meta.url));
// Declaration deviations accepted only with an owner, keyed by package identity and
// the exact decisive error set. Any other deviation, or an entry no install
// matches, fails the gate.
const EXPECTED_DEVIATIONS = [
  { package: { name: '@aihq/catalog', version: '0.1.0' }, owner: 'samartomar/aih-catalog#99',
    reason: 'The older baseline predates the producer-declaration role fix (consumes to accepts).',
    variants: ['baseline'], errors: [
      '/contracts/8/role must be equal to one of the allowed values (accepts|produces|both)',
      '/contracts/9/role must be equal to one of the allowed values (accepts|produces|both)'] },
];
// Portable entries every install must declare and load without host globals.
const REQUIRED_PORTABLE = ['@aihq/core/contracts', '@aihq/core/harness', '@aihq/core/support', '@aihq/core/report',
  '@aihq/catalog/contracts', '@aihq/catalog/reader', '@aihq/scan/contracts', '@aihq/scan/read'];
// Produced review/run families that need native trust or macOS session setup.
const NATIVE_ONLY_FAMILIES = {
  'urn:aihq:core:prepared-work:1.2.0': 'trust repair and certificate export need native trust setup',
  'urn:aihq:core:run-result:1.2.0': 'trust repair and certificate export need native trust setup',
  'urn:aihq:core:prepared-work:1.3.0': 'macOS session repair needs a native macOS session',
  'urn:aihq:core:run-result:1.3.0': 'macOS session repair needs a native macOS session',
};
const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const gateSource = { commit: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain']) === '' };
// Public types of the operations the current install exercises, compiled strictly.
const CURRENT_TYPES = `
      import {checkFileState,type FileStateResult,type OperationSelection,type PreparationResult,type RunResult} from '@aihq/core';
      import {recipeOperationKinds,validateOrganizationTarget,type ExecutionPolicy} from '@aihq/core/contracts';
      import {getGuidance,renderSupportMarkdown,type GuidanceResult} from '@aihq/core/support';
      import {targets} from '@aihq/core/harness';
      import {CLAIMS_SCHEMA,readClaimSet,validateClaimSet,type ClaimSetValidation} from '@aihq/core/report';
      import {releaseInventory,type ReleaseInventoryEntry,type ResolveSelectionsResult,type SelectionRef} from '@aihq/catalog/contracts';
      import {compareReleases,resolveSelections,type CompareReleasesResult,type ItemComparison} from '@aihq/catalog/reader';
      import {readContentCoverage,maxContentDescriptors,type ContentDescriptor,type ReadContentCoverageInput,type ReadContentCoverageResult} from '@aihq/scan/read';
      export function selections(prepared: PreparationResult): readonly OperationSelection[] { return prepared.operationSelections ?? []; }
      export function observable(kind: string): boolean {
        return Object.values(recipeOperationKinds).flat().some(record => record.kind === kind && record.effects === 'observable');
      }
      export async function selectionsOf(policy: ExecutionPolicy, project: string): Promise<string[][]> {
        const result: FileStateResult = await checkFileState({ policy, target: { project } });
        return result.targets.map(target => target.selectionIds);
      }
      export function guidance(prepared: PreparationResult, run: RunResult): GuidanceResult[] {
        const { prepared: _handle, ...result } = prepared;
        return [getGuidance({ kind: 'prepare', result }, { platform: 'unknown' }), getGuidance({ kind: 'run', result: run }, { platform: 'linux' })];
      }
      export const markdown = renderSupportMarkdown;
      export const npm: string | undefined = targets.find(target => target.executables.includes('npx'))?.id;
      export const claims: ClaimSetValidation = validateClaimSet({ schema: CLAIMS_SCHEMA, claims: [], calculations: [], actions: [] });
      export const claimRead = readClaimSet;
      export const organizationTarget = validateOrganizationTarget({ schema: 'urn:aihq:core:organization-target:1.0.0', client: 'codex' });
      export const inventory: readonly ReleaseInventoryEntry[] = releaseInventory.releases;
      export function declaredBy(result: ResolveSelectionsResult): (SelectionRef | undefined)[] {
        return result.status === 'refused' ? result.diagnostics.map(entry => entry.declaredBy) : [];
      }
      export const resolve = resolveSelections;
      export function changed(result: CompareReleasesResult): ItemComparison[] {
        return result.status === 'ok' ? result.value.items.filter(item => item.presence !== 'in-both' || item.content === 'changed') : [];
      }
      export const compare = compareReleases;
      export async function unmatched(read: ReadContentCoverageInput['read'], descriptors: ContentDescriptor[]): Promise<string[]> {
        if (descriptors.length > maxContentDescriptors) return [];
        const result: ReadContentCoverageResult = await readContentCoverage({ read, descriptors });
        return result.status === 'mismatched' ? result.unmatchedPaths : [];
      }
      import {entrySupport} from '@aihq/scan/contracts';
      export const rootGroups = entrySupport.entries.find(entry => entry.export === '@aihq/scan')?.groups?.map(group => [group.group, group.status]);
      const catalogRole: 'accepts'|'produces'|'both' = catalog.contracts[0]!.role;
      void catalogRole;
`;
const artifacts = Object.fromEntries(['core', 'catalog', 'catalog-baseline', 'scan'].map(name => {
  assert.ok(lstatSync(options[name]).isFile(), `Artifact must be a regular file: ${name}`);
  const bytes = readFileSync(options[name]);
  return [name, { path: options[name], bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
}));
assert.notEqual(artifacts.catalog.sha256, artifacts['catalog-baseline'].sha256, 'The compatible-content comparison needs two distinct artifacts.');
mkdirSync(options.output); // Refuse to overwrite evidence or an existing install.
// Keep product custody in a disposable user-home location, separate from the
// workspace's inherited ACLs. Retain its path with the evidence for inspection.
const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'aih-public-consumer-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.NODE_TEST_CONTEXT;
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
const record = { artifacts, gateSource, runtime: process.version, home, checks: {}, deviations: [], status: 'running' };
const save = () => writeFileSync(join(options.output, 'acceptance.json'), JSON.stringify(record, null, 2) + '\n');
save();
function run(args, cwd, name, timeout = 120_000) {
  try {
    const output = execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(options.output, `${name}.log`), output);
    return output;
  } catch (error) {
    writeFileSync(join(options.output, `${name}.log`), `${error.stdout ?? ''}\n${error.stderr ?? ''}`);
    throw error;
  }
}
const portable = {};
try {
  for (const variant of ['baseline', 'current']) {
    const consumer = join(options.output, variant);
    mkdirSync(consumer);
    cpSync(join(source, 'examples/public-consumer'), consumer, { recursive: true });
    cpSync(join(source, 'scripts/public-consumer'), join(consumer, 'acceptance'), { recursive: true });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: `public-consumer-${variant}`, private: true, type: 'module',
      dependencies: Object.fromEntries(['core', 'catalog', 'scan'].map(name => [`@aihq/${name}`,
        `file:${options[name === 'catalog' && variant === 'baseline' ? 'catalog-baseline' : name]}`])) }, null, 2));
    run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], consumer, `${variant}-install`);
    const audit = run(['--input-type=module', '-e',
      "import {auditInstalledPackages} from './acceptance/audit.mjs'; console.log(JSON.stringify(await auditInstalledPackages(process.cwd())));"], consumer, `${variant}-audit`);
    const { declarations, ...packages } = JSON.parse(audit);
    // Every installed declaration is validated against Core's installed
    // package-support schema; Core and Harness (and the current Catalog) must
    // conform, and every other result is recorded as a finding.
    const supportSchema = JSON.parse(readFileSync(createRequire(join(consumer, 'package.json'))
      .resolve('@aihq/core/schemas/package-support/1.0.0.json'), 'utf8'));
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(supportSchema);
    packages.packageSupportSchema = Object.fromEntries(Object.entries(declarations).map(([name, declaration]) =>
      [name, validate(declaration) ? { valid: true } : { valid: false, errors: schemaErrors(declaration, validate.errors) }]));
    for (const name of ['core', 'harness', ...(variant === 'current' ? ['catalog'] : [])]) {
      assert.equal(packages.packageSupportSchema[name].valid, true, `${variant} ${name}: ${JSON.stringify(packages.packageSupportSchema[name])}`);
    }
    for (const [name, result] of Object.entries(packages.packageSupportSchema)) {
      if (result.valid) continue;
      const { package: identity } = declarations[name];
      const expected = EXPECTED_DEVIATIONS.find(entry => entry.package.name === identity.name &&
        entry.package.version === identity.version && (!entry.variants || entry.variants.includes(variant)));
      assert.ok(expected, `${variant} ${name}: unexpected package-support deviation ${JSON.stringify(result.errors)}`);
      assert.deepEqual([...result.errors].sort(), [...expected.errors].sort(), `${variant} ${name}: deviation differs from ${expected.owner}`);
      record.deviations.push({ variant, package: identity, contract: 'urn:aihq:package-support:1.0.0',
        owner: expected.owner, reason: expected.reason, errors: result.errors });
    }
    record.checks[`${variant}Packages`] = { ...packages, declarations };
    const portableEntries = [...new Set(Object.values(declarations).flatMap(declaration =>
      declaration.entries.filter(entry => entry.runtime === 'portable').map(entry => entry.export)))].sort();
    for (const entry of REQUIRED_PORTABLE) assert.ok(portableEntries.includes(entry), `${variant}: ${entry} is not declared portable`);
    writeFileSync(join(consumer, 'public-contracts.mts'), `
      import {prepare,apply} from '@aihq/core';
      import {parsePolicy,contractSupport} from '@aihq/core/contracts';
      import {contractSupport as harness,repairIndex} from '@aihq/core/harness';
      import {contractSupport as catalog} from '@aihq/catalog/contracts';
      import {readRelease,configureItem,validateSelectionSet} from '@aihq/catalog/reader';
      import {readInstalledRelease} from '@aihq/catalog/node';
      import {contractSupport as scan} from '@aihq/scan/contracts';
      import {readArtifact,readReport} from '@aihq/scan/read';
      import {runScan,prepareArtifact} from '@aihq/scan/host';
      const role:'accepts'|'produces'|'both'=harness.contracts[0]!.role;
      void [prepare,apply,parsePolicy,contractSupport,repairIndex,catalog,scan,
        readRelease,configureItem,validateSelectionSet,readInstalledRelease,
        readArtifact,readReport,runScan,prepareArtifact,role];
    ${variant === 'current' ? CURRENT_TYPES : ''}`);
    run([join(source, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--types', 'node',
      '--typeRoots', join(source, 'node_modules/@types'), 'public-contracts.mts'], consumer, `${variant}-declarations`);
    // Every entry an installed declaration marks portable loads with browser
    // globals only; the current install also bundles a driver that calls the
    // newer operations in that context after the scenario.
    const bundle = await portableBundle(consumer, [
      ...portableEntries.map((entry, index) => `export * as entry${index} from '${entry}';`),
      ...(variant === 'current' ? [`export { runPortableOperations } from './acceptance/portable-operations.mjs';`] : []),
    ].join('\n'));
    const browser = browserContext();
    runInNewContext(bundle.text, browser, { timeout: 10_000 });
    assert.equal(browser.publicPackages[`entry${portableEntries.indexOf('@aihq/core/harness')}`].contractSupport.package.name, '@aihq/core');
    writeFileSync(join(consumer, 'public-packages.js'), bundle.text);
    portable[variant] = browser;
    record.checks[`${variant}PortableBundle`] = { nodeGlobalsAbsent: true, entries: portableEntries, inputs: bundle.inputs };
    const example = await build({ entryPoints: [join(consumer, 'browser/app.js')],
      outfile: join(consumer, 'browser/app.bundle.js'), bundle: true, platform: 'browser', format: 'esm',
      metafile: true, logLevel: 'silent' });
    assert.ok(Object.keys(example.metafile.inputs).every(path => !/^(?:node:)|harness\/runtime|\/artifact\/host/.test(path)));
    const admin = await build({ entryPoints: [join(consumer, 'src/admin.js')], bundle: true, platform: 'browser', format: 'esm',
      write: false, metafile: true, logLevel: 'silent' });
    assert.ok(Object.keys(admin.metafile.inputs).every(path => !/^(?:node:)|harness\/runtime|\/artifact\/host/.test(path)));
    record.checks[`${variant}ExampleBundle`] = { inputs: Object.keys(example.metafile.inputs).length };
    record.checks[`${variant}AdminBundle`] = { inputs: Object.keys(admin.metafile.inputs).length };
    save();
  }
  const current = join(options.output, 'current');
  cpSync(join(source, 'test/fixtures/evidence/production.scan.json'), join(current, 'production.scan.json'));
  env.SCAN_ARTIFACT_FIXTURE = join(current, 'production.scan.json');
  record.checks.reports = JSON.parse(run(['--input-type=module', '-e',
    "import {createDisplayFixtures} from './acceptance/fixtures.mjs'; console.log(JSON.stringify(await createDisplayFixtures(process.cwd())));"], current, 'report-fixtures'));
  // The example's own tests and the scenario use the same copied implementation
  // in both installs; no product-source imports or version negotiation occurs.
  run(['--test', 'test/*.test.mjs'], current, 'example-tests');
  record.checks.baselineScenario = JSON.parse(run(['acceptance/scenario.mjs', 'baseline'],
    join(options.output, 'baseline'), 'baseline-scenario'));
  // The baseline artifact's upgrade-release bytes, compared by the current reader.
  cpSync(record.checks.baselineScenario.upgrade.export, join(current, 'baseline-release.json'));
  env.BASELINE_RELEASE = join(current, 'baseline-release.json');
  record.checks.currentScenario = JSON.parse(run(['acceptance/scenario.mjs', 'current'], current, 'current-scenario'));
  // A content-only upgrade: the current artifact adds items the baseline lacks.
  const [before, after] = [record.checks.baselineScenario.upgrade, record.checks.currentScenario.upgrade];
  assert.notEqual(before.sha256, after.sha256, 'the Catalog pair carries identical upgrade-release content');
  assert.equal(before.addedItemPresent, false);
  assert.equal(after.addedItemPresent, true);
  assert.ok(after.itemCount > before.itemCount, `${after.itemCount} > ${before.itemCount}`);
  const compared = record.checks.currentScenario.catalog.compare;
  assert.deepEqual([compared.first.sha256, compared.second.sha256], [before.sha256, after.sha256]);
  assert.equal(compared.sameRelease, false);
  assert.ok(compared.onlyInSecond.includes(after.addedItem));
  assert.equal(after.itemCount - compared.onlyInSecond.length, before.itemCount - (compared.items['only-in-first'] ?? 0));
  // Support guidance families: every produced family is exercised or explicitly native-only.
  const scenario = record.checks.currentScenario;
  const exercised = [scenario.common.guidance, ...Object.values(scenario.policyFamilies),
    scenario.administrator.organizationFamily.guidance].flatMap(entry => [entry.reviewSchema, entry.runSchema]);
  const produced = record.checks.currentPackages.declarations.core.contracts
    .filter(contract => /^urn:aihq:core:(?:prepared-work|run-result):/.test(contract.id) && contract.role !== 'accepts').map(contract => contract.id);
  const notExercised = produced.filter(id => !exercised.includes(id));
  for (const id of notExercised) assert.ok(Object.hasOwn(NATIVE_ONLY_FAMILIES, id), `support guidance family not exercised: ${id}`);
  record.checks.supportFamilies = { exercised: [...new Set(exercised)].sort(),
    notExercised: Object.fromEntries(notExercised.map(id => [id, NATIVE_ONLY_FAMILIES[id]])) };
  const bytes = path => new Uint8Array(readFileSync(path));
  record.checks.currentPortableOperations = await portable.current.publicPackages.runPortableOperations({
    current: bytes(after.export), baseline: bytes(join(current, 'baseline-release.json')),
    artifact: bytes(join(current, 'production.scan.json')),
    preparationText: readFileSync(join(current, 'organization-prepared.json'), 'utf8'),
    runText: readFileSync(join(current, 'organization-run.json'), 'utf8'),
  });
  const portableResult = record.checks.currentPortableOperations;
  assert.deepEqual([portableResult.scan.matched, portableResult.scan.mismatched], ['matched', 'mismatched']);
  assert.deepEqual([portableResult.core.prepareGuidance, portableResult.core.runGuidance], ['complete', 'complete']);
  assert.equal(portableResult.catalog.resolveRefusal, 'ITEM_UNAVAILABLE');
  for (const expected of EXPECTED_DEVIATIONS) {
    assert.ok(record.deviations.some(entry => entry.owner === expected.owner), `stale expected deviation: ${expected.owner}`);
  }
  assert.ok(compared.onlyInSecond.includes(record.checks.currentScenario.upgradeUsed.itemId), 'the applied item is added content');
  // Only a committed, clean gate source can produce `passed`.
  record.status = gateSource.clean ? 'passed' : 'passed-dirty';
  save();
  console.log(JSON.stringify({ status: record.status, evidence: join(options.output, 'acceptance.json') }));
} catch (error) {
  record.status = 'failed';
  record.failure = error instanceof Error ? error.message : String(error);
  save();
  throw error;
} finally {
  stop();
}

// Entry errors come from the oneOf branch that matches the entry's declared
// runtime (portable 0, node 1); an entry with another runtime keeps its oneOf error.
function schemaErrors(declaration, errors) {
  const kept = errors.filter(error => {
    const entry = /^\/entries\/(\d+)(?:\/|$)/.exec(error.instancePath);
    if (!entry) return error.keyword !== 'oneOf';
    const branch = { portable: 0, node: 1 }[declaration.entries[Number(entry[1])]?.runtime];
    return branch === undefined ? error.keyword === 'oneOf' : error.schemaPath.startsWith(`#/properties/entries/items/oneOf/${branch}/`);
  });
  return [...new Set(kept.map(error => {
    const detail = error.params?.additionalProperty ?? error.params?.allowedValues?.join('|') ?? error.params?.missingProperty;
    return `${error.instancePath || '/'} ${error.message}${detail ? ` (${detail})` : ''}`;
  }))];
}

async function portableBundle(consumer, contents) {
  const bundle = await build({ stdin: { contents, resolveDir: consumer }, bundle: true, platform: 'browser', format: 'iife',
    globalName: 'publicPackages', write: false, metafile: true, logLevel: 'silent' });
  const inputs = Object.keys(bundle.metafile.inputs);
  assert.ok(inputs.every(path => !/^(?:node:)|\/src\/|harness\/runtime|\/artifact\/host/.test(path)), JSON.stringify(inputs));
  return { text: bundle.outputFiles[0].text, inputs: inputs.length };
}

// Browser-standard globals only: no process, require, Buffer, timers or filesystem.
function browserContext() {
  return { TextEncoder, TextDecoder, crypto: webcrypto, URL, Uint8Array, structuredClone, atob, btoa };
}
