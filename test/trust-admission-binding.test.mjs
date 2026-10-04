import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {trustCapabilities,selectTrustCell} from '../dist/harness/contracts.mjs';
import {detectTrustPlatform} from '../dist/harness/trust.mjs';
const platform=detectTrustPlatform();
const admitted=!!platform.release&&selectTrustCell({definitionId:'certificate-export',route:'export',target:null,
  platform,network:'declared',format:'pem'},trustCapabilities).status==='admitted';
for(const subject of ['admission module','selected evidence'])for(const mutation of ['change','delete'])
for(const phase of subject==='admission module'?['after Prepare','before next Prepare']:['after Prepare'])
test(`${subject} ${mutation} ${phase} rejects before output effects`,{skip:!admitted?'Exact installed export admission unavailable.':false},()=>{
  const scratch=mkdtempSync(join(tmpdir(),'aih-trust-binding-'));const installed=join(scratch,'installed'),home=join(scratch,'home');
  try {
    mkdirSync(installed);mkdirSync(home);const source=fileURLToPath(new URL('../',import.meta.url));
    cpSync(join(source,'dist'),join(installed,'dist'),{recursive:true});cpSync(join(source,'package.json'),join(installed,'package.json'));
    symlinkSync(join(source,'node_modules'),join(installed,'node_modules'),process.platform==='win32'?'junction':'dir');
    const file=join(scratch,'team.pem');cpSync(new URL('./fixtures/root-a.pem',import.meta.url),file);
    const script=join(scratch,'driver.mjs');
    const imports=name=>JSON.stringify(pathToFileURL(join(installed,'dist',name)).href);
    const changedPath=subject==='admission module'?JSON.stringify('dist/harness/trust-capabilities.mjs'):'cell.evidence.reference';
    const mutate=mutation==='delete'?'unlinkSync(path);':'writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from([10,32])]));';
    writeFileSync(script,`
import {prepare,apply} from ${imports('core/index.js')};
import {validateRunResult12,validatePreparedWork12} from ${imports('core/contracts.js')};
import {trustCapabilities,selectTrustCell} from ${imports('harness/contracts.mjs')};
import {detectTrustPlatform} from ${imports('harness/trust.mjs')};
import {readFileSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const p=await prepare({schema:'urn:aihq:core:certificate-export-request:1.0.0',useCase:'certificate-export',
 sources:{os:false,supplied:[{id:'team',file:${JSON.stringify(file)}}]}},{logging:'off'});
if(p.status!=='ready')throw new Error(JSON.stringify(p.diagnostics));
const cell=selectTrustCell({definitionId:'certificate-export',route:'export',target:null,platform:detectTrustPlatform(),network:'declared',format:'pem'},trustCapabilities).cell;
const path=join(${JSON.stringify(installed)},${changedPath});${mutate}
const result=${phase==='after Prepare'?"await apply(p.prepared,{approved:true,origin:'automation',reviewDigest:p.review.reviewDigest},{logging:'off'})":`await prepare({schema:'urn:aihq:core:certificate-export-request:1.0.0',useCase:'certificate-export',sources:{os:false,supplied:[{id:'team',file:${JSON.stringify(file)}}]}},{logging:'off'})`};
console.log(JSON.stringify({completion:result.completion??result.status,diagnostics:result.diagnostics,outputs:result.trust?.outputs??[],
 valid:result.review?validatePreparedWork12(result.review).valid:validateRunResult12(result).valid,outputExists:existsSync(join(${JSON.stringify(home)},'.aih','exports','os-ca.pem'))}));
`);
    const result=JSON.parse(execFileSync(process.execPath,[script],{env:{...process.env,HOME:home,USERPROFILE:home},encoding:'utf8',timeout:60_000}));
    assert.equal(result.completion,phase==='after Prepare'?'rejected':'blocked',JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(d=>phase==='after Prepare'?d.code==='REVIEW_STALE'&&d.reason==='trust-binding-changed':d.reason==='trust-admission-changed'));
    assert.equal(result.valid,true);assert.deepEqual(result.outputs,[]);assert.equal(result.outputExists,false);
  } finally {rmSync(scratch,{recursive:true,force:true});}
});

test('cached Harness imported before Core cannot authorize a revoked installed admission payload',
  {skip:!admitted?'Exact installed export admission unavailable.':false},()=>{
  const scratch=mkdtempSync(join(tmpdir(),'aih-trust-cached-harness-'));
  const installed=join(scratch,'installed'),home=join(scratch,'home');
  try {
    mkdirSync(installed);mkdirSync(home);const source=fileURLToPath(new URL('../',import.meta.url));
    cpSync(join(source,'dist'),join(installed,'dist'),{recursive:true});cpSync(join(source,'package.json'),join(installed,'package.json'));
    symlinkSync(join(source,'node_modules'),join(installed,'node_modules'),process.platform==='win32'?'junction':'dir');
    const file=join(scratch,'team.pem');cpSync(new URL('./fixtures/root-a.pem',import.meta.url),file);
    const url=name=>JSON.stringify(pathToFileURL(join(installed,'dist',name)).href);
    const script=join(scratch,'driver.mjs');writeFileSync(script,`
import {trustCapabilities} from ${url('harness/contracts.mjs')};
import {writeFileSync,existsSync} from 'node:fs';
if(!trustCapabilities.cells.length)throw new Error('Cached fixture has no admitted cells');
writeFileSync(${JSON.stringify(join(installed,'dist/harness/trust-capabilities.mjs'))},'export const trustCellRecords = Object.freeze([]);');
const {prepare}=await import(${url('core/index.js')});
const {validatePreparedWork12}=await import(${url('core/contracts.js')});
const result=await prepare({schema:'urn:aihq:core:certificate-export-request:1.0.0',useCase:'certificate-export',
 sources:{os:false,supplied:[{id:'team',file:${JSON.stringify(file)}}]}},{logging:'off'});
console.log(JSON.stringify({status:result.status,diagnostics:result.diagnostics,valid:validatePreparedWork12(result.review).valid,
 outputExists:existsSync(${JSON.stringify(join(home,'.aih','exports','os-ca.pem'))})}));
`);
    const result=JSON.parse(execFileSync(process.execPath,[script],{env:{...process.env,HOME:home,USERPROFILE:home},encoding:'utf8',timeout:60_000}));
    assert.equal(result.status,'blocked',JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(d=>d.reason==='trust-admission-changed'));
    assert.equal(result.valid,true);assert.equal(result.outputExists,false);
  } finally {rmSync(scratch,{recursive:true,force:true});}
});
