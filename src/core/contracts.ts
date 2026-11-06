// `@aihq/core/contracts` (contract 3): portable, browser-safe. Exactly one schema per format with one valid and one
// invalid fixture each, every refusal code, the limits, and the portable readers and helpers. Nothing here touches the host.
import { distribution } from '../distribution.mjs';
import { schemas } from './plan/formats.js';
import { validateOrganization, type OrganizationResult } from './enterprise/organization.js';
import type { PackageSupport, SupportedContract } from './package-support.js';

export { schemas, validateFormat } from './plan/formats.js';
export type { FormatResult } from './plan/formats.js';
export { refusalCodes } from './plan/codes.js';
export type { RefusalCode } from './plan/codes.js';
export { limits } from './plan/limits.js';
export type { Limit } from './plan/limits.js';

// Authored changes (contract 4.2): read a change and derive its canonical, material-bound identity.
export { validateChange, deriveChangeIdentity } from './change/validate.js';
export type { Change, ChangeReference, ChangeResult, ChangeIdentity, DeriveChangeIdentityRequest } from './change/validate.js';

/** Reads an organization document (`urn:aihq:core:organization:0.1.0`, contract 11); no other version is read. */
export function validateOrganizationPolicy(value: unknown): OrganizationResult { return validateOrganization(value); }
export { previewAdmission } from './enterprise/preview.js';
export type { PreviewAdmissionRequest, PreviewAdmissionResult, AdmissionPreview } from './enterprise/preview.js';
export type { Organization, OrganizationEntry, OrganizationResult } from './enterprise/organization.js';

export { runMemberClaims, removalClaims, type RunMemberClaims, type RemovalClaims } from './run-claims.js';
export { stateLocation } from './state-location.js';
export type { StateLocation, StateLocationRoot, StateLocationMarker } from './state-location.js';

export { getGuidance, renderSupportMarkdown } from './support.js';
export type { SupportInput, SupportOptions, GuidanceResult, SupportMarkdownResult, GuidanceItem } from './support.js';

// Report snapshots and claim sets: `report:0.1.0` and `claims:0.1.0`, never throwing.
export { createReport, validateSnapshot, importSnapshot, exportSnapshot, validateClaimSet, readClaimSet, projectClaims,
  REPORT as REPORT_SCHEMA, CLAIMS as CLAIMS_SCHEMA } from './report.js';
export type { ReportResult, ReportSnapshot, ClaimSet, ClaimsProjection, CreateReportInput } from './report.js';

export { checkContracts } from './package-support.js';
export type { ContractFixture, SupportedContract, PackageSupport, ContractReadResult, CheckContractsRequest, ContractCheck,
  ContractCheckResult } from './package-support.js';

/** What Core reads (`accepts`), writes (`produces`), or keeps in its own state and reads back (`both`). */
const ROLES: Readonly<Record<string, SupportedContract['role']>> = {
  'plan-request': 'accepts', change: 'accepts', 'change-request': 'accepts', 'repair-request': 'accepts', 'repair-inputs': 'accepts',
  'export-request': 'accepts', 'export-inputs': 'accepts', 'macos-session-request': 'accepts', 'macos-session-inputs': 'accepts',
  'macos-session-verification-request': 'accepts', organization: 'accepts', 'native-verification-request': 'accepts',
  'native-verification-bundle': 'accepts', 'native-test-identity': 'accepts', claims: 'accepts',
  review: 'produces', run: 'produces', inventory: 'produces', 'file-check': 'produces', inspection: 'produces',
  'native-verification-result': 'produces', 'macos-session-verification-result': 'produces', 'native-verification-definition': 'produces',
  'macos-session-profiles': 'produces', repair: 'produces', 'trust-capabilities': 'produces', 'tool-registry': 'produces',
  'signer-records': 'produces', receipt: 'both', 'trust-custody': 'both', 'macos-session-custody': 'both', report: 'both',
  'package-support': 'both'
};
const at = (id: string, part: string) => `@aihq/core/contracts#schemas/${id}/${part}`;
/**
 * Core's own format declarations (C21, `urn:aihq:core:package-support:0.1.0`). Each schema and its fixtures are the
 * `schemas` entry of this module, addressed as `@aihq/core/contracts#schemas/<id>/{schema,fixtures/valid,fixtures/invalid}`.
 */
export const contractSupport: PackageSupport = Object.freeze({
  schema: 'urn:aihq:core:package-support:0.1.0',
  package: Object.freeze({ name: distribution.name, version: distribution.version }),
  contracts: Object.freeze(Object.keys(schemas).map(id => Object.freeze({
    id, role: ROLES[id.split(':')[3]!] ?? 'accepts', schemaExport: at(id, 'schema'), versions: Object.freeze([id.split(':')[4]!]),
    fixtures: Object.freeze([Object.freeze({ export: at(id, 'fixtures/valid'), expect: 'accept' as const }),
      Object.freeze({ export: at(id, 'fixtures/invalid'), expect: 'refuse' as const })])
  }))),
  entries: Object.freeze([
    Object.freeze({ export: '@aihq/core', runtime: 'node' as const, nodeRange: '>=26.12.1 <27' }),
    Object.freeze({ export: '@aihq/core/contracts', runtime: 'portable' as const }),
    Object.freeze({ export: '@aihq/core/harness', runtime: 'portable' as const }),
    Object.freeze({ export: '@aihq/core/harness/runtime', runtime: 'node' as const, nodeRange: '>=26.12.1 <27' })
  ])
});
