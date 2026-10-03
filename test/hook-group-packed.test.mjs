import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build, stop } from 'esbuild';
import { groupOf, hookOp, hookSelection, policy11 } from './hook-group-fixture.mjs';

// Public-consumer acceptance: the packed artifact installed in an outside project, driven only through
// the exported `@aihq/core` API, its exported schemas and the installed `aih` bin. No private import.
test('a packed Core consumer adds, updates, conflicts, resolves and removes an owned hook group through the API and the aih CLI', async () => {
  assert.ok(process.env.npm_execpath, 'Run this acceptance with npm test so its npm CLI is known.');
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'aih-hook-packed-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const home = join(root, 'home'), project = join(root, 'target'), consumer = join(root, 'consumer');
  for (const path of [home, project, consumer]) mkdirSync(path);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  delete env.NODE_TEST_CONTEXT;
  const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, encoding: 'utf8', timeout: 180_000 });
  try {
    const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], packageRoot))[0];
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'hook-consumer', private: true, type: 'module',
      dependencies: { '@aihq/core': `file:${join(root, packed.filename)}` } }));
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
    const installed = join(consumer, 'node_modules/@aihq/core');
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    const bin = (args, extra = {}) => spawnSync(process.execPath, [join(installed, manifest.bin.aih), ...args],
      { cwd: consumer, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
    const json = result => JSON.parse(result.stdout);

    const policyFile = (name, policy) => { const path = join(consumer, name); writeFileSync(path, JSON.stringify(policy)); return path; };
    const add = policyFile('add.json', policy11([hookSelection('guard-a', [hookOp('add', 'guard-a')])]));
    const update = policyFile('update.json', policy11([hookSelection('guard-a', [hookOp('add', 'guard-a', { group: groupOf('guard-a', { matcher: 'Write' }) })])]));
    const remove = policyFile('remove.json', policy11([hookSelection('guard-a', [hookOp('drop', 'guard-a', { action: 'remove' })])]));
    const settings = join(project, '.tool', 'settings.json');
    const neighbors = [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'mine/a.sh' }] }];
    mkdirSync(join(project, '.tool'));
    writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: neighbors } }));
    const groups = () => JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse;

    // Exported schemas and support declaration (no private import).
    writeFileSync(join(consumer, 'schemas.mjs'), `
      import assert from 'node:assert/strict';
      import {Ajv2020} from 'ajv/dist/2020.js';
      import {contractSupport,parsePolicy,validateRecipe} from '@aihq/core/contracts';
      import {getGuidance} from '@aihq/core/support';
      import {prepare,apply,checkFileState} from '@aihq/core';
      import {readFileSync} from 'node:fs';
      const ajv=new Ajv2020({strict:true});
      for (const entry of contractSupport.contracts) ajv.addSchema((await import(entry.schemaExport,{with:{type:'json'}})).default);
      const ids=contractSupport.contracts.map(entry=>entry.id);
      for (const id of ['urn:aihq:core:execution-policy:1.1.0','urn:aihq:core:recipe:1.1.0','urn:aihq:core:prepared-work:1.1.0','urn:aihq:core:run-result:1.1.0'])
        assert.ok(ids.includes(id),id);
      const request=text=>({useCase:'policy',policy:parsePolicy(readFileSync(text,'utf8')).document,target:{project:process.env.TEST_PROJECT}});
      const fsRequest=file=>({policy:request(file).policy,target:request(file).target});
      const approve=p=>({approved:true,origin:'automation',reviewDigest:p.review.reviewDigest});
      const run=async file=>{const p=await prepare(request(file),{logging:'off'});
        assert.ok(p.prepared,JSON.stringify(p.diagnostics));
        assert.equal(p.review.schema,'urn:aihq:core:prepared-work:1.1.0');
        assert.equal(ajv.validate(p.review.schema,p.review),true,JSON.stringify(ajv.errors));
        const result=await apply(p.prepared,approve(p),{logging:'off'});
        assert.equal(result.schema,'urn:aihq:core:run-result:1.1.0');
        assert.equal(ajv.validate(result.schema,result),true,JSON.stringify(ajv.errors));
        assert.equal(result.completion,'complete',JSON.stringify(result));return {p,result};};
      const first=await run('add.json');
      assert.equal(first.p.review.operations[0].kind,'hook.group');
      assert.equal(first.p.review.operations[0].effects,'replace-file');
      assert.equal((await checkFileState(fsRequest('add.json'))).fileState,'match');
      const second=await run('update.json');
      assert.equal(second.p.review.operations[0].details.hookGroup.matchedIndex,1);
      assert.equal((await checkFileState(fsRequest('add.json'))).fileState,'changed');
      // A reviewed conflict, with safe public guidance.
      const edited=readFileSync(process.env.TEST_SETTINGS,'utf8');
      const text=edited.replace('"Write"','"Locally-edited"');
      (await import('node:fs')).writeFileSync(process.env.TEST_SETTINGS,text);
      const blocked=await prepare(request('update.json'),{logging:'off'});
      assert.equal(blocked.status,'blocked');
      assert.equal(blocked.review.conflicts[0].reason,'owned-hook-edited');
      const guidance=getGuidance({kind:'prepare',result:blocked},{platform:process.platform});
      assert.equal(guidance.status,'complete');
      assert.ok(guidance.items.some(item=>item.id==='hook-group-conflict'));
      assert.equal(JSON.stringify(guidance).includes('Locally-edited'),false);
      (await import('node:fs')).writeFileSync(process.env.TEST_SETTINGS,edited);
      assert.equal((await run('remove.json')).p.review.operations[0].details.hookGroup.action,'remove');
      assert.equal(validateRecipe(parsePolicy(readFileSync('add.json','utf8')).document.selections[0].recipe.inline).valid,true);
      console.log('packed hook-group API passed');
    `);
    const api = spawnSync(process.execPath, [join(consumer, 'schemas.mjs')], { cwd: consumer, encoding: 'utf8', timeout: 90_000,
      env: { ...env, TEST_PROJECT: project, TEST_SETTINGS: settings } });
    assert.equal(api.status, 0, api.stdout + api.stderr);
    assert.match(api.stdout, /packed hook-group API passed/);
    assert.deepEqual(groups(), neighbors, 'the API scenario ends with only the original neighbor');

    // The installed aih CLI: the same versioned review and result, with explicit approval.
    const preview = bin(['policy', add, '--project', project, '--json']);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(json(preview).review.schema, 'urn:aihq:core:prepared-work:1.1.0');
    assert.equal(json(preview).review.operations[0].kind, 'hook.group');
    assert.deepEqual(groups(), neighbors, 'preview never writes');
    const refused = bin(['policy', add, '--project', project, '--apply', '--json'], { CI: '1' });
    assert.notEqual(refused.status, 0, 'no approval, no apply');
    assert.deepEqual(groups(), neighbors);
    const applied = bin(['policy', add, '--project', project, '--apply', '--yes', '--json']);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(json(applied).schema, 'urn:aihq:core:run-result:1.1.0');
    assert.deepEqual(groups(), [...neighbors, groupOf('guard-a')]);
    assert.equal(json(bin(['check-files', add, '--project', project, '--json'])).fileState, 'match');
    assert.equal(bin(['check-files', add, '--project', project, '--json']).status, 0);
    const updated = bin(['policy', update, '--project', project, '--apply', '--yes', '--json']);
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.deepEqual(groups(), [...neighbors, groupOf('guard-a', { matcher: 'Write' })]);
    const check = bin(['check-files', add, '--project', project, '--json']);
    assert.equal(check.status, 1);
    assert.equal(json(check).targets[0].outcome, 'changed');
    assert.equal(bin(['validate', 'execution-policy', update, '--json']).status, 0);
    assert.equal(json(bin(['validate', 'execution-policy', update])).schema, 'urn:aihq:core:execution-policy:1.1.0');

    // A conflict is a review outcome with exit 1, never a write; its observed digest resolves it exactly.
    const edited = readFileSync(settings, 'utf8').replace('"Write"', '"Locally-edited"');
    writeFileSync(settings, edited);
    const blocked = bin(['policy', update, '--project', project, '--apply', '--yes', '--json']);
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.equal(json(blocked).review.conflicts[0].reason, 'owned-hook-edited');
    assert.equal(blocked.stdout.includes('Locally-edited'), false);
    assert.equal(readFileSync(settings, 'utf8'), edited);
    const resolutions = join(consumer, 'resolutions.json');
    writeFileSync(resolutions, JSON.stringify({ resolutions: [{ selectionId: 'guard-a', operationId: 'add', choice: 'replace',
      observedSha256: json(blocked).review.operations[0].details.hookGroup.targetBeforeSha256 }] }));
    const resolved = bin(['policy', update, '--project', project, '--resolutions', resolutions, '--apply', '--yes', '--json']);
    assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
    assert.deepEqual(groups(), [...neighbors, groupOf('guard-a', { matcher: 'Write' })]);
    const removed = bin(['policy', remove, '--project', project, '--apply', '--yes', '--json']);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.deepEqual(groups(), neighbors);
    assert.equal(json(bin(['policy', remove, '--project', project, '--json'])).review.operations[0].effects, 'already-satisfied');

    // Portable consumers receive the same contract without Node host code.
    const browser = await build({ absWorkingDir: consumer, stdin: { contents: `
      import {parsePolicy,contractSupport} from '@aihq/core/contracts';
      import {getGuidance} from '@aihq/core/support';
      globalThis.portable = [parsePolicy(${JSON.stringify(readFileSync(add, 'utf8'))}).valid,
        contractSupport.contracts.some(entry => entry.id === 'urn:aihq:core:recipe:1.1.0'), typeof getGuidance];`, resolveDir: consumer },
      bundle: true, platform: 'browser', format: 'iife', write: false, metafile: true });
    assert.equal(Object.keys(browser.metafile.inputs).some(name => name.startsWith('node:') || /harness\/runtime\.mjs$/.test(name)), false);
    const globals = { TextEncoder, TextDecoder, atob, btoa };
    runInNewContext(browser.outputFiles[0].text, globals, { timeout: 5000 });
    assert.deepEqual([...globals.portable], [true, true, 'function']);
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
