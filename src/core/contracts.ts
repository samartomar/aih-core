import { describeContract } from '../contract-fixtures.mjs';
import type { PackageSupport, SupportedContract } from './package-support.js';
import { distribution } from '../distribution.mjs';
import policySchema from './schemas/execution-policy/1.0.0.json' with { type: 'json' };
import recipeSchema from './schemas/recipe/1.0.0.json' with { type: 'json' };
import preparedSchema from './schemas/prepared-work/1.0.0.json' with { type: 'json' };
import resultSchema from './schemas/run-result/1.0.0.json' with { type: 'json' };
import policySchema14 from './schemas/execution-policy/1.4.0.json' with { type: 'json' };
import preparedSchema16 from './schemas/prepared-work/1.6.0.json' with { type: 'json' };
import resultSchema14 from './schemas/run-result/1.4.0.json' with { type: 'json' };
import policySchema13 from './schemas/execution-policy/1.3.0.json' with { type: 'json' };
import recipeSchema13 from './schemas/recipe/1.3.0.json' with { type: 'json' };
import recipeSchema14 from './schemas/recipe/1.4.0.json' with { type: 'json' };
import policySchema12 from './schemas/execution-policy/1.2.0.json' with { type: 'json' };
import recipeSchema12 from './schemas/recipe/1.2.0.json' with { type: 'json' };
import preparedSchema14 from './schemas/prepared-work/1.4.0.json' with { type: 'json' };
import preparedSchema15 from './schemas/prepared-work/1.5.0.json' with { type: 'json' };
import organizationTargetSchema from './schemas/organization-target/1.0.0.json' with { type: 'json' };
import organizationTargetSchema11 from './schemas/organization-target/1.1.0.json' with { type: 'json' };
import managedRemovalSchema11 from './schemas/managed-removal-preparation/1.1.0.json' with { type: 'json' };
import managedRemovalSchema12 from './schemas/managed-removal-preparation/1.2.0.json' with { type: 'json' };
import policySchema11 from './schemas/execution-policy/1.1.0.json' with { type: 'json' };
import recipeSchema11 from './schemas/recipe/1.1.0.json' with { type: 'json' };
import preparedSchema11 from './schemas/prepared-work/1.1.0.json' with { type: 'json' };
import resultSchema11 from './schemas/run-result/1.1.0.json' with { type: 'json' };
import organizationSchema from './schemas/organization-policy/1.0.0.json' with { type: 'json' };
import organizationSchema11 from './schemas/organization-policy/1.1.0.json' with { type: 'json' };
import fileStateSchema from './schemas/file-state-result/1.1.0.json' with { type: 'json' };
import managedInventorySchema from './schemas/managed-inventory-result/1.0.0.json' with { type: 'json' };
import managedInventorySchema11 from './schemas/managed-inventory-result/1.1.0.json' with { type: 'json' };
import managedRemovalSchema from './schemas/managed-removal-preparation/1.0.0.json' with { type: 'json' };
import { parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { registerSchemas, schemaCheck, validateAcceptedDocument, validateExactDocument } from './internal/contract-validation.js';
import type { ExecutionPolicy, OrganizationParseResult, OrganizationPolicy, ParseResult, ValidationResult } from './types.js';
import { organizationSemantics, organizationTargetSemantics, policySemantics, recipeSemantics } from './internal/policy-validation.js';
import { trustContractSchemas } from './trust-contracts.js';
import macosRequestSchema from './schemas/repair-request/1.1.0.json' with { type: 'json' };
import macosInputsSchema from './schemas/repair-inputs/1.1.0.json' with { type: 'json' };
import macosPreparedSchema from './schemas/prepared-work/1.3.0.json' with { type: 'json' };
import macosResultSchema from './schemas/run-result/1.3.0.json' with { type: 'json' };
import macosCustodySchema from './schemas/macos-session-custody/1.0.0.json' with { type: 'json' };
import macosVerificationRequestSchema from './schemas/macos-session-verification-request/1.0.0.json' with { type: 'json' };
import macosVerificationResultSchema from './schemas/macos-session-verification-result/1.0.0.json' with { type: 'json' };
// Explicit type exports: the document shapes this entry parses, validates or derives.
export type { MacosSessionClientId, MacosSessionContext, MacosSessionLaunch, MacosSessionApplication, MacosSessionSelection,
  MacosSession, MacosRepairRequest, MacosRepairInputs, MacosSessionState, MacosSessionApplicationReview,
  MacosSessionEffect, MacosSessionReview, MacosSessionConfiguration, MacosSessionVerification,
  MacosSessionApplicationRun, MacosSessionRun, MacosSessionVerificationRequest, MacosSessionObservation,
  MacosSessionCheck, MacosSessionRecordStatus, MacosSessionVerificationResult, MacosSessionPresence,
  MacosSessionCustodyFile, MacosSessionCustodyKey, MacosSessionCustodyEntry, MacosSessionCustody } from './macos-session-contracts.js';
export { validateMacosRepairRequest, validateMacosRepairInputs, validateMacosSessionReview, validateMacosSessionRun,
  validateMacosSessionCustody, validateMacosSessionVerificationRequest, validateMacosSessionVerificationResult,
  validateMacosSessionProfiles, validatePreparedWork13, validateRunResult13,
  MACOS_REPAIR_REQUEST_SCHEMA, MACOS_REPAIR_INPUTS_SCHEMA, MACOS_PREPARED_WORK_SCHEMA, MACOS_RUN_RESULT_SCHEMA,
  MACOS_SESSION_CUSTODY_SCHEMA, MACOS_SESSION_VERIFICATION_REQUEST_SCHEMA, MACOS_SESSION_VERIFICATION_RESULT_SCHEMA } from './macos-session-contracts.js';
export type { Json, Diagnostic, ValidationResult, ParseResult, Slot, InputSpec, TargetPath, OperationBase, FileOperation,
  ConfigEntrySet, ConfigEntryRemove, ConfigOperation, TextBlockOperation, RemoveOperation, Executable,
  ProcessInvocation, ProcessOperation, JsonObject, HookGroupOperation, Operation, FileCheck, ProcessCheck,
  RecipeCheck, MaterialSource, MaterialIdentity, MaterialMember, InlineMaterial, MaterialRecipeReference,
  Prerequisite, Recipe, Selection, SelectionMetadata, InclusionOrigin, CatalogItemRef, ExecutionPolicy, OrganizationInputPermission, OrganizationSelection,
  OrganizationObligation, OrganizationTargetFact, OrganizationTargetFacts, OrganizationTarget,
  OrganizationTargetDeclaration, OrganizationTargetDeclaration10, OrganizationTargetDeclaration11, OrganizationApplicability, OrganizationObligationResultBase,
  OrganizationAdvisoryResult, OrganizationFulfillmentResult, OrganizationSelection11, OrganizationPolicy10,
  OrganizationPolicy11, OrganizationPolicy, OrganizationParseResult } from './types.js';
export { deriveRecipeIdentity, previewOrganizationAdmission, previewOrganizationObligations } from './authoring-helpers.js';
export { recipeOperationKinds } from './operation-kinds.js';
export type { OperationEffectsVisibility, RecipeOperationKind, RecipeOperationKindRecord, RecipeSchemaId } from './operation-kinds.js';
export type { PackageDetails, AuthoringDiagnostic, AuthoringResult, DeriveRecipeIdentityRequest, RecipeIdentity,
  OrganizationAdmissionSelection, OrganizationAdmissionLifecycle, PreviewOrganizationAdmissionRequest,
  OrganizationAdmissionPreview, PreviewOrganizationObligationsRequest, OrganizationObligationsPreview } from './authoring-helpers.js';
export type { Sha256, TrustRepairId, TrustRoute, TrustRouteOrExport, TrustNetwork, TrustSourceKind, TrustCompleteness,
  TrustSourceScope, TrustProjection, TrustOutputFormat, TrustOutputEffect, TrustCertificateDisposition,
  SuppliedTrustSource, TrustSources, TrustResolution, TrustRepairStep, TrustRepairRequest, TrustRepairInputs,
  CertificateExportRequest, CertificateExportInputs, TrustSourceAdapter, TrustSourceReview, TrustTargetClient,
  TrustTargetPolicy, TrustSecondarySource, TrustTargetVerification, TrustTargetReview, CertificateReview,
  TrustOutputReview, TrustInputs, TrustRunOutput, TrustRunTarget, TrustRunTrust, TrustCustodySource,
  TrustCustodyEntry, TrustCustody } from './trust-contracts.js';
export {
  validateTrustRepairRequest, validateTrustRepairInputs,
  validateCertificateExportRequest, validateCertificateExportInputs,
  validatePreparedWork12, validatePreparedWork14, validateRunResult12, validateTrustCustody
} from './trust-contracts.js';
export type { NativeClientId, NativeMember, NativeTreeFile, NativeVerificationRequest,
  NativeVerificationBundle, NativeStageOutcome, NativeStageEvidence, NativeStage,
  NativeVerificationResult } from './native-contracts.js';
export { runMemberClaims, removalClaims, type RunMemberClaims, type RemovalClaims } from './run-claims.js';
export { validateNativeVerificationRequest, validateNativeVerificationResult,
  validateNativeVerificationBundle } from './native-contracts.js';

registerSchemas(recipeSchema, recipeSchema11, recipeSchema12, recipeSchema13, recipeSchema14, policySchema, policySchema11, policySchema12, policySchema13, policySchema14,
  organizationSchema, organizationSchema11, organizationTargetSchema, organizationTargetSchema11, fileStateSchema);
const checkFileStateResult = schemaCheck(fileStateSchema.$id);
/** Validate a stored file-state 1.1.0 result without observing or changing the host. */
export const validateFileStateResult = (value: unknown): ValidationResult =>
  validateExactDocument(value, fileStateSchema.$id, checkFileStateResult, () => []);

const schemaVersion = (id: string): string => id.split(':')[4]!;
const trustSchemaRoles: Readonly<Record<string, 'accepts' | 'produces' | 'both'>> = Object.freeze({
  [trustContractSchemas[0].$id]: 'accepts',
  [trustContractSchemas[1].$id]: 'accepts',
  [trustContractSchemas[2].$id]: 'accepts',
  [trustContractSchemas[3].$id]: 'accepts',
  [trustContractSchemas[4].$id]: 'produces',
  [trustContractSchemas[5].$id]: 'produces',
  [trustContractSchemas[6].$id]: 'both'
});
export const contractSupport = Object.freeze({
  schema: 'urn:aihq:package-support:1.1.0',
  package: distribution,
  contracts: ([
    ...[policySchema, recipeSchema, preparedSchema, resultSchema, organizationSchema,
      policySchema11, recipeSchema11, preparedSchema11, resultSchema11, fileStateSchema,
      managedInventorySchema, managedRemovalSchema, policySchema12, recipeSchema12, preparedSchema14, managedRemovalSchema11, policySchema13, recipeSchema13, organizationSchema11,
      organizationTargetSchema, preparedSchema15, organizationTargetSchema11, policySchema14, preparedSchema16, resultSchema14, managedInventorySchema11, recipeSchema14, managedRemovalSchema12].map((schema): SupportedContract => ({
      id: schema.$id, role: [preparedSchema, resultSchema, fileStateSchema, preparedSchema11, resultSchema11,
        managedInventorySchema, managedRemovalSchema, preparedSchema14, managedRemovalSchema11, preparedSchema15, preparedSchema16, resultSchema14, managedInventorySchema11, managedRemovalSchema12].includes(schema as never) ? 'produces' : 'accepts',
      schemaExport: `@aihq/core/schemas/${schema.$id.split(':')[3]}/${schemaVersion(schema.$id)}.json`
    })),
    ...trustContractSchemas.map((schema): SupportedContract => ({
      id: schema.$id, role: trustSchemaRoles[schema.$id] ?? 'accepts',
      schemaExport: `@aihq/core/schemas/${schema.$id.split(':')[3]}/${schemaVersion(schema.$id)}.json`
    })),
    ...[macosRequestSchema, macosInputsSchema, macosPreparedSchema, macosResultSchema, macosCustodySchema,
      macosVerificationRequestSchema, macosVerificationResultSchema].map((schema): SupportedContract => ({
      id: schema.$id, role: schema === macosCustodySchema ? 'both' :
        [macosPreparedSchema, macosResultSchema, macosVerificationResultSchema].includes(schema as never) ? 'produces' : 'accepts',
      schemaExport: `@aihq/core/schemas/${schema.$id.split(':')[3]}/${schemaVersion(schema.$id)}.json`
    })),
    { id: 'urn:aihq:harness:repair:1.2.0', role: 'accepts', schemaExport: '@aihq/core/harness/schemas/repair/1.2.0.json' },
    { id: 'urn:aihq:harness:macos-session-profiles:1.0.0', role: 'accepts', schemaExport: '@aihq/core/harness/schemas/macos-session-profiles/1.0.0.json' },
    { id: 'urn:aihq:harness:repair:1.1.0', role: 'accepts',
      schemaExport: '@aihq/core/harness/schemas/repair/1.1.0.json' },
    { id: 'urn:aihq:harness:trust-capabilities:1.0.0', role: 'accepts',
      schemaExport: '@aihq/core/harness/schemas/trust-capabilities/1.0.0.json' },
    { id: 'urn:aihq:core:native-verification-request:1.0.0', role: 'accepts', schemaExport: '@aihq/core/schemas/native-verification-request/1.0.0.json' },
    { id: 'urn:aihq:core:native-verification-result:1.0.0', role: 'both', schemaExport: '@aihq/core/schemas/native-verification-result/1.0.0.json' },
    { id: 'urn:aihq:core:native-verification-bundle:1.0.0', role: 'accepts', schemaExport: '@aihq/core/schemas/native-verification-bundle/1.0.0.json' },
    { id: 'urn:aihq:harness:native-verification-definition:1.0.0', role: 'accepts', schemaExport: '@aihq/core/harness/schemas/native-verification-definition/1.0.0.json' },
    { id: 'urn:aihq:harness:native-test-identity:1.0.0', role: 'accepts', schemaExport: '@aihq/core/harness/schemas/native-test-identity/1.0.0.json' },
    { id: 'urn:aihq:package-support:1.0.0', role: 'both', schemaExport: '@aihq/core/schemas/package-support/1.0.0.json' },
    { id: 'urn:aihq:package-support:1.1.0', role: 'both', schemaExport: '@aihq/core/schemas/package-support/1.1.0.json' }
  ] as const satisfies readonly SupportedContract[]).map(describeContract),
  entries: [
    { export: '@aihq/core/contracts', runtime: 'portable' },
    { export: '@aihq/core/support', runtime: 'portable' },
    { export: '@aihq/core/report', runtime: 'portable' },
    { export: '@aihq/core/harness', runtime: 'portable' },
    { export: '@aihq/core/harness/runtime', runtime: 'node', nodeRange: '>=24.15.0 <25' },
    { export: '@aihq/core', runtime: 'node', nodeRange: '>=24.15.0 <25' }
  ]
} satisfies PackageSupport);

const accepting = (...schemas: { $id: string }[]) => Object.freeze(Object.fromEntries(schemas.map(schema => [schema.$id, schemaCheck(schema.$id)])));
const policies = accepting(policySchema, policySchema11, policySchema12, policySchema13, policySchema14);
const recipes = accepting(recipeSchema, recipeSchema11, recipeSchema12, recipeSchema13, recipeSchema14);
const organizations = accepting(organizationSchema, organizationSchema11);
const organizationTargets = accepting(organizationTargetSchema, organizationTargetSchema11);
export const validatePolicy = (value: unknown): ValidationResult =>
  validateAcceptedDocument(value, policies, policySemantics as never);
export const validateRecipe = (value: unknown): ValidationResult =>
  validateAcceptedDocument(value, recipes, recipeSemantics as never);
export const validateOrganizationPolicy = (value: unknown): ValidationResult =>
  validateAcceptedDocument(value, organizations, organizationSemantics as never);
/** Caller-declared client (1.0.0) or registry tool (1.1.0) and optional repository for Enterprise preparation; declared, never inferred. */
export const validateOrganizationTarget = (value: unknown): ValidationResult =>
  validateAcceptedDocument(value, organizationTargets, organizationTargetSemantics as never);
export function parsePolicy(text: string): ParseResult {
  try {
    if (typeof text !== 'string' || text.length > 1_000_000 || new TextEncoder().encode(text).length > 1_000_000) throw new Error('input limit');
    const document = parseStrictJsonObjectV1(text, 'policy');
    const result = validatePolicy(document);
    return result.valid ? { ...result, document: document as unknown as ExecutionPolicy } : result;
  } catch {
    return { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] };
  }
}
export function parseOrganizationPolicy(text: string): OrganizationParseResult {
  try {
    if (typeof text !== 'string' || text.length > 1_000_000 || new TextEncoder().encode(text).length > 1_000_000) throw new Error('input limit');
    const document = parseStrictJsonObjectV1(text, 'organization policy');
    const result = validateOrganizationPolicy(document);
    return result.valid ? { ...result, document: document as unknown as OrganizationPolicy } : result;
  } catch {
    return { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] };
  }
}

export { checkContracts, validatePackageSupport } from './package-support.js';
export { stateLocation } from './state-location.js';
export type { StateLocation, StateLocationRoot, StateLocationMarker } from './state-location.js';
export type { ContractFixture, SupportedContract, PackageSupport, ContractReadResult, CheckContractsRequest, ContractCheck, ContractCheckResult } from './package-support.js';
