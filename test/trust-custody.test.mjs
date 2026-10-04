import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { prepare, apply, prepareManagedRemoval } from '../dist/core/index.js';
import { policy } from './fixture.mjs';
import { validateRunResult12, validatePreparedWork12, validateTrustCustody } from '../dist/core/contracts.js';
import { trustCapabilities, selectTrustCell } from '../dist/harness/contracts.mjs';
import { detectTrustPlatform } from '../dist/harness/trust.mjs';
const platform=detectTrustPlatform();
const admitted=!!platform.release && selectTrustCell({definitionId:'certificate-export',route:'export',target:null,platform,network:'declared',format:'pem'},trustCapabilities).status==='admitted';
const testExport=(name,fn)=>test(name,{skip:!admitted?'Exact installed export format capability unavailable on this host.':false},fn);
const originalRename=fs.renameSync;
const originalLink=fs.linkSync;
const previous={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE};let scratch;
function setup(){scratch=fs.mkdtempSync(join(tmpdir(),'aih-trust-custody-'));const home=join(scratch,'home');fs.mkdirSync(home);
  process.env.HOME=home;process.env.USERPROFILE=home;const file=join(scratch,'team.pem');fs.copyFileSync(new URL('./fixtures/root-a.pem',import.meta.url),file);
  return {home,file,output:join(home,'.aih','exports','os-ca.pem'),state:join(home,'.aih','core')};}
afterEach(()=>{fs.renameSync=originalRename;fs.linkSync=originalLink;syncBuiltinESMExports();for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
  if(scratch)fs.rmSync(scratch,{recursive:true,force:true});});
const request=file=>({schema:'urn:aihq:core:certificate-export-request:1.0.0',useCase:'certificate-export',sources:{os:false,supplied:[{id:'team',file}]}});
const approve=p=>({approved:true,origin:'automation',reviewDigest:p.review.reviewDigest});
function injectRename(predicate,action){fs.renameSync=(from,to)=>{if(predicate(to))return action(from,to);return originalRename(from,to);};syncBuiltinESMExports();}

testExport('mandatory pending-intent staging failure rejects before output effects',async()=>{
  const {file,output,state}=setup();const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p.diagnostics));let fired=false;
  fs.linkSync=(from,to)=>{if(basename(to)==='trust-custody-pending.json'){fired=true;throw Object.assign(new Error('injected staging failure'),{code:'EIO'});}return originalLink(from,to);};syncBuiltinESMExports();
  const r=await apply(p.prepared,approve(p),{logging:'off'});assert.equal(fired,true);assert.equal(r.completion,'rejected',JSON.stringify(r.diagnostics));
  assert.equal(fs.existsSync(output),false);assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),false);assert.deepEqual(r.trust.outputs,[]);
});

testExport('failed output publication reports uncertainty with protected pending evidence',async()=>{
  const {file,output,state}=setup();const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p.diagnostics));let fired=false;
  fs.linkSync=(from,to)=>{if(to===output){fired=true;throw Object.assign(new Error('injected output failure'),{code:'EIO'});}return originalLink(from,to);};syncBuiltinESMExports();
  const r=await apply(p.prepared,approve(p),{logging:'off'});assert.equal(fired,true);assert.equal(r.completion,'incomplete',JSON.stringify(r.diagnostics));
  assert.equal(fs.existsSync(output),false);assert.deepEqual(r.trust.outputs,[]);assert.ok(r.operations.some(o=>o.application==='failed'&&o.effectsUncertain));
  assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),true);
});

for(const boundary of ['ordinary receipt','trust provenance'])testExport(`failure after output at ${boundary} leaves pending custody and no successful output`,async()=>{
  const {home,file,output,state}=setup();const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p));let fired=false;
  injectRename(to=>fs.existsSync(output)&&(boundary==='ordinary receipt'?/^[a-f0-9]{64}\.json$/.test(basename(to)):basename(to)==='trust-custody.json'),()=>{fired=true;throw Object.assign(new Error('injected write failure'),{code:'EIO'});});
  const r=await apply(p.prepared,approve(p),{logging:'off'});fs.renameSync=originalRename;syncBuiltinESMExports();
  assert.equal(fired,true);assert.equal(r.completion,'incomplete',JSON.stringify(r));assert.equal(fs.existsSync(output),true);assert.deepEqual(r.trust.outputs,[]);
  assert.equal(validateRunResult12(r).valid,true,JSON.stringify(validateRunResult12(r).diagnostics));assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),true);
  const next=await prepare(request(file),{logging:'off'});assert.equal(next.status,'blocked');assert.ok(next.diagnostics.some(d=>d.reason==='trust-custody-pending'));
  assert.equal(validatePreparedWork12(next.review).valid,true,JSON.stringify(validatePreparedWork12(next.review).diagnostics));
  const project=join(home,'project');fs.mkdirSync(project);const unrelated=await prepare({useCase:'policy',target:{project},policy:policy()},{logging:'off'});
  assert.equal(unrelated.status,'ready',JSON.stringify(unrelated));assert.equal((await apply(unrelated.prepared,approve(unrelated),{logging:'off'})).completion,'complete');
  const absent=await prepareManagedRemoval({target:{project},managementId:'unrelated-absent',scope:'user',mode:'vibe'},{logging:'off'});assert.equal(absent.disposition,'absent',JSON.stringify(absent));
});

testExport('cancellation after output publication preserves pending state without claiming a successful output',async()=>{
  const {file,output,state}=setup();const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p));const controller=new AbortController();let fired=false;
  injectRename(to=>fs.existsSync(output)&&/^[a-f0-9]{64}\.json$/.test(basename(to)),(from,to)=>{const value=originalRename(from,to);fired=true;controller.abort();return value;});
  const r=await apply(p.prepared,approve(p),{logging:'off',signal:controller.signal});
  assert.equal(fired,true);assert.equal(r.completion,'cancelled',JSON.stringify(r));assert.deepEqual(r.trust.outputs,[]);assert.equal(fs.existsSync(output),true);
  assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),true);assert.equal(validateRunResult12(r).valid,true,JSON.stringify(validateRunResult12(r).diagnostics));
});

testExport('cancelled approval cleans private staging and a consumed handle remains a 1.2 rejection',async()=>{
  const {file,output,state}=setup();const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p));const controller=new AbortController();controller.abort();
  const invalid=await apply(p.prepared,approve(p),{logging:'invalid'});assert.equal(invalid.completion,'rejected');
  assert.equal(validateRunResult12(invalid).valid,true,JSON.stringify(validateRunResult12(invalid).diagnostics));
  const r=await apply(p.prepared,approve(p),{logging:'off',signal:controller.signal});assert.equal(r.completion,'cancelled');assert.equal(fs.existsSync(output),false);
  assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),false);
  const work=join(state,'work');assert.equal(fs.existsSync(work)&&fs.readdirSync(work).some(name=>fs.existsSync(join(work,name,'trust-material'))),false);
  const again=await apply(p.prepared,approve(p),{logging:'off'});assert.equal(again.schema,'urn:aihq:core:run-result:1.2.0');assert.equal(again.completion,'rejected');
  assert.equal(validateRunResult12(again).valid,true,JSON.stringify(validateRunResult12(again).diagnostics));
});

testExport('mandatory sidecar tamper after review rejects before output effects',async()=>{
  const {file,output,state}=setup();const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p));
  fs.writeFileSync(join(state,'trust-custody.json'),'{}',{mode:0o600});const r=await apply(p.prepared,approve(p),{logging:'off'});
  assert.equal(r.completion,'rejected',JSON.stringify(r));assert.ok(r.diagnostics.some(d=>d.code==='REVIEW_STALE'));assert.equal(fs.existsSync(output),false);assert.deepEqual(r.trust.outputs,[]);
});

testExport('aggregate provenance overflow blocks Prepare before another output is created',async()=>{
  const {home,file,state}=setup();const first=await prepare(request(file),{logging:'off'});assert.equal(first.status,'ready',JSON.stringify(first));
  assert.equal((await apply(first.prepared,approve(first),{logging:'off'})).completion,'complete');
  const path=join(state,'trust-custody.json');const image=JSON.parse(fs.readFileSync(path));const template=image.entries[0];const limit=1_048_576;
  const sort=()=>image.entries.sort((a,b)=>a.pathKey<b.pathKey?-1:a.pathKey>b.pathKey?1:0);
  const bytes=()=>Buffer.byteLength(JSON.stringify(image));let index=0;
  // Independent stored-state fixture: retained entries occupy the aggregate budget.
  while(limit-bytes()>6200){const relativePath=`archive/${String(index++).padStart(4,'0')}/root.pem`;
    image.entries.push({...template,managementId:`archive-${index}`,relativePath,pathKey:JSON.stringify({home,segments:relativePath.split('/')}),
      sources:[{...template.sources[0],fingerprints:[...template.sources[0].fingerprints],privateFile:'/'+ 'x'.repeat(4095),runtimeVersion:'v'.repeat(512)}]});}
  const relativePath=`archive/${String(index).padStart(4,'0')}/root.pem`;const filler={...template,managementId:`archive-${index+1}`,relativePath,
    pathKey:JSON.stringify({home,segments:relativePath.split('/')}),sources:[{...template.sources[0],fingerprints:[...template.sources[0].fingerprints],privateFile:'/',runtimeVersion:null}]};image.entries.push(filler);sort();
  let remaining=limit-64-bytes();assert.ok(remaining>=0);
  // Fill only within documented field bounds; fingerprint padding covers the remaining budget.
  let n=0;while(remaining>4095){filler.sources[0].fingerprints.push((++n).toString(16).padStart(64,'0'));filler.sources[0].fingerprints.sort();remaining=limit-64-bytes();}
  filler.sources[0].privateFile='/'+ 'x'.repeat(remaining);assert.equal(bytes(),limit-64);
  const boundary=JSON.parse(JSON.stringify(image));const boundarySource=boundary.entries.find(e=>e.managementId===filler.managementId).sources[0];
  boundarySource.runtimeVersion='v'.repeat(66);assert.equal(Buffer.byteLength(JSON.stringify(boundary)),limit);
  assert.equal(validateTrustCustody(boundary).valid,true,JSON.stringify(validateTrustCustody(boundary).diagnostics));
  boundarySource.runtimeVersion+='v';assert.equal(Buffer.byteLength(JSON.stringify(boundary)),limit+1);assert.equal(validateTrustCustody(boundary).valid,false);
  assert.equal(validateTrustCustody(image).valid,true,JSON.stringify(validateTrustCustody(image).diagnostics));fs.writeFileSync(path,JSON.stringify(image),{mode:0o600});
  const p=await prepare({...request(file),output:'other/new.pem'},{logging:'off'});assert.equal(p.status,'blocked',JSON.stringify(p));
  assert.ok(p.diagnostics.some(d=>d.code==='SOURCE_LIMIT'&&d.reason==='custody-record-limit'));assert.equal(fs.existsSync(join(home,'other','new.pem')),false);
  assert.equal(fs.statSync(path).size,limit-64);assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),false);
});

test('unknown trust controls and pre-aborted preparation have no output effects',async()=>{
  const {file,output}=setup();const unknown=await prepare(request(file),{logging:'off',materialRoots:{}});assert.equal(unknown.status,'invalid');assert.equal(unknown.review,undefined);
  const controller=new AbortController();controller.abort();const cancelled=await prepare(request(file),{logging:'off',signal:controller.signal});assert.equal(cancelled.status,'cancelled');assert.equal(fs.existsSync(output),false);
});
