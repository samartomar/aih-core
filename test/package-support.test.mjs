import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../dist/core/contracts.js';
const bytes = new TextEncoder().encode('{}');
const declaration = (name, role, fixtures = []) => ({schema:'urn:aihq:package-support:1.1.0',package:{name,version:'0.1.0'},entries:[],contracts:[{id:'example',role,versions:['1.0.0'],schemaExport:'example/schema',fixtures}]});
test('contract checks run another package fixture through the supplied reader', async () => {
  const result = await contracts.checkContracts({declarations:[declaration('reader','accepts'),declaration('producer','produces',[{export:'producer/fixture',expect:'accept'}])],readers:{example:()=>({accepted:true})},loadFixture:()=>bytes});
  assert.equal(result.ok,true);
  assert.equal(result.checks.length,1);
  assert.equal(result.checks[0].status,'passed');
  assert.equal(result.checks[0].readerPackage,'reader');
  assert.equal(result.checks[0].fixturePackage,'producer');
});

test('a reader refusing a newer major names the package to update', async () => {
  const result=await contracts.checkContracts({declarations:[declaration('older-reader','both'),declaration('new-producer','produces',[{export:'new-producer/v2',expect:'accept'}])],readers:{example:bytes=>{const result=contracts.validatePolicy(JSON.parse(new TextDecoder().decode(bytes)));return {accepted:result.valid,code:result.diagnostics[0]?.code};}},loadFixture:()=>new TextEncoder().encode('{"schema":"urn:aihq:core:execution-policy:2.0.0"}')});
  assert.equal(result.ok,false);
  assert.equal(result.checks[0].status,'failed');
  assert.equal(result.checks[0].updatePackage,'older-reader');
  assert.equal(result.checks[0].actual.code,'SCHEMA_UNSUPPORTED');
});
test('refusal code must match; missing reader, fixture references and bytes are unavailable', async () => {
  const producer=declaration('producer','produces',[{export:'producer/no',expect:'refuse',code:'INPUT_INVALID'}]);
  const run=(readers,loadFixture=()=>bytes,p=producer)=>contracts.checkContracts({declarations:[declaration('reader','accepts'),p],readers,loadFixture});
  assert.equal((await run({example:()=>({accepted:false,code:'INPUT_INVALID'})})).ok,true);
  assert.equal((await run({example:()=>({accepted:false,code:'OTHER'})})).checks[0].status,'failed');
  for(const result of [await run({}),await run({example:()=>({accepted:true})},()=> 'unavailable'),await run({example:()=>({accepted:true})},()=>bytes,declaration('producer','produces'))]) {
    assert.equal(result.ok,false); assert.equal(result.checks[0].status,'unavailable');
  }
});
test('unknown fields identify their escaped JSON pointer; unsupported formats list exact supported IDs', () => {
  const result=contracts.validatePolicy({schema:'urn:aihq:core:execution-policy:1.0.0',mode:'vibe',selections:[],'unknown/~':true});
  assert.ok(result.diagnostics.some(d=>d.path==='/unknown~1~0'));
  const future='urn:aihq:core:execution-policy:2.0.0';
  const unsupported=contracts.validatePolicy({schema:future});
  assert.equal(unsupported.diagnostics[0].encountered,future);
  assert.equal(unsupported.diagnostics[0].path,'/schema');
  assert.ok(unsupported.diagnostics[0].supported.includes('urn:aihq:core:execution-policy:1.3.0'));
});

test('every other producing declaration fixture is required, including declarations in the same distribution', async () => {
  const fixtures=[{export:'producer/yes',expect:'accept'},{export:'producer/no',expect:'refuse'}];
  const declarations=[declaration('same-package','accepts'),declaration('same-package','both',fixtures),declaration('third','accepts',fixtures)];
  const result=await contracts.checkContracts({declarations,readers:{example:bytes=>({accepted:bytes[0]===1})},loadFixture:(_name,ref)=>new Uint8Array([ref.endsWith('yes')?1:0])});
  assert.equal(result.ok,true,'accepts-only declarations do not contribute producer checks');
  assert.equal(result.checks.length,4);
  assert.ok(result.checks.every(c=>c.status==='passed'));
});
test('adapter exceptions, absent bytes, malformed results and invalid support are never passes', async () => {
  const declarations=[declaration('reader','accepts'),declaration('producer','produces',[{export:'producer/yes',expect:'accept'}])];
  for(const [reader,loader,status] of [
    [()=>{throw Error('reader');},()=>bytes,'failed'],
    [()=>({accepted:'yes'}),()=>bytes,'failed'],
    [()=>({accepted:true}),()=>{throw Error('missing');},'unavailable'],
    [()=>({accepted:true}),()=>undefined,'unavailable']]) {
    const result=await contracts.checkContracts({declarations,readers:{example:reader},loadFixture:loader});
    assert.equal(result.ok,false); assert.equal(result.checks[0].status,status);
  }
  const result=await contracts.checkContracts({declarations:[{...declarations[0],unknown:true}],readers:{},loadFixture:()=>bytes});
  assert.equal(result.ok,false); assert.equal(result.diagnostics[0].path,'/unknown');
});

test('native format refusals name supported versions and retain unknown-field JSON paths', () => {
  const future='urn:aihq:core:native-verification-request:2.0.0';
  const refused=contracts.validateNativeVerificationRequest({schema:future,client:'claude'});
  assert.equal(refused.diagnostics[0].encountered,future);
  assert.deepEqual(refused.diagnostics[0].supported,['urn:aihq:core:native-verification-request:1.0.0']);
  const unknown=contracts.validateNativeVerificationRequest({schema:'urn:aihq:core:native-verification-request:1.0.0',client:'claude','unknown/~':true});
  assert.ok(unknown.diagnostics.some(d=>d.path==='/unknown~1~0'));
});
