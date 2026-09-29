import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
  const home = join(root, 'home'); const project = join(root, 'target'); const consumer = join(root, 'consumer');
  for (const path of [home, project, consumer]) mkdirSync(path);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // npm run exports this configuration, but npm 11 refuses the inherited value
  // on a project install. This fixture always disables lifecycle scripts itself.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  try {
    const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], packageRoot))[0];
    for (const entry of packed.files) assert.equal(/(?:^|\/)(?:src|test|docs|ai-harness|AGENTS\.md|\.scratch)(?:\/|$)/.test(entry.path), false, entry.path);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'outside-consumer', private: true, type: 'module', dependencies: { ajv: '8.20.0' } }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)], consumer);
    writeFileSync(join(consumer, 'policy.json'), JSON.stringify(policy()));
    writeFileSync(join(consumer, 'run.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { prepare, apply } from '@aihq/core';
      import { parsePolicy, contractSupport } from '@aihq/core/contracts';
      import { Ajv2020 } from 'ajv/dist/2020.js';
      const ajv = new Ajv2020({strict:true});
      for (const entry of contractSupport.contracts) {
        const schema = (await import(entry.schemaExport, {with:{type:'json'}})).default;
        ajv.addSchema(schema);
      }
      assert.equal(contractSupport.contracts.length, 4);
      const p = await prepare({useCase:'policy',policy:parsePolicy(readFileSync('policy.json','utf8')).document,target:{project:process.env.TEST_PROJECT}}, {logging:'off'});
      assert.equal(p.status,'ready');
      assert.equal(ajv.validate(p.review.schema,p.review),true,JSON.stringify(ajv.errors));
      const result = await apply(p.prepared,{approved:true,origin:'automation',reviewDigest:p.review.reviewDigest},{logging:'off'});
      assert.equal(result.completion,'complete');
      assert.equal(ajv.validate(result.schema,result),true,JSON.stringify(ajv.errors));
      console.log('packed API and schema check passed');
    `);
    const output = execFileSync(process.execPath, ['run.mjs'], { cwd: consumer, env: { ...env, TEST_PROJECT: project }, encoding: 'utf8', timeout: 20_000 });
    assert.match(output, /packed API and schema check passed/);
    const bundle = await build({ absWorkingDir: consumer, stdin: { contents: `import {parsePolicy} from '@aihq/core/contracts'; globalThis.validation = parsePolicy(${JSON.stringify(JSON.stringify(policy()))}).valid;`, resolveDir: consumer }, bundle: true, platform: 'browser', format: 'iife', write: false });
    const browserGlobals = { TextEncoder, TextDecoder };
    runInNewContext(bundle.outputFiles[0].text, browserGlobals, { timeout: 5000 });
    assert.equal(browserGlobals.validation, true);
    // Locate only the documented bin entry in the installed package's manifest.
    const installed = join(consumer, 'node_modules/@aihq/core');
    const bin = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).bin.aih;
    const cliResult = execFileSync(process.execPath, [join(installed, bin), 'policy', join(consumer, 'policy.json'), '--project', project, '--apply', '--yes', '--json'], { cwd: consumer, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(JSON.parse(cliResult).operations[0].application, 'already-satisfied');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
