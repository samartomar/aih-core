import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// The contract seam is the installed public package, including byte-resource exports.
test('packed public contracts load every declared fixture and check without Node globals', async () => {
  assert.ok(process.env.npm_execpath, 'Run with npm test.');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'aih-contract-check-'));
  const consumer = join(root, 'consumer'), home = join(root, 'home');
  mkdirSync(consumer); mkdirSync(home);
  const env = { ...process.env, HOME:home, USERPROFILE:home };
  delete env.NODE_TEST_CONTEXT;
  for(const key of Object.keys(env)) if(key.toLowerCase()==='npm_config_allow_scripts') delete env[key];
  const run = (args, cwd=consumer) => execFileSync(process.execPath,args,{cwd,env,encoding:'utf8',windowsHide:true,timeout:300_000});
  try {
    const [packed] = JSON.parse(run([join(source,'scripts/pack-distribution.mjs'),'--pack-destination',root],source));
    writeFileSync(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@aihq/core':'file:'+join(root,packed.filename)}}));
    run([process.env.npm_execpath,'install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false']);
    copyFileSync(new URL('./fixtures/package-support-consumer.mjs',import.meta.url),join(consumer,'check.mjs'));
    const receipt = JSON.parse(run(['check.mjs']).trim());
    assert.equal(receipt.status,'passed');
    assert.equal(receipt.contracts,68);
    assert.equal(receipt.fixtures,120);
    const browser = await build({absWorkingDir:consumer,stdin:{resolveDir:consumer,contents:`
      import {checkContracts,contractSupport,validatePackageSupport} from '@aihq/core/contracts';
      const make = (name,role,fixtures=[]) => ({schema:'urn:aihq:package-support:1.1.0',package:{name,version:'0.1.0'},contracts:[{id:'example',role,versions:['1.0.0'],schemaExport:'example/schema',fixtures}],entries:[]});
      globalThis.result=checkContracts({declarations:[make('reader','accepts'),make('producer','produces',[{export:'producer/fixture',expect:'accept'}])],readers:{example:bytes=>({accepted:bytes.length===2})},loadFixture:()=>new TextEncoder().encode('{}')});
      globalThis.supportValid=validatePackageSupport(contractSupport).valid;
    `},bundle:true,platform:'browser',format:'iife',write:false,metafile:true});
    assert.equal(Object.keys(browser.metafile.inputs).some(p=>p.startsWith('node:')||/harness\/runtime\.mjs$/.test(p)),false);
    const globals={TextEncoder,TextDecoder};
    runInNewContext(browser.outputFiles[0].text,globals,{timeout:5000});
    assert.equal((await globals.result).ok,true);
    assert.equal(globals.supportValid,true);
    writeFileSync(join(consumer,'types.mts'),`
      import {checkContracts,contractSupport,validatePackageSupport} from '@aihq/core/contracts';
      import {contractSupport as harnessSupport} from '@aihq/core/harness';
      import type {PackageSupport,ContractCheckResult} from '@aihq/core/contracts';
      const declaration:PackageSupport=contractSupport;
      const result:ContractCheckResult=await checkContracts({declarations:[declaration,harnessSupport],readers:{},loadFixture:()=> 'unavailable'});
      validatePackageSupport(declaration);
    `);
    const require=createRequire(import.meta.url);
    const compilerManifest = require.resolve('typescript/package.json');
    const compiler = join(dirname(compilerManifest), JSON.parse(readFileSync(compilerManifest, 'utf8')).bin.tsc);
    run([compiler,'--noEmit','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','types.mts']);
    console.log(JSON.stringify({...receipt,sha256:packed.sha256,publicTypes:'passed',browser:'passed'}));
  } finally {
    assert.equal(dirname(realpathSync.native(root)),parent);
    rmSync(root,{recursive:true,maxRetries:3,retryDelay:100});
  }
});
