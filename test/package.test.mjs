import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { policy } from './fixture.mjs';

test('one Core artifact delivers APIs, portable Harness, repairs and a versioned Harness update', async () => {
  assert.ok(process.env.npm_execpath, 'Run this acceptance with npm test so its npm CLI is known.');
  const root = mkdtempSync(join(tmpdir(), 'aih-core-package-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  const home = join(root, 'home'), project = join(root, 'target'), consumer = join(root, 'consumer');
  for (const path of [home, project, consumer]) mkdirSync(path);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // npm 11 refuses this inherited setting on installs; fixture installs and
  // packs explicitly disable lifecycle scripts below.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  // A separate test invocation must not inherit Node's parent-test marker,
  // which would silently skip the updated artifact's owning test files.
  delete env.NODE_TEST_CONTEXT;
  const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args],
    { cwd, env, encoding: 'utf8', timeout: 120_000 });
  const pack = cwd => JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], cwd))[0];
  const install = packed => {
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'outside-consumer', private: true, type: 'module',
      dependencies: { '@aihq/core': `file:${join(root, packed.filename)}` } }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
  };
  const run = (file, extraEnv = {}) => execFileSync(process.execPath, [file],
    { cwd: consumer, env: { ...env, TEST_PROJECT: project, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
  try {
    const packed = pack(packageRoot);
    for (const entry of packed.files) {
      assert.equal(/(?:^|\/)(?:src|test|docs|ai-harness|AGENTS\.md|\.scratch)(?:\/|$)/.test(entry.path), false, entry.path);
      assert.ok(/^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|dist\/core\/.*|dist\/distribution\.(?:mjs|d\.mts)|dist\/harness\/(?:contracts\.(?:mjs|d\.mts)|runtime\.(?:mjs|d\.mts)|ca\.mjs|candidate\.mjs|user-trust(?:-definitions)?\.mjs))$/.test(entry.path), entry.path);
    }
    install(packed);
    const installed = join(consumer, 'node_modules/@aihq/core');
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies['@aihq/harness'], undefined);
    assert.equal(existsSync(join(consumer, 'node_modules/@aihq/harness')), false);
    writeFileSync(join(consumer, 'policy.json'), JSON.stringify(policy()));
    writeFileSync(join(consumer, 'ca.pem'), readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
    writeFileSync(join(consumer, 'run.mjs'), `
      import assert from 'node:assert/strict';
      import {readFileSync,writeFileSync} from 'node:fs';
      import {join,resolve} from 'node:path';
      import {prepare,apply,inspect} from '@aihq/core';
      import {parsePolicy,contractSupport,validateRecipe} from '@aihq/core/contracts';
      import {repairIndex,contractSupport as harnessSupport} from '@aihq/core/harness';
      import {getRepairRecipe} from '@aihq/core/harness/runtime';
      import {Ajv2020} from 'ajv/dist/2020.js';
      const ajv = new Ajv2020({strict:true});
      for (const entry of contractSupport.contracts)
        ajv.addSchema((await import(entry.schemaExport,{with:{type:'json'}})).default);
      assert.equal(contractSupport.contracts.length,4);
      assert.deepEqual(harnessSupport.package,contractSupport.package);
      assert.deepEqual(contractSupport.package,{name:'@aihq/core',version:${JSON.stringify(version)}});
      const inspection = await inspect({targets:['node'],network:'off'});
      assert.deepEqual(inspection.package,contractSupport.package);
      assert.equal(inspection.tools.find(tool=>tool.id==='node').state,'runnable');
      const p = await prepare({useCase:'policy',policy:parsePolicy(readFileSync('policy.json','utf8')).document,
        target:{project:process.env.TEST_PROJECT}},{logging:'off'});
      assert.equal(p.status,'ready');
      assert.equal(ajv.validate(p.review.schema,p.review),true,JSON.stringify(ajv.errors));
      const result = await apply(p.prepared,{approved:true,origin:'automation',reviewDigest:p.review.reviewDigest},{logging:'off'});
      assert.equal(result.completion,'complete');
      assert.equal(ajv.validate(result.schema,result),true,JSON.stringify(ajv.errors));
      assert.equal(repairIndex[0].id,'node-npm-ca');
      const userTrust = repairIndex.find(item=>item.id==='user-tools-ca');
      assert.ok(userTrust,'packed Harness must include the user-tools-ca repair');
      assert.deepEqual(userTrust.targets,['python','pip','git','cargo','conda']);
      for (const item of userTrust.variants) {
        const recipe = getRepairRecipe(item.recipeRef);
        assert.ok(recipe,'installed runtime resolves each portable repair variant');
        const validation = validateRecipe(recipe);
        assert.equal(validation.valid,true,JSON.stringify(validation.diagnostics));
      }
      const variant = repairIndex[0].variants.find(item=>item.os===process.platform&&item.targets.length===1&&item.targets[0]==='npm'&&item.network==='off');
      assert.equal(getRepairRecipe(variant.recipeRef).id,'node-npm-ca');
      const repair = await prepare({useCase:'repair',repairs:[{id:'node-npm-ca',targets:['npm'],
        inputs:{caFile:resolve('ca.pem')}}],network:'off'},{logging:'off'});
      assert.equal(repair.status,'ready',JSON.stringify(repair.diagnostics));
      assert.deepEqual(repair.review.inputs.package,contractSupport.package);
      writeFileSync('baseline-helper.txt',repair.review.inputs.helperSha256);
      assert.equal(ajv.validate(repair.review.schema,repair.review),true,JSON.stringify(ajv.errors));
      const repaired = await apply(repair.prepared,{approved:true,origin:'automation',reviewDigest:repair.review.reviewDigest},{logging:'off'});
      assert.equal(repaired.completion,'incomplete');
      assert.equal(repaired.operations.find(op=>op.id==='trust/material').application,'applied');
      assert.equal(ajv.validate(repaired.schema,repaired),true,JSON.stringify(ajv.errors));
      const privateSentinel = 'fixture-private-credential-value';
      writeFileSync(join(process.env.HOME,'.gitconfig'),'[credential]\\n\\thelper = '+privateSentinel+'\\n');
      const gitRepair = await prepare({useCase:'repair',repairs:[{id:'user-tools-ca',targets:['git'],
        inputs:{caFile:resolve('ca.pem')}}],network:'off'},{logging:'off'});
      assert.ok(gitRepair.review,JSON.stringify(gitRepair.diagnostics));
      assert.equal(JSON.stringify(gitRepair).includes(privateSentinel),false,'preserved credentials stay private');
      assert.equal(gitRepair.review.operations.find(item=>item.id==='trust/git-config').details.content,'[REDACTED]');
      console.log('packed API, Harness runtime, repair and schemas passed');
    `);
    assert.match(run('run.mjs'), /packed API, Harness runtime, repair and schemas passed/);
    const browser = await build({ absWorkingDir: consumer, stdin: { contents: `
      import {parsePolicy,contractSupport} from '@aihq/core/contracts';
      import {contractSupport as harnessSupport,helperMetadata,repairIndex,verificationKeys} from '@aihq/core/harness';
      globalThis.portable = [parsePolicy(${JSON.stringify(JSON.stringify(policy()))}).valid,
        contractSupport.package,harnessSupport.package,helperMetadata.diagnostics.length,repairIndex[0].id,verificationKeys.length];`, resolveDir: consumer },
      bundle: true, platform: 'browser', format: 'iife', write: false, metafile: true });
    assert.equal(Object.keys(browser.metafile.inputs).some(name=>/harness\/(?:runtime|ca|candidate|user-trust)\.mjs$/.test(name)), false);
    const browserGlobals = { TextEncoder, TextDecoder };
    runInNewContext(browser.outputFiles[0].text, browserGlobals, { timeout: 5000 });
    assert.equal(browserGlobals.portable[0], true);
    assert.equal(browserGlobals.portable[1].name, '@aihq/core');
    assert.equal(browserGlobals.portable[2].version, version);
    assert.ok(browserGlobals.portable[3] > 0);
    assert.equal(browserGlobals.portable[4], 'node-npm-ca');
    const cliResult = execFileSync(process.execPath, [join(installed, manifest.bin.aih), 'policy',
      join(consumer, 'policy.json'), '--project', project, '--apply', '--yes', '--json'],
      { cwd: consumer, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(JSON.parse(cliResult).operations[0].application, 'already-satisfied');

    // Mutate only this disposable installation, keeping the preparing module
    // instance alive. Changed bundled bytes must invalidate the reviewed work.
    writeFileSync(join(consumer, 'stale.mjs'), `
      import assert from 'node:assert/strict';
      import {readFileSync,writeFileSync,existsSync} from 'node:fs';
      import {resolve} from 'node:path';
      import {fileURLToPath} from 'node:url';
      import {prepare,apply} from '@aihq/core';
      const p = await prepare({useCase:'repair',repairs:[{id:'node-npm-ca',targets:['npm'],
        inputs:{caFile:resolve('ca.pem')}}],network:'off'},{logging:'off'});
      assert.equal(p.status,'ready');
      const helper = fileURLToPath(import.meta.resolve('@aihq/core/harness/runtime'));
      const original = readFileSync(helper);
      try {
        writeFileSync(helper,Buffer.concat([original,Buffer.from('\\n// changed fixture bytes\\n')]));
        const result = await apply(p.prepared,{approved:true,origin:'automation',reviewDigest:p.review.reviewDigest},{logging:'off'});
        assert.equal(result.completion,'rejected');
        assert.ok(result.diagnostics.some(item=>item.code==='REVIEW_STALE'));
        assert.equal(existsSync(p.review.operations.find(op=>op.id==='trust/material').details.target),false);
      } finally {writeFileSync(helper,original)}
      console.log('changed bundled helper rejected');
    `);
    const staleHome = join(root, 'stale-home'); mkdirSync(staleHome);
    assert.match(run('stale.mjs', { HOME: staleHome, USERPROFILE: staleHome }), /changed bundled helper rejected/);

    // A Harness edit ships in a new Core version built from standalone source.
    const updated = join(root, 'updated-core'); mkdirSync(updated);
    for (const name of ['src', 'scripts']) cpSync(join(packageRoot, name), join(updated, name), { recursive: true });
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'LICENSE'])
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
    const changedHelper = originalHelper.replace('Set user npm cafile without changing other npm settings',
      'Set user npm cafile and retain unrelated npm settings');
    assert.notEqual(changedHelper, originalHelper);
    writeFileSync(helper, changedHelper);
    mkdirSync(join(updated, 'dist/harness'), { recursive: true });
    writeFileSync(join(updated, 'dist/index.js'), 'obsolete output');
    writeFileSync(join(updated, 'dist/harness/package.json'), '{}');
    npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], updated);
    npm(['run', 'typecheck'], updated);
    npm(['run', 'build'], updated);
    assert.equal(existsSync(join(updated, 'dist/index.js')), false);
    assert.equal(existsSync(join(updated, 'dist/harness/package.json')), false);
    npm(['test'], updated);
    const replacement = pack(updated);
    assert.equal(replacement.version, nextVersion);
    install(replacement);
    const updateHome = join(root, 'updated-home'); mkdirSync(updateHome);
    writeFileSync(join(consumer, 'update.mjs'), `
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {resolve} from 'node:path';
      import {prepare} from '@aihq/core';
      import {contractSupport} from '@aihq/core/contracts';
      import {contractSupport as harnessSupport} from '@aihq/core/harness';
      const p = await prepare({useCase:'repair',repairs:[{id:'node-npm-ca',targets:['npm'],
        inputs:{caFile:resolve('ca.pem')}}],network:'off'},{logging:'off'});
      assert.equal(p.status,'ready',JSON.stringify(p.diagnostics));
      assert.deepEqual(contractSupport.package,{name:'@aihq/core',version:${JSON.stringify(nextVersion)}});
      assert.deepEqual(harnessSupport.package,contractSupport.package);
      assert.deepEqual(p.review.inputs.package,contractSupport.package);
      assert.notEqual(p.review.inputs.helperSha256,readFileSync('baseline-helper.txt','utf8'));
      assert.equal(p.review.operations.find(item=>item.id==='trust/npm-config').purpose,
        'Set user npm cafile and retain unrelated npm settings');
      console.log('new Core artifact delivers changed Harness');
    `);
    assert.match(run('update.mjs', { HOME: updateHome, USERPROFILE: updateHome }), /new Core artifact delivers changed Harness/);
    // Reinstall the original chosen artifact to restore its reproducible bytes.
    const baselineDigest = readFileSync(join(consumer, 'baseline-helper.txt'), 'utf8');
    install(packed);
    const restoredHome = join(root, 'restored-home'); mkdirSync(restoredHome);
    assert.match(run('run.mjs', { HOME: restoredHome, USERPROFILE: restoredHome }), /packed API, Harness runtime, repair and schemas passed/);
    assert.equal(readFileSync(join(consumer, 'baseline-helper.txt'), 'utf8'), baselineDigest);
    assert.equal(existsSync(join(consumer, 'node_modules/@aihq/harness')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
