import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { prepare, apply, prepareManagedRemoval, listManagedSelections } from '../dist/core/index.js';
import { validatePreparedWork12, validateRunResult12, validateTrustCustody } from '../dist/core/contracts.js';
import { trustCapabilities,selectTrustCell } from '../dist/harness/contracts.mjs';
import { detectTrustPlatform } from '../dist/harness/trust.mjs';
const platform=detectTrustPlatform();
const admitted=!!platform.release&&selectTrustCell({definitionId:'certificate-export',route:'export',target:null,platform,
  network:'declared',format:'pem'},trustCapabilities).status==='admitted';
const testExport=(name,fn)=>test(name,{skip:!admitted?'No exact installed export format cell is admitted on this host.':false},fn);

const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let scratch;
function setup() {
  scratch = mkdtempSync(join(tmpdir(), 'aih-trust-'));
  const home = join(scratch, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
  const file = join(scratch, 'team.pem');
  writeFileSync(file, readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
  return { home, file };
}
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
const request = file => ({ schema: 'urn:aihq:core:certificate-export-request:1.0.0',
  useCase: 'certificate-export', sources: { os: false, supplied: [{ id: 'team', file }] } });
const approve = p => ({ approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest });

testExport('supplied-only export reviews without output effects and applies with genuine paired custody', async () => {
  const { home, file } = setup();
  const p = await prepare(request(file), { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  assert.equal(p.review.schema, 'urn:aihq:core:prepared-work:1.2.0');
  assert.equal(validatePreparedWork12(p.review).valid,true,JSON.stringify(validatePreparedWork12(p.review).diagnostics));
  const output = join(home, '.aih', 'exports', 'os-ca.pem');
  assert.equal(existsSync(output), false);
  const r = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.equal(r.completion, 'complete', JSON.stringify(r));
  assert.equal(r.schema, 'urn:aihq:core:run-result:1.2.0');
  assert.equal(validateRunResult12(r).valid,true,JSON.stringify(validateRunResult12(r).diagnostics));
  assert.equal(r.trust.outputs.length, 1);
  const custody = JSON.parse(readFileSync(join(home, '.aih', 'core', 'trust-custody.json')));
  assert.equal(custody.entries[0].outputSha256, r.trust.outputs[0].sha256);
  assert.match(custody.entries[0].recipeIdentity, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateTrustCustody(custody).valid,true,JSON.stringify(validateTrustCustody(custody).diagnostics));
});

testExport('source change after review rejects before output, with a full 1.2 stale result',async () => {
  const {home,file}=setup(); const p=await prepare(request(file),{logging:'off'});
  assert.equal(p.status,'ready',JSON.stringify(p));
  writeFileSync(file,readFileSync(new URL('./harness/fixtures/root-b.pem',import.meta.url)));
  const r=await apply(p.prepared,approve(p),{logging:'off'});
  assert.equal(r.completion,'rejected',JSON.stringify(r));
  assert.ok(r.diagnostics.some(d=>d.code==='REVIEW_STALE'&&d.reason==='trust-binding-changed'));
  assert.deepEqual(r.trust.outputs,[]); assert.equal(existsSync(join(home,'.aih','exports','os-ca.pem')),false);
  assert.equal(validateRunResult12(r).valid,true,JSON.stringify(validateRunResult12(r).diagnostics));
});

testExport('refresh revalidates retained sources and explicit same-ID replacement is reviewed',async () => {
  const {file}=setup();const first=await prepare(request(file),{logging:'off'});
  assert.equal(first.status,'ready',JSON.stringify(first));
  assert.equal((await apply(first.prepared,approve(first),{logging:'off'})).completion,'complete');
  const retained={...request(file),sources:{os:false,supplied:[]}};
  const unchanged=await prepare(retained,{logging:'off'});
  assert.equal(unchanged.status,'ready',JSON.stringify(unchanged.diagnostics));
  assert.equal(unchanged.review.inputs.trust.certificates[0].disposition,'retained');
  assert.equal((await apply(unchanged.prepared,approve(unchanged),{logging:'off'})).trust.outputs[0].status,'unchanged');
  const stale=await prepare(retained,{logging:'off'});assert.equal(stale.status,'ready',JSON.stringify(stale.diagnostics));
  writeFileSync(file,readFileSync(new URL('./harness/fixtures/root-b.pem',import.meta.url)));
  const staleResult=await apply(stale.prepared,approve(stale),{logging:'off'});assert.equal(staleResult.completion,'rejected');
  assert.ok(staleResult.diagnostics.some(d=>d.code==='REVIEW_STALE'&&d.reason==='trust-binding-changed'),JSON.stringify(staleResult.diagnostics));
  const changed=await prepare(retained,{logging:'off'});
  assert.equal(changed.status,'blocked');assert.ok(changed.diagnostics.some(d=>d.reason==='supplied-source-changed'));
  const explicit=await prepare(request(file),{logging:'off'});
  assert.equal(explicit.status,'ready',JSON.stringify(explicit.diagnostics));
  assert.deepEqual(explicit.review.inputs.trust.certificates.map(c=>c.disposition).sort(),['added','removed']);
  assert.equal((await apply(explicit.prepared,approve(explicit),{logging:'off'})).completion,'complete');
});

testExport('equal unowned bytes require exact replacement and establish genuine ownership',async () => {
  const {home,file}=setup();mkdirSync(join(home,'.aih','exports'),{recursive:true});
  const output=join(home,'.aih','exports','os-ca.pem');const der=new X509Certificate(readFileSync(file)).raw;
  const normalized=`-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  writeFileSync(output,normalized,{mode:0o600});
  const blocked=await prepare(request(file),{logging:'off'});
  assert.equal(blocked.status,'blocked',JSON.stringify(blocked));
  assert.equal(blocked.diagnostics[0].reason,'trust-output-conflict');
  const hint=blocked.resolutionInputs[0];assert.deepEqual(hint.availableChoices,['replace']);
  const p=await prepare({...request(file),resolutions:[{selectionId:hint.selectionId,operationId:hint.operationId,choice:'replace',observedSha256:hint.observedSha256}]},{logging:'off'});
  assert.equal(p.status,'ready',JSON.stringify(p));
  const r=await apply(p.prepared,approve(p),{logging:'off'});assert.equal(r.completion,'complete',JSON.stringify(r));
  assert.equal(r.trust.outputs[0].status,'unchanged');
  const removal=await prepareManagedRemoval({target:{project:home},managementId:p.review.inputs.trust.outputs[0].managementId,scope:'user',mode:'vibe'},{logging:'off'});
  assert.equal(removal.disposition,'prepared',JSON.stringify(removal));
  assert.equal((await apply(removal.preparation.prepared,approve(removal.preparation),{logging:'off'})).completion,'complete');
  assert.equal(existsSync(output),false);
});

testExport('legacy deletion remains visible and orphan cleanup never resurrects a source',async () => {
  const {home,file}=setup(); const p=await prepare(request(file),{logging:'off'});
  assert.equal((await apply(p.prepared,approve(p),{logging:'off'})).completion,'complete');
  const managementId=p.review.inputs.trust.outputs[0].managementId;
  rmSync(join(home,'.aih','exports','os-ca.pem'));
  const receipts=join(home,'.aih','core','ownership');
  // Simulate an older binary's removal of its genuine ordinary receipt.
  for(const name of (await import('node:fs')).readdirSync(receipts)) if(/^[a-f0-9]{64}\.json$/.test(name)) rmSync(join(receipts,name));
  rmSync(file);
  const inventory=await listManagedSelections({target:{project:home},scope:'user'});
  assert.equal(inventory.status,'incomplete');assert.ok(inventory.selections.some(s=>s.managementId===managementId));
  const removal=await prepareManagedRemoval({target:{project:home},managementId,scope:'user',mode:'vibe'},{logging:'off'});
  assert.equal(removal.disposition,'prepared',JSON.stringify(removal));
  const r=await apply(removal.preparation.prepared,approve(removal.preparation),{logging:'off'});
  assert.equal(r.completion,'complete',JSON.stringify(r));
  assert.deepEqual(JSON.parse(readFileSync(join(home,'.aih','core','trust-custody.json'))).entries,[]);
});

test('unadmitted native Node/npm is blocked with exact 1.2 target rows',async () => {
  setup();const p=await prepare({schema:'urn:aihq:core:repair-request:1.0.0',useCase:'repair',route:'native',repairs:[{id:'node-npm-ca',targets:['npm','node'],inputs:{}}]},{logging:'off'});
  assert.equal(p.status,'blocked',JSON.stringify(p));assert.equal(p.prepared,undefined);
  assert.deepEqual(p.review.inputs.trust.targets.map(t=>[t.id,t.admission,t.reason]),[['node','unavailable','native-route-unsupported'],['npm','unavailable','native-route-unsupported']]);
  assert.equal(validatePreparedWork12(p.review).valid,true,JSON.stringify(validatePreparedWork12(p.review).diagnostics));
});

test('default OS export is a full blocked 1.2 review when complete OS discovery is unavailable',async()=>{
  setup();const p=await prepare({schema:'urn:aihq:core:certificate-export-request:1.0.0',useCase:'certificate-export'},{logging:'off'});
  assert.equal(p.status,'blocked',JSON.stringify(p));assert.equal(p.prepared,undefined);assert.deepEqual(p.review.inputs.trust.targets,[]);
  assert.match(p.review.inputs.trust.sourceSetSha256,/^[a-f0-9]{64}$/);assert.equal(validatePreparedWork12(p.review).valid,true,JSON.stringify(validatePreparedWork12(p.review).diagnostics));
});

testExport('explicit removal happens before an unavailable retained source is revalidated',async()=>{
  const {file}=setup();const other=join(scratch,'other.pem');writeFileSync(other,readFileSync(new URL('./harness/fixtures/root-b.pem',import.meta.url)));
  const initial={...request(file),sources:{os:false,supplied:[{id:'team',file},{id:'other',file:other}]}};const first=await prepare(initial,{logging:'off'});
  assert.equal(first.status,'ready',JSON.stringify(first));assert.equal((await apply(first.prepared,approve(first),{logging:'off'})).completion,'complete');rmSync(file);
  const refresh=await prepare({...request(file),sources:{os:false,supplied:[],removeSupplied:['team']}},{logging:'off'});
  assert.equal(refresh.status,'ready',JSON.stringify(refresh));assert.deepEqual(refresh.review.inputs.trust.sources.map(s=>s.id),['supplied:other']);
  assert.equal((await apply(refresh.prepared,approve(refresh),{logging:'off'})).completion,'complete');
});

test('supplied-only npm file repair applies and removes genuine content-root custody without native claims',async()=>{
  const {home,file}=setup();const p=await prepare({schema:'urn:aihq:core:repair-request:1.0.0',useCase:'repair',route:'file',network:'off',
    repairs:[{id:'node-npm-ca',targets:['npm'],inputs:{}}],sources:{os:false,supplied:[{id:'team',file}]}},{logging:'off'});
  assert.equal(p.status,'ready',JSON.stringify(p.diagnostics));assert.equal(validatePreparedWork12(p.review).valid,true,JSON.stringify(validatePreparedWork12(p.review).diagnostics));
  assert.deepEqual(p.review.inputs.trust.sources.map(s=>s.id),['node-bundled-default','supplied:team']);assert.equal(p.review.inputs.trust.targets[0].cellId,null);
  const r=await apply(p.prepared,approve(p),{logging:'off'});assert.equal(r.completion,'complete',JSON.stringify(r.diagnostics));
  assert.equal(validateRunResult12(r).valid,true,JSON.stringify(validateRunResult12(r).diagnostics));assert.equal(r.trust.outputs.length,1);assert.equal(r.trust.targets[0].verification,'skipped');
  const consumed=await apply(p.prepared,approve(p),{logging:'off'});assert.equal(consumed.completion,'rejected');assert.equal(consumed.useCase,'repair');assert.equal(consumed.schema,'urn:aihq:core:run-result:1.2.0');
  const output=p.review.inputs.trust.outputs[0].path;assert.equal(existsSync(output),true);assert.match(readFileSync(join(home,'.npmrc'),'utf8'),/cafile=/);
  const removal=await prepareManagedRemoval({target:{project:home},managementId:'node-npm-trust',scope:'user',mode:'vibe'},{logging:'off'});
  assert.equal(removal.disposition,'prepared',JSON.stringify(removal.diagnostics));assert.equal(removal.preparation.status,'ready',JSON.stringify(removal.preparation.diagnostics));
  const removed=await apply(removal.preparation.prepared,approve(removal.preparation),{logging:'off'});assert.equal(removed.completion,'complete',JSON.stringify(removed.diagnostics));
  assert.equal(existsSync(output),false);assert.deepEqual(JSON.parse(readFileSync(join(home,'.aih','core','trust-custody.json'))).entries,[]);
});

test('OS-sourced file repair never admits targets from complete source observation alone',async()=>{
  const {file}=setup();const p=await prepare({schema:'urn:aihq:core:repair-request:1.0.0',useCase:'repair',route:'file',network:'off',
    repairs:[{id:'node-npm-ca',targets:['npm','node'],inputs:{}}],sources:{os:true,supplied:[{id:'team',file}]}},{logging:'off'});
  assert.equal(p.status,'blocked',JSON.stringify(p.diagnostics));assert.deepEqual(p.review.inputs.trust.targets.map(t=>[t.id,t.admission,t.reason]),
    [['node','unavailable','file-route-unsupported'],['npm','unavailable','file-route-unsupported']]);
  assert.equal(validatePreparedWork12(p.review).valid,true,JSON.stringify(validatePreparedWork12(p.review).diagnostics));
});

testExport('history overflow preserves complete public certificate facts and successful custody',async()=>{
  const {home,file}=setup();const base=new X509Certificate(readFileSync(file)).raw;
  const supplied=[];const expected=new Set();
  for(let source=0;source<16;source++) {
    const certificates=[];
    for(let item=0;item<256;item++) {
      // Signature bytes distinguish otherwise identical fixture anchors. Discovery parses
      // CA/validity fields; it does not require a supplied root to verify its own signature.
      const der=Buffer.from(base);der.writeUInt16BE(source*256+item,der.length-2);
      const certificate=new X509Certificate(der);assert.equal(certificate.ca,true);
      expected.add(certificate.fingerprint256.replaceAll(':','').toLowerCase());
      certificates.push(`-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`);
    }
    const path=join(scratch,`roots-${source}.pem`);writeFileSync(path,certificates.join(''));
    supplied.push({id:`roots-${source}`,file:path});
  }
  assert.equal(expected.size,4096);
  const p=await prepare({...request(file),sources:{os:false,supplied}},{logging:'on'});
  assert.equal(p.status,'ready',JSON.stringify(p.diagnostics));
  assert.equal(p.record.status,'failed',JSON.stringify(p.record));assert.equal(p.record.reason,'record-limit');
  assert.equal(p.review.inputs.trust.certificates.length,4096);
  assert.deepEqual(new Set(p.review.inputs.trust.certificates.map(c=>c.fingerprint)),expected);
  assert.equal(validatePreparedWork12(p.review).valid,true,JSON.stringify(validatePreparedWork12(p.review).diagnostics));
  const r=await apply(p.prepared,approve(p),{logging:'on'});
  assert.equal(r.completion,'complete',JSON.stringify(r.diagnostics));
  assert.equal(r.record.status,'failed',JSON.stringify(r.record));assert.equal(r.record.reason,'record-limit');
  assert.deepEqual(r.inputs.trust.certificates,p.review.inputs.trust.certificates);
  assert.equal(r.trust.outputs[0].certificateCount,4096);
  assert.equal(validateRunResult12(r).valid,true,JSON.stringify(validateRunResult12(r).diagnostics));
  const bytes=readFileSync(join(home,'.aih','core','trust-custody.json'));assert.ok(bytes.length<=1_048_576);
  assert.equal(validateTrustCustody(JSON.parse(bytes)).valid,true);
});
