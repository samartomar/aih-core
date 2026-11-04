// The 0.1.0 format registry (contract 4, C47, C74): one schema per format, with one valid and one invalid fixture.
// Append-only: a later slice adds its schema/fixture files and one entry to `entries`, nothing else.
// `@aihq/core/contracts` publishes it as `schemas`, and `validateFormat` reads any registered document.
import planRequestSchema from '../schemas/plan-request/0.1.0.json' with { type: 'json' };
import planRequestValid from '../../fixtures/core/plan-request/0.1.0/accept.json' with { type: 'json' };
import planRequestInvalid from '../../fixtures/core/plan-request/0.1.0/refuse.json' with { type: 'json' };
import reviewSchema from '../schemas/review/0.1.0.json' with { type: 'json' };
import reviewValid from '../../fixtures/core/review/0.1.0/accept.json' with { type: 'json' };
import reviewInvalid from '../../fixtures/core/review/0.1.0/refuse.json' with { type: 'json' };
import runSchema from '../schemas/run/0.1.0.json' with { type: 'json' };
import runValid from '../../fixtures/core/run/0.1.0/accept.json' with { type: 'json' };
import runInvalid from '../../fixtures/core/run/0.1.0/refuse.json' with { type: 'json' };
import inventorySchema from '../schemas/inventory/0.1.0.json' with { type: 'json' };
import inventoryValid from '../../fixtures/core/inventory/0.1.0/accept.json' with { type: 'json' };
import inventoryInvalid from '../../fixtures/core/inventory/0.1.0/refuse.json' with { type: 'json' };
import changeSchema from '../schemas/change/0.1.0.json' with { type: 'json' };
import changeValid from '../../fixtures/core/change/0.1.0/accept.json' with { type: 'json' };
import changeInvalid from '../../fixtures/core/change/0.1.0/refuse.json' with { type: 'json' };
import changeRequestSchema from '../schemas/change-request/0.1.0.json' with { type: 'json' };
import changeRequestValid from '../../fixtures/core/change-request/0.1.0/accept.json' with { type: 'json' };
import changeRequestInvalid from '../../fixtures/core/change-request/0.1.0/refuse.json' with { type: 'json' };
// Environment work: repair, certificate export and the macOS session (samartomar/aih-core#170).
import repairRequestSchema from '../schemas/repair-request/0.1.0.json' with { type: 'json' };
import repairRequestValid from '../../fixtures/core/repair-request/0.1.0/accept.json' with { type: 'json' };
import repairRequestInvalid from '../../fixtures/core/repair-request/0.1.0/refuse.json' with { type: 'json' };
import repairInputsSchema from '../schemas/repair-inputs/0.1.0.json' with { type: 'json' };
import repairInputsValid from '../../fixtures/core/repair-inputs/0.1.0/accept.json' with { type: 'json' };
import repairInputsInvalid from '../../fixtures/core/repair-inputs/0.1.0/refuse.json' with { type: 'json' };
import exportRequestSchema from '../schemas/export-request/0.1.0.json' with { type: 'json' };
import exportRequestValid from '../../fixtures/core/export-request/0.1.0/accept.json' with { type: 'json' };
import exportRequestInvalid from '../../fixtures/core/export-request/0.1.0/refuse.json' with { type: 'json' };
import exportInputsSchema from '../schemas/export-inputs/0.1.0.json' with { type: 'json' };
import exportInputsValid from '../../fixtures/core/export-inputs/0.1.0/accept.json' with { type: 'json' };
import exportInputsInvalid from '../../fixtures/core/export-inputs/0.1.0/refuse.json' with { type: 'json' };
import macosSessionRequestSchema from '../schemas/macos-session-request/0.1.0.json' with { type: 'json' };
import macosSessionRequestValid from '../../fixtures/core/macos-session-request/0.1.0/accept.json' with { type: 'json' };
import macosSessionRequestInvalid from '../../fixtures/core/macos-session-request/0.1.0/refuse.json' with { type: 'json' };
import macosSessionInputsSchema from '../schemas/macos-session-inputs/0.1.0.json' with { type: 'json' };
import macosSessionInputsValid from '../../fixtures/core/macos-session-inputs/0.1.0/accept.json' with { type: 'json' };
import macosSessionInputsInvalid from '../../fixtures/core/macos-session-inputs/0.1.0/refuse.json' with { type: 'json' };
import trustCustodySchema from '../schemas/trust-custody/0.1.0.json' with { type: 'json' };
import trustCustodyValid from '../../fixtures/core/trust-custody/0.1.0/accept.json' with { type: 'json' };
import trustCustodyInvalid from '../../fixtures/core/trust-custody/0.1.0/refuse.json' with { type: 'json' };
import macosSessionCustodySchema from '../schemas/macos-session-custody/0.1.0.json' with { type: 'json' };
import macosSessionCustodyValid from '../../fixtures/core/macos-session-custody/0.1.0/accept.json' with { type: 'json' };
import macosSessionCustodyInvalid from '../../fixtures/core/macos-session-custody/0.1.0/refuse.json' with { type: 'json' };
import macosSessionVerificationRequestSchema from '../schemas/macos-session-verification-request/0.1.0.json' with { type: 'json' };
import macosSessionVerificationRequestValid from '../../fixtures/core/macos-session-verification-request/0.1.0/accept.json' with { type: 'json' };
import macosSessionVerificationRequestInvalid from '../../fixtures/core/macos-session-verification-request/0.1.0/refuse.json' with { type: 'json' };
import macosSessionVerificationResultSchema from '../schemas/macos-session-verification-result/0.1.0.json' with { type: 'json' };
import macosSessionVerificationResultValid from '../../fixtures/core/macos-session-verification-result/0.1.0/accept.json' with { type: 'json' };
import macosSessionVerificationResultInvalid from '../../fixtures/core/macos-session-verification-result/0.1.0/refuse.json' with { type: 'json' };
import macosSessionProfilesSchema from '../schemas/macos-session-profiles/0.1.0.json' with { type: 'json' };
import macosSessionProfilesValid from '../../fixtures/core/macos-session-profiles/0.1.0/accept.json' with { type: 'json' };
import macosSessionProfilesInvalid from '../../fixtures/core/macos-session-profiles/0.1.0/refuse.json' with { type: 'json' };
import toolRegistrySchema from '../schemas/tool-registry/0.1.0.json' with { type: 'json' };
import toolRegistryValid from '../../fixtures/core/tool-registry/0.1.0/accept.json' with { type: 'json' };
import toolRegistryInvalid from '../../fixtures/core/tool-registry/0.1.0/refuse.json' with { type: 'json' };
import inspectionSchema from '../schemas/inspection/0.1.0.json' with { type: 'json' };
import inspectionValid from '../../fixtures/core/inspection/0.1.0/accept.json' with { type: 'json' };
import inspectionInvalid from '../../fixtures/core/inspection/0.1.0/refuse.json' with { type: 'json' };
import fileCheckSchema from '../schemas/file-check/0.1.0.json' with { type: 'json' };
import fileCheckValid from '../../fixtures/core/file-check/0.1.0/accept.json' with { type: 'json' };
import fileCheckInvalid from '../../fixtures/core/file-check/0.1.0/refuse.json' with { type: 'json' };
import reportSchema from '../schemas/report/0.1.0.json' with { type: 'json' };
import reportValid from '../../fixtures/core/report/0.1.0/accept.json' with { type: 'json' };
import reportInvalid from '../../fixtures/core/report/0.1.0/refuse.json' with { type: 'json' };
import claimsSchema from '../schemas/claims/0.1.0.json' with { type: 'json' };
import claimsValid from '../../fixtures/core/claims/0.1.0/accept.json' with { type: 'json' };
import claimsInvalid from '../../fixtures/core/claims/0.1.0/refuse.json' with { type: 'json' };
import nativeRequestSchema from '../schemas/native-verification-request/0.1.0.json' with { type: 'json' };
import nativeRequestValid from '../../fixtures/core/native-verification-request/0.1.0/accept.json' with { type: 'json' };
import nativeRequestInvalid from '../../fixtures/core/native-verification-request/0.1.0/refuse.json' with { type: 'json' };
import nativeResultSchema from '../schemas/native-verification-result/0.1.0.json' with { type: 'json' };
import nativeResultValid from '../../fixtures/core/native-verification-result/0.1.0/accept.json' with { type: 'json' };
import nativeResultInvalid from '../../fixtures/core/native-verification-result/0.1.0/refuse.json' with { type: 'json' };
import nativeBundleSchema from '../schemas/native-verification-bundle/0.1.0.json' with { type: 'json' };
import nativeBundleValid from '../../fixtures/core/native-verification-bundle/0.1.0/accept.json' with { type: 'json' };
import nativeBundleInvalid from '../../fixtures/core/native-verification-bundle/0.1.0/refuse.json' with { type: 'json' };
import nativeDefinitionSchema from '../schemas/native-verification-definition/0.1.0.json' with { type: 'json' };
import nativeDefinitionValid from '../../fixtures/core/native-verification-definition/0.1.0/accept.json' with { type: 'json' };
import nativeDefinitionInvalid from '../../fixtures/core/native-verification-definition/0.1.0/refuse.json' with { type: 'json' };
import nativeTestIdentitySchema from '../schemas/native-test-identity/0.1.0.json' with { type: 'json' };
import nativeTestIdentityValid from '../../fixtures/core/native-test-identity/0.1.0/accept.json' with { type: 'json' };
import nativeTestIdentityInvalid from '../../fixtures/core/native-test-identity/0.1.0/refuse.json' with { type: 'json' };
// Enterprise admission (samartomar/aih-core#179).
import organizationSchema from '../schemas/organization/0.1.0.json' with { type: 'json' };
import organizationValid from '../../fixtures/core/organization/0.1.0/accept.json' with { type: 'json' };
import organizationInvalid from '../../fixtures/core/organization/0.1.0/refuse.json' with { type: 'json' };
import { registerSchemas, schemaCheck } from '../internal/contract-validation.js';
import { cloneJsonValueStructureV1 } from '../internal/strict-json.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import type { Json } from '../types.js';
import type { Problem } from './types.js';

export interface FormatEntry { id: string; schema: { $id: string }; fixtures: { valid: unknown; invalid: unknown } }
const entries: FormatEntry[] = [
  { id: planRequestSchema.$id, schema: planRequestSchema, fixtures: { valid: planRequestValid, invalid: planRequestInvalid } },
  { id: reviewSchema.$id, schema: reviewSchema, fixtures: { valid: reviewValid, invalid: reviewInvalid } },
  { id: runSchema.$id, schema: runSchema, fixtures: { valid: runValid, invalid: runInvalid } },
  { id: inventorySchema.$id, schema: inventorySchema, fixtures: { valid: inventoryValid, invalid: inventoryInvalid } },
  // Authored changes and named groups (samartomar/aih-core#166).
  { id: changeSchema.$id, schema: changeSchema, fixtures: { valid: changeValid, invalid: changeInvalid } },
  { id: changeRequestSchema.$id, schema: changeRequestSchema, fixtures: { valid: changeRequestValid, invalid: changeRequestInvalid } },
  { id: repairRequestSchema.$id, schema: repairRequestSchema, fixtures: { valid: repairRequestValid, invalid: repairRequestInvalid } },
  { id: repairInputsSchema.$id, schema: repairInputsSchema, fixtures: { valid: repairInputsValid, invalid: repairInputsInvalid } },
  { id: exportRequestSchema.$id, schema: exportRequestSchema, fixtures: { valid: exportRequestValid, invalid: exportRequestInvalid } },
  { id: exportInputsSchema.$id, schema: exportInputsSchema, fixtures: { valid: exportInputsValid, invalid: exportInputsInvalid } },
  { id: macosSessionRequestSchema.$id, schema: macosSessionRequestSchema, fixtures: { valid: macosSessionRequestValid, invalid: macosSessionRequestInvalid } },
  { id: macosSessionInputsSchema.$id, schema: macosSessionInputsSchema, fixtures: { valid: macosSessionInputsValid, invalid: macosSessionInputsInvalid } },
  { id: trustCustodySchema.$id, schema: trustCustodySchema, fixtures: { valid: trustCustodyValid, invalid: trustCustodyInvalid } },
  { id: macosSessionCustodySchema.$id, schema: macosSessionCustodySchema, fixtures: { valid: macosSessionCustodyValid, invalid: macosSessionCustodyInvalid } },
  { id: macosSessionVerificationRequestSchema.$id, schema: macosSessionVerificationRequestSchema, fixtures: { valid: macosSessionVerificationRequestValid, invalid: macosSessionVerificationRequestInvalid } },
  { id: macosSessionVerificationResultSchema.$id, schema: macosSessionVerificationResultSchema, fixtures: { valid: macosSessionVerificationResultValid, invalid: macosSessionVerificationResultInvalid } },
  { id: macosSessionProfilesSchema.$id, schema: macosSessionProfilesSchema, fixtures: { valid: macosSessionProfilesValid, invalid: macosSessionProfilesInvalid } },
  // Tool registry, inspection, file comparison, report snapshots and claim sets (samartomar/aih-core#174).
  { id: toolRegistrySchema.$id, schema: toolRegistrySchema, fixtures: { valid: toolRegistryValid, invalid: toolRegistryInvalid } },
  { id: inspectionSchema.$id, schema: inspectionSchema, fixtures: { valid: inspectionValid, invalid: inspectionInvalid } },
  { id: fileCheckSchema.$id, schema: fileCheckSchema, fixtures: { valid: fileCheckValid, invalid: fileCheckInvalid } },
  { id: reportSchema.$id, schema: reportSchema, fixtures: { valid: reportValid, invalid: reportInvalid } },
  { id: claimsSchema.$id, schema: claimsSchema, fixtures: { valid: claimsValid, invalid: claimsInvalid } },
  // Native client verification (samartomar/aih-core#177).
  { id: nativeRequestSchema.$id, schema: nativeRequestSchema, fixtures: { valid: nativeRequestValid, invalid: nativeRequestInvalid } },
  { id: nativeResultSchema.$id, schema: nativeResultSchema, fixtures: { valid: nativeResultValid, invalid: nativeResultInvalid } },
  { id: nativeBundleSchema.$id, schema: nativeBundleSchema, fixtures: { valid: nativeBundleValid, invalid: nativeBundleInvalid } },
  { id: nativeDefinitionSchema.$id, schema: nativeDefinitionSchema, fixtures: { valid: nativeDefinitionValid, invalid: nativeDefinitionInvalid } },
  { id: nativeTestIdentitySchema.$id, schema: nativeTestIdentitySchema, fixtures: { valid: nativeTestIdentityValid, invalid: nativeTestIdentityInvalid } },
  // Enterprise admission (samartomar/aih-core#179).
  { id: organizationSchema.$id, schema: organizationSchema, fixtures: { valid: organizationValid, invalid: organizationInvalid } },
];
registerSchemas(...entries.map(entry => entry.schema));

/** Every 0.1.0 format, keyed by id: its JSON Schema and its valid and invalid fixture. Plain, frozen data. */
export const schemas: Readonly<Record<string, { schema: Json; fixtures: { valid: Json; invalid: Json } }>> =
  deepFreezeStrictJsonV1(Object.fromEntries(entries.map(entry => [entry.id,
    { schema: entry.schema as unknown as Json, fixtures: { valid: entry.fixtures.valid as Json, invalid: entry.fixtures.invalid as Json } }])) as Json) as never;

const checks = new Map(entries.map(entry => [entry.id, schemaCheck(entry.id)]));
const pointer = (path: string, extra?: unknown): string =>
  extra === undefined ? path : `${path}/${String(extra).replaceAll('~', '~0').replaceAll('/', '~1')}`;

/** Schema problems for one registered format; `undefined` when the document conforms. */
export function schemaProblems(id: string, value: unknown): Problem[] | undefined {
  const check = checks.get(id)!();
  if (check(value)) return undefined;
  return (check.errors ?? []).slice(0, 64).map(error => ({
    path: error.keyword === 'additionalProperties' ? pointer(error.instancePath, error.params.additionalProperty) : error.instancePath,
    reason: error.keyword === 'additionalProperties' ? 'unknown-field' : error.keyword,
    message: 'The document does not satisfy the published schema.' }));
}

export type FormatResult = { status: 'ok'; schema: string } | { status: 'invalid'; problems: Problem[] } |
  { status: 'unsupported-version'; encountered: string; supported: string[] };
/** Reads any 0.1.0 document by its `schema` field: `ok`, `invalid` with problems, or `unsupported-version`. */
export function validateFormat(value: unknown): FormatResult {
  let safe: unknown;
  try { safe = cloneJsonValueStructureV1(value, 'document', 32, 16 * 1_048_576); }
  catch { return { status: 'invalid', problems: [{ path: '', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] }; }
  const id = safe && typeof safe === 'object' && !Array.isArray(safe) ? (safe as { schema?: unknown }).schema : undefined;
  if (typeof id !== 'string') return { status: 'invalid', problems: [{ path: '/schema', reason: 'required', message: 'A document names its format in `schema`.' }] };
  if (!checks.has(id)) {
    const family = id.split(':').slice(0, 4).join(':') + ':';
    const supported = entries.map(entry => entry.id).filter(entry => entry.startsWith(family));
    return { status: 'unsupported-version', encountered: id, supported: supported.length ? supported : entries.map(entry => entry.id) };
  }
  const problems = schemaProblems(id, safe);
  return problems ? { status: 'invalid', problems } : { status: 'ok', schema: id };
}
