import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build, stop } from 'esbuild';
import { policy } from './fixture.mjs';

test('one Core artifact delivers APIs, portable Harness, repairs and a versioned Harness update', async () => {
  assert.ok(process.env.npm_execpath, 'Run this acceptance with npm test so its npm CLI is known.');
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-core-package-'));
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
  const npm = (args, cwd, timeout = 120_000) => execFileSync(process.execPath, [process.env.npm_execpath, ...args],
    { cwd, env, encoding: 'utf8', timeout });
  const pack = cwd => JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], cwd))[0];
  const install = packed => {
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'outside-consumer', private: true, type: 'module',
      dependencies: { '@aihq/core': `file:${join(root, packed.filename)}` } }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
  };
  const run = (file, extraEnv = {}) => execFileSync(process.execPath, [file],
    { cwd: consumer, env: { ...env, TEST_PROJECT: project, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
  let failure;
  try {
    const packed = pack(packageRoot);
    for (const entry of packed.files) {
      assert.equal(/(?:^|\/)(?:src|test|docs|ai-harness|AGENTS\.md|\.scratch)(?:\/|$)/.test(entry.path), false, entry.path);
      assert.ok(/^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|node_modules\/@sigstore\/(?:verify|core|bundle|protobuf-specs)\/.*|dist\/core\/.*|dist\/distribution\.(?:mjs|d\.mts)|dist\/harness\/(?:schemas\/(?:diagnostic|repair|package-support)\/1\.0\.0\.json|contracts\.(?:mjs|d\.mts)|runtime\.(?:mjs|d\.mts)|ca\.mjs|candidate\.mjs|user-trust(?:-definitions)?\.mjs|jvm-trust(?:-definitions)?\.mjs|github-policy\.mjs|scan-trust\.mjs|verification-publishers\.mjs|trust-data\.mjs))$/.test(entry.path), entry.path);
    }
    for (const name of ['verify', 'core', 'bundle', 'protobuf-specs']) {
      assert.ok(packed.files.some(entry => entry.path === `node_modules/@sigstore/${name}/package.json`),
        `The published artifact must carry the reviewed @sigstore/${name} bytes.`);
    }
    // The cryptography tree must come from the selected artifact, even without
    // registry access. Other ordinary dependencies retain their normal registry.
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    install(packed);
    const installed = join(consumer, 'node_modules/@aihq/core');
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    writeFileSync(join(consumer, 'contracts.mts'), `
      import {contractSupport,repairIndex,selectVerificationPublishers} from '@aihq/core/harness';
      import type {SupportedContract,PublicEntry,VerificationPublisherRecord} from '@aihq/core/harness';
      import {diagnose} from '@aihq/core/harness/runtime';
      import type {DiagnoseResult} from '@aihq/core/harness/runtime';
      const schema: 'urn:aihq:package-support:1.0.0' = contractSupport.schema;
      const contract: SupportedContract = contractSupport.contracts[0]!;
      const role: 'accepts'|'produces'|'both' = contract.role;
      const schemaExport: string = contract.schemaExport;
      // @ts-expect-error Contract records replace the old string-only support list.
      const oldString: string = contract;
      const entry: PublicEntry = contractSupport.entries[0]!;
      if (entry.runtime === 'node') { const range: string = entry.nodeRange; }
      else {
        // @ts-expect-error Portable entries do not promise a Node runtime range.
        const range: string = entry.nodeRange;
      }
      const repairSchema: 'urn:aihq:harness:repair:1.0.0' = repairIndex[0]!.schema;
      const result: DiagnoseResult = await diagnose({requestId:'types',targets:['node'],network:'off'});
      const selected = selectVerificationPublishers('scan-report');
      if (selected.status === 'selected') { const records: readonly VerificationPublisherRecord[] = selected.publishers; }
    `);
    const compilerManifest = createRequire(import.meta.url).resolve('typescript/package.json');
    const compiler = join(dirname(compilerManifest), JSON.parse(readFileSync(compilerManifest, 'utf8')).bin.tsc);
    execFileSync(process.execPath, [compiler,
      '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2023', 'contracts.mts'], { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 });
    const coreRequire = createRequire(join(installed, 'package.json'));
    const verifierRequire = createRequire(coreRequire.resolve('@sigstore/verify'));
    const bundleRequire = createRequire(verifierRequire.resolve('@sigstore/bundle'));
    const installedVersion = (resolveFrom, name) =>
      JSON.parse(readFileSync(join(dirname(resolveFrom.resolve(name)), '../package.json'), 'utf8')).version;
    for (const [name, expected] of Object.entries({
      '@sigstore/verify': '4.1.2', '@sigstore/core': '4.0.1',
      '@sigstore/bundle': '5.0.0', '@sigstore/protobuf-specs': '0.5.0'
    })) {
      const resolveFrom = name === '@sigstore/verify' ? coreRequire : verifierRequire;
      assert.ok(resolveFrom.resolve(name).startsWith(join(installed, 'node_modules') + sep),
        `Bundled resolution of ${name}`);
      assert.equal(installedVersion(resolveFrom, name),
        expected, `Actual verifier resolution of ${name}`);
    }
    assert.equal(installedVersion(bundleRequire, '@sigstore/protobuf-specs'), '0.5.0');
    assert.equal(manifest.dependencies['@aihq/harness'], undefined);
    assert.equal(existsSync(join(consumer, 'node_modules/@aihq/harness')), false);
    assert.equal(existsSync(join(consumer, 'node_modules/@aihq/scan')), false);
    assert.equal(existsSync(join(consumer, 'node_modules/@aihq/catalog')), false);
    copyFileSync(new URL('./fixtures/evidence/production.scan.json', import.meta.url), join(consumer, 'production.scan.json'));
    copyFileSync(new URL('./fixtures/evidence/test-dsse-0.0.2.artifact.json', import.meta.url), join(consumer, 'partial.scan.json'));
    copyFileSync(new URL('./fixtures/evidence/test-dsse-0.0.2.trust.json', import.meta.url), join(consumer, 'partial-trust.json'));
    writeFileSync(join(consumer, 'evidence.mjs'), `
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {authenticateEvidence} from '@aihq/core';
      import {selectVerificationKeys,selectVerificationPublishers} from '@aihq/core/harness';
      const keys=await selectVerificationKeys('scan-report'), publishers=selectVerificationPublishers('scan-report');
      assert.equal(keys.status,'selected'); assert.equal(publishers.status,'selected');
      globalThis.fetch=()=>{throw new Error('unexpected network')};
      for(const [file,trust] of [['production.scan.json',{keys:keys.keys,publishers:publishers.publishers}],
        ['partial.scan.json',JSON.parse(readFileSync('partial-trust.json','utf8'))]]) {
        const bytes=readFileSync(file), expectedScanId=JSON.parse(bytes).scanId;
        const result=await authenticateEvidence({bytes,expectedScanId,trust});
        assert.equal(result.status,'authenticated',JSON.stringify(result));
        assert.equal(result.reportRead,'not-requested');
      }
      console.log('packed production and later partial evidence passed');
    `);
    assert.match(run('evidence.mjs'), /packed production and later partial evidence passed/);
    writeFileSync(join(consumer, 'policy.json'), JSON.stringify(policy()));
    const lifecyclePolicy = policy();
    lifecyclePolicy.managedSelections = [{ id: 'guidance', scope: 'project', members: [lifecyclePolicy.selections[0].managementId] }];
    writeFileSync(join(consumer, 'lifecycle-policy.json'), JSON.stringify(lifecyclePolicy));
    writeFileSync(join(consumer, 'lifecycle.mjs'), `
      import assert from 'node:assert/strict';
      import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {prepare,apply} from '@aihq/core';
      import {parsePolicy} from '@aihq/core/contracts';
      const project=join(process.env.TEST_PROJECT,'lifecycle'); mkdirSync(project);
      const document=parsePolicy(readFileSync('lifecycle-policy.json','utf8')).document;
      const request=policy=>({useCase:'policy',policy,target:{project}});
      const execute=async policy=>{const p=await prepare(request(policy),{logging:'off'});
        assert.equal(p.status,'ready',JSON.stringify(p));
        const result=await apply(p.prepared,{approved:true,origin:'automation',reviewDigest:p.review.reviewDigest},{logging:'off'});
        assert.equal(result.completion,'complete',JSON.stringify(result));return result;};
      await execute(document);
      await execute({schema:document.schema,mode:'vibe',selections:[]});
      assert.equal(existsSync(join(project,'TEAM.md')),true);
      const empty={schema:document.schema,mode:'vibe',selections:[],managedSelections:[{id:'guidance',scope:'project',members:[]}]};
      const result=await execute(empty);assert.ok(result.recovery);
      assert.equal(existsSync(join(project,'TEAM.md')),false);
      assert.deepEqual((await execute(empty)).operations,[]);
      writeFileSync('lifecycle-empty.json',JSON.stringify(empty));
      console.log('packed lifecycle passed');
    `);
    assert.match(run('lifecycle.mjs'), /packed lifecycle passed/);
    const lifecycleCli = execFileSync(process.execPath, [join(installed, 'dist/core/cli.js'), 'policy',
      join(consumer, 'lifecycle-empty.json'), '--project', join(project, 'lifecycle'), '--apply', '--yes', '--json'],
      { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(JSON.parse(lifecycleCli).completion, 'complete');
    writeFileSync(join(consumer, 'ca.pem'), readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
    writeFileSync(join(consumer, 'run.mjs'), `
      import assert from 'node:assert/strict';
      import {readFileSync,writeFileSync} from 'node:fs';
      import {join,resolve} from 'node:path';
      import {prepare,apply,inspect} from '@aihq/core';
      import {parsePolicy,contractSupport,validateRecipe} from '@aihq/core/contracts';
      import {repairIndex,contractSupport as harnessSupport} from '@aihq/core/harness';
      import {getRepairRecipe,diagnose} from '@aihq/core/harness/runtime';
      import {Ajv2020} from 'ajv/dist/2020.js';
      const ajv = new Ajv2020({strict:true});
      for (const entry of contractSupport.contracts)
        ajv.addSchema((await import(entry.schemaExport,{with:{type:'json'}})).default);
      assert.equal(contractSupport.contracts.length,5);
      for (const entry of harnessSupport.contracts) {
        const schema=(await import(entry.schemaExport,{with:{type:'json'}})).default;
        assert.equal(schema.$id,entry.id);
        assert.equal(schema.$schema,'https://json-schema.org/draft/2020-12/schema');
        if (!ajv.getSchema(schema.$id)) ajv.addSchema(schema);
      }
      const supportSchema=(await import('@aihq/core/schemas/package-support/1.0.0.json',{with:{type:'json'}})).default;
      ajv.addSchema(supportSchema);
      for (const declaration of [contractSupport,harnessSupport])
        assert.equal(ajv.validate(supportSchema.$id,declaration),true,JSON.stringify(ajv.errors));
      for (const definition of repairIndex)
        assert.equal(ajv.validate(definition.schema,definition),true,JSON.stringify(ajv.errors));
      const diagnostic=await diagnose({requestId:'packed-diagnostic',targets:['node'],network:'off'});
      assert.equal(diagnostic.status,'completed');
      assert.equal(diagnostic.tools.find(tool=>tool.id==='node').state,'runnable');
      assert.equal(Object.hasOwn(diagnostic,'schema'),false);
      assert.equal(ajv.validate('urn:aihq:harness:diagnostic:1.0.0',diagnostic),true,JSON.stringify(ajv.errors));
      assert.ok(contractSupport.contracts.some(entry=>entry.id==='urn:aihq:core:organization-policy:1.0.0'&&entry.role==='accepts'));
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
      const jvmTrust = repairIndex.find(item=>item.id==='jvm-ca');
      assert.ok(jvmTrust,'packed Harness must include the JVM repair');
      assert.deepEqual(jvmTrust.targets,['gradle','maven']);
      for (const item of jvmTrust.variants) {
        const recipe = getRepairRecipe(item.recipeRef);
        assert.ok(recipe,'installed runtime resolves each portable JVM repair variant');
        const validation = validateRecipe(recipe);
        assert.equal(validation.valid,true,JSON.stringify(validation.diagnostics));
      }
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
      import {contractSupport as harnessSupport,helperMetadata,repairIndex,verificationKeys,verificationPublishers,selectVerificationPublishers} from '@aihq/core/harness';
      globalThis.portable = [parsePolicy(${JSON.stringify(JSON.stringify(policy()))}).valid,
        contractSupport.package,harnessSupport.package,helperMetadata.diagnostics.length,repairIndex[0].id,verificationKeys.length,
        verificationPublishers.length,selectVerificationPublishers('scan-report').status];`, resolveDir: consumer },
      bundle: true, platform: 'browser', format: 'iife', write: false, metafile: true });
    assert.equal(Object.keys(browser.metafile.inputs).some(name=>/harness\/(?:runtime|ca|candidate|user-trust)\.mjs$/.test(name)), false);
    assert.equal(Object.keys(browser.metafile.inputs).some(name=>/core\/evidence\/|@sigstore\//.test(name)), false);
    const browserGlobals = { TextEncoder, TextDecoder, atob, btoa };
    runInNewContext(browser.outputFiles[0].text, browserGlobals, { timeout: 5000 });
    assert.equal(browserGlobals.portable[0], true);
    assert.equal(browserGlobals.portable[1].name, '@aihq/core');
    assert.equal(browserGlobals.portable[2].version, version);
    assert.ok(browserGlobals.portable[3] > 0);
    assert.equal(browserGlobals.portable[4], 'node-npm-ca');
    assert.equal(browserGlobals.portable[6], 1);
    assert.equal(browserGlobals.portable[7], 'selected');
    const cliResult = execFileSync(process.execPath, [join(installed, manifest.bin.aih), 'policy',
      join(consumer, 'policy.json'), '--project', project, '--apply', '--yes', '--json'],
      { cwd: consumer, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(JSON.parse(cliResult).operations[0].application, 'already-satisfied');

    // The installed bin serves version, pure validation and --no-log runs.
    const bin = (args, binEnv = env) => spawnSync(process.execPath, [join(installed, 'dist/core/cli.js'), ...args],
      { cwd: consumer, env: binEnv, encoding: 'utf8', timeout: 30_000 });
    const binVersion = bin(['--version']);
    assert.equal(binVersion.status, 0, binVersion.stdout + binVersion.stderr);
    assert.equal(binVersion.stdout, `@aihq/core ${manifest.version}\n`);
    const validDocument = bin(['validate', 'execution-policy', join(consumer, 'policy.json')]);
    assert.equal(validDocument.status, 0, validDocument.stdout + validDocument.stderr);
    assert.equal(JSON.parse(validDocument.stdout).status, 'valid');
    writeFileSync(join(consumer, 'invalid-policy.json'), JSON.stringify({ schema: 'urn:aihq:core:execution-policy:1.0.0' }));
    const invalidDocument = bin(['validate', 'execution-policy', join(consumer, 'invalid-policy.json')]);
    assert.equal(invalidDocument.status, 2, invalidDocument.stdout + invalidDocument.stderr);
    assert.equal(JSON.parse(invalidDocument.stdout).status, 'invalid');
    const unknownKind = bin(['validate', 'nope', join(consumer, 'policy.json')]);
    assert.equal(unknownKind.status, 2, unknownKind.stdout + unknownKind.stderr);
    const noLogHome = join(root, 'no-log-home'), noLogProject = join(root, 'no-log-project');
    mkdirSync(noLogHome); mkdirSync(noLogProject);
    const noLog = bin(['policy', join(consumer, 'policy.json'), '--project', noLogProject, '--apply', '--yes', '--no-log', '--json'],
      { ...env, HOME: noLogHome, USERPROFILE: noLogHome });
    assert.equal(noLog.status, 0, noLog.stdout + noLog.stderr);
    assert.deepEqual(JSON.parse(noLog.stdout).record, { status: 'disabled', reason: 'logging-off' });
    assert.ok(readdirSync(join(noLogHome, '.aih/core/ownership')).length > 0);
    assert.ok(readdirSync(join(noLogHome, '.aih/core/recovery')).length > 0);

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
    // This runs a complete standalone suite, including bounded Windows native
    // subprocess checks. Its budget is larger than an individual npm install.
    npm(['test'], updated, 300_000);
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
