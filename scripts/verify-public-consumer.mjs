import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
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
const record = { artifacts, runtime: process.version, home, checks: {}, status: 'running' };
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
    record.checks[`${variant}Packages`] = JSON.parse(audit);
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
    `);
    run([join(source, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--types', 'node',
      '--typeRoots', join(source, 'node_modules/@types'), 'public-contracts.mts'], consumer, `${variant}-declarations`);
    const bundle = await build({ stdin: { contents: `
      export * as core from '@aihq/core/contracts';
      export * as harness from '@aihq/core/harness';
      export * as catalog from '@aihq/catalog/contracts';
      export * as reader from '@aihq/catalog/reader';
      export * as scan from '@aihq/scan/contracts';
      export * as reports from '@aihq/scan/read';
    `, resolveDir: consumer }, bundle: true, platform: 'browser', format: 'iife', globalName: 'publicPackages',
      write: false, metafile: true, logLevel: 'silent' });
    assert.ok(Object.keys(bundle.metafile.inputs).every(path => !/^(?:node:)|\/src\/|harness\/runtime|\/artifact\/host/.test(path)));
    const browser = { TextEncoder, TextDecoder, crypto: webcrypto, URL, Uint8Array };
    runInNewContext(bundle.outputFiles[0].text, browser, { timeout: 10_000 });
    assert.equal(browser.publicPackages.harness.contractSupport.package.name, '@aihq/core');
    writeFileSync(join(consumer, 'public-packages.js'), bundle.outputFiles[0].text);
    record.checks[`${variant}PortableBundle`] = { nodeGlobalsAbsent: true, inputs: Object.keys(bundle.metafile.inputs).length };
    const example = await build({ entryPoints: [join(consumer, 'browser/app.js')],
      outfile: join(consumer, 'browser/app.bundle.js'), bundle: true, platform: 'browser', format: 'esm',
      metafile: true, logLevel: 'silent' });
    assert.ok(Object.keys(example.metafile.inputs).every(path => !/^(?:node:)|harness\/runtime|\/artifact\/host/.test(path)));
    record.checks[`${variant}ExampleBundle`] = { inputs: Object.keys(example.metafile.inputs).length };
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
  for (const variant of ['baseline', 'current']) {
    record.checks[`${variant}Scenario`] = JSON.parse(run(['acceptance/scenario.mjs', variant],
      join(options.output, variant), `${variant}-scenario`));
  }
  assert.ok(record.checks.currentScenario.itemCount > record.checks.baselineScenario.itemCount);
  record.status = 'passed';
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
