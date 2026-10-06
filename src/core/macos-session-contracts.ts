// Portable macOS session contracts, types and strict validators.
//
// Importing or calling anything here performs no host observation, process
// execution, network access, writes or state lookup. The strict JSON rules match
// the existing portable validators in `trust-contracts.ts`: bounded plain JSON
// data first, then the published schema, then the semantic rules that a JSON
// schema cannot express. Unknown/mismatched schema IDs are refused without
// fallback. The session additions delegate to the immutable 1.0/1.2 validators
// after stripping their explicit session members, so inherited semantics are
// preserved by construction rather than copied.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import macosRepairRequestSchema from './schemas/repair-request/1.1.0.json' with { type: 'json' };
import macosRepairInputsSchema from './schemas/repair-inputs/1.1.0.json' with { type: 'json' };
import macosSessionCustodySchema from './schemas/macos-session-custody/1.0.0.json' with { type: 'json' };
import macosSessionProfilesSchemaDocument from '../harness/schemas/macos-session-profiles/1.0.0.json' with { type: 'json' };
import preparedWork13Schema from './schemas/prepared-work/1.3.0.json' with { type: 'json' };
import runResult13Schema from './schemas/run-result/1.3.0.json' with { type: 'json' };
import { macosRepairIndex } from '../harness/macos-session-definitions.mjs';
import verificationRequestSchema from './schemas/macos-session-verification-request/1.0.0.json' with { type: 'json' };
import verificationResultSchema from './schemas/macos-session-verification-result/1.0.0.json' with { type: 'json' };
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, parseStrictJsonObjectV1, STRICT_JSON_MAX_DEPTH_V1 } from './internal/strict-json.js';
import { canonicalJson } from './internal/canonical.js';
import { validateTrustRepairRequest, validateTrustRepairInputs,
  validatePreparedWork12, validateRunResult12,
  TRUST_REPAIR_REQUEST_1_0_0, TRUST_REPAIR_INPUTS_1_0_0,
  PREPARED_WORK_1_2_0, RUN_RESULT_1_2_0, HARNESS_REPAIR_1_1_0,
  type TrustRepairRequest, type TrustRepairInputs } from './trust-contracts.js';
import type { Diagnostic, ValidationResult } from './types.js';

export type { Sha256 } from './trust-contracts.js';
import type { Sha256 } from './trust-contracts.js';

export const MACOS_REPAIR_REQUEST_SCHEMA = 'urn:aihq:core:repair-request:1.1.0' as const;
export const MACOS_REPAIR_INPUTS_SCHEMA = 'urn:aihq:core:repair-inputs:1.1.0' as const;
export const MACOS_PREPARED_WORK_SCHEMA = 'urn:aihq:core:prepared-work:1.3.0' as const;
export const MACOS_RUN_RESULT_SCHEMA = 'urn:aihq:core:run-result:1.3.0' as const;
export const MACOS_SESSION_CUSTODY_SCHEMA = 'urn:aihq:core:macos-session-custody:1.0.0' as const;
export const MACOS_SESSION_VERIFICATION_REQUEST_SCHEMA = 'urn:aihq:core:macos-session-verification-request:1.0.0' as const;
export const MACOS_SESSION_VERIFICATION_RESULT_SCHEMA = 'urn:aihq:core:macos-session-verification-result:1.0.0' as const;
export const MACOS_SESSION_PROFILES_SCHEMA = 'urn:aihq:harness:macos-session-profiles:1.0.0' as const;
export const HARNESS_REPAIR_1_2_0 = 'urn:aihq:harness:repair:1.2.0' as const;

/** The eleven inherited Harness client IDs; a roster entry is never a support claim. */
export type MacosSessionClientId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'windsurf'
  | 'opencode' | 'kimi' | 'kiro' | 'antigravity' | 'zed';
export type MacosSessionContext = 'terminal' | 'desktop' | 'both';
export type MacosSessionLaunch = 'finder' | 'dock';

export interface MacosSessionApplication {
  clientId: MacosSessionClientId;
  appPath: string;
  targets: readonly string[];
  launch: MacosSessionLaunch;
}
/** Explicit session selection carried by repair request/inputs 1.1. */
export interface MacosSessionSelection {
  context: MacosSessionContext;
  applications: readonly MacosSessionApplication[];
}
export type MacosSession = MacosSessionSelection;
export type MacosRepairRequest = Omit<TrustRepairRequest, 'schema'> & {
  schema: typeof MACOS_REPAIR_REQUEST_SCHEMA;
  macosSession: MacosSessionSelection;
};
export type MacosRepairInputs = Omit<TrustRepairInputs, 'schema'> & {
  schema: typeof MACOS_REPAIR_INPUTS_SCHEMA;
  macosSession: MacosSessionSelection;
};

export interface MacosSessionState {
  uid: number;
  domain: string;
  identitySha256: Sha256;
}
export interface MacosSessionApplicationReview {
  clientId: string;
  appPath: string;
  bundleId: string | null;
  version: string | null;
  build: string | null;
  targets: readonly string[];
  launch: MacosSessionLaunch;
  profileIds: readonly string[];
  status: 'admitted' | 'unavailable';
  reason: string | null;
  relaunch: 'quit-app' | 'logout-login' | 'unavailable';
}
export interface MacosSessionEffect {
  operationId: string;
  kind: 'terminal-config' | 'app-config' | 'launch-agent' | 'gui-environment';
  target: string;
  scope: 'current-user-config' | 'current-user-gui-future-processes';
  beforeSha256: Sha256 | null;
  afterSha256: Sha256 | null;
  effect: 'create' | 'replace' | 'remove' | 'unchanged' | 'conflict' | 'unavailable';
  persistent: boolean;
  key: string | null;
}
/** Exact `inputs.macosSession` branch of prepared-work 1.3.0. */
export interface MacosSessionReview {
  context: MacosSessionContext;
  bindingSha256: Sha256;
  session: MacosSessionState | null;
  applications: readonly MacosSessionApplicationReview[];
  effects: readonly MacosSessionEffect[];
}

export type MacosSessionConfiguration = 'applied' | 'already-satisfied' | 'not-applied' | 'uncertain';
export type MacosSessionVerification = 'passed' | 'failed' | 'unavailable' | 'skipped';
export interface MacosSessionApplicationRun {
  clientId: string;
  appPath: string;
  targets: readonly string[];
  launch: MacosSessionLaunch;
  configuration: MacosSessionConfiguration;
  verification: MacosSessionVerification;
  reason: string;
  relaunch: 'none' | 'quit-app' | 'logout-login' | 'unavailable';
}
/** Exact `macosSession` branch of run-result 1.3.0. */
export interface MacosSessionRun {
  context: MacosSessionContext;
  managementId: string | null;
  selectionId: string | null;
  configuration: MacosSessionConfiguration;
  persistence: 'not-required' | 'registered' | 'disabled' | 'unavailable' | 'uncertain';
  verification: MacosSessionVerification;
  reason: string;
  applications: readonly MacosSessionApplicationRun[];
}

export interface MacosSessionVerificationRequest {
  schema: typeof MACOS_SESSION_VERIFICATION_REQUEST_SCHEMA;
  managementId: string;
}
export interface MacosSessionObservation {
  context: 'terminal' | 'desktop';
  target: string;
  clientId: string | null;
  appPath: string | null;
  profileId: string | null;
  trustCellId: string;
  probeProfile: string;
  client: {
    version: string;
    build: string;
    backend: string;
    backendVersion: string;
    applicationId: string | null;
  };
  executableSha256: Sha256;
  applicationIdentitySha256: Sha256 | null;
  configurationSha256: Sha256;
  helperSha256: Sha256;
  sessionIdentitySha256: Sha256 | null;
  processBirthSha256: Sha256;
  observationSha256: Sha256;
  checkIds: readonly string[];
}
/** Mirrors the public Core `CheckResult` row. */
export interface MacosSessionCheck {
  id: string;
  operationId: string;
  status: 'passed' | 'failed' | 'unavailable' | 'skipped';
  reason: string;
  effectsUncertain?: boolean;
  terminationUnconfirmed?: boolean;
}
/** Mirrors the public Core `RecordStatus` union. */
export type MacosSessionRecordStatus = { status: 'written'; reference: string }
  | { status: 'disabled'; reason: 'logging-off' }
  | { status: 'failed'; reason: 'record-limit' | 'record-write'; diagnosticId: string };
export interface MacosSessionVerificationResult {
  schema: typeof MACOS_SESSION_VERIFICATION_RESULT_SCHEMA;
  status: 'complete' | 'incomplete' | 'invalid' | 'cancelled';
  package: { name: '@aihq/core'; version: string } | null;
  platform: { os: 'darwin'; release: string; build: string; architecture: 'arm64' | 'x64' } | null;
  managementId: string | null;
  selectionId: string | null;
  bindingSha256: Sha256 | null;
  observations: readonly MacosSessionObservation[];
  configuration: MacosSessionConfiguration;
  verification: MacosSessionVerification;
  reason: string;
  applications: readonly MacosSessionApplicationRun[];
  checks: readonly MacosSessionCheck[];
  diagnostics: Diagnostic[];
  elapsedMs: number;
  record: MacosSessionRecordStatus;
}

export interface MacosSessionPresence {
  present: boolean;
  value: string | null;
}
export interface MacosSessionCustodyFile {
  operationId: string;
  pathKey: string;
  sha256: Sha256;
}
export interface MacosSessionCustodyKey {
  key: string;
  label: string;
  plistPathKey: string;
  helperSha256: Sha256;
  desired: MacosSessionPresence;
  sessionIdentitySha256: Sha256;
  before: MacosSessionPresence;
  after: MacosSessionPresence;
}
export interface MacosSessionCustodyEntry {
  managementId: string;
  selectionId: string;
  recipeIdentity: string;
  bindingSha256: Sha256;
  context: MacosSessionContext;
  request: MacosRepairRequest;
  files: readonly MacosSessionCustodyFile[];
  keys: readonly MacosSessionCustodyKey[];
  profileIds: readonly string[];
  appBindingSha256: Sha256;
  appliedAt: string;
}
/** Protected session provenance supplement; never recipe authority. */
export interface MacosSessionCustody {
  schema: typeof MACOS_SESSION_CUSTODY_SCHEMA;
  entries: readonly MacosSessionCustodyEntry[];
}

const FAMILY_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'node-npm-ca': Object.freeze(['node', 'npm']),
  'user-tools-ca': Object.freeze(['python', 'pip', 'git', 'cargo', 'conda']),
  'jvm-ca': Object.freeze(['gradle', 'maven'])
});
const CLIENT_IDS: readonly string[] = ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf',
  'opencode', 'kimi', 'kiro', 'antigravity', 'zed'];

type Data = Record<string, unknown>;
const isObject = (value: unknown): value is Data => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (reason: string, path?: string): Diagnostic => ({
  code: 'INPUT_INVALID', reason, message: 'The document does not satisfy the published contract.', ...(path === undefined ? {} : { path })
});
const invalidSession = (path: string): Diagnostic => invalid('invalid-session-selection', path);

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
  semantics: (document: Data) => Diagnostic[],
  maxBytes?: number
): ValidationResult {
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

const unsafePathCharacter = /[\\:\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
/** Absolute normalized macOS `.app` directory (request) or document-relative path (CLI inputs). */
function appPathValid(value: unknown, absolute: boolean): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  if (unsafePathCharacter.test(value)) return false;
  if (absolute && !value.startsWith('/')) return false;
  if (value.endsWith('/') || value.includes('//')) return false;
  if (!value.endsWith('.app')) return false;
  const segments = value.split('/');
  return absolute ? segments.every(segment => segment !== '.' && segment !== '..') : true;
}

function macosSessionSemantics(
  session: unknown,
  selectedTargets: readonly unknown[],
  base: string,
  absolutePaths: boolean,
  requireCoverage: boolean
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isObject(session)) return out;
  const context = session.context;
  const applications = Array.isArray(session.applications) ? session.applications : [];
  if (context === 'terminal' && applications.length > 0) out.push(invalidSession(`${base}/applications`));
  const selected = new Set(selectedTargets.filter((target): target is string => typeof target === 'string'));
  const seenPaths = new Set<string>();
  const covered = new Set<string>();
  applications.forEach((application, index) => {
    if (!isObject(application)) return;
    const path = `${base}/applications/${String(index)}`;
    if (typeof application.clientId === 'string' && !CLIENT_IDS.includes(application.clientId))
      out.push(invalidSession(`${path}/clientId`));
    if (!appPathValid(application.appPath, absolutePaths)) out.push(invalidSession(`${path}/appPath`));
    else {
      const appPath = application.appPath;
      if (seenPaths.has(appPath)) out.push(invalidSession(`${path}/appPath`));
      seenPaths.add(appPath);
    }
    const targets = Array.isArray(application.targets) ? application.targets : [];
    targets.forEach(target => {
      if (typeof target !== 'string') return;
      if (selected.size > 0 && !selected.has(target)) out.push(invalidSession(`${path}/targets`));
      covered.add(target);
    });
  });
  if (requireCoverage && context === 'desktop')
    for (const target of selected) if (!covered.has(target)) {
      out.push(invalidSession(`${base}/applications`));
      break;
    }
  return out;
}

function macosRepairRequestSemantics(document: Data): Diagnostic[] {
  // Strip the explicit session addition and substitute the immutable 1.0 schema ID,
  // then delegate so the inherited route/source/input semantics cannot drift.
  const { macosSession: _macosSession, ...rest } = document;
  const inherited = validateTrustRepairRequest({ ...rest, schema: TRUST_REPAIR_REQUEST_1_0_0 });
  const repairs = Array.isArray(document.repairs) ? document.repairs : [];
  const step = isObject(repairs[0]) ? repairs[0] : undefined;
  const targets = step && Array.isArray(step.targets) ? step.targets : [];
  return [...inherited.diagnostics, ...macosSessionSemantics(document.macosSession, targets, '/macosSession', true, true)];
}

function macosRepairInputsSemantics(document: Data): Diagnostic[] {
  const { macosSession: _macosSession, ...rest } = document;
  const inherited = validateTrustRepairInputs({ ...rest, schema: TRUST_REPAIR_INPUTS_1_0_0 });
  const repairs = isObject(document.repairs) ? document.repairs : {};
  const family = Object.keys(repairs)[0];
  const targets = family === undefined ? [] : (FAMILY_TARGETS[family] ?? []);
  return [...inherited.diagnostics, ...macosSessionSemantics(document.macosSession, targets, '/macosSession', false, false)];
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(macosRepairRequestSchema);
ajv.addSchema(macosRepairInputsSchema);
ajv.addSchema(macosSessionCustodySchema);
ajv.addSchema(macosSessionProfilesSchemaDocument);
ajv.addSchema(preparedWork13Schema);
ajv.addSchema(runResult13Schema);
ajv.addSchema(verificationRequestSchema);
ajv.addSchema(verificationResultSchema);
const checkMacosRepairRequest = ajv.getSchema(macosRepairRequestSchema.$id) as ValidateFunction;
const checkMacosRepairInputs = ajv.getSchema(macosRepairInputsSchema.$id) as ValidateFunction;
const checkMacosSessionCustody = ajv.getSchema(macosSessionCustodySchema.$id) as ValidateFunction;
const checkMacosSessionProfiles = ajv.getSchema(macosSessionProfilesSchemaDocument.$id) as ValidateFunction;
const checkPreparedWork13 = ajv.getSchema(preparedWork13Schema.$id) as ValidateFunction;
const checkRunResult13 = ajv.getSchema(runResult13Schema.$id) as ValidateFunction;
const checkMacosSessionReviewDef = ajv.compile({ $ref: `${preparedWork13Schema.$id}#/$defs/macosSessionReview` });
const checkMacosSessionRunDef = ajv.compile({ $ref: `${runResult13Schema.$id}#/$defs/macosSessionRun` });
const checkVerificationRequest = ajv.getSchema(verificationRequestSchema.$id) as ValidateFunction;
const checkVerificationResult = ajv.getSchema(verificationResultSchema.$id) as ValidateFunction;

export const validateMacosRepairRequest = (value: unknown): ValidationResult =>
  validateAgainst(value, macosRepairRequestSchema.$id, checkMacosRepairRequest, macosRepairRequestSemantics, 1_000_000);
export const validateMacosRepairInputs = (value: unknown): ValidationResult =>
  validateAgainst(value, macosRepairInputsSchema.$id, checkMacosRepairInputs, macosRepairInputsSemantics, 1_000_000);

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

/** A custody path key is canonical strict JSON `{home, segments}` with safe nonempty segments. */
function canonicalPathKey(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false;
  let parsed: unknown;
  try {
    parsed = parseStrictJsonObjectV1(value, 'session member');
  } catch {
    return false;
  }
  if (!isObject(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || typeof parsed.home !== 'string' || parsed.home.length === 0 || parsed.home.length > 4096)
    return false;
  const segments = parsed.segments;
  if (!Array.isArray(segments) || segments.length === 0) return false;
  if (segments.some(segment => typeof segment !== 'string' || segment === '' || segment === '.' || segment === '..' ||
      segment.length > 4096 || unsafePathCharacter.test(segment))) return false;
  return canonicalJson(parsed) === value;
}

const environmentKeyGrammar = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** The owned LaunchAgent label is derived, never freely chosen: dev.aihq.trust.<lowercase-key-with-dashes>. */
function ownedLabel(key: string): string {
  return `dev.aihq.trust.${key.toLowerCase().replaceAll('_', '-')}`;
}

function macosSessionCustodySemantics(document: Data): Diagnostic[] {
  const out: Diagnostic[] = [];
  const entries = Array.isArray(document.entries) ? document.entries : [];
  let previousManagementId: string | undefined;
  entries.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const base = `/entries/${String(index)}`;
    const managementId = typeof entry.managementId === 'string' ? entry.managementId : undefined;
    if (managementId !== undefined && previousManagementId !== undefined && managementId <= previousManagementId)
      out.push(invalid('custody-order', base));
    if (managementId !== undefined) previousManagementId = managementId;
    const files = Array.isArray(entry.files) ? entry.files : [];
    let previousPathKey: string | undefined;
    files.forEach((file, fileIndex) => {
      if (!isObject(file)) return;
      const fileBase = `${base}/files/${String(fileIndex)}`;
      if (!canonicalPathKey(file.pathKey)) out.push(invalid('invalid-session-custody', `${fileBase}/pathKey`));
      const pathKey = typeof file.pathKey === 'string' ? file.pathKey : undefined;
      if (pathKey !== undefined && previousPathKey !== undefined && pathKey <= previousPathKey)
        out.push(invalid('custody-order', fileBase));
      if (pathKey !== undefined) previousPathKey = pathKey;
    });
    const keys = Array.isArray(entry.keys) ? entry.keys : [];
    let previousKey: string | undefined;
    keys.forEach((row, keyIndex) => {
      if (!isObject(row)) return;
      const keyBase = `${base}/keys/${String(keyIndex)}`;
      const key = typeof row.key === 'string' ? row.key : undefined;
      if (key !== undefined) {
        if (!environmentKeyGrammar.test(key)) out.push(invalid('invalid-session-custody', `${keyBase}/key`));
        else if (row.label !== ownedLabel(key)) out.push(invalid('invalid-session-custody', `${keyBase}/label`));
        if (previousKey !== undefined && key <= previousKey) out.push(invalid('custody-order', keyBase));
        previousKey = key;
      }
      if (!canonicalPathKey(row.plistPathKey)) out.push(invalid('invalid-session-custody', `${keyBase}/plistPathKey`));
    });
    if (!sortedUniqueStrings(entry.profileIds)) out.push(invalid('custody-order', `${base}/profileIds`));
    // The private embedded request must remain a fully valid 1.1 selection; it is read as data only.
    if (validateMacosRepairRequest(entry.request).diagnostics.length > 0)
      out.push(invalid('invalid-session-custody', `${base}/request`));
    else {
      const request = entry.request as unknown as MacosRepairRequest;
      const definition = macosRepairIndex.find(row => row.id === request.repairs[0]?.id);
      if (!definition || entry.managementId !== definition.managementId || entry.selectionId !== 'trust' ||
          entry.context !== request.macosSession.context) out.push(invalid('invalid-session-custody', base));
    }
  });
  return out;
}

export const validateMacosSessionCustody = (value: unknown): ValidationResult =>
  validateAgainst(value, macosSessionCustodySchema.$id, checkMacosSessionCustody, macosSessionCustodySemantics, 1_048_576);

const environmentKeyName = /^[A-Za-z_][A-Za-z0-9_]*$/;
function macosSessionProfilesSemantics(document: Data): Diagnostic[] {
  const out: Diagnostic[] = [];
  const profiles = Array.isArray(document.profiles) ? document.profiles : [];
  const seenIds = new Set<string>();
  const seenTuples = new Set<string>();
  profiles.forEach((profile, index) => {
    if (!isObject(profile)) return;
    const base = `/profiles/${String(index)}`;
    if (typeof profile.id === 'string') {
      if (seenIds.has(profile.id)) out.push(invalid('invalid-session-profiles', `${base}/id`));
      seenIds.add(profile.id);
    }
    // One unambiguous join per app/launch/mechanism tuple; ambiguity blocks admission.
    const tuple = canonicalJson([profile.clientId ?? null, profile.trustCellId ?? null, profile.bundleId ?? null,
      profile.appVersion ?? null, profile.appBuild ?? null, profile.launch ?? null, profile.mechanism ?? null,
      profile.configurationProfile ?? null]);
    if (seenTuples.has(tuple)) out.push(invalid('invalid-session-profiles', base));
    seenTuples.add(tuple);
    const keys = Array.isArray(profile.environmentKeys) ? profile.environmentKeys : [];
    keys.forEach((key, keyIndex) => {
      if (typeof key === 'string' && !environmentKeyName.test(key))
        out.push(invalid('invalid-session-profiles', `${base}/environmentKeys/${String(keyIndex)}`));
    });
  });
  return out;
}

export const validateMacosSessionProfiles = (value: unknown): ValidationResult =>
  validateAgainst(value, macosSessionProfilesSchemaDocument.$id, checkMacosSessionProfiles, macosSessionProfilesSemantics, 1_048_576);

const invalidReview = (path: string): Diagnostic => invalid('invalid-session-review', path);
const invalidRun = (path: string): Diagnostic => invalid('invalid-session-run', path);

function sessionReviewSemantics(session: unknown, base: string, operationIds?: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isObject(session)) return out;
  const applications = Array.isArray(session.applications) ? session.applications : [];
  if (session.context === 'terminal') {
    if (session.session !== null && session.session !== undefined) out.push(invalidReview(`${base}/session`));
    if (applications.length > 0) out.push(invalidReview(`${base}/applications`));
  }
  if (isObject(session.session)) {
    const uid = session.session.uid;
    if (typeof uid === 'number' && Number.isInteger(uid)) {
      if (uid < 1) out.push(invalidReview(`${base}/session/uid`));
      else if (session.session.domain !== `gui/${String(uid)}`) out.push(invalidReview(`${base}/session/domain`));
    }
  }
  applications.forEach((application, index) => {
    if (!isObject(application)) return;
    const path = `${base}/applications/${String(index)}`;
    if (application.status === 'admitted') {
      if (application.reason !== null) out.push(invalidReview(`${path}/reason`));
      if (!Array.isArray(application.profileIds) || application.profileIds.length === 0)
        out.push(invalidReview(`${path}/profileIds`));
      if (application.relaunch !== 'quit-app' && application.relaunch !== 'logout-login')
        out.push(invalidReview(`${path}/relaunch`));
    } else if (application.status === 'unavailable') {
      if (typeof application.reason !== 'string' || application.reason.length === 0)
        out.push(invalidReview(`${path}/reason`));
      if (application.relaunch !== 'unavailable') out.push(invalidReview(`${path}/relaunch`));
    }
  });
  if (operationIds !== undefined) {
    const effects = Array.isArray(session.effects) ? session.effects : [];
    effects.forEach((effect, index) => {
      if (!isObject(effect)) return;
      if (typeof effect.operationId === 'string' && !operationIds.has(effect.operationId))
        out.push(invalidReview(`${base}/effects/${String(index)}/operationId`));
    });
  }
  return out;
}

function sessionRunSemantics(run: unknown, base: string, completion?: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isObject(run)) return out;
  const applications = Array.isArray(run.applications) ? run.applications : [];
  if (run.context === 'terminal' && applications.length > 0) out.push(invalidRun(`${base}/applications`));
  if ((run.configuration === 'applied' || run.configuration === 'already-satisfied') && typeof run.managementId !== 'string')
    out.push(invalidRun(`${base}/managementId`));
  if (run.verification === 'passed' && completion !== undefined && completion !== 'complete')
    out.push(invalidRun(`${base}/verification`));
  return out;
}

/** Substitutes the immutable 1.1 definition schema ID so the stripped document stays a genuine 1.2 input. */
function trustWithDefinition11(trust: unknown): unknown {
  if (!isObject(trust)) return trust;
  const definition = isObject(trust.definition) ? { ...trust.definition, schema: HARNESS_REPAIR_1_1_0 } : trust.definition;
  return { ...trust, definition };
}
function stripForPrepared12(document: Data): Data {
  const clone: Data = { ...document, schema: PREPARED_WORK_1_2_0 };
  if (isObject(document.inputs)) {
    const { macosSession: _dropped, ...restInputs } = document.inputs;
    clone.inputs = { ...restInputs, trust: trustWithDefinition11(restInputs.trust) };
  }
  return clone;
}
function stripForRun12(document: Data): Data {
  const { macosSession: _dropped, ...rest } = document;
  const clone: Data = { ...rest, schema: RUN_RESULT_1_2_0 };
  if (isObject(document.inputs)) {
    const { macosSession: _droppedInputs, ...restInputs } = document.inputs;
    clone.inputs = { ...restInputs, trust: trustWithDefinition11(restInputs.trust) };
  }
  return clone;
}

function preparedWork13Semantics(document: Data): Diagnostic[] {
  const inherited = validatePreparedWork12(stripForPrepared12(document));
  const operationIds = new Set((Array.isArray(document.operations) ? document.operations : [])
    .filter(isObject).map(operation => operation.id).filter((id): id is string => typeof id === 'string'));
  const inputs = isObject(document.inputs) ? document.inputs : undefined;
  return [...inherited.diagnostics, ...sessionReviewSemantics(inputs?.macosSession, '/inputs/macosSession', operationIds)];
}
function runResult13Semantics(document: Data): Diagnostic[] {
  const inherited = validateRunResult12(stripForRun12(document));
  const out = [...inherited.diagnostics, ...sessionRunSemantics(document.macosSession, '/macosSession', document.completion)];
  const inputs = isObject(document.inputs) ? document.inputs : undefined;
  if (inputs !== undefined && Object.hasOwn(inputs, 'macosSession'))
    out.push(...sessionReviewSemantics(inputs.macosSession, '/inputs/macosSession'));
  return out;
}

export const validatePreparedWork13 = (value: unknown): ValidationResult =>
  validateAgainst(value, preparedWork13Schema.$id, checkPreparedWork13, preparedWork13Semantics);
export const validateRunResult13 = (value: unknown): ValidationResult =>
  validateAgainst(value, runResult13Schema.$id, checkRunResult13, runResult13Semantics);
export const validateMacosSessionReview = (value: unknown): ValidationResult =>
  validateAgainst(value, preparedWork13Schema.$id, checkMacosSessionReviewDef,
    document => sessionReviewSemantics(document, ''));
export const validateMacosSessionRun = (value: unknown): ValidationResult =>
  validateAgainst(value, runResult13Schema.$id, checkMacosSessionRunDef,
    document => sessionRunSemantics(document, ''));

const invalidResult = (path: string) => invalid('invalid-session-result', path);
function verificationResultSemantics(document: Data): Diagnostic[] {
  const out: Diagnostic[] = [];
  const observations = Array.isArray(document.observations) ? document.observations.filter(isObject) : [];
  const checks = Array.isArray(document.checks) ? document.checks.filter(isObject) : [];
  const applications = Array.isArray(document.applications) ? document.applications.filter(isObject) : [];
  if (document.status === 'invalid') {
    for (const field of ['package', 'platform', 'managementId', 'selectionId', 'bindingSha256'])
      if (document[field] !== null) out.push(invalidResult(`/${field}`));
    if (document.configuration !== 'not-applied' || document.verification !== 'unavailable' ||
        observations.length || checks.length || applications.length || !Array.isArray(document.diagnostics) || !document.diagnostics.length)
      out.push(invalidResult('/status'));
  }
  const checkIds = new Set<string>();
  for (const check of checks) {
    if (typeof check.id === 'string') {
      if (checkIds.has(check.id)) out.push(invalidResult('/checks'));
      checkIds.add(check.id);
    }
  }
  const observedChecks = new Set<string>();
  const targetOrder = Object.values(FAMILY_TARGETS).flat();
  const orderKey = (row: Data) => [row.context === 'terminal' ? '0' : '1', row.clientId ?? '', row.appPath ?? '',
    String(targetOrder.indexOf(String(row.target))).padStart(2, '0')].join('\0');
  let prior = '';
  observations.forEach((observation, index) => {
    const path = `/observations/${index}`;
    const appFields = ['clientId', 'appPath', 'profileId', 'applicationIdentitySha256', 'sessionIdentitySha256'];
    const client = isObject(observation.client) ? observation.client : {};
    if (observation.context === 'terminal' && (appFields.some(field => observation[field] !== null) || client.applicationId !== null))
      out.push(invalidResult(path));
    if (observation.context === 'desktop' && (appFields.some(field => typeof observation[field] !== 'string') ||
        typeof client.applicationId !== 'string' || !appPathValid(observation.appPath, true))) out.push(invalidResult(path));
    if (!targetOrder.includes(String(observation.target))) out.push(invalidResult(`${path}/target`));
    const key = orderKey(observation);
    if (prior && key <= prior) out.push(invalidResult('/observations'));
    prior = key;
    if (Array.isArray(observation.checkIds)) for (const id of observation.checkIds) {
      if (typeof id !== 'string' || !checkIds.has(id)) out.push(invalidResult(`${path}/checkIds`));
      else observedChecks.add(id);
    }
  });
  for (const check of checks) if (check.status === 'passed' && !observedChecks.has(String(check.id))) out.push(invalidResult('/checks'));
  if (document.status === 'complete' || document.verification === 'passed') {
    if (document.status !== 'complete' || document.verification !== 'passed' || document.package === null || document.platform === null ||
        typeof document.managementId !== 'string' || typeof document.selectionId !== 'string' || typeof document.bindingSha256 !== 'string' ||
        !['applied', 'already-satisfied'].includes(String(document.configuration)) || !checks.length || !observations.length ||
        checks.some(check => check.status !== 'passed' || check.effectsUncertain || check.terminationUnconfirmed) ||
        applications.some(app => app.verification !== 'passed') || !Array.isArray(document.diagnostics) || document.diagnostics.length)
      out.push(invalidResult('/status'));
  }
  return out;
}
export const validateMacosSessionVerificationRequest = (value: unknown): ValidationResult =>
  validateAgainst(value, verificationRequestSchema.$id, checkVerificationRequest, () => [], 4096);
export const validateMacosSessionVerificationResult = (value: unknown): ValidationResult =>
  validateAgainst(value, verificationResultSchema.$id, checkVerificationResult, verificationResultSemantics, 1_048_576);
