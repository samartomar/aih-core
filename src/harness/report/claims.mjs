/**
 * Normalized claim sets for @aihq/core/report.
 *
 * Data only: validation and projection are pure functions of the supplied value.
 * They read no clock, randomness, filesystem, network or Catalog, perform no
 * host effects and compare strings by UTF-16 code unit, so the same input always
 * yields a deep-equal and identically serialized result. Caller input is
 * admitted as bounded plain JSON first and is never mutated. See
 * docs/reporting/CONTRACT.md.
 *
 * Validation never promotes or alters authentication: it is copied as supplied.
 * Unknown values stay absent; nothing defaults to zero and no calculation
 * yields a combined or global risk score.
 */
import {
  ReportInputError, invalid, isPlainObject, rejectDuplicateKeys, requireArray, requireEnum,
  requireKeys, requireString, toBoundedJson,
} from './bounded-json.mjs';

/** Versioned identity of the claim set this module accepts. */
export const CLAIMS_SCHEMA = 'urn:aihq:report:claims:1.0.0';

/** Versioned identity of the claim set that adds the recurrence calculation method. */
export const CLAIMS_SCHEMA_1_1_0 = 'urn:aihq:report:claims:1.1.0';

/** Every claim-set schema identity this version reads. */
export const CLAIMS_ACCEPTED_VERSIONS = Object.freeze([CLAIMS_SCHEMA, CLAIMS_SCHEMA_1_1_0]);

/** Versioned identity of the projection this module produces. */
export const CLAIMS_PROJECTION_SCHEMA = 'urn:aihq:report:claims-projection:1.0.0';

/** Versioned identity of the projection of a claims 1.1.0 set. */
export const CLAIMS_PROJECTION_SCHEMA_1_1_0 = 'urn:aihq:report:claims-projection:1.1.0';

// A claim set carries many small records, so its node and string budgets are
// larger than the diagnostic snapshot's. Values beyond them are rejected, never
// truncated.
const CLAIM_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 300000,
  maxStringBytes: 65536,
  maxTotalStringBytes: 2_097_152,
  maxArrayLength: 4096,
  maxObjectKeys: 256,
});
const MAX_JSON_BYTES = 2_097_152;
const MAX_IDENTITY = 256;
const MAX_TEXT = 2048;

const encoder = new TextEncoder();
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|\+00:00)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const SCOPE_KINDS = ['machine', 'repository', 'workspace', 'user-content'];
const CLAIM_KINDS = ['measured', 'estimated', 'declared', 'unknown'];
const COVERAGE_STATES = ['complete', 'partial', 'unknown'];
const AUTHENTICATION_STATUSES = ['not-authenticated', 'authenticated', 'verification-failed'];
const APPLICABILITY_STATES = ['current', 'recheck-needed', 'unknown'];
const ACTION_CATEGORIES = ['blocker', 'urgent-review', 'important-unknown', 'optional-improvement'];
const ROUTE_KINDS = ['operation', 'guidance'];

const CATEGORY_RULES = Object.freeze({
  blocker: 'Blocks the intended work until it is resolved.',
  'urgent-review': 'Needs prompt human review.',
  'important-unknown': 'An important outcome is unknown and needs a determination.',
  'optional-improvement': 'Optional improvement; no recorded failure depends on it.',
});

const CLAIM_REQUIRED = [
  'id', 'revision', 'producer', 'recordSchema', 'subject', 'scope', 'sources', 'observation',
  'capturedAt', 'measure', 'kind', 'coverage', 'authentication', 'applicability',
];
const CLAIM_OPTIONAL = ['value', 'unknownReason', 'method'];

// ---------------------------------------------------------------- primitives

function identity(value, path) {
  return requireString(value, path, MAX_IDENTITY);
}

function text(value, path) {
  return requireString(value, path, MAX_TEXT);
}

function freeText(value, path) {
  if (typeof value !== 'string') invalid(`${path}: expected string`);
  if ([...value].length > MAX_TEXT) invalid(`${path}: exceeds maximum length`);
  return value;
}

function sha256(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${path}: expected 64 lowercase hex characters`);
}

/** Epoch milliseconds of an RFC 3339 UTC instant, or null when it is not a real instant. */
function instantMs(value) {
  if (typeof value !== 'string') return null;
  const match = INSTANT.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'));
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime();
}

function instant(value, path) {
  if (instantMs(value) === null) invalid(`${path}: expected an RFC 3339 UTC instant with an explicit Z or +00:00 offset`);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRefs(left, right) {
  return compare(left.id, right.id) || compare(left.revision, right.revision);
}

function refKey(id, revision) {
  return JSON.stringify([id, revision]);
}

/** Deterministic serialization with code-unit key order, used only for equality. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameNamedVersion(left, right) {
  return left.id === right.id && left.version === right.version;
}

// ---------------------------------------------------------------- claim shape

function validateNamedVersion(value, path) {
  requireKeys(value, path, ['id', 'version']);
  identity(value.id, `${path}.id`);
  identity(value.version, `${path}.version`);
}

function validateSubject(value, path) {
  requireKeys(value, path, ['kind', 'id']);
  identity(value.kind, `${path}.kind`);
  identity(value.id, `${path}.id`);
}

function validateRef(value, path) {
  requireKeys(value, path, ['id', 'revision']);
  identity(value.id, `${path}.id`);
  identity(value.revision, `${path}.revision`);
}

function validateRecordRef(value, path) {
  requireKeys(value, path, ['id', 'schema'], ['sha256']);
  identity(value.id, `${path}.id`);
  identity(value.schema, `${path}.schema`);
  if ('sha256' in value) sha256(value.sha256, `${path}.sha256`);
}

function copyRecordRef(record) {
  return record.sha256 === undefined
    ? { id: record.id, schema: record.schema }
    : { id: record.id, schema: record.schema, sha256: record.sha256 };
}

function validateAuthentication(value, path) {
  if (!isPlainObject(value)) invalid(`${path}: expected object`);
  requireEnum(value.status, AUTHENTICATION_STATUSES, `${path}.status`);
  if (value.status === 'not-authenticated') {
    requireKeys(value, path, ['status']);
    return;
  }
  requireKeys(value, path, ['status', 'verifier', 'method', 'verifiedAt', 'evidence']);
  validateNamedVersion(value.verifier, `${path}.verifier`);
  validateNamedVersion(value.method, `${path}.method`);
  instant(value.verifiedAt, `${path}.verifiedAt`);
  const evidence = requireArray(value.evidence, `${path}.evidence`);
  if (evidence.length === 0) invalid(`${path}.evidence: expected at least one record`);
  evidence.forEach((entry, index) => validateRecordRef(entry, `${path}.evidence[${index}]`));
}

function validateClaim(claim, at) {
  requireKeys(claim, at, CLAIM_REQUIRED, CLAIM_OPTIONAL);
  identity(claim.id, `${at}.id`);
  identity(claim.revision, `${at}.revision`);
  validateNamedVersion(claim.producer, `${at}.producer`);
  identity(claim.recordSchema, `${at}.recordSchema`);
  validateSubject(claim.subject, `${at}.subject`);

  requireKeys(claim.scope, `${at}.scope`, ['kind', 'targets']);
  requireEnum(claim.scope.kind, SCOPE_KINDS, `${at}.scope.kind`);
  const targets = requireArray(claim.scope.targets, `${at}.scope.targets`);
  if (targets.length === 0) invalid(`${at}.scope.targets: expected at least one target`);
  targets.forEach((target, index) => identity(target, `${at}.scope.targets[${index}]`));
  if (new Set(targets).size !== targets.length) invalid(`${at}.scope.targets: targets must be unique`);

  const sources = requireArray(claim.sources, `${at}.sources`);
  if (sources.length === 0) invalid(`${at}.sources: expected at least one source record`);
  sources.forEach((source, index) => validateRecordRef(source, `${at}.sources[${index}]`));

  if (claim.observation !== null) identity(claim.observation, `${at}.observation`);
  instant(claim.capturedAt, `${at}.capturedAt`);
  identity(claim.measure, `${at}.measure`);
  requireEnum(claim.kind, CLAIM_KINDS, `${at}.kind`);

  if (claim.kind === 'unknown') {
    if ('value' in claim) invalid(`${at}.value: must be absent when kind is unknown`);
    if (!('unknownReason' in claim)) invalid(`${at}.unknownReason: required when kind is unknown`);
    text(claim.unknownReason, `${at}.unknownReason`);
  } else {
    if ('unknownReason' in claim) invalid(`${at}.unknownReason: allowed only when kind is unknown`);
    if (!('value' in claim)) invalid(`${at}.value: required unless kind is unknown`);
    requireKeys(claim.value, `${at}.value`, ['amount', 'unit']);
    const { amount } = claim.value;
    if (typeof amount === 'string') text(amount, `${at}.value.amount`);
    else if (typeof amount !== 'number' && typeof amount !== 'boolean') {
      invalid(`${at}.value.amount: expected number, string or boolean`);
    }
    identity(claim.value.unit, `${at}.value.unit`);
  }

  if ('method' in claim) validateNamedVersion(claim.method, `${at}.method`);
  else if (claim.kind === 'estimated') invalid(`${at}.method: required when kind is estimated`);

  requireKeys(claim.coverage, `${at}.coverage`, ['state', 'reason']);
  requireEnum(claim.coverage.state, COVERAGE_STATES, `${at}.coverage.state`);
  freeText(claim.coverage.reason, `${at}.coverage.reason`);

  validateAuthentication(claim.authentication, `${at}.authentication`);

  requireKeys(claim.applicability, `${at}.applicability`, ['state', 'reason', 'inputs']);
  requireEnum(claim.applicability.state, APPLICABILITY_STATES, `${at}.applicability.state`);
  text(claim.applicability.reason, `${at}.applicability.reason`);
  requireArray(claim.applicability.inputs, `${at}.applicability.inputs`)
    .forEach((input, index) => validateRef(input, `${at}.applicability.inputs[${index}]`));
}

// ---------------------------------------------------------------- claim set

/** The check outcome a claim carries: 'passed' | 'failed' | 'unknown', or null if it is not a check outcome. */
function outcomeOf(claim) {
  if (claim.kind === 'unknown') return 'unknown';
  const { amount, unit } = claim.value;
  if (unit === 'outcome' && (amount === 'passed' || amount === 'failed')) return amount;
  return null;
}

function validateCheckScore(request, at, resolve) {
  requireKeys(request, at, ['id', 'method', 'version', 'checkSet', 'selected', 'inapplicable']);
  identity(request.id, `${at}.id`);
  validateNamedVersion(request.checkSet, `${at}.checkSet`);
  const selected = new Set();
  requireArray(request.selected, `${at}.selected`).forEach((ref, index) => {
    const path = `${at}.selected[${index}]`;
    const claim = resolve(ref, path);
    if (claim.measure !== 'configuration-check') invalid(`${path}: expected a configuration-check claim`);
    if (claim.method === undefined || !sameNamedVersion(claim.method, request.checkSet)) {
      invalid(`${path}: claim method does not match the check set`);
    }
    if (outcomeOf(claim) === null) invalid(`${path}: expected a passed or failed outcome, or an unknown claim`);
    const key = refKey(ref.id, ref.revision);
    if (selected.has(key)) invalid(`${path}: duplicate claim reference`);
    selected.add(key);
  });
  const excluded = new Set();
  requireArray(request.inapplicable, `${at}.inapplicable`).forEach((entry, index) => {
    const path = `${at}.inapplicable[${index}]`;
    requireKeys(entry, path, ['claim', 'reason']);
    resolve(entry.claim, `${path}.claim`);
    text(entry.reason, `${path}.reason`);
    const key = refKey(entry.claim.id, entry.claim.revision);
    if (selected.has(key)) invalid(`${path}.claim: an inapplicable claim must not also be selected`);
    if (excluded.has(key)) invalid(`${path}.claim: duplicate claim reference`);
    excluded.add(key);
  });
}

function validateRepairCount(request, at, resolve) {
  requireKeys(request, at, ['id', 'method', 'version', 'attempts']);
  identity(request.id, `${at}.id`);
  requireArray(request.attempts, `${at}.attempts`).forEach((attempt, index) => {
    const path = `${at}.attempts[${index}]`;
    requireKeys(attempt, path, ['operation', 'subject', 'condition', 'precheck', 'repair', 'postcheck']);
    identity(attempt.operation, `${path}.operation`);
    validateSubject(attempt.subject, `${path}.subject`);
    identity(attempt.condition, `${path}.condition`);
    for (const name of ['precheck', 'repair', 'postcheck']) {
      if (attempt[name] !== null) resolve(attempt[name], `${path}.${name}`);
    }
  });
}

function validateContextChange(request, at, resolve) {
  requireKeys(request, at, ['id', 'method', 'version', 'before', 'after']);
  identity(request.id, `${at}.id`);
  resolve(request.before, `${at}.before`);
  resolve(request.after, `${at}.after`);
}

function validateRecurrence(request, at, resolve) {
  requireKeys(request, at, ['id', 'method', 'version', 'subject', 'condition', 'observations']);
  identity(request.id, `${at}.id`);
  validateSubject(request.subject, `${at}.subject`);
  identity(request.condition, `${at}.condition`);
  const seen = new Set();
  requireArray(request.observations, `${at}.observations`).forEach((ref, index) => {
    const path = `${at}.observations[${index}]`;
    resolve(ref, path);
    const key = refKey(ref.id, ref.revision);
    if (seen.has(key)) invalid(`${path}: duplicate claim reference`);
    seen.add(key);
  });
}

function validateCalculation(request, at, claims, schema) {
  if (!isPlainObject(request)) invalid(`${at}: expected object`);
  const method = methodOf(request, schema);
  if (method === undefined) invalid(`${at}.method: unsupported calculation method or version`);

  const resolve = (ref, path) => {
    validateRef(ref, path);
    const claim = claims.get(refKey(ref.id, ref.revision));
    if (claim === undefined) invalid(`${path}: does not resolve to a claim in the set`);
    return claim;
  };
  method.validate(request, at, resolve);
}

function validateAction(action, at, claims) {
  requireKeys(action, at, ['id', 'category', 'reason', 'subjects', 'evidence', 'prerequisites', 'route']);
  identity(action.id, `${at}.id`);
  requireEnum(action.category, ACTION_CATEGORIES, `${at}.category`);
  text(action.reason, `${at}.reason`);
  const subjects = requireArray(action.subjects, `${at}.subjects`);
  if (subjects.length === 0) invalid(`${at}.subjects: expected at least one subject`);
  subjects.forEach((subject, index) => validateSubject(subject, `${at}.subjects[${index}]`));
  requireArray(action.evidence, `${at}.evidence`).forEach((ref, index) => {
    const path = `${at}.evidence[${index}]`;
    validateRef(ref, path);
    if (!claims.has(refKey(ref.id, ref.revision))) invalid(`${path}: does not resolve to a claim in the set`);
  });
  requireArray(action.prerequisites, `${at}.prerequisites`)
    .forEach((entry, index) => text(entry, `${at}.prerequisites[${index}]`));
  requireKeys(action.route, `${at}.route`, ['kind', 'id']);
  requireEnum(action.route.kind, ROUTE_KINDS, `${at}.route.kind`);
  identity(action.route.id, `${at}.route.id`);
}

/**
 * Validate a bounded plain copy and index its claims by identity. The same
 * identity with identical content is one claim; with different content the set
 * is invalid. Throws ReportInputError.
 */
function admitClaimSet(value) {
  if (!isPlainObject(value)) invalid('claimSet: expected object');
  if (typeof value.schema !== 'string') invalid('claimSet.schema: expected a schema identity string');
  if (!CLAIMS_ACCEPTED_VERSIONS.includes(value.schema)) {
    throw new ReportInputError('SCHEMA_UNSUPPORTED', 'claimSet.schema: unsupported version');
  }
  requireKeys(value, 'claimSet', ['schema', 'claims'], ['calculations', 'actions']);

  const claims = new Map();
  requireArray(value.claims, 'claimSet.claims').forEach((claim, index) => {
    const at = `claimSet.claims[${index}]`;
    validateClaim(claim, at);
    const key = refKey(claim.id, claim.revision);
    const existing = claims.get(key);
    if (existing === undefined) claims.set(key, claim);
    else if (canonicalJson(existing) !== canonicalJson(claim)) {
      invalid(`${at}: claim identity repeats with different content`);
    }
  });

  const calculationIds = new Set();
  const calculations = 'calculations' in value ? requireArray(value.calculations, 'claimSet.calculations') : [];
  calculations.forEach((request, index) => {
    const at = `claimSet.calculations[${index}]`;
    validateCalculation(request, at, claims, value.schema);
    if (calculationIds.has(request.id)) invalid(`${at}.id: duplicate calculation id`);
    calculationIds.add(request.id);
  });

  const actionIds = new Set();
  const actions = 'actions' in value ? requireArray(value.actions, 'claimSet.actions') : [];
  actions.forEach((action, index) => {
    const at = `claimSet.actions[${index}]`;
    validateAction(action, at, claims);
    if (actionIds.has(action.id)) invalid(`${at}.id: duplicate action id`);
    actionIds.add(action.id);
  });

  return { schema: value.schema, claims, calculations, actions };
}

// ---------------------------------------------------------------- dedup

function contentKey(claim) {
  const { id, revision, ...content } = claim;
  return canonicalJson(content);
}

/**
 * Group claims by producer and non-null observation. Identical content apart
 * from id/revision is one observation; differing content is a conflict and
 * every member stays visible.
 */
function classify(sorted) {
  const dedup = new Map();
  const groups = new Map();
  const unidentified = [];
  for (const claim of sorted) {
    if (claim.observation === null) {
      dedup.set(refKey(claim.id, claim.revision), { status: 'unidentified', canonical: null, group: `claim:${refKey(claim.id, claim.revision)}` });
      unidentified.push({ id: claim.id, revision: claim.revision });
      continue;
    }
    const key = JSON.stringify([claim.producer.id, claim.observation]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim);
  }
  const duplicates = [];
  const conflicts = [];
  for (const [key, members] of groups) {
    const first = members[0];
    const producer = first.producer.id;
    const { observation } = first;
    const refs = members.map((member) => ({ id: member.id, revision: member.revision }));
    const group = `observation:${key}`;
    if (new Set(members.map(contentKey)).size > 1) {
      for (const member of members) {
        dedup.set(refKey(member.id, member.revision), { status: 'conflict', canonical: null, group, conflicted: true, representative: refs[0] });
      }
      conflicts.push({ producer, observation, claims: refs, reason: 'same-observation-different-content' });
    } else if (members.length === 1) {
      dedup.set(refKey(first.id, first.revision), { status: 'unique', canonical: null, group: `claim:${refKey(first.id, first.revision)}` });
    } else {
      const canonical = refs[0];
      members.forEach((member, index) => {
        dedup.set(refKey(member.id, member.revision), {
          status: index === 0 ? 'canonical' : 'duplicate', canonical, group, representative: canonical,
        });
      });
      duplicates.push({ producer, observation, claim: canonical, merged: refs.slice(1), imports: members.length });
    }
  }
  duplicates.sort((left, right) => compare(left.producer, right.producer) || compare(left.observation, right.observation));
  conflicts.sort((left, right) => compare(left.producer, right.producer) || compare(left.observation, right.observation));
  return { dedup, duplicates, conflicts, unidentified };
}

// ---------------------------------------------------------------- calculations

function refOf(claim) {
  return { id: claim.id, revision: claim.revision };
}

function refOrNull(ref) {
  return ref === null ? null : { id: ref.id, revision: ref.revision };
}

function uniqueSortedRefs(refs) {
  const byKey = new Map();
  for (const ref of refs) byKey.set(refKey(ref.id, ref.revision), { id: ref.id, revision: ref.revision });
  return [...byKey.values()].sort(compareRefs);
}

function calculationHead(request, status, reason, inputs) {
  return {
    id: request.id,
    method: { id: request.method, version: request.version },
    status,
    reason,
    inputs: uniqueSortedRefs(inputs),
  };
}

/**
 * Whether the numbers rest on a deduplicated event identity. A claim with no
 * observation identity cannot be matched with a re-import, so any such input
 * means the aggregate is shown but not asserted as deduplicated.
 */
function deduplicationOf(inputs, context) {
  const unidentified = inputs.filter((ref) => context.claim(ref).observation === null);
  return {
    status: unidentified.length === 0 ? 'established' : 'not-established',
    unidentified: uniqueSortedRefs(unidentified),
  };
}

function configurationCheckScore(request, context) {
  const outcomes = new Map();
  const failed = [];
  const conflicts = [];
  for (const ref of request.selected) {
    const claim = context.claim(ref);
    const info = context.dedup.get(refKey(claim.id, claim.revision));
    // A failed claim is always listed, even as a member of a conflicted observation;
    // duplicates of one event are listed once, as their canonical claim.
    if (info.conflicted) conflicts.push(refOf(claim));
    // Conflict members are listed as themselves; duplicates collapse to their canonical claim.
    const listedRef = info.conflicted ? refOf(claim) : info.representative ?? refOf(claim);
    if (outcomeOf(claim) === 'failed') failed.push(listedRef);
    // A conflicted observation has no single reliable outcome, so it counts once as unknown.
    if (!outcomes.has(info.group)) outcomes.set(info.group, info.conflicted ? 'unknown' : outcomeOf(claim));
  }
  const counts = { passed: 0, failed: 0, unknown: 0, inapplicable: 0 };
  for (const outcome of outcomes.values()) counts[outcome] += 1;
  const excludedGroups = new Set();
  const excluded = request.inapplicable.map((entry) => {
    const claim = context.claim(entry.claim);
    excludedGroups.add(context.dedup.get(refKey(claim.id, claim.revision)).group);
    return { claim: refOf(claim), reason: entry.reason };
  }).sort((left, right) => compareRefs(left.claim, right.claim));
  counts.inapplicable = excludedGroups.size;

  const numerator = counts.passed;
  const denominator = counts.passed + counts.failed + counts.unknown;
  const available = denominator > 0;
  const inputs = [...request.selected, ...request.inapplicable.map((entry) => entry.claim)];
  return {
    ...calculationHead(request, available ? 'available' : 'unavailable', available ? null : 'no-applicable-checks', inputs),
    checkSet: { id: request.checkSet.id, version: request.checkSet.version },
    counts,
    numerator,
    denominator,
    score: available ? (numerator * 100) / denominator : null,
    failed: uniqueSortedRefs(failed),
    conflicts: uniqueSortedRefs(conflicts),
    excluded,
    deduplication: deduplicationOf(inputs, context),
  };
}

function verifiedRepairCount(request, context) {
  const verifiedConditions = new Set();
  const inputs = [];
  const attempts = request.attempts.map((attempt) => {
    const [pre, repair, post] = [attempt.precheck, attempt.repair, attempt.postcheck]
      .map((ref) => (ref === null ? null : context.claim(ref)));
    for (const claim of [pre, repair, post]) if (claim !== null) inputs.push(refOf(claim));

    const sameSubject = (claim) => claim.subject.kind === attempt.subject.kind && claim.subject.id === attempt.subject.id;
    const checkMatches = (claim) => claim === null
      || (sameSubject(claim) && claim.measure === attempt.condition && outcomeOf(claim) !== null);
    const repairMatches = (claim) => claim === null
      || (sameSubject(claim) && (claim.measure === 'repair' || claim.measure === 'external-repair')
        && claim.kind !== 'unknown' && claim.value.unit === 'operation' && claim.value.amount === attempt.operation);
    const conflicted = (claim) => claim !== null && Boolean(context.dedup.get(refKey(claim.id, claim.revision)).conflicted);
    const times = [pre, repair, post].filter((claim) => claim !== null).map((claim) => instantMs(claim.capturedAt));
    const ordered = times.every((time, index) => index === 0 || times[index - 1] < time);

    const preOutcome = pre === null ? 'unknown' : outcomeOf(pre);
    const postOutcome = post === null ? 'unknown' : outcomeOf(post);
    let reason;
    if (!checkMatches(pre) || !checkMatches(post) || !repairMatches(repair) || !ordered) reason = 'uncorrelated';
    else if (conflicted(pre) || conflicted(repair) || conflicted(post)) reason = 'conflicting-evidence';
    else if (preOutcome === 'unknown') reason = 'unknown-precondition';
    else if (preOutcome === 'passed') reason = 'already-healthy';
    else if (repair !== null && repair.measure === 'external-repair') reason = 'external-repair';
    else if (repair === null && postOutcome === 'passed') reason = 'unknown-cause';
    else if (repair !== null && postOutcome === 'unknown') reason = 'applied-unverified';
    else if (repair !== null && postOutcome === 'failed') reason = 'repair-not-verified';
    else if (repair === null) reason = 'no-recovery';
    else reason = 'verified';

    const counted = reason === 'verified';
    if (counted) verifiedConditions.add(context.dedup.get(refKey(pre.id, pre.revision)).group);
    return {
      operation: attempt.operation,
      subject: { kind: attempt.subject.kind, id: attempt.subject.id },
      condition: attempt.condition,
      precheck: refOrNull(attempt.precheck),
      repair: refOrNull(attempt.repair),
      postcheck: refOrNull(attempt.postcheck),
      counted,
      reason,
    };
  });
  return {
    ...calculationHead(request, 'available', null, inputs),
    count: verifiedConditions.size,
    attempts,
    deduplication: deduplicationOf(inputs, context),
  };
}

function contextChange(request, context) {
  const before = context.claim(request.before);
  const after = context.claim(request.after);
  const head = (reason) => calculationHead(request, reason === null ? 'available' : 'unavailable', reason, [request.before, request.after]);

  let reason = null;
  if (before.kind === 'unknown' || after.kind === 'unknown') reason = 'unknown-value';
  else if (before.measure !== after.measure) reason = 'incomparable-measure';
  else if (before.kind !== after.kind) reason = 'incomparable-kind';
  else if (before.value.unit !== after.value.unit) reason = 'incomparable-unit';
  else if (before.kind === 'declared') reason = 'unsupported-kind';
  else if (before.kind === 'measured' && before.value.unit !== 'bytes') reason = 'unsupported-unit';
  else if (before.kind === 'estimated' && !sameNamedVersion(before.method, after.method)) reason = 'incomparable-method';
  else {
    const amounts = [before.value.amount, after.value.amount];
    if (amounts.some((amount) => typeof amount !== 'number' || amount < 0)) reason = 'invalid-amount';
  }
  if (reason !== null) return head(reason);

  const [from, to] = [before.value.amount, after.value.amount];
  const result = {
    ...head(null),
    before: from,
    after: to,
    unit: before.value.unit,
    absoluteDifference: Math.abs(from - to),
    direction: to < from ? 'decrease' : to > from ? 'increase' : 'unchanged',
  };
  if (from > 0) {
    result.percentage = ((from - to) * 100) / from;
  } else {
    result.percentage = null;
    result.percentageReason = 'zero-baseline';
  }
  return result;
}

/** `[role, next state]` for a passed or failed outcome arriving in each walk state. */
const RECURRENCE_STEPS = Object.freeze({
  failed: Object.freeze({ initial: ['failure', 'failing'], failing: ['repeated-failure', 'failing'], recovered: ['recurrence', 'failing'] }),
  passed: Object.freeze({ initial: ['passed', 'initial'], failing: ['recovery', 'recovered'], recovered: ['passed', 'recovered'] }),
});

/**
 * A later same-condition failure after a verified recovery. Matching is exact
 * (subject and condition), events are de-duplicated by observation identity and
 * ordered by capture instant. Missing or insufficient history is unavailable
 * with a null count, never zero; an unknown outcome never changes state.
 */
function recurrence(request, context) {
  const sameSubject = (claim) => claim.subject.kind === request.subject.kind && claim.subject.id === request.subject.id;
  const unmatched = [];
  const conflicts = [];
  const events = new Map();
  for (const ref of request.observations) {
    const claim = context.claim(ref);
    let reason = null;
    if (!sameSubject(claim)) reason = 'different-subject';
    else if (claim.measure !== request.condition) reason = 'different-condition';
    else if (outcomeOf(claim) === null) reason = 'not-a-check-outcome';
    if (reason !== null) {
      unmatched.push({ claim: refOf(claim), reason });
      continue;
    }
    const info = context.dedup.get(refKey(claim.id, claim.revision));
    // A conflicted observation has no reliable outcome or time, so it stays off the timeline.
    if (info.conflicted) conflicts.push(refOf(claim));
    else if (!events.has(info.group)) {
      events.set(info.group, { claim: info.representative ?? refOf(claim), capturedAt: claim.capturedAt, time: instantMs(claim.capturedAt), outcome: outcomeOf(claim), role: null });
    }
  }
  unmatched.sort((left, right) => compareRefs(left.claim, right.claim));

  const timeline = [...events.values()].sort((left, right) => left.time - right.time || compareRefs(left.claim, right.claim));
  const outcomesAt = new Map();
  for (const event of timeline) {
    if (!outcomesAt.has(event.time)) outcomesAt.set(event.time, new Set());
    outcomesAt.get(event.time).add(event.outcome);
  }
  const ambiguous = [...outcomesAt.values()].some((outcomes) => outcomes.has('passed') && outcomes.has('failed'));
  const known = timeline.some((event) => event.outcome !== 'unknown');

  // An ambiguous order assigns no roles at all.
  const recurrences = [];
  if (!ambiguous) {
    let state = 'initial';
    let episode = null;
    let recovery = null;
    for (const event of timeline) {
      if (event.outcome === 'unknown') {
        event.role = 'unknown';
        continue;
      }
      [event.role, state] = RECURRENCE_STEPS[event.outcome][state];
      if (event.role === 'recovery') recovery = event.claim;
      else if (event.role === 'failure' || event.role === 'recurrence') {
        if (event.role === 'recurrence') recurrences.push({ failure: refOf(episode), recovery: refOf(recovery), recurrence: refOf(event.claim) });
        episode = event.claim;
      }
    }
  }

  let reason = null;
  if (!known) reason = 'no-history';
  else if (ambiguous) reason = 'ambiguous-order';
  else if (!timeline.some((event) => event.outcome === 'failed')) reason = 'no-failure';
  else if (!timeline.some((event) => event.role === 'recovery')) reason = 'no-recovery';
  return {
    ...calculationHead(request, reason === null ? 'available' : 'unavailable', reason, request.observations),
    subject: { kind: request.subject.kind, id: request.subject.id },
    condition: request.condition,
    count: reason === null ? recurrences.length : null,
    recurrences: reason === null ? recurrences : [],
    timeline: timeline.map((event) => ({ claim: refOf(event.claim), capturedAt: event.capturedAt, outcome: event.outcome, role: event.role })),
    unmatched,
    conflicts: uniqueSortedRefs(conflicts),
    deduplication: deduplicationOf(request.observations, context),
  };
}

// ---------------------------------------------------------------- methods

/**
 * One entry per method keeps the advertised list, validation and calculation in
 * step. `since` is the first claim-set version that accepts the method.
 */
const METHODS = Object.freeze({
  'configuration-check-score': Object.freeze({ version: '1.0.0', since: CLAIMS_SCHEMA, validate: validateCheckScore, calculate: configurationCheckScore }),
  'verified-repair-count': Object.freeze({ version: '1.0.0', since: CLAIMS_SCHEMA, validate: validateRepairCount, calculate: verifiedRepairCount }),
  'context-change': Object.freeze({ version: '1.0.0', since: CLAIMS_SCHEMA, validate: validateContextChange, calculate: contextChange }),
  recurrence: Object.freeze({ version: '1.0.0', since: CLAIMS_SCHEMA_1_1_0, validate: validateRecurrence, calculate: recurrence }),
});

/** The explicit, versioned calculation methods a request may select. */
export const CALCULATION_METHODS = Object.freeze(Object.keys(METHODS)
  .map((id) => Object.freeze({ id, version: METHODS[id].version })));

/** The method a request names at its exact version, if the claim-set version accepts it, or undefined. */
function methodOf(request, schema) {
  if (typeof request.method !== 'string' || !Object.hasOwn(METHODS, request.method)) return undefined;
  const method = METHODS[request.method];
  const accepted = CLAIMS_ACCEPTED_VERSIONS.indexOf(schema) >= CLAIMS_ACCEPTED_VERSIONS.indexOf(method.since);
  return accepted && method.version === request.version ? method : undefined;
}

// ---------------------------------------------------------------- projection

function copyClaim(claim, dedup) {
  const copy = {
    id: claim.id,
    revision: claim.revision,
    producer: { id: claim.producer.id, version: claim.producer.version },
    recordSchema: claim.recordSchema,
    subject: { kind: claim.subject.kind, id: claim.subject.id },
    scope: { kind: claim.scope.kind, targets: [...claim.scope.targets] },
    sources: claim.sources.map(copyRecordRef),
    observation: claim.observation,
    capturedAt: claim.capturedAt,
    measure: claim.measure,
    kind: claim.kind,
  };
  if (claim.kind === 'unknown') copy.unknownReason = claim.unknownReason;
  else copy.value = { amount: claim.value.amount, unit: claim.value.unit };
  if (claim.method !== undefined) copy.method = { id: claim.method.id, version: claim.method.version };
  copy.coverage = { state: claim.coverage.state, reason: claim.coverage.reason };
  copy.authentication = claim.authentication.status === 'not-authenticated'
    ? { status: 'not-authenticated' }
    : {
      status: claim.authentication.status,
      verifier: { id: claim.authentication.verifier.id, version: claim.authentication.verifier.version },
      method: { id: claim.authentication.method.id, version: claim.authentication.method.version },
      verifiedAt: claim.authentication.verifiedAt,
      evidence: claim.authentication.evidence.map(copyRecordRef),
    };
  copy.applicability = {
    state: claim.applicability.state,
    reason: claim.applicability.reason,
    inputs: claim.applicability.inputs.map(refOf),
  };
  copy.dedup = { status: dedup.status, canonical: dedup.canonical === null ? null : { ...dedup.canonical } };
  return copy;
}

function orderActions(actions) {
  const rank = (action) => ACTION_CATEGORIES.indexOf(action.category);
  return [...actions]
    .sort((left, right) => rank(left) - rank(right) || compare(left.id, right.id))
    .map((action, index) => ({
      id: action.id,
      category: action.category,
      reason: action.reason,
      subjects: action.subjects.map((subject) => ({ kind: subject.kind, id: subject.id })),
      evidence: action.evidence.map(refOf),
      prerequisites: [...action.prerequisites],
      route: { kind: action.route.kind, id: action.route.id },
      order: { rank: index + 1, category: action.category, reason: CATEGORY_RULES[action.category], tie: 'id' },
    }));
}

function project(admitted) {
  const sorted = [...admitted.claims.values()].sort(compareRefs);
  const { dedup, duplicates, conflicts, unidentified } = classify(sorted);
  const context = {
    dedup,
    claim: (ref) => admitted.claims.get(refKey(ref.id, ref.revision)),
  };
  const calculations = admitted.calculations.map((request) => methodOf(request, admitted.schema).calculate(request, context));
  return {
    schema: admitted.schema === CLAIMS_SCHEMA ? CLAIMS_PROJECTION_SCHEMA : CLAIMS_PROJECTION_SCHEMA_1_1_0,
    source: { schema: admitted.schema },
    claims: sorted.map((claim) => copyClaim(claim, dedup.get(refKey(claim.id, claim.revision)))),
    observations: { duplicates, conflicts, unidentified },
    calculations,
    actions: orderActions(admitted.actions),
  };
}

// ---------------------------------------------------------------- public API

/**
 * Validate a claim-set value. Returns `{valid, errors}` and never throws for
 * malformed input; error strings carry structural paths, not raw values.
 */
export function validateClaimSet(value) {
  try {
    admitClaimSet(toBoundedJson(value, 'claimSet', CLAIM_LIMITS));
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof ReportInputError) return { valid: false, errors: [error.message] };
    throw error;
  }
}

/**
 * Parse and validate a claim-set JSON document without throwing. A rejected
 * result carries the exact unchanged input so the caller can preserve it.
 */
export function readClaimSet(json) {
  let schema = null;
  try {
    if (typeof json !== 'string') invalid('input: expected a JSON string');
    if (json.length > MAX_JSON_BYTES || encoder.encode(json).length > MAX_JSON_BYTES) {
      invalid('input: JSON exceeds byte limit');
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      invalid('input: invalid JSON');
    }
    if (isPlainObject(parsed) && typeof parsed.schema === 'string') schema = parsed.schema;
    const bounded = toBoundedJson(parsed, 'claimSet', CLAIM_LIMITS);
    rejectDuplicateKeys(json, CLAIM_LIMITS);
    admitClaimSet(bounded);
    return { status: 'supported', claimSet: bounded };
  } catch (error) {
    if (!(error instanceof ReportInputError)) throw error;
    return {
      status: 'rejected',
      code: error.code,
      schema,
      errors: [error.message],
      original: typeof json === 'string' ? json : '',
    };
  }
}

/**
 * Validate a claim set and project it deterministically. Throws
 * ReportInputError: SCHEMA_UNSUPPORTED for an unaccepted schema identity,
 * otherwise INPUT_INVALID. The caller's value is never mutated.
 */
export function projectClaims(claimSet) {
  return project(admitClaimSet(toBoundedJson(claimSet, 'claimSet', CLAIM_LIMITS)));
}
