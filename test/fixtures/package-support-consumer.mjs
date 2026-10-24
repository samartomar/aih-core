import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as core from '@aihq/core/contracts';
import { contractSupport as harnessSupport, validateNativeVerificationDefinition } from '@aihq/core/harness';

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
console.log(JSON.stringify({contracts:all.length,fixtures:checked.checks.length,status:'passed'}));
