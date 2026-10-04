// Portable trust/export contracts, types and strict validators.
//
// Importing or calling anything here performs no host observation, process
// execution, network access, writes or state lookup. The strict JSON rules match
// the existing portable validators in `contracts.ts`: bounded plain JSON data
// first, then the published schema, then the semantic rules that a JSON schema
// cannot express. Unknown/mismatched schema IDs are refused without fallback.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import repairRequestSchema from './schemas/repair-request/1.0.0.json' with { type: 'json' };
import repairInputsSchema from './schemas/repair-inputs/1.0.0.json' with { type: 'json' };
import certificateExportRequestSchema from './schemas/certificate-export-request/1.0.0.json' with { type: 'json' };
import certificateExportInputsSchema from './schemas/certificate-export-inputs/1.0.0.json' with { type: 'json' };
import preparedWork12Schema from './schemas/prepared-work/1.2.0.json' with { type: 'json' };
import runResult12Schema from './schemas/run-result/1.2.0.json' with { type: 'json' };
import trustCustodySchema from './schemas/trust-custody/1.0.0.json' with { type: 'json' };
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, STRICT_JSON_MAX_DEPTH_V1 } from './internal/strict-json.js';
import { canonicalJson } from './internal/canonical.js';
import type { Diagnostic, ValidationResult } from './types.js';

/** Lowercase 64-character hexadecimal SHA-256 digest with no prefix. */
export type Sha256 = string;

export const TRUST_REPAIR_REQUEST_1_0_0 = 'urn:aihq:core:repair-request:1.0.0' as const;
export const TRUST_REPAIR_INPUTS_1_0_0 = 'urn:aihq:core:repair-inputs:1.0.0' as const;
export const CERTIFICATE_EXPORT_REQUEST_1_0_0 = 'urn:aihq:core:certificate-export-request:1.0.0' as const;
export const CERTIFICATE_EXPORT_INPUTS_1_0_0 = 'urn:aihq:core:certificate-export-inputs:1.0.0' as const;
export const PREPARED_WORK_1_2_0 = 'urn:aihq:core:prepared-work:1.2.0' as const;
export const RUN_RESULT_1_2_0 = 'urn:aihq:core:run-result:1.2.0' as const;
export const TRUST_CUSTODY_1_0_0 = 'urn:aihq:core:trust-custody:1.0.0' as const;
export const HARNESS_REPAIR_1_1_0 = 'urn:aihq:harness:repair:1.1.0' as const;

export type TrustRepairId = 'node-npm-ca' | 'user-tools-ca' | 'jvm-ca';
export type TrustRoute = 'native' | 'file';
export type TrustRouteOrExport = 'native' | 'file' | 'export';
export type TrustNetwork = 'declared' | 'off';
export type TrustSourceKind = 'os' | 'supplied' | 'node-bundled' | 'jvm-baseline';
export type TrustCompleteness = 'complete' | 'incomplete' | 'unavailable';
export type TrustSourceScope = 'effective-current-user' | 'explicit-source' | 'runtime-bundled' | 'selected-jvm-baseline';
export type TrustProjection = 'windows-effective-server-auth-v1' | 'macos-effective-server-auth-v1' | 'ubuntu-24.04-system-openssl-v1';
export type TrustOutputFormat = 'pem' | 'pkcs7-der' | 'jks';
export type TrustOutputEffect = 'create' | 'unchanged' | 'replace' | 'conflict' | 'unavailable';
export type TrustCertificateDisposition = 'added' | 'removed' | 'retained' | 'provenance-changed' | 'excluded';

/** Request-level source selection. `os:false` explicitly removes the OS partition after review. */
export interface SuppliedTrustSource {
  id: string;
  file: string;
}
export interface TrustSources {
  os: boolean;
  supplied: readonly SuppliedTrustSource[];
  removeSupplied?: readonly string[];
}
export interface TrustResolution {
  selectionId: string;
  operationId: string;
  choice: 'replace';
  observedSha256: Sha256 | null;
}
export interface TrustRepairStep {
  id: TrustRepairId;
  targets: readonly string[];
  inputs: Readonly<Record<string, string | boolean | number>>;
}
export interface TrustRepairRequest {
  schema: typeof TRUST_REPAIR_REQUEST_1_0_0;
  useCase: 'repair';
  repairs: readonly [TrustRepairStep];
  route: TrustRoute;
  sources?: TrustSources;
  network?: TrustNetwork;
  resolutions?: readonly TrustResolution[];
}
export interface TrustRepairInputs {
  schema: typeof TRUST_REPAIR_INPUTS_1_0_0;
  route: TrustRoute;
  repairs: Partial<Record<TrustRepairId, Readonly<Record<string, string | boolean | number>>>>;
  sources?: TrustSources;
}
export interface CertificateExportRequest {
  schema: typeof CERTIFICATE_EXPORT_REQUEST_1_0_0;
  useCase: 'certificate-export';
  format?: 'pem' | 'pkcs7-der';
  output?: string;
  sources?: TrustSources;
  network?: TrustNetwork;
  resolutions?: readonly TrustResolution[];
}
export interface CertificateExportInputs {
  schema: typeof CERTIFICATE_EXPORT_INPUTS_1_0_0;
  sources: TrustSources;
}

export interface TrustSourceAdapter {
  id: string;
  version: string;
  sha256: Sha256;
}
export interface TrustSourceReview {
  id: string;
  kind: TrustSourceKind;
  adapter: TrustSourceAdapter | null;
  scope: TrustSourceScope;
  completeness: TrustCompleteness;
  policySha256: Sha256 | null;
  sourceSha256: Sha256 | null;
  runtimeVersion: string | null;
  reason: string | null;
  fingerprints: readonly Sha256[];
}
export interface TrustTargetClient {
  version: string;
  executableSha256: Sha256;
  backend: string;
  backendVersion: string;
  applicationId: string | null;
}
export interface TrustTargetPolicy {
  projection: TrustProjection;
  binding: 'live-os' | 'snapshot';
  observationSha256: Sha256;
  scope: string;
}
export interface TrustSecondarySource {
  id: string;
  disposition: 'participates' | 'ignored';
  sha256: Sha256 | null;
}
export interface TrustTargetVerification {
  status: 'planned' | 'skipped' | 'unavailable';
  reason: string;
  checkIds: readonly string[];
}
export interface TrustTargetReview {
  id: string;
  route: TrustRoute;
  admission: 'admitted' | 'unavailable';
  reason: string | null;
  cellId: string | null;
  client: TrustTargetClient | null;
  policy: TrustTargetPolicy | null;
  configurationSha256: Sha256 | null;
  secondarySources: readonly TrustSecondarySource[];
  verification: TrustTargetVerification;
}
export interface CertificateReview {
  fingerprint: Sha256;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  beforeSources: readonly string[];
  afterSources: readonly string[];
  disposition: TrustCertificateDisposition;
  reasons: readonly string[];
}
export interface TrustOutputReview {
  selectionId: string;
  operationId: string;
  managementId: string;
  path: string;
  pathKey: string;
  format: TrustOutputFormat;
  consumerProfile: string;
  beforeSha256: Sha256 | null;
  afterSha256: Sha256 | null;
  custodyBeforeSha256: Sha256 | null;
  certificateCount: number;
  effect: TrustOutputEffect;
}
/** Exact `inputs` branch of prepared-work 1.2.0 (and run-result 1.2.0 `inputs`). */
export interface TrustInputs {
  trust: {
    route: TrustRouteOrExport;
    definition: { id: string; schema: typeof HARNESS_REPAIR_1_1_0 };
    helperSha256: Sha256;
    package: { name: '@aihq/core'; version: string };
    bindingSha256: Sha256;
    sourceSetSha256: Sha256 | null;
    targets: readonly TrustTargetReview[];
    sources: readonly TrustSourceReview[];
    certificates: readonly CertificateReview[];
    outputs: readonly TrustOutputReview[];
  };
}
export interface TrustRunOutput {
  operationId: string;
  path: string;
  format: TrustOutputFormat;
  sha256: Sha256;
  certificateCount: number;
  status: 'written' | 'unchanged';
}
export interface TrustRunTarget {
  id: string;
  configuration: 'applied' | 'already-satisfied' | 'not-applied' | 'uncertain';
  verification: 'passed' | 'failed' | 'unavailable' | 'skipped';
  reason: string;
  policyObservationSha256: Sha256 | null;
}
export interface TrustRunTrust {
  outputs: readonly TrustRunOutput[];
  targets: readonly TrustRunTarget[];
}
export interface TrustCustodySource {
  id: string;
  kind: TrustSourceKind;
  fingerprints: readonly Sha256[];
  sourceSha256: Sha256;
  policySha256: Sha256 | null;
  runtimeVersion: string | null;
  privateFile: string | null;
}
export interface TrustCustodyEntry {
  managementId: string;
  selectionId: string;
  operationId: string;
  pathKey: string;
  relativePath: string;
  format: TrustOutputFormat;
  outputSha256: Sha256;
  recipeIdentity: string;
  sourceSetSha256: Sha256;
  sources: readonly TrustCustodySource[];
}
export interface TrustCustody {
  schema: typeof TRUST_CUSTODY_1_0_0;
  entries: readonly TrustCustodyEntry[];
}

export const trustContractSchemas = Object.freeze([
  repairRequestSchema,
  repairInputsSchema,
  certificateExportRequestSchema,
  certificateExportInputsSchema,
  preparedWork12Schema,
  runResult12Schema,
  trustCustodySchema
] as const);

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of trustContractSchemas) ajv.addSchema(schema);
const checkTrustRepairRequest = ajv.getSchema(repairRequestSchema.$id) as ValidateFunction;
const checkTrustRepairInputs = ajv.getSchema(repairInputsSchema.$id) as ValidateFunction;
const checkCertificateExportRequest = ajv.getSchema(certificateExportRequestSchema.$id) as ValidateFunction;
const checkCertificateExportInputs = ajv.getSchema(certificateExportInputsSchema.$id) as ValidateFunction;
const checkPreparedWork12 = ajv.getSchema(preparedWork12Schema.$id) as ValidateFunction;
const checkRunResult12 = ajv.getSchema(runResult12Schema.$id) as ValidateFunction;
const checkTrustCustody = ajv.getSchema(trustCustodySchema.$id) as ValidateFunction;

type Data = Record<string, unknown>;
const isObject = (value: unknown): value is Data => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (reason: string, path?: string): Diagnostic => ({
  code: 'INPUT_INVALID', reason, message: 'The document does not satisfy the published contract.', ...(path === undefined ? {} : { path })
});

/** Reads the caller value once through the shared strict-JSON rules; never invokes a getter. */
function inspect(value: unknown, maxBytes?: number): { safe: Data } | { diagnostic: Diagnostic } {
  try {
    const safe = cloneJsonValueStructureV1(value, 'document', STRICT_JSON_MAX_DEPTH_V1, maxBytes ?? Infinity);
    assertStrictJsonValueV1(safe, 'document');
    if (!isObject(safe)) throw new TypeError('document root must be an object');
    if (maxBytes !== undefined && new TextEncoder().encode(canonicalJson(safe)).length > maxBytes)
      throw new TypeError('document byte limit');
    return { safe };
  } catch {
    return { diagnostic: { code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' } };
  }
}

function validateAgainst(
  value: unknown,
  expected: string,
  check: ValidateFunction,
  semantics: (document: Data) => Diagnostic[]
): ValidationResult {
  // Complete produced facts are governed by discovery/output limits, never the
  // optional history cap. Private provenance has its own exact 1 MiB limit.
  const maxBytes = expected === PREPARED_WORK_1_2_0 || expected === RUN_RESULT_1_2_0 ? undefined :
    expected === TRUST_CUSTODY_1_0_0 ? 1_048_576 : 1_000_000;
  const inspected = inspect(value, maxBytes);
  if ('diagnostic' in inspected) return { valid: false, diagnostics: [inspected.diagnostic] };
  const { safe } = inspected;
  const found = safe.schema;
  if (typeof found === 'string' && found !== expected) return {
    valid: false, schema: found, diagnostics: [{
      code: 'SCHEMA_UNSUPPORTED', reason: 'schema-unsupported', message: 'This format is not supported.',
      path: '/schema', encountered: found, supported: [expected]
    }]
  };
  const semantic = semantics(safe);
  if (semantic.length > 0) return { valid: false, schema: expected, diagnostics: semantic };
  if (check(safe)) return { valid: true, schema: expected, diagnostics: [] };
  return {
    valid: false, schema: expected,
    diagnostics: (check.errors ?? []).map(error => ({
      code: 'INPUT_INVALID', reason: error.keyword === 'additionalProperties' ? 'unknown-field' : error.keyword,
      message: 'The document does not satisfy the published schema.', path: error.instancePath
    }))
  };
}

/** Strictly ascending (therefore also duplicate-free) string list. */
function sortedUniqueStrings(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  for (let index = 1; index < value.length; index += 1) {
    const previous = value[index - 1];
    const current = value[index];
    if (typeof previous !== 'string' || typeof current !== 'string') return true;
    if (!(previous < current)) return false;
  }
  return true;
}

function trustSourcesSemantics(sources: unknown, base: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isObject(sources)) return out;
  const supplied = Array.isArray(sources.supplied) ? sources.supplied : [];
  const added = new Set<string>();
  supplied.forEach((source, index) => {
    if (!isObject(source) || typeof source.id !== 'string') return;
    if (added.has(source.id)) out.push(invalid('invalid-source-selection', `${base}/supplied/${String(index)}/id`));
    added.add(source.id);
  });
  const remove = Array.isArray(sources.removeSupplied) ? sources.removeSupplied : [];
  const removed = new Set<string>();
  remove.forEach((id, index) => {
    if (typeof id !== 'string') return;
    if (removed.has(id)) out.push(invalid('invalid-source-selection', `${base}/removeSupplied/${String(index)}`));
    removed.add(id);
  });
  for (const id of removed) if (added.has(id)) out.push(invalid('invalid-source-selection', `${base}/supplied`));
  return out;
}

function routeSourcesSemantics(document: Data): Diagnostic[] {
  const out: Diagnostic[] = [];
  const hasSources = Object.hasOwn(document, 'sources');
  if (document.route === 'native' && hasSources) out.push(invalid('invalid-source-selection', '/sources'));
  if (document.route === 'file' && !hasSources) out.push(invalid('invalid-source-selection', '/sources'));
  out.push(...trustSourcesSemantics(document.sources, '/sources'));
  return out;
}

function caFileSemantics(repairs: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const entries = Array.isArray(repairs) ? repairs : isObject(repairs) ? Object.values(repairs) : [];
  entries.forEach((entry, index) => {
    if (isObject(entry) && isObject(entry.inputs) && Object.hasOwn(entry.inputs, 'caFile'))
      out.push(invalid('unknown-field', `/repairs/${String(index)}/inputs/caFile`));
  });
  return out;
}

function repairRequestSemantics(document: Data): Diagnostic[] {
  return [...routeSourcesSemantics(document), ...caFileSemantics(document.repairs)];
}
function repairInputsSemantics(document: Data): Diagnostic[] {
  const out = routeSourcesSemantics(document);
  const repairs = isObject(document.repairs) ? document.repairs : undefined;
  if (repairs !== undefined) for (const [id, value] of Object.entries(repairs)) {
    if (isObject(value) && Object.hasOwn(value, 'caFile')) out.push(invalid('unknown-field', `/repairs/${id}/caFile`));
  }
  return out;
}
function certificateExportRequestSemantics(document: Data): Diagnostic[] {
  const out = trustSourcesSemantics(document.sources, '/sources');
  const output = document.output;
  if (typeof output === 'string') {
    const format = document.format === 'pkcs7-der' ? 'pkcs7-der' : 'pem';
    const expected = format === 'pkcs7-der' ? '.p7b' : '.pem';
    const slash = output.lastIndexOf('/');
    const dot = output.lastIndexOf('.');
    const extension = dot > slash ? output.slice(dot) : '';
    if (extension !== expected) out.push(invalid('format-path-mismatch', '/output'));
  }
  return out;
}
function certificateExportInputsSemantics(document: Data): Diagnostic[] {
  return trustSourcesSemantics(document.sources, '/sources');
}
function sourceRowsSemantics(sources: unknown[], base: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  sources.forEach((source, index) => {
    if (!isObject(source)) return;
    const id = source.id;
    const expected = source.kind === 'os' ? 'os' : source.kind === 'node-bundled' ? 'node-bundled-default' :
      source.kind === 'jvm-baseline' ? 'jvm-baseline' : undefined;
    if (typeof id === 'string') {
      if (seen.has(id) || (source.kind === 'supplied' ? !/^supplied:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) : id !== expected))
        out.push(invalid('invalid-source-selection', `${base}/${String(index)}/id`));
      seen.add(id);
    }
    if (!sortedUniqueStrings(source.fingerprints)) out.push(invalid('source-order', `${base}/${String(index)}/fingerprints`));
  });
  return out;
}
function preparedWork12Semantics(document: Data): Diagnostic[] {
  const out: Diagnostic[] = [];
  const inputs = isObject(document.inputs) ? document.inputs : undefined;
  const trust = inputs && isObject(inputs.trust) ? inputs.trust : undefined;
  if (trust === undefined) return out;
  const sources = Array.isArray(trust.sources) ? trust.sources : [];
  out.push(...sourceRowsSemantics(sources, '/inputs/trust/sources'));
  const certificates = Array.isArray(trust.certificates) ? trust.certificates : [];
  certificates.forEach((certificate, index) => {
    if (!isObject(certificate)) return;
    if (!sortedUniqueStrings(certificate.beforeSources))
      out.push(invalid('certificate-order', `/inputs/trust/certificates/${String(index)}/beforeSources`));
    if (!sortedUniqueStrings(certificate.afterSources))
      out.push(invalid('certificate-order', `/inputs/trust/certificates/${String(index)}/afterSources`));
  });
  return out;
}
function runResult12Semantics(document: Data): Diagnostic[] {
  return preparedWork12Semantics(document);
}
function trustCustodySemantics(document: Data): Diagnostic[] {
  const out: Diagnostic[] = [];
  const entries = Array.isArray(document.entries) ? document.entries : [];
  let previousPathKey: string | undefined;
  let previousManagementId: string | undefined;
  entries.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const pathKey = typeof entry.pathKey === 'string' ? entry.pathKey : undefined;
    const managementId = typeof entry.managementId === 'string' ? entry.managementId : undefined;
    if (pathKey !== undefined && managementId !== undefined && previousPathKey !== undefined && previousManagementId !== undefined &&
        (pathKey < previousPathKey || (pathKey === previousPathKey && managementId <= previousManagementId)))
      out.push(invalid('custody-order', `/entries/${String(index)}`));
    if (pathKey !== undefined) previousPathKey = pathKey;
    if (managementId !== undefined) previousManagementId = managementId;
    const sources = Array.isArray(entry.sources) ? entry.sources : [];
    out.push(...sourceRowsSemantics(sources, `/entries/${String(index)}/sources`));
  });
  return out;
}

export const validateTrustRepairRequest = (value: unknown): ValidationResult =>
  validateAgainst(value, repairRequestSchema.$id, checkTrustRepairRequest, repairRequestSemantics);
export const validateTrustRepairInputs = (value: unknown): ValidationResult =>
  validateAgainst(value, repairInputsSchema.$id, checkTrustRepairInputs, repairInputsSemantics);
export const validateCertificateExportRequest = (value: unknown): ValidationResult =>
  validateAgainst(value, certificateExportRequestSchema.$id, checkCertificateExportRequest, certificateExportRequestSemantics);
export const validateCertificateExportInputs = (value: unknown): ValidationResult =>
  validateAgainst(value, certificateExportInputsSchema.$id, checkCertificateExportInputs, certificateExportInputsSemantics);
export const validatePreparedWork12 = (value: unknown): ValidationResult =>
  validateAgainst(value, preparedWork12Schema.$id, checkPreparedWork12, preparedWork12Semantics);
export const validateRunResult12 = (value: unknown): ValidationResult =>
  validateAgainst(value, runResult12Schema.$id, checkRunResult12, runResult12Semantics);
export const validateTrustCustody = (value: unknown): ValidationResult =>
  validateAgainst(value, trustCustodySchema.$id, checkTrustCustody, trustCustodySemantics);
