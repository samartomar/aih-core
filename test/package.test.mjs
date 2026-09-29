import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { policy } from './fixture.mjs';

test('an isolated packed consumer imports public schemas, runs a file and bundles portable contracts', async () => {
  assert.ok(process.env.npm_execpath, 'Run this acceptance with npm test so its npm CLI is known.');
  const root = mkdtempSync(join(tmpdir(), 'aih-core-package-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const harnessRoot = fileURLToPath(new URL('../../aih-harness/', import.meta.url));
  const home = join(root, 'home'); const project = join(root, 'target'); const consumer = join(root, 'consumer');
  for (const path of [home, project, consumer]) mkdirSync(path);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // npm run exports this configuration, but npm 11 refuses the inherited value
  // on a project install. This fixture always disables lifecycle scripts itself.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  try {
    const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], packageRoot))[0];
    const harnessPacked = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], harnessRoot))[0];
    for (const entry of packed.files) assert.equal(/(?:^|\/)(?:src|test|docs|ai-harness|AGENTS\.md|\.scratch)(?:\/|$)/.test(entry.path), false, entry.path);
    for (const entry of harnessPacked.files) assert.equal(/(?:^|\/)(?:src|test|docs|ai-harness|AGENTS\.md|\.scratch)(?:\/|$)/.test(entry.path), false, entry.path);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'outside-consumer', private: true, type: 'module',
      dependencies: { ajv: '8.20.0', '@aihq/core': `file:${join(root, packed.filename)}`,
        '@aihq/harness': `file:${join(root, harnessPacked.filename)}` } }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
    writeFileSync(join(consumer, 'policy.json'), JSON.stringify(policy()));
    writeFileSync(join(consumer, 'ca.pem'), readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
    writeFileSync(join(consumer, 'run.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      import { prepare, apply, inspect } from '@aihq/core';
      import { parsePolicy, contractSupport } from '@aihq/core/contracts';
      import { repairIndex } from '@aihq/harness/contracts';
      import { Ajv2020 } from 'ajv/dist/2020.js';
      const ajv = new Ajv2020({strict:true});
      for (const entry of contractSupport.contracts) {
        const schema = (await import(entry.schemaExport, {with:{type:'json'}})).default;
        ajv.addSchema(schema);
      }
      assert.equal(contractSupport.contracts.length, 4);
      const inspection = await inspect({targets:['node'],network:'off'});
      assert.equal(inspection.package.name,'@aihq/harness');
      assert.equal(inspection.package.version,'2.0.0-dev.0');
      assert.equal(inspection.tools.find(tool=>tool.id==='node').state,'runnable');
      const p = await prepare({useCase:'policy',policy:parsePolicy(readFileSync('policy.json','utf8')).document,target:{project:process.env.TEST_PROJECT}}, {logging:'off'});
      assert.equal(p.status,'ready');
      assert.equal(ajv.validate(p.review.schema,p.review),true,JSON.stringify(ajv.errors));
      const result = await apply(p.prepared,{approved:true,origin:'automation',reviewDigest:p.review.reviewDigest},{logging:'off'});
      assert.equal(result.completion,'complete');
      assert.equal(ajv.validate(result.schema,result),true,JSON.stringify(ajv.errors));
      assert.equal(repairIndex[0].id,'node-npm-ca');
      const repair = await prepare({useCase:'repair',repairs:[{id:'node-npm-ca',targets:['npm'],
        inputs:{caFile:resolve('ca.pem')}}],network:'off'},{logging:'off'});
      assert.equal(repair.status,'ready',JSON.stringify(repair.diagnostics));
      writeFileSync('baseline-helper.txt',repair.review.inputs.helperSha256);
      assert.equal(ajv.validate(repair.review.schema,repair.review),true,JSON.stringify(ajv.errors));
      const repaired = await apply(repair.prepared,{approved:true,origin:'automation',reviewDigest:repair.review.reviewDigest},{logging:'off'});
      assert.equal(repaired.completion,'incomplete');
      assert.equal(ajv.validate(repaired.schema,repaired),true,JSON.stringify(ajv.errors));
      console.log('packed API and schema check passed');
    `);
    const output = execFileSync(process.execPath, ['run.mjs'], { cwd: consumer, env: { ...env, TEST_PROJECT: project }, encoding: 'utf8', timeout: 20_000 });
    assert.match(output, /packed API and schema check passed/);
    const bundle = await build({ absWorkingDir: consumer, stdin: { contents: `import {parsePolicy} from '@aihq/core/contracts'; globalThis.validation = parsePolicy(${JSON.stringify(JSON.stringify(policy()))}).valid;`, resolveDir: consumer }, bundle: true, platform: 'browser', format: 'iife', write: false });
    const browserGlobals = { TextEncoder, TextDecoder };
    runInNewContext(bundle.outputFiles[0].text, browserGlobals, { timeout: 5000 });
    assert.equal(browserGlobals.validation, true);
    const harnessBundle = await build({ absWorkingDir: consumer, stdin: {
      contents: "import {contractSupport,helperMetadata} from '@aihq/harness/contracts'; globalThis.harnessSupport = [contractSupport.package.name, helperMetadata.diagnostics.length];",
      resolveDir: consumer
    }, bundle: true, platform: 'browser', format: 'iife', write: false });
    runInNewContext(harnessBundle.outputFiles[0].text, browserGlobals, { timeout: 5000 });
    assert.equal(browserGlobals.harnessSupport[0], '@aihq/harness');
    assert.ok(browserGlobals.harnessSupport[1] > 0);
    // Locate only the documented bin entry in the installed package's manifest.
    const installed = join(consumer, 'node_modules/@aihq/core');
    const bin = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).bin.aih;
    const cliResult = execFileSync(process.execPath, [join(installed, bin), 'policy', join(consumer, 'policy.json'), '--project', project, '--apply', '--yes', '--json'], { cwd: consumer, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(JSON.parse(cliResult).operations[0].application, 'already-satisfied');
    const coreBytesBefore = createHash('sha256').update(readFileSync(join(installed, 'dist/index.js'))).digest('hex');
    const updated = join(root, 'updated-harness'); mkdirSync(updated);
    for (const name of ['package.json', 'contracts.mjs', 'contracts.d.mts', 'runtime.mjs', 'runtime.d.mts',
      'ca.mjs', 'candidate.mjs', 'README.md', 'LICENSE']) copyFileSync(join(harnessRoot, name), join(updated, name));
    const manifest = JSON.parse(readFileSync(join(updated, 'package.json'), 'utf8'));
    manifest.version = '2.0.0-dev.1';
    writeFileSync(join(updated, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(updated, 'contracts.mjs'), readFileSync(join(updated, 'contracts.mjs'), 'utf8')
      .replace("version: '2.0.0-dev.0'", "version: '2.0.0-dev.1'"));
    writeFileSync(join(updated, 'runtime.mjs'), readFileSync(join(updated, 'runtime.mjs'), 'utf8')
      .replace('Set user npm cafile without changing other npm settings',
        'Set user npm cafile and retain unrelated npm settings'));
    const replacement = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], updated))[0];
    const consumerManifest = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'));
    consumerManifest.dependencies['@aihq/harness'] = `file:${join(root, replacement.filename)}`;
    writeFileSync(join(consumer, 'package.json'), JSON.stringify(consumerManifest));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
    const updateHome = join(root, 'updated-home'); mkdirSync(updateHome);
    writeFileSync(join(consumer, 'update.mjs'), `
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {resolve} from 'node:path';
      import {prepare} from '@aihq/core';
      import {contractSupport} from '@aihq/harness/contracts';
      const prepared = await prepare({useCase:'repair',repairs:[{id:'node-npm-ca',targets:['npm'],
        inputs:{caFile:resolve('ca.pem')}}],network:'off'},{logging:'off'});
      assert.equal(prepared.status,'ready',JSON.stringify(prepared.diagnostics));
      assert.equal(contractSupport.package.version,'2.0.0-dev.1');
      assert.equal(prepared.review.inputs.package.version,'2.0.0-dev.1');
      assert.notEqual(prepared.review.inputs.helperSha256,readFileSync('baseline-helper.txt','utf8'));
      assert.equal(prepared.review.operations.find(item=>item.id==='trust/npm-config').purpose,
        'Set user npm cafile and retain unrelated npm settings');
      console.log('updated compatible Harness recognized without Core rebuild');
    `);
    const updateOutput = execFileSync(process.execPath, ['update.mjs'], { cwd: consumer,
      env: { ...env, HOME: updateHome, USERPROFILE: updateHome }, encoding: 'utf8', timeout: 20_000 });
    assert.match(updateOutput, /updated compatible Harness recognized without Core rebuild/);
    assert.equal(createHash('sha256').update(readFileSync(join(installed, 'dist/index.js'))).digest('hex'), coreBytesBefore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
