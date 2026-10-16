/**
 * Experimental structured report data interface for @aihq/core/report.
 *
 * Data only: this module performs no rendering, no filesystem access and no
 * host observation. It validates a bounded @aihq/core Harness diagnostic result
 * and projects it into a versioned, redacted ReportSnapshot. See docs/reporting/CONTRACT.md
 * and docs/reporting/FIELDS.md.
 */
import {
  ReportInputError, invalid, isPlainObject, rejectDuplicateKeys, requireArray, requireEnum,
  requirePlainObject, requireString, toBoundedJson,
} from './bounded-json.mjs';

export { ReportInputError };
export {
  CALCULATION_METHODS, CLAIMS_ACCEPTED_VERSIONS, CLAIMS_PROJECTION_SCHEMA, CLAIMS_PROJECTION_SCHEMA_1_1_0,
  CLAIMS_SCHEMA, CLAIMS_SCHEMA_1_1_0, projectClaims, readClaimSet, validateClaimSet,
} from './claims.mjs';

/** Versioned identity of the ReportSnapshot shape this module produces. */
export const SNAPSHOT_SCHEMA = 'urn:aihq:report:snapshot:1.0.0';

/** The single supported producer contract (schema identity of `diagnostic`). */
export const DIAGNOSTIC_CONTRACT = 'urn:aihq:harness:diagnostic:1.0.0';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const encoder = new TextEncoder();

const DIAGNOSTIC_STATUS = ['completed', 'cancelled', 'invalid', 'unavailable'];
const TOOL_STATES = ['binary', 'runnable', 'broken', 'config-only', 'absent'];
const TOOL_SELECTIONS = ['requested', 'detected', 'unselected'];
const CHECK_OUTCOMES = ['passed', 'failed', 'unavailable', 'skipped'];
const ACQUISITIONS = ['supplied', 'newly-acquired'];

function validateTool(tool, at) {
  const optional = tool !== null && typeof tool === 'object' && !Array.isArray(tool) && 'config' in tool;
  requirePlainObject(tool, at, optional ? ['id', 'label', 'state', 'selection', 'config'] : ['id', 'label', 'state', 'selection']);
  requireString(tool.id, `${at}.id`);
  requireString(tool.label, `${at}.label`);
  requireEnum(tool.state, TOOL_STATES, `${at}.state`);
  requireEnum(tool.selection, TOOL_SELECTIONS, `${at}.selection`);
  if (optional && typeof tool.config !== 'string') invalid(`${at}.config: expected string`);
}

function validateObservation(observation, at) {
  requirePlainObject(observation, at, ['id', 'target', 'detail']);
  requireString(observation.id, `${at}.id`);
  requireString(observation.target, `${at}.target`);
  if (typeof observation.detail !== 'string') invalid(`${at}.detail: expected string`);
}

function validateCheck(check, at) {
  requirePlainObject(check, at, ['id', 'target', 'outcome', 'reason', 'detail']);
  requireString(check.id, `${at}.id`);
  requireString(check.target, `${at}.target`);
  requireEnum(check.outcome, CHECK_OUTCOMES, `${at}.outcome`);
  if (typeof check.reason !== 'string') invalid(`${at}.reason: expected string`);
  if (typeof check.detail !== 'string') invalid(`${at}.detail: expected string`);
}

function validateDiagnosticEntry(entry, at) {
  requirePlainObject(entry, at, ['code', 'reason', 'message']);
  if (typeof entry.code !== 'string') invalid(`${at}.code: expected string`);
  if (typeof entry.reason !== 'string') invalid(`${at}.reason: expected string`);
  if (typeof entry.message !== 'string') invalid(`${at}.message: expected string`);
}

function validateLimitNumbers(limits, at) {
  const { budgetMs, elapsedMs, maxActiveProbes } = limits;
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 180000) invalid(`${at}.budgetMs: expected integer 1..180000`);
  if (!Number.isInteger(elapsedMs) || elapsedMs < 0) invalid(`${at}.elapsedMs: expected integer >= 0`);
  if (!Number.isInteger(maxActiveProbes) || maxActiveProbes < 1 || maxActiveProbes > 2) invalid(`${at}.maxActiveProbes: expected integer 1..2`);
}

function validateDiagnostic(diagnostic) {
  const root = requirePlainObject(diagnostic, 'diagnostic', [
    'requestId', 'helper', 'status', 'tools', 'observations', 'checks',
    'diagnostics', 'repairChoices', 'limits',
  ]);
  if (typeof root.requestId !== 'string' || root.requestId.length < 1 || root.requestId.length > 128) {
    invalid('diagnostic.requestId: expected string of 1..128 characters');
  }
  requirePlainObject(root.helper, 'diagnostic.helper', ['name', 'version']);
  requireString(root.helper.name, 'diagnostic.helper.name');
  requireString(root.helper.version, 'diagnostic.helper.version');
  requireEnum(root.status, DIAGNOSTIC_STATUS, 'diagnostic.status');
  for (const [index, tool] of requireArray(root.tools, 'diagnostic.tools').entries()) {
    validateTool(tool, `diagnostic.tools[${index}]`);
  }
  for (const [index, observation] of requireArray(root.observations, 'diagnostic.observations').entries()) {
    validateObservation(observation, `diagnostic.observations[${index}]`);
  }
  for (const [index, check] of requireArray(root.checks, 'diagnostic.checks').entries()) {
    validateCheck(check, `diagnostic.checks[${index}]`);
  }
  for (const [index, entry] of requireArray(root.diagnostics, 'diagnostic.diagnostics').entries()) {
    validateDiagnosticEntry(entry, `diagnostic.diagnostics[${index}]`);
  }
  for (const [index, choice] of requireArray(root.repairChoices, 'diagnostic.repairChoices').entries()) {
    const at = `diagnostic.repairChoices[${index}]`;
    requirePlainObject(choice, at, ['target', 'kind', 'reason', 'guidance']);
    requireString(choice.target, `${at}.target`);
    if (choice.kind !== 'manual-guidance') invalid(`${at}.kind: expected manual-guidance`);
    if (typeof choice.reason !== 'string') invalid(`${at}.reason: expected string`);
    if (typeof choice.guidance !== 'string') invalid(`${at}.guidance: expected string`);
  }
  requirePlainObject(root.limits, 'diagnostic.limits', ['budgetMs', 'elapsedMs', 'maxActiveProbes']);
  validateLimitNumbers(root.limits, 'diagnostic.limits');
  return root;
}

/** Structural validation of a ReportSnapshot: version, shape and integrity. */
function validateSnapshotShape(snapshot) {
  const root = requirePlainObject(snapshot, 'snapshot', [
    'schema', 'compatibility', 'producer', 'capture', 'evidence', 'status',
    'tools', 'observations', 'checks', 'diagnostics', 'metrics',
  ]);
  if (root.schema !== SNAPSHOT_SCHEMA) invalid('snapshot.schema: unsupported version');
  if (root.compatibility !== 'experimental') invalid('snapshot.compatibility: expected experimental');
  requirePlainObject(root.producer, 'snapshot.producer', ['name', 'version', 'revision', 'contract']);
  if (root.producer.name !== '@aihq/core') invalid('snapshot.producer.name: expected @aihq/core');
  requireString(root.producer.version, 'snapshot.producer.version', 128);
  if (root.producer.revision !== null) requireString(root.producer.revision, 'snapshot.producer.revision', 128);
  if (root.producer.contract !== DIAGNOSTIC_CONTRACT) invalid('snapshot.producer.contract: unsupported contract');
  requirePlainObject(root.capture, 'snapshot.capture', ['observedAt', 'acquisition']);
  if (typeof root.capture.observedAt !== 'string' || !ISO_UTC.test(root.capture.observedAt)) {
    invalid('snapshot.capture.observedAt: expected an ISO UTC timestamp');
  }
  requireEnum(root.capture.acquisition, ACQUISITIONS, 'snapshot.capture.acquisition');
  requirePlainObject(root.evidence, 'snapshot.evidence', [
    'originalSha256', 'authentication', 'structuralValidation', 'projection',
  ]);
  if (root.evidence.originalSha256 !== null && !/^[0-9a-f]{64}$/.test(root.evidence.originalSha256)) {
    invalid('snapshot.evidence.originalSha256: expected 64 lowercase hex characters or null');
  }
  if (root.evidence.authentication !== 'not-authenticated') invalid('snapshot.evidence.authentication: expected not-authenticated');
  if (root.evidence.structuralValidation !== 'passed') invalid('snapshot.evidence.structuralValidation: expected passed');
  if (root.evidence.projection !== 'redacted') invalid('snapshot.evidence.projection: expected redacted');
  requireEnum(root.status, DIAGNOSTIC_STATUS, 'snapshot.status');
  for (const [index, tool] of requireArray(root.tools, 'snapshot.tools').entries()) {
    validateTool(tool, `snapshot.tools[${index}]`);
  }
  for (const [index, observation] of requireArray(root.observations, 'snapshot.observations').entries()) {
    validateObservation(observation, `snapshot.observations[${index}]`);
  }
  for (const [index, check] of requireArray(root.checks, 'snapshot.checks').entries()) {
    validateCheck(check, `snapshot.checks[${index}]`);
  }
  for (const [index, entry] of requireArray(root.diagnostics, 'snapshot.diagnostics').entries()) {
    validateDiagnosticEntry(entry, `snapshot.diagnostics[${index}]`);
  }
  requirePlainObject(root.metrics, 'snapshot.metrics', ['budgetMs', 'elapsedMs', 'maxActiveProbes', 'counts']);
  validateLimitNumbers(root.metrics, 'snapshot.metrics');
  const counts = requirePlainObject(root.metrics.counts, 'snapshot.metrics.counts', CHECK_OUTCOMES);
  for (const outcome of CHECK_OUTCOMES) {
    if (!Number.isInteger(counts[outcome]) || counts[outcome] < 0) {
      invalid(`snapshot.metrics.counts.${outcome}: expected a non-negative integer`);
    }
  }
  const derived = countOutcomes(root.checks);
  if (CHECK_OUTCOMES.some((outcome) => counts[outcome] !== derived[outcome])) {
    invalid('snapshot.metrics.counts: does not match snapshot.checks');
  }
  return root;
}

/**
 * Redaction projection. The caller may declare exact home paths and secret
 * values; on top of that we always mask high-confidence provider credential
 * shapes and sensitive command-line values, ported from the legacy ai-harness
 * patterns (Apache-2.0) without any host or environment access.
 */
const SECRET_PATTERNS = [
  /\b(?:A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16})\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bxox[abprsoe]-[A-Za-z0-9-]{10,}\b/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/gi,
  /bearer\s+[A-Za-z0-9._-]+/gi,
];
const ASSIGNMENT_KEYWORDS = ['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'API_KEY', 'ACCESS_KEY'];
const SHORT_ASSIGNMENT_KEYWORDS = ['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'API_KEY', 'APIKEY', 'ACCESS_KEY'];
const SENSITIVE_FLAG_NAME = /^(token|access[-_]?token|auth[-_]?token|password|passwd|pass|secret|client[-_]?secret|api[-_]?key|apikey|auth|bearer)$/i;
const WINDOWS_HOME = /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?:[^\\/:\r\n\t"'<>;|?*]+(?=[\\/]|$|["';\r\n\t|?*<>]|:(?![\\/]))|[^\s\\/:"'<>;|?*]+)/gi;
const UNIX_HOME = /\/(?:home|Users)\/[^/\s"'<>;]+/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mask `KEY=VALUE` / `KEY: VALUE` diagnostics, including quoted credential keys. */
function redactSecretAssignments(text) {
  // Scan keys first: consuming a noncredential value could skip a nested credential key.
  const keys = /(?:["']|\b)([A-Za-z_][A-Za-z0-9_-]*)["']?(\s*[=:]\s*)/g;
  let output = '';
  let copied = 0;
  let match;
  while ((match = keys.exec(text)) !== null) {
    const prefix = text.slice(Math.max(0, match.index - 3), match.index);
    // Delegate only a complete, recognized bare flag with '=' to the flag scanner.
    if (/(?:^|[^\w-])--?$/.test(prefix) && SENSITIVE_FLAG_NAME.test(match[1]) &&
        match[2] === '=' && match[0] === match[1] + match[2]) continue;
    const upper = match[1].toUpperCase();
    const shortAssignment = SHORT_ASSIGNMENT_KEYWORDS.some((keyword) => upper.endsWith(keyword));
    const possibleLongAssignment = ASSIGNMENT_KEYWORDS.some((keyword) => upper.includes(keyword));
    if (!shortAssignment && !possibleLongAssignment) continue;
    const start = keys.lastIndex;
    const end = credentialValueEnd(text, start);
    const value = text.slice(start, end).replace(/^["']|["']$/g, '');
    if (!shortAssignment && (value === '<homePath>' || value.length < 8)) continue;
    output += text.slice(copied, match.index) + '[REDACTED]';
    copied = end;
    keys.lastIndex = end;
  }
  return output + text.slice(copied);
}

/** Find one credential value's end without leaving quoted or punctuated suffixes exposed. */
function credentialValueEnd(text, start) {
  const redactedEnd = start + '[REDACTED]'.length;
  if (text.startsWith('[REDACTED]', start) && (redactedEnd === text.length || /[\s,;}\]]/.test(text[redactedEnd]))) return redactedEnd;
  // Ambiguous container values cannot safely be cut at their first whitespace.
  if (text[start] === '{' || text[start] === '[') return text.length;
  const quote = text[start];
  let end = start;
  if (quote === '"' || quote === "'") {
    end++;
    while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) return text.length;
    end++;
    if (end === text.length || /[\s,;}\]]/.test(text[end])) return end;
  }
  // Punctuation inside an unquoted credential is part of the credential.
  while (end < text.length && !/[\s,;]/.test(text[end])) end++;
  return end;
}

/** Mask `--token value` / `--token=value` for credential-bearing flags. */
function redactSensitiveFlags(text) {
  const flags = /(--?[A-Za-z][\w-]*)(=|\s+)/g;
  let output = '';
  let copied = 0;
  let match;
  while ((match = flags.exec(text)) !== null) {
    if (!SENSITIVE_FLAG_NAME.test(match[1].replace(/^--?/, ''))) continue;
    const end = credentialValueEnd(text, flags.lastIndex);
    output += text.slice(copied, match.index) + match[0] + '[REDACTED]';
    copied = end;
    flags.lastIndex = end;
  }
  return output + text.slice(copied);
}

/** Validate the optional `redaction` object and return ordered literal rules. */
function buildRedactor(redaction) {
  if (redaction === undefined) return [];
  if (!isPlainObject(redaction)) invalid('input.redaction: expected object');
  const keys = Reflect.ownKeys(redaction);
  if (keys.some((key) => typeof key !== 'string' || !['homePaths', 'secretValues'].includes(key))) {
    invalid('input.redaction: unknown field');
  }
  const rules = [];
  for (const [name, replacement, caseInsensitive] of [
    ['homePaths', '<homePath>', true],
    ['secretValues', '[REDACTED]', false],
  ]) {
    const list = redaction[name];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0) invalid(`input.redaction.${name}: expected a non-empty array of strings`);
    for (let index = 0; index < list.length; index += 1) {
      if (typeof list[index] !== 'string' || list[index].length === 0) {
        invalid(`input.redaction.${name}[${index}]: expected a non-empty string`);
      }
    }
    const ordered = [...new Set(list)].sort((left, right) => right.length - left.length);
    for (const value of ordered) rules.push({ value, replacement, caseInsensitive });
  }
  return rules;
}

/** Apply one literal rule, covering both path separator styles for home paths. */
function applyLiteral(text, rule) {
  if (!rule.caseInsensitive) return text.split(rule.value).join(rule.replacement);
  const variants = [...new Set([
    rule.value,
    rule.value.replace(/\\/g, '/'),
    rule.value.replace(/\//g, '\\'),
  ])].sort((left, right) => right.length - left.length);
  let output = text;
  for (const variant of variants) {
    output = output.replace(new RegExp(escapeRegExp(variant), 'gi'), rule.replacement);
  }
  return output;
}

/** Full redaction pipeline for one free-text string. */
function redactText(value, rules) {
  let output = value;
  for (const rule of rules) output = applyLiteral(output, rule);
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]');
  return redactSensitiveFlags(redactSecretAssignments(output)).replace(WINDOWS_HOME, '<homePath>').replace(UNIX_HOME, '<homePath>');
}

function countOutcomes(checks) {
  const counts = { passed: 0, failed: 0, unavailable: 0, skipped: 0 };
  for (const check of checks) counts[check.outcome] += 1;
  return counts;
}

/** Project one validated diagnostic into a redacted ReportSnapshot. */
function project(diagnostic, input, rules) {
  const { limits } = diagnostic;
  const redact = (value) => redactText(value, rules);
  return {
    schema: SNAPSHOT_SCHEMA,
    compatibility: 'experimental',
    producer: {
      name: input.producer.name,
      version: redact(input.producer.version),
      revision: input.producer.revision === null ? null : redact(input.producer.revision),
      contract: DIAGNOSTIC_CONTRACT,
    },
    capture: { observedAt: input.observedAt, acquisition: input.acquisition },
    evidence: {
      originalSha256: input.originalSha256 ?? null,
      authentication: 'not-authenticated',
      structuralValidation: 'passed',
      projection: 'redacted',
    },
    status: diagnostic.status,
    tools: diagnostic.tools.map((tool) => (tool.config === undefined
      ? { id: redact(tool.id), label: redact(tool.label), state: tool.state, selection: tool.selection }
      : { id: redact(tool.id), label: redact(tool.label), state: tool.state, selection: tool.selection, config: redact(tool.config) })),
    observations: diagnostic.observations.map((observation) => ({
      id: redact(observation.id), target: redact(observation.target), detail: redact(observation.detail),
    })),
    checks: diagnostic.checks.map((check) => ({
      id: redact(check.id), target: redact(check.target), outcome: check.outcome,
      reason: redact(check.reason), detail: redact(check.detail),
    })),
    diagnostics: diagnostic.diagnostics.map((entry) => ({
      code: redact(entry.code), reason: redact(entry.reason), message: redact(entry.message),
    })),
    metrics: {
      budgetMs: limits.budgetMs,
      elapsedMs: limits.elapsedMs,
      maxActiveProbes: limits.maxActiveProbes,
      counts: countOutcomes(diagnostic.checks),
    },
  };
}

/**
 * Validate one supplied @aihq/core Harness diagnostic result and project it
 * into an experimental ReportSnapshot. The caller's objects are never mutated.
 */
export function createReport(input) {
  const bounded = toBoundedJson(input, 'input');
  if (!isPlainObject(bounded)) invalid('input: expected object');
  const allowed = ['diagnostic', 'producer', 'observedAt', 'acquisition', 'originalSha256', 'redaction'];
  const keys = Reflect.ownKeys(bounded);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) invalid('input: unknown field');
  if (!('diagnostic' in bounded)) invalid('input.diagnostic: required');
  if (!('producer' in bounded)) invalid('input.producer: required');
  if (!('observedAt' in bounded)) invalid('input.observedAt: required');
  if (!('acquisition' in bounded)) invalid('input.acquisition: required');
  requirePlainObject(bounded.producer, 'input.producer', ['name', 'version', 'revision']);
  if (bounded.producer.name !== '@aihq/core') invalid('input.producer.name: expected @aihq/core');
  requireString(bounded.producer.version, 'input.producer.version', 128);
  if (bounded.producer.revision !== null) requireString(bounded.producer.revision, 'input.producer.revision', 128);
  if (typeof bounded.observedAt !== 'string' || !ISO_UTC.test(bounded.observedAt)) {
    invalid('input.observedAt: expected an ISO UTC timestamp');
  }
  requireEnum(bounded.acquisition, ACQUISITIONS, 'input.acquisition');
  if (bounded.originalSha256 !== undefined && !/^[0-9a-f]{64}$/.test(bounded.originalSha256)) {
    invalid('input.originalSha256: expected 64 lowercase hex characters');
  }
  const rules = buildRedactor(bounded.redaction);
  const diagnostic = validateDiagnostic(bounded.diagnostic);
  return checkedProjection(project(diagnostic, bounded, rules));
}

/**
 * Canonicalize and re-redact a validated snapshot. Rebuilding in a fixed key
 * order makes JSON import/export deterministic; re-running the redaction
 * pipeline keeps a caller-injected secret out of the exported bytes.
 */
function rebuildSnapshot(snapshot, rules) {
  const redact = (value) => redactText(value, rules);
  return {
    schema: SNAPSHOT_SCHEMA,
    compatibility: 'experimental',
    producer: {
      name: '@aihq/core',
      version: redact(snapshot.producer.version),
      revision: snapshot.producer.revision === null ? null : redact(snapshot.producer.revision),
      contract: DIAGNOSTIC_CONTRACT,
    },
    capture: {
      observedAt: snapshot.capture.observedAt,
      acquisition: snapshot.capture.acquisition,
    },
    evidence: {
      originalSha256: snapshot.evidence.originalSha256,
      authentication: 'not-authenticated',
      structuralValidation: 'passed',
      projection: 'redacted',
    },
    status: snapshot.status,
    tools: snapshot.tools.map((tool) => (tool.config === undefined
      ? { id: redact(tool.id), label: redact(tool.label), state: tool.state, selection: tool.selection }
      : { id: redact(tool.id), label: redact(tool.label), state: tool.state, selection: tool.selection, config: redact(tool.config) })),
    observations: snapshot.observations.map((observation) => ({
      id: redact(observation.id), target: redact(observation.target), detail: redact(observation.detail),
    })),
    checks: snapshot.checks.map((check) => ({
      id: redact(check.id), target: redact(check.target), outcome: check.outcome,
      reason: redact(check.reason), detail: redact(check.detail),
    })),
    diagnostics: snapshot.diagnostics.map((entry) => ({
      code: redact(entry.code), reason: redact(entry.reason), message: redact(entry.message),
    })),
    metrics: {
      budgetMs: snapshot.metrics.budgetMs,
      elapsedMs: snapshot.metrics.elapsedMs,
      maxActiveProbes: snapshot.metrics.maxActiveProbes,
      counts: countOutcomes(snapshot.checks),
    },
  };
}

/**
 * Validate a ReportSnapshot value. Returns `{valid, errors}` and never throws
 * for malformed input; error strings carry structural paths, not raw values.
 */
export function validateSnapshot(value) {
  try {
    const bounded = toBoundedJson(value, 'snapshot');
    validateSnapshotShape(bounded);
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof ReportInputError) return { valid: false, errors: [error.message] };
    throw error;
  }
}

/**
 * Parse and validate a versioned snapshot JSON document, then re-apply the
 * privacy projection. A recognized-but-unsupported version throws
 * SCHEMA_UNSUPPORTED; malformed JSON or shape throws INPUT_INVALID.
 */
export function importSnapshot(json, redaction) {
  if (typeof json !== 'string') invalid('input: expected a JSON string');
  if (json.length > 2_097_152 || encoder.encode(json).length > 2_097_152) invalid('input: JSON exceeds byte limit');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    invalid('input: invalid JSON');
  }
  const bounded = toBoundedJson(parsed, 'snapshot');
  rejectDuplicateKeys(json);
  if (isPlainObject(bounded)) {
    if (typeof bounded.schema === 'string' && bounded.schema !== SNAPSHOT_SCHEMA) {
      throw new ReportInputError('SCHEMA_UNSUPPORTED', 'snapshot.schema: unsupported version');
    }
    if (isPlainObject(bounded.producer) && typeof bounded.producer.contract === 'string'
      && bounded.producer.contract !== DIAGNOSTIC_CONTRACT) {
      throw new ReportInputError('SCHEMA_UNSUPPORTED', 'snapshot.producer.contract: unsupported contract');
    }
  }
  validateSnapshotShape(bounded);
  return checkedProjection(rebuildSnapshot(bounded, buildRedactor(redaction === undefined ? undefined : toBoundedJson(redaction, 'redaction'))));
}

/**
 * Validate and serialize a snapshot to deterministic JSON. The same privacy
 * projection is applied again, so an injected secret cannot survive export.
 */
export function exportSnapshot(report) {
  const bounded = toBoundedJson(report, 'snapshot');
  validateSnapshotShape(bounded);
  return JSON.stringify(checkedProjection(rebuildSnapshot(bounded, [])));
}

function checkedProjection(value) {
  const bounded = toBoundedJson(value, 'snapshot');
  validateSnapshotShape(bounded);
  return bounded;
}
