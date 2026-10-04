import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { prepare, apply, prepareManagedRemoval, listManagedSelections } from '../dist/core/index.js';
import { policy } from './fixture.mjs';
import { validateRunResult12, validatePreparedWork12, validateTrustCustody } from '../dist/core/contracts.js';
import { trustCapabilities, selectTrustCell } from '../dist/harness/contracts.mjs';
import { detectTrustPlatform } from '../dist/harness/trust.mjs';
const platform=detectTrustPlatform();
const admitted=!!platform.release && selectTrustCell({definitionId:'certificate-export',route:'export',target:null,platform,network:'declared',format:'pem'},trustCapabilities).status==='admitted';
const testExport=(name,fn)=>test(name,{skip:!admitted?'Exact installed export format capability unavailable on this host.':false},fn);
const originalRename=fs.renameSync;
const originalLink=fs.linkSync;
const originalRemove=fs.rmSync;
const previous={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE};let scratch;
function setup(){scratch=fs.mkdtempSync(join(tmpdir(),'aih-trust-custody-'));const home=join(scratch,'home');fs.mkdirSync(home);
  process.env.HOME=home;process.env.USERPROFILE=home;const file=join(scratch,'team.pem');fs.copyFileSync(new URL('./fixtures/root-a.pem',import.meta.url),file);
  return {home,file,output:join(home,'.aih','exports','os-ca.pem'),state:join(home,'.aih','core')};}
afterEach(()=>{fs.renameSync=originalRename;fs.linkSync=originalLink;fs.rmSync=originalRemove;syncBuiltinESMExports();for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
  if(scratch)fs.rmSync(scratch,{recursive:true,force:true});});
const request=file=>({schema:'urn:aihq:core:certificate-export-request:1.0.0',useCase:'certificate-export',sources:{os:false,supplied:[{id:'team',file}]}});
const approve=p=>({approved:true,origin:'automation',reviewDigest:p.review.reviewDigest});
function injectRename(predicate,action){fs.renameSync=(from,to)=>{if(predicate(to))return action(from,to);return originalRename(from,to);};syncBuiltinESMExports();}

async function pendingFixture(boundary) {
  const fixture=setup();const p=await prepare(request(fixture.file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p.diagnostics));
  if(boundary==='no output') {fs.linkSync=(from,to)=>{if(to===fixture.output)throw new Error('injected output failure');return originalLink(from,to);};syncBuiltinESMExports();}
  else injectRename(to=>fs.existsSync(fixture.output)&&(boundary==='receipt missing'?/^[a-f0-9]{64}\.json$/.test(basename(to)):basename(to)==='trust-custody.json'),()=>{throw new Error('injected custody failure');});
  const r=await apply(p.prepared,approve(p),{logging:'off'});fs.linkSync=originalLink;fs.renameSync=originalRename;syncBuiltinESMExports();
  assert.equal(r.completion,'incomplete');assert.equal(fs.existsSync(join(fixture.state,'trust-custody-pending.json')),true);
  return {...fixture,managementId:p.review.inputs.trust.outputs[0].managementId};
}

for(const malformed of ['duplicate','excess'])testExport(`malformed ${malformed} pending context references fail closed before snapshot IO`,async()=>{
  const {file,state,output}=await pendingFixture('no output');const intentPath=join(state,'trust-custody-pending.json');
  const intent=JSON.parse(fs.readFileSync(intentPath));
  const context={reference:intent.after,sha256:intent.afterSha256};
  intent.contexts=malformed==='duplicate'?[context,context]:[context,
    {reference:intent.before,sha256:intent.beforeSha256},
    {reference:'recovery/00000000-0000-0000-0000-000000000000/trust-before.json',sha256:intent.beforeSha256}];
  fs.writeFileSync(intentPath,JSON.stringify(intent));const before=fs.readFileSync(intentPath);
  const read=fs.readFileSync;let contextReads=0;
  fs.readFileSync=(path,...args)=>{if(String(path).endsWith('trust-before.json')||String(path).endsWith('trust-after.json'))contextReads++;return read(path,...args);};
  syncBuiltinESMExports();let p;
  try {p=await prepare(request(file),{logging:'off'});}finally {fs.readFileSync=read;syncBuiltinESMExports();}
  assert.equal(p.status,'blocked',JSON.stringify(p));assert.ok(p.diagnostics.some(d=>d.reason==='trust-custody-conflict'));
  assert.equal(contextReads,0);assert.deepEqual(fs.readFileSync(intentPath),before);assert.equal(fs.existsSync(output),false);
});
testExport('fresh reviewed orphan removal clears a failed no-output intent without publishing an output',async()=>{
  const {home,output,state,managementId}=await pendingFixture('no output');const before=fs.readFileSync(join(state,'trust-custody-pending.json'));
  const removal=await prepareManagedRemoval({target:{project:home},managementId,scope:'user',mode:'vibe'},{logging:'off'});
  assert.equal(removal.disposition,'prepared',JSON.stringify(removal));assert.equal(removal.preparation.status,'ready');
  assert.deepEqual(fs.readFileSync(join(state,'trust-custody-pending.json')),before);assert.equal(fs.existsSync(output),false);
  const inventory=await listManagedSelections({target:{project:home},scope:'user'});assert.equal(inventory.status,'incomplete');
  assert.ok(inventory.selections.some(s=>s.managementId===managementId&&s.custody==='legacy-reconcile'));
  assert.equal((await apply(removal.preparation.prepared,approve(removal.preparation),{logging:'off'})).completion,'complete');
  assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),false);assert.equal(fs.existsSync(output),false);
});
testExport('explicit pending source removal survives a second output failure without resurrecting the old source',async()=>{
  const {file,output,state}=await pendingFixture('provenance missing');fs.rmSync(file);
  const replacement=join(scratch,'replacement.pem');fs.copyFileSync(new URL('./harness/fixtures/root-b.pem',import.meta.url),replacement);
  const edited={...request(file),sources:{os:false,supplied:[{id:'replacement',file:replacement}],removeSupplied:['team']}};
  const unknown=await prepare({...edited,sources:{...edited.sources,removeSupplied:['unrecorded']}},{logging:'off'});
  assert.equal(unknown.status,'invalid');assert.ok(unknown.diagnostics.some(d=>d.reason==='invalid-source-selection'));
  const conflict=await prepare(edited,{logging:'off'});const hint=conflict.resolutionInputs[0];assert.ok(hint,JSON.stringify(conflict.diagnostics));
  const first=await prepare({...edited,resolutions:[{selectionId:hint.selectionId,operationId:hint.operationId,choice:'replace',observedSha256:hint.observedSha256}]},{logging:'off'});
  assert.equal(first.status,'ready',JSON.stringify(first.diagnostics));const original=JSON.parse(fs.readFileSync(join(state,'trust-custody-pending.json')));
  injectRename(to=>to===output,()=>{throw new Error('second output publication failure');});
  assert.equal((await apply(first.prepared,approve(first),{logging:'off'})).completion,'incomplete');fs.renameSync=originalRename;syncBuiltinESMExports();
  assert.equal(fs.existsSync(join(state,original.before)),true);assert.equal(fs.existsSync(join(state,original.after)),true);
  const active=JSON.parse(fs.readFileSync(join(state,'trust-custody-pending.json')));
  const referenced=[...new Set([active.before,active.after,...(active.contexts??[]).map(c=>c.reference)])];
  const failedCopy=active.before.replace('-before.json','-reconciled-intent.json');
  assert.equal(fs.existsSync(join(state,failedCopy)),true);
  const unrelated=join(state,'recovery',active.transactionId,'unrelated.txt');fs.writeFileSync(unrelated,'preserve unrelated evidence');
  const freshInput={...request(replacement),sources:{os:false,supplied:[{id:'replacement',file:replacement}]}};
  const retry=await prepare(freshInput,{logging:'off'});const retryHint=retry.resolutionInputs[0];assert.ok(retryHint,JSON.stringify(retry.diagnostics));
  const fresh=await prepare({...freshInput,resolutions:[{selectionId:retryHint.selectionId,operationId:retryHint.operationId,choice:'replace',observedSha256:retryHint.observedSha256}]},{logging:'off'});
  assert.equal(fresh.status,'ready',JSON.stringify(fresh.diagnostics));assert.deepEqual(fresh.review.inputs.trust.sources.map(s=>s.id),['supplied:replacement']);
  const r=await apply(fresh.prepared,approve(fresh),{logging:'off'});assert.equal(r.completion,'complete',JSON.stringify(r.diagnostics));
  assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),false);
  for(const reference of referenced)assert.equal(fs.existsSync(join(state,reference)),false,`active staging retained: ${reference}`);
  for(const suffix of ['before','after','reconciled-intent'])assert.equal(fs.existsSync(join(state,'recovery',r.runId,`trust-${suffix}.json`)),false,`current staging retained: ${suffix}`);
  for(const reference of [original.before,original.after].filter(path=>!referenced.includes(path)))assert.equal(fs.existsSync(join(state,reference)),true,'unreferenced failed-run evidence removed');
  assert.equal(fs.existsSync(join(state,failedCopy)),true);assert.equal(fs.readFileSync(unrelated,'utf8'),'preserve unrelated evidence');
});

testExport('no-effects cancellation restores original intent and removes redundant reconciliation staging',async()=>{
  const {file,state}=await pendingFixture('receipt missing');const intentPath=join(state,'trust-custody-pending.json');const original=fs.readFileSync(intentPath);
  const pending=JSON.parse(original),snapshots=[pending.before,pending.after].map(reference=>({reference,bytes:fs.readFileSync(join(state,reference))}));
  const conflict=await prepare(request(file),{logging:'off'});const hint=conflict.resolutionInputs[0];assert.ok(hint);
  const fresh=await prepare({...request(file),resolutions:[{selectionId:hint.selectionId,operationId:hint.operationId,choice:'replace',observedSha256:hint.observedSha256}]},{logging:'off'});
  assert.equal(fresh.status,'ready',JSON.stringify(fresh.diagnostics));const controller=new AbortController();let fired=false;
  fs.linkSync=(from,to)=>{const value=originalLink(from,to);if(basename(to)==='trust-reconciled-intent.json'){fired=true;controller.abort();}return value;};syncBuiltinESMExports();
  const r=await apply(fresh.prepared,approve(fresh),{logging:'off',signal:controller.signal});fs.linkSync=originalLink;syncBuiltinESMExports();
  assert.equal(fired,true);assert.equal(r.completion,'cancelled',JSON.stringify(r));assert.ok(r.operations.every(o=>o.application==='not-attempted'));
  assert.deepEqual(fs.readFileSync(intentPath),original);for(const snapshot of snapshots)assert.deepEqual(fs.readFileSync(join(state,snapshot.reference)),snapshot.bytes);
  for(const suffix of ['before','after','reconciled-intent'])assert.equal(fs.existsSync(join(state,'recovery',r.runId,`trust-${suffix}.json`)),false,`redundant staging retained: ${suffix}`);
});
testExport('one-path restoration or removal cannot discharge another output in an aggregate pending intent',async()=>{
  const {home,file,state,managementId}=await pendingFixture('no output');const intentPath=join(state,'trust-custody-pending.json');
  const intent=JSON.parse(fs.readFileSync(intentPath)),afterPath=join(state,intent.after),after=JSON.parse(fs.readFileSync(afterPath));
  const second=structuredClone(after.entries[0]);second.relativePath='other/out.pem';second.pathKey=JSON.stringify({home,segments:['other','out.pem']});
  second.managementId=`ca-export-${createHash('sha256').update(second.pathKey).digest('hex')}`;
  after.entries.push(second);after.entries.sort((a,b)=>a.pathKey<b.pathKey?-1:a.pathKey>b.pathKey?1:0);const bytes=Buffer.from(JSON.stringify(after));fs.writeFileSync(afterPath,bytes);
  intent.afterSha256=createHash('sha256').update(bytes).digest('hex');intent.outputs.push({pathKey:second.pathKey,oldSha256:null,newSha256:second.outputSha256});
  fs.writeFileSync(intentPath,JSON.stringify(intent));const original=fs.readFileSync(intentPath);
  const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'blocked');assert.ok(p.diagnostics.some(d=>d.reason==='trust-custody-pending'));
  const removal=await prepareManagedRemoval({target:{project:home},managementId,scope:'user',mode:'vibe'},{logging:'off'});
  assert.equal(removal.disposition,'unavailable');assert.deepEqual(fs.readFileSync(intentPath),original);
});
for(const boundary of ['receipt missing','provenance missing'])testExport(`fresh exact replacement reconciles ${boundary} without replaying snapshot sources`,async()=>{
  const {file,output,state}=await pendingFixture(boundary);const intent=fs.readFileSync(join(state,'trust-custody-pending.json'));
  const implicit=await prepare({...request(file),sources:{os:false,supplied:[]}},{logging:'off'});assert.equal(implicit.status,'blocked');
  const conflict=await prepare(request(file),{logging:'off'});assert.equal(conflict.status,'blocked',JSON.stringify(conflict.diagnostics));
  assert.equal(conflict.diagnostics[0].reason,'trust-output-conflict');const hint=conflict.resolutionInputs[0];assert.deepEqual(hint.availableChoices,['replace']);
  const p=await prepare({...request(file),resolutions:[{selectionId:hint.selectionId,operationId:hint.operationId,choice:'replace',observedSha256:hint.observedSha256}]},{logging:'off'});
  assert.equal(p.status,'ready',JSON.stringify(p.diagnostics));assert.deepEqual(fs.readFileSync(join(state,'trust-custody-pending.json')),intent);
  const r=await apply(p.prepared,approve(p),{logging:'off'});assert.equal(r.completion,'complete',JSON.stringify(r.diagnostics));
  assert.equal(r.trust.outputs.length,1);assert.equal(fs.existsSync(output),true);assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),false);
  assert.equal(validateRunResult12(r).valid,true);
});

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
  const next=await prepare({...request(file),sources:{os:false,supplied:[]}},{logging:'off'});assert.equal(next.status,'blocked');assert.ok(next.diagnostics.some(d=>d.reason==='trust-custody-pending'));
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
  const cancelledIntent=JSON.parse(fs.readFileSync(join(state,'trust-custody-pending.json')));
  for(const reference of [cancelledIntent.before,cancelledIntent.after])assert.equal(fs.existsSync(join(state,reference)),true);
  fs.renameSync=originalRename;syncBuiltinESMExports();
  const fresh=await prepare(request(file),{logging:'off'});assert.equal(fresh.status,'ready',JSON.stringify(fresh.diagnostics));
  assert.equal((await apply(fresh.prepared,approve(fresh),{logging:'off'})).completion,'complete');
  assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),false);
});

testExport('fresh review reconciles a completed custody pair whose final intent cleanup failed',async()=>{
  const {file,state}=setup();const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready');
  fs.rmSync=(path,options)=>{if(basename(path)==='trust-custody-pending.json')throw new Error('injected cleanup failure');return originalRemove(path,options);};syncBuiltinESMExports();
  const r=await apply(p.prepared,approve(p),{logging:'off'});assert.equal(r.completion,'incomplete');
  fs.rmSync=originalRemove;syncBuiltinESMExports();const original=fs.readFileSync(join(state,'trust-custody-pending.json'));
  const fresh=await prepare(request(file),{logging:'off'});assert.equal(fresh.status,'ready',JSON.stringify(fresh.diagnostics));
  assert.deepEqual(fs.readFileSync(join(state,'trust-custody-pending.json')),original);
  assert.equal((await apply(fresh.prepared,approve(fresh),{logging:'off'})).completion,'complete');assert.equal(fs.existsSync(join(state,'trust-custody-pending.json')),false);
});

for(const drift of ['intent','snapshot','live output'])testExport(`pending reconciliation ${drift} drift after fresh review rejects without clearing evidence`,async()=>{
  const {file,output,state}=await pendingFixture('receipt missing');const conflict=await prepare(request(file),{logging:'off'});const hint=conflict.resolutionInputs[0];
  assert.ok(hint,JSON.stringify(conflict.diagnostics));const fresh=await prepare({...request(file),resolutions:[{...hint,choice:'replace',availableChoices:undefined}].map(({availableChoices,...r})=>r)},{logging:'off'});
  assert.equal(fresh.status,'ready',JSON.stringify(fresh.diagnostics));const intentPath=join(state,'trust-custody-pending.json');const intent=JSON.parse(fs.readFileSync(intentPath));
  if(drift==='live output')fs.writeFileSync(output,'replacement user bytes');
  else fs.appendFileSync(drift==='intent'?intentPath:join(state,intent.after),' ');
  const r=await apply(fresh.prepared,approve(fresh),{logging:'off'});assert.equal(r.completion,'rejected',JSON.stringify(r.diagnostics));
  assert.ok(r.diagnostics.some(d=>d.code==='REVIEW_STALE'));assert.equal(fs.existsSync(intentPath),true);assert.deepEqual(r.trust.outputs,[]);
  for(const reference of [intent.before,intent.after,...(intent.contexts??[]).map(c=>c.reference)])assert.equal(fs.existsSync(join(state,reference)),true);
  if(drift==='live output') {
    assert.equal(fs.readFileSync(output,'utf8'),'replacement user bytes');const next=await prepare(request(file),{logging:'off'});
    assert.equal(next.status,'blocked');assert.deepEqual(next.resolutionInputs,[]);
  }
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
