import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as core from '@aihq/core/contracts';
import { contractSupport as harnessSupport, validateNativeVerificationDefinition, validateToolBinding, validateToolRegistry } from '@aihq/core/harness';

const { contractSupport, checkContracts, validatePackageSupport } = core;
assert.equal(contractSupport.schema, 'urn:aihq:package-support:1.1.0');
assert.equal(validatePackageSupport(contractSupport).valid, true);
assert.equal(validatePackageSupport(harnessSupport).valid, true);
assert.equal(validatePackageSupport({ schema:'urn:aihq:package-support:1.0.0', package:{name:'old',version:'0.1.0'},contracts:[],entries:[] }).valid, true);
const all = [...new Map([...contractSupport.contracts, ...harnessSupport.contracts].map(c => [c.id,c])).values()];
const ajv = new Ajv2020({ strict:true });
for (const contract of all) {
  assert.deepEqual(contract.versions, [contract.id.split(':').at(-1)]);
  const schema = (await import(contract.schemaExport, {with:{type:'json'}})).default;
  ajv.addSchema(schema);
  assert.ok(contract.fixtures.length > 0);
}
const publicReaders = {
  'execution-policy':core.validatePolicy, recipe:core.validateRecipe,
  'organization-policy':core.validateOrganizationPolicy, 'organization-target':core.validateOrganizationTarget,
  'repair-request':value=>value.schema.endsWith('1.1.0') ? core.validateMacosRepairRequest(value):core.validateTrustRepairRequest(value),
  'repair-inputs':value=>value.schema.endsWith('1.1.0') ? core.validateMacosRepairInputs(value):core.validateTrustRepairInputs(value),
  'certificate-export-request':core.validateCertificateExportRequest, 'certificate-export-inputs':core.validateCertificateExportInputs,
  'native-verification-request':core.validateNativeVerificationRequest, 'native-verification-result':core.validateNativeVerificationResult,
  'native-verification-bundle':core.validateNativeVerificationBundle
};
const readers = Object.fromEntries(all.map(contract=>[contract.id, bytes=> {
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(contract.id.startsWith('urn:aihq:harness:native-verification-definition:')) {
    const result=validateNativeVerificationDefinition(value); return {accepted:result.valid,code:result.diagnostics[0]?.code};
  }
  if(contract.id==='urn:aihq:harness:tool-registry:1.0.0') {
    const result=validateToolRegistry(value); return {accepted:result.valid,code:result.diagnostics[0]?.code};
  }
  if(contract.id==='urn:aihq:harness:tool-binding:1.0.0') {
    const result=validateToolBinding(value); return {accepted:result.valid,code:result.diagnostics[0]?.code};
  }
  const validate=contract.id.startsWith('urn:aihq:core:') && publicReaders[contract.id.split(':')[3]];
  if(validate) { const result=validate(value); return {accepted:result.valid,code:result.diagnostics[0]?.code}; }
  try { return {accepted:ajv.validate(contract.id,value),code:'INPUT_INVALID'}; } catch(error) { console.error(contract.id,error.message); throw error; }
}]));
const loadFixture = async (packageName, exportSpecifier) => {
  assert.equal(packageName,'@aihq/core');
  assert.ok(exportSpecifier.startsWith(packageName+'/fixtures/'));
  try { return new Uint8Array(await readFile(new URL(import.meta.resolve(exportSpecifier)))); }
  catch { return 'unavailable'; }
};
const producer={...contractSupport,contracts:all.map(c=>({...c,role:'produces'}))};
const consumer={...contractSupport,package:{name:'fixture-consumer',version:'0.1.0'},contracts:all.map(c=>({...c,role:'accepts',fixtures:[]}))};
const checked=await checkContracts({declarations:[consumer,producer],readers,loadFixture});
assert.equal(checked.ok,true,JSON.stringify(checked.checks.filter(c=>c.status!=='passed'),null,2));
assert.ok(checked.checks.some(c=>c.expect==='accept'));
assert.ok(checked.checks.some(c=>c.expectedCode==='SCHEMA_UNSUPPORTED'));


// Every advertised reader must preserve the format and unknown-field location.
const harness = await import('@aihq/core/harness');
const report = await import('@aihq/core/report');
const identity = {schema:'urn:aihq:harness:native-test-identity:1.0.0',id:'example',client:'claude',adapterId:'claude-oauth-otel.v1',purpose:'dedicated-native-test',expected:{accountUuid:'00000000-0000-0000-0000-000000000001',organizationId:'00000000-0000-0000-0000-000000000002'},credential:{path:'oauth.json',sha256:'a'.repeat(64),byteLength:1}};
for(const [validate,value,supported] of [
  [harness.validateNativeVerificationDefinition,harness.nativeVerificationDefinitions[0],['urn:aihq:harness:native-verification-definition:1.0.0','urn:aihq:harness:native-verification-definition:1.1.0']],
  [harness.validateNativeTestIdentity,identity,[identity.schema]],
  [harness.validateRepairDefinition11,harness.trustRepairIndex[0],[harness.trustRepairIndex[0].schema]],
  [harness.validateRepairDefinition12,harness.macosRepairIndex[0],[harness.macosRepairIndex[0].schema]],
  [harness.validateTrustCapabilities,harness.trustCapabilities,[harness.trustCapabilities.schema]],
  [harness.validateToolRegistry,harness.toolRegistry,[harness.toolRegistry.schema]],
  [harness.validateToolBinding,harness.toolBindings[0],[harness.toolBindings[0].schema]]
]) {
  const future=value.schema.replace(/:[0-9]+\.[0-9]+\.[0-9]+$/,':2.0.0');
  const refusal=validate({...value,schema:future}).diagnostics.find(d=>d.code==='SCHEMA_UNSUPPORTED');
  assert.ok(refusal,validate.name+' unsupported code');
  assert.equal(refusal.path,'/schema'); assert.equal(refusal.encountered,future); assert.deepEqual(refusal.supported,supported);
  const unknown=validate({...structuredClone(value),'unknown/~':true});
  assert.ok(unknown.diagnostics.some(d=>d.path==='/unknown~1~0'),validate.name+' unknown path');
}
const snapshot=report.createReport({diagnostic:{requestId:'example',helper:{name:'@aihq/core',version:'0.1.0'},status:'completed',tools:[],observations:[],checks:[],diagnostics:[],repairChoices:[],limits:{budgetMs:1000,elapsedMs:0,maxActiveProbes:1}},producer:{name:'@aihq/core',version:'0.1.0',revision:null},observedAt:'2026-10-24T00:00:00Z',acquisition:'supplied'});
for(const [value,path,encountered,supported] of [
  [{...snapshot,schema:'urn:aihq:report:snapshot:2.0.0'},'/schema','urn:aihq:report:snapshot:2.0.0',[report.SNAPSHOT_SCHEMA]],
  [{...snapshot,producer:{...snapshot.producer,contract:'urn:aihq:harness:diagnostic:2.0.0'}},'/producer/contract','urn:aihq:harness:diagnostic:2.0.0',[report.DIAGNOSTIC_CONTRACT]]
]) assert.throws(()=>report.importSnapshot(JSON.stringify(value)),error=>error.code==='SCHEMA_UNSUPPORTED'&&error.path===path&&error.encountered===encountered&&JSON.stringify(error.supported)===JSON.stringify(supported));
assert.throws(()=>report.importSnapshot(JSON.stringify({...snapshot,'unknown/~':true})),error=>error.code==='INPUT_INVALID'&&error.path==='/unknown~1~0');
assert.throws(()=>report.importSnapshot(JSON.stringify({...snapshot,producer:{...snapshot.producer,'unknown/~':true}})),error=>error.path==='/producer/unknown~1~0');
const futureClaims=report.readClaimSet('{"schema":"urn:aihq:report:claims:2.0.0","claims":[]}');
assert.equal(futureClaims.encountered,'urn:aihq:report:claims:2.0.0');assert.equal(futureClaims.path,'/schema');assert.deepEqual(futureClaims.supported,[...report.CLAIMS_ACCEPTED_VERSIONS]);
assert.equal(report.readClaimSet(JSON.stringify({schema:report.CLAIMS_SCHEMA,claims:[],'unknown/~':true})).path,'/unknown~1~0');

for(const [validate,value,path] of [
  [harness.validateNativeVerificationDefinition,{...structuredClone(harness.nativeVerificationDefinitions[0]),platform:{...harness.nativeVerificationDefinitions[0].platform,'unknown/~':true}},'/platform/unknown~1~0'],
  [harness.validateNativeTestIdentity,{...identity,expected:{...identity.expected,'unknown/~':true}},'/expected/unknown~1~0'],
  [harness.validateRepairDefinition11,{...structuredClone(harness.trustRepairIndex[0]),variants:[{...structuredClone(harness.trustRepairIndex[0].variants[0]),'unknown/~':true}]},'/variants/0/unknown~1~0'],
  [harness.validateRepairDefinition12,{...structuredClone(harness.macosRepairIndex[0]),variants:[{...structuredClone(harness.macosRepairIndex[0].variants[0]),'unknown/~':true}]},'/variants/0/unknown~1~0'],
  [harness.validateTrustCapabilities,{...structuredClone(harness.trustCapabilities),package:{...harness.trustCapabilities.package,'unknown/~':true}},'/package/unknown~1~0']
]) assert.ok(validate(value).diagnostics.some(d=>d.path===path),validate.name+' nested unknown path');

// Nested closed objects retain the owning refusal reason and exact unknown key.
const nestedCases = [];
for (const definition of harness.nativeVerificationDefinitions) {
  for (const [parts, reason] of [[['runtimeMembers',0],'runtime-members'],[['guardrails',0],'guardrails'],[['guardrails',0,'member'],'guardrails']])
    nestedCases.push([harness.validateNativeVerificationDefinition,definition,parts,reason]);
}
for (const [validate, definitions] of [[harness.validateRepairDefinition11,harness.trustRepairIndex],[harness.validateRepairDefinition12,harness.macosRepairIndex]]) {
  for (const definition of definitions) {
    nestedCases.push([validate,definition,['limits'],'limits'],[validate,definition,['trustLimits'],'trust-limits']);
    for (const name of Object.keys(definition.inputs)) nestedCases.push([validate,definition,['inputs',name],'inputs']);
    for (const [index] of definition.offlineVerification.entries()) nestedCases.push([validate,definition,['offlineVerification',index],'offline-verification']);
  }
}
for (const [validate,fixture,parts,reason] of nestedCases) {
  assert.equal(validate(fixture).valid,true,validate.name+' unmodified fixture');
  const value=structuredClone(fixture);let target=value;
  for (const part of parts) target=target[part];
  target['unknown/~']=true;
  const refused=validate(value);assert.equal(refused.valid,false);
  const diagnostic=refused.diagnostics.find(item=>item.reason===reason);
  const expected='/'+parts.map(part=>String(part).replaceAll('~','~0').replaceAll('/','~1')).join('/')+'/unknown~1~0';
  assert.equal(diagnostic?.path,expected,validate.name+' '+expected);
}
const runtime = await import('@aihq/core/harness/runtime');
const packageRoot = fileURLToPath(new URL('../../', import.meta.resolve('@aihq/core')));
const admission = runtime.verifyTrustAdmissionEvidence({packageRoot,capabilities:harness.trustCapabilities});
assert.equal(admission.valid,true,JSON.stringify(admission.diagnostics));
console.log(JSON.stringify({contracts:all.length,fixtures:checked.checks.length,status:'passed',preciseReaderRefusals:'passed'}));
