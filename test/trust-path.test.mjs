import { test,afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,copyFileSync,rmSync,readFileSync,existsSync,renameSync,symlinkSync,linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare,apply } from '../dist/core/index.js';
import { trustCapabilities,selectTrustCell } from '../dist/harness/contracts.mjs';
import { detectTrustPlatform } from '../dist/harness/trust.mjs';
const platform=detectTrustPlatform();const admitted=!!platform.release&&selectTrustCell({definitionId:'certificate-export',route:'export',target:null,platform,network:'declared',format:'pem'},trustCapabilities).status==='admitted';
const testExport=(name,fn)=>test(name,{skip:!admitted?'Exact installed export format capability unavailable on this host.':false},fn);
let scratch;const previous={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE};
function setup(){scratch=mkdtempSync(join(tmpdir(),'aih-trust-path-'));const home=join(scratch,'home');mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;
  const file=join(scratch,'team.pem');copyFileSync(new URL('./fixtures/root-a.pem',import.meta.url),file);return{home,file};}
afterEach(()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;if(scratch)rmSync(scratch,{recursive:true,force:true});});
const request=(file,output='certs/team.pem')=>({schema:'urn:aihq:core:certificate-export-request:1.0.0',useCase:'certificate-export',sources:{os:false,supplied:[{id:'team',file}]},output});
const approve=p=>({approved:true,origin:'automation',reviewDigest:p.review.reviewDigest});

testExport('native case alias of an existing export preserves its recorded management identity',async(t)=>{
  if(process.platform!=='win32'){t.skip('This case equivalence assertion needs the Windows native cell.');return;}
  const {home,file}=setup();const first=await prepare(request(file,'Certs/Team.pem'),{logging:'off'});assert.equal(first.status,'ready',JSON.stringify(first));assert.equal((await apply(first.prepared,approve(first),{logging:'off'})).completion,'complete');
  const alias=await prepare(request(file,'CERTS/TEAM.pem'),{logging:'off'});assert.equal(alias.status,'ready',JSON.stringify(alias));
  assert.equal(alias.review.inputs.trust.outputs[0].managementId,first.review.inputs.trust.outputs[0].managementId);
  assert.equal(alias.review.inputs.trust.outputs[0].pathKey,first.review.inputs.trust.outputs[0].pathKey);
  assert.equal((await apply(alias.prepared,approve(alias),{logging:'off'})).completion,'complete');assert.equal(existsSync(join(home,'Certs','Team.pem')),true);
});

testExport('deleted output with an absent case alias fails closed rather than creating a second identity',async(t)=>{
  if(process.platform!=='win32'){t.skip('This absent alias assertion needs Windows native name semantics.');return;}
  const {home,file}=setup();const first=await prepare(request(file),{logging:'off'});assert.equal(first.status,'ready',JSON.stringify(first));assert.equal((await apply(first.prepared,approve(first),{logging:'off'})).completion,'complete');
  rmSync(join(home,'certs','team.pem'));const alias=await prepare(request(file,'certs/TEAM.pem'),{logging:'off'});
  assert.equal(alias.status,'blocked',JSON.stringify(alias));assert.ok(alias.diagnostics.some(d=>d.reason==='output-path-alias'));assert.deepEqual(alias.resolutionInputs,[]);
});

testExport('a parent changed to a filesystem alias after review rejects before publication',async()=>{
  const {home,file}=setup();const parent=join(home,'certs');mkdirSync(parent);const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p));
  renameSync(parent,join(home,'other'));symlinkSync(join(home,'other'),parent,process.platform==='win32'?'junction':'dir');const r=await apply(p.prepared,approve(p),{logging:'off'});
  assert.equal(r.completion,'rejected',JSON.stringify(r));assert.deepEqual(r.trust.outputs,[]);assert.equal(existsSync(join(home,'other','team.pem')),false);
});

testExport('hardlink outputs fail closed and a legacy policy cannot touch new trust custody',async()=>{
  const {home,file}=setup();mkdirSync(join(home,'certs'));const output=join(home,'certs','team.pem');linkSync(file,output);
  const blocked=await prepare(request(file),{logging:'off'});assert.equal(blocked.status,'blocked');assert.ok(blocked.diagnostics.some(d=>d.reason==='output-path-alias'));rmSync(output);
  const p=await prepare(request(file),{logging:'off'});assert.equal(p.status,'ready',JSON.stringify(p));assert.equal((await apply(p.prepared,approve(p),{logging:'off'})).completion,'complete');const bytes=readFileSync(output);
  const recipe={schema:'urn:aihq:core:recipe:1.0.0',id:'legacy-writer',description:'Write user material',inputs:{},materials:[],targets:['user'],prerequisites:[],checks:[],operations:[{id:'write',purpose:'Write user material',kind:'file.write',scope:'user',requires:[],checks:[],target:{root:'userHome',segments:[{literal:'certs'},{literal:'team.pem'}]},content:{literal:'replacement'},mode:384}]};
  const legacy=await prepare({useCase:'policy',target:{project:home},policy:{schema:'urn:aihq:core:execution-policy:1.0.0',mode:'vibe',selections:[{id:'legacy',scope:'user',managementId:'legacy',configuration:{},requires:[],recipe:{inline:recipe}}]}},{logging:'off'});
  assert.equal(legacy.status,'blocked',JSON.stringify(legacy));assert.ok(legacy.diagnostics.some(d=>d.reason==='new-custody-legacy-request'));assert.deepEqual(legacy.resolutionInputs,[]);assert.deepEqual(readFileSync(output),bytes);
});
