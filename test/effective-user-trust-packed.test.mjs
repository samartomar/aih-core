import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('qualified packed consumer exercises effective trust through public runtime and renderer', {timeout:300000}, () => {
  assert.ok(process.env.npm_execpath, 'Use npm test.');
  const root=mkdtempSync(join(tmpdir(),'aih-effective-packed-'));
  const source=fileURLToPath(new URL('../',import.meta.url));
  try {
    const consumer=join(root,'consumer'),home=join(root,'home');
    mkdirSync(consumer);mkdirSync(home);
    const env={...process.env,HOME:home,USERPROFILE:home};delete env.NODE_TEST_CONTEXT;
    const run=(args,cwd=consumer)=>execFileSync(process.execPath,args,{cwd,env,encoding:'utf8',timeout:240000,windowsHide:true});
    const [archive]=JSON.parse(run([join(source,'scripts/pack-distribution.mjs'),'--pack-destination',root],source));
    assert.match(archive.sha256,/^[a-f0-9]{64}$/);
    writeFileSync(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@aihq/core':`file:${join(root,archive.filename)}`}}));
    run([process.env.npm_execpath,'install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false']);
    copyFileSync(new URL('./effective-user-trust.test.mjs',import.meta.url),join(consumer,'consumer.test.mjs'));
    const output=run(['--test','consumer.test.mjs']);
    assert.match(output,/(?:fail 0|# fail 0)/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
