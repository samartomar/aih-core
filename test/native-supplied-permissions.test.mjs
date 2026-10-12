import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as installed from '../src/harness/native/runtime.mjs';
import {validateNativeVerificationBundle,validateNativeVerificationResult} from '@aihq/core/contracts';

const hash=installed.sha256, canonical=installed.canonicalJson;
const treeHash=files => hash(canonical(files.map(({root,path,member}) => ({root,path,sha256:member.sha256,byteLength:member.byteLength})).sort((a,b) => a.root < b.root ? -1 : a.root > b.root ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
function archiveMembers(entries) {
  const chunks=[];
  for (const [name,bytes] of entries) {
    const header=Buffer.alloc(512); header.write(name,0,100); header.write('0000600\0',100);
    header.write('0000000\0',108); header.write('0000000\0',116); header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);
    header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257);
    header.write(header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}

// Real public Core acquisition/staging/persistence and installed Harness derivation.
// Only host observations and session receipts are controlled: no process/provider is started.
async function controlled(t,scenario='healthy') {
  const directory=realpathSync.native(mkdtempSync(join(tmpdir(),'aih-supplied-permissions-')));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const root=fileURLToPath(new URL('../',import.meta.url));
  cpSync(join(root,'dist'),join(directory,'dist'),{recursive:true}); cpSync(join(root,'package.json'),join(directory,'package.json'));
  symlinkSync(join(root,'node_modules'),join(directory,'node_modules'),process.platform==='win32'?'junction':'dir');
  const native=join(directory,'dist','harness','native');
  cpSync(join(native,'runtime.mjs'),join(native,'runtime-installed.mjs'));
  const recordPath=join(directory,'observed.json');
  const wrapper=`import * as installed from './runtime-installed.mjs';
import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {release} from 'node:os';
export * from './runtime-installed.mjs';
export function createNativeRuntime(_module,dependencies) {
 const runtime=installed.createNativeRuntime(installed,dependencies), scenario=${JSON.stringify(scenario)}, recordPath=${JSON.stringify(recordPath)};
 const observations={resolutions:0,sessions:[]}; const save=()=>writeFileSync(recordPath,JSON.stringify(observations)); save();
 const original=runtime.nativeDefinitions.find(d=>d.platform.os==='win32');
 const definition={...original,platform:{os:process.platform,arch:process.arch,execution:'native',osRelease:release()},state:'candidate',evidenceSha256:null};
 runtime.nativeDefinitions=[definition]; runtime.nativeManagedRestriction=()=>scenario==='managed';
 runtime.resolveNativeClient=async()=>{observations.resolutions++;save();return {executable:process.execPath,sha256:installed.sha256(readFileSync(process.execPath)),observedVersion:definition.clientVersions[0],argv:[],runtime:[]};};
 runtime.revalidateNativeClient=()=>true; runtime.nativeCapabilities=()=>({lifecycle:true,peerIdentity:true,credentialChannel:true});
 runtime.captureNativeIdentity=async binding=>({credential:Buffer.from('synthetic controlled credential'),expected:binding.expected,sourceIdentity:null});
 runtime.revalidateNativeIdentity=()=>true; runtime.protectNativeCell=async()=>true;
 runtime.startNativeSession=async input=>{
   const path=join(input.cell.home,'.claude','settings.json'), bytes=readFileSync(path);
   observations.sessions.push({settings:JSON.parse(bytes),settingsSha256:installed.sha256(bytes),guardrails:input.guardrails});save();
   if (scenario==='tamper' && input.index===1) writeFileSync(path,bytes+' ');
   if (scenario==='client-grant' && input.index===1) writeFileSync(join(input.cell.home,'.claude','.claude.json'),JSON.stringify({projects:{[input.cell.project]:{enabledMcpjsonServers:[input.material.server.name]}}}));
   const server=input.material.server;
   return {pid:process.pid,argv:[process.execPath],cleanup:async()=>({confirmed:true,survivors:[]}),observations:Promise.resolve({
     sessionId:'00000000-0000-4000-8000-00000000000'+input.index,resumed:false,loading:'observed',restrictions:'observed',authentication:'matched',
     discovery:{complete:true,clientTools:server.toolNames,serverList:true},serverPeerBound:true,
     instructions:{nativeSha256:[],attestations:input.material.instructions.map(i=>({markerSha256:i.markerSha256,challengeMatched:true,clientReceipt:true})),rejected:false,alternateRead:false},
     query:{correlated:true,challengeMatched:true,resultSha256:server.expectedResultSha256,answerSha256:installed.sha256(server.expectedAnswer)},isolation:'unobservable',
     usage:{turns:2,estimatedCostUsd:0.125},counts:{observedBytes:0,telemetryEvents:0,rpcMessages:0}})};
 };
 return runtime;
}`;
  writeFileSync(join(native,'runtime.mjs'),wrapper);
  writeFileSync(join(directory,'entry.mjs'),"export {verifyNativeClient} from '@aihq/core';");
  const runtime=installed.createNativeRuntime(installed,{readPinned(){throw Error('no process');},Stop:Error});
  const definition=runtime.nativeDefinitions.find(d=>d.platform.os==='win32'), bundled=runtime.nativeBundledFixture(definition,{check(){}});
  const outputTree=structuredClone(bundled.outputTree), bytes=new Map(bundled.bytes);
  const server={...bundled.server,name:scenario==='ambiguous'?'bad__alias':'aihq-graph-fixture',queryTool:'aihq_graph_callees',toolNames:['aihq_attest_instruction','aihq_graph_callees']};
  if(scenario==='extra-tool')server.toolNames.push('write_file');
  const configuration=outputTree.find(file=>file.path==='.mcp.json');
  const config={mcpServers:{[server.name]:{type:'stdio',command:'node',args:['.aihq-native/server.mjs']}}};
  if(scenario==='extra-server')config.mcpServers.other={command:'node',args:['other.mjs']};
  const configBytes=Buffer.from(JSON.stringify(config)); configuration.member.sha256=hash(configBytes);configuration.member.byteLength=configBytes.length;bytes.set(configuration.member.path,configBytes);
  const release=Buffer.from('{}'),recipe=Buffer.from('{}');
  const bundle={schema:'urn:aihq:core:native-verification-bundle:1.0.0',id:'controlled.supplied-permissions',client:'claude',adapterId:'claude-stream-json.v1',scope:'test-configuration',
    package:{name:'@aihq/controlled-native',version:'1.0.0'},release:{path:'package/release.json',sha256:hash(release),byteLength:release.length},
    selection:{itemId:'controlled',itemSha256:hash('{}'),recipe:{path:'package/recipe.json',sha256:hash(recipe),byteLength:recipe.length},inputs:{}},
    startingTree:[],startingTreeSha256:hash('[]'),outputTree,outputTreeSha256:treeHash(outputTree),instructions:bundled.instructions,server};
  assert.deepEqual(validateNativeVerificationBundle(bundle).diagnostics,[]);
  const manifest=Buffer.from(JSON.stringify(bundle)), manifestSha256=hash(manifest);
  const entries=[['package/m.json',manifest],['package/release.json',release],['package/recipe.json',recipe],...outputTree.map(file=>[file.member.path,bytes.get(file.member.path)])];
  const archive=archiveMembers(entries),archivePath=join(directory,'supplied.tar');writeFileSync(archivePath,archive);
  const cells=join(directory,'cells');mkdirSync(cells);
  const api=await import(pathToFileURL(join(directory,'entry.mjs')).href);
  const result=await api.verifyNativeClient({schema:'urn:aihq:core:native-verification-request:1.0.0',client:'claude',configuration:{kind:'supplied',input:'reviewed',bundleId:bundle.id,manifestSha256}},
    {maxTurns:20,maxEstimatedCostUsd:2,admission:'candidate-smoke',sandboxRoot:realpathSync.native(cells),testIdentity:{adapterId:'claude-oauth-otel.v1',provisionedRoot:directory,manifestSha256:'a'.repeat(64),expected:{accountUuid:'11111111-1111-4111-8111-111111111111',organizationId:'22222222-2222-4222-8222-222222222222'}},
      configurationSources:{reviewed:{archivePath,archiveSha256:hash(archive),archiveBytes:archive.length,manifestPath:'package/m.json',manifestSha256,manifestBytes:manifest.length}}});
  assert.deepEqual(validateNativeVerificationResult(result).diagnostics,[]);
  return {result,observed:JSON.parse(readFileSync(recordPath)),bundle,definition};
}

test('public supplied verification stages narrow user settings once across two fresh controlled sessions',async t=>{
  const {result,observed,bundle,definition}=await controlled(t);
  assert.equal(result.verdict,'unverified'); assert.equal(result.admission,'candidate-smoke'); assert.equal(result.sessions.length,2);
  assert.equal(result.security.sandbox.level,'hygiene-only'); assert.equal(result.cleanup.files,'removed');
  assert.equal(observed.resolutions,1); assert.equal(observed.sessions.length,2);
  const first=observed.sessions[0],settings=first.settings;
  assert.deepEqual(settings.permissions.allow,['mcp__aihq-graph-fixture__aihq_attest_instruction','mcp__aihq-graph-fixture__aihq_graph_callees']);
  assert.deepEqual(settings.enabledMcpjsonServers,['aihq-graph-fixture']);assert.equal(settings.enableAllProjectMcpServers,false);
  assert.deepEqual(observed.sessions[1],first);
  assert.equal(first.guardrails[0].member.sha256,first.settingsSha256);
  assert.equal(result.content.guardrailsSha256,treeHash(first.guardrails));assert.notEqual(result.content.guardrailsSha256,definition.guardrailsSha256);
  assert.equal(result.content.outputTreeSha256,bundle.outputTreeSha256);
  assert.equal(result.content.stagedConfigurationDigest,hash(canonical({outputTreeSha256:bundle.outputTreeSha256,guardrailsSha256:result.content.guardrailsSha256})));
});
for(const scenario of ['ambiguous','extra-tool','extra-server','managed'])test('public supplied verifier refuses before host/client resolution: '+scenario,async t=>{
  const {result,observed}=await controlled(t,scenario);
  assert.equal(observed.resolutions,0);assert.equal(observed.sessions.length,0);assert.equal(result.sessions.length,0);
  assert.ok(result.stages.some(row=>row.reason===(scenario==='managed'?'managed-restriction':'configuration-channel-unsupported')));
});
for(const scenario of ['tamper','client-grant'])test('supplied settings/state mutation stops before the second session: '+scenario,async t=>{
  const {result,observed}=await controlled(t,scenario);
  assert.equal(result.verdict,'failed');assert.equal(result.sessions.length,1);assert.equal(observed.sessions.length,1);
  assert.ok(result.stages.some(row=>row.reason==='configuration-changed'));assert.equal(result.cleanup.files,'removed');
});
