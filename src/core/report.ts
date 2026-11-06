// Portable report snapshots and claim sets under `@aihq/core/contracts` (contract 3, 4, 16, C32, C42).
// `urn:aihq:core:report:0.1.0` is the retained diagnostic snapshot (it holds the diagnostic data it reads) and
// `urn:aihq:core:claims:0.1.0` the retained 1.1.0 claim set, each under its one Core format id. Every helper returns
// `ok`, `invalid` with problems, or `unsupported-version`; none throws for bad input. The retained readers do the
// work: the same redaction, bounds, duplicate-key refusal and exact claim predicates (a claim is never inferred from a
// successful subset).
import { createReport as createRetained, exportSnapshot as exportRetained, importSnapshot as importRetained,
  validateSnapshot as validateRetained, projectClaims as projectRetained, readClaimSet as readRetained,
  validateClaimSet as validateClaimRetained, ReportInputError, SNAPSHOT_SCHEMA, DIAGNOSTIC_CONTRACT } from '../harness/report/data.mjs';
import type { CreateReportInput } from '../harness/report/data.mjs';
import { rejectDuplicateKeys } from '../harness/report/bounded-json.mjs';
import type { Json } from './types.js';
import type { Problem } from './plan/types.js';

export const REPORT = 'urn:aihq:core:report:0.1.0' as const;
export const CLAIMS = 'urn:aihq:core:claims:0.1.0' as const;
const SNAPSHOT_BYTES = 2_097_152;

export type ReportResult<T> = ({ status: 'ok' } & T) | { status: 'invalid'; problems: Problem[] } |
  { status: 'unsupported-version'; encountered: string; supported: string[] };
type Snapshot = { [key: string]: Json };
export type ReportSnapshot = Snapshot & { schema: typeof REPORT };
export type ClaimSet = Snapshot & { schema: typeof CLAIMS };
export type ClaimsProjection = { [key: string]: Json };
export type { CreateReportInput };

const problem = (message: string, path = ''): Problem => ({ path, reason: 'invalid', message });
const failure = (error: unknown, supported: string): ReportResult<never> => {
  if (!(error instanceof ReportInputError)) throw error;
  if (error.code === 'SCHEMA_UNSUPPORTED' && error.path !== '/producer/contract')
    return { status: 'unsupported-version', encountered: String(error.encountered ?? ''), supported: [supported] };
  return { status: 'invalid', problems: [problem(error.message, typeof error.path === 'string' ? error.path : '')] };
};
const schemaOf = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value) ? (value as { schema?: unknown }).schema : undefined;
const unsupported = (encountered: unknown, supported: string): ReportResult<never> | undefined =>
  typeof encountered === 'string' && encountered !== supported ? { status: 'unsupported-version', encountered, supported: [supported] } : undefined;

/** The retained snapshot read under its retained id (the diagnostic contract it read is part of the 0.1.0 format). */
function toRetained(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { producer, ...rest } = value as Snapshot;
  return { ...rest, schema: SNAPSHOT_SCHEMA,
    ...(producer !== undefined ? { producer: producer && typeof producer === 'object' && !Array.isArray(producer) ?
      { ...(producer as Snapshot), contract: DIAGNOSTIC_CONTRACT } : producer } : {}) };
}
function fromRetained(snapshot: Snapshot): ReportSnapshot {
  const out: Snapshot = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'schema') out.schema = REPORT;
    else if (key === 'producer') { const { contract: _contract, ...producer } = value as Snapshot; out.producer = producer; }
    else out[key] = value;
  }
  return out as ReportSnapshot;
}

/** Validates one Core diagnostic result and projects it into a redacted `report:0.1.0` snapshot. */
export function createReport(input: CreateReportInput): ReportResult<{ snapshot: ReportSnapshot }> {
  try { return { status: 'ok', snapshot: fromRetained(createRetained(input) as unknown as Snapshot) }; }
  catch (error) { return failure(error, REPORT); }
}
/** Checks a snapshot value; never throws. */
export function validateSnapshot(value: unknown): ReportResult<{ schema: typeof REPORT }> {
  const other = unsupported(schemaOf(value), REPORT);
  if (other) return other;
  if (schemaOf(value) !== REPORT) return { status: 'invalid', problems: [problem('A report snapshot names its format in `schema`.', '/schema')] };
  const checked = validateRetained(toRetained(value));
  return checked.valid ? { status: 'ok', schema: REPORT } :
    { status: 'invalid', problems: checked.errors.map(message => problem(message, typeof checked.path === 'string' ? checked.path : '')) };
}
/** Parses snapshot JSON, checks it and applies the privacy projection again; never throws. */
export function importSnapshot(json: string, redaction?: CreateReportInput['redaction']): ReportResult<{ snapshot: ReportSnapshot }> {
  if (typeof json !== 'string') return { status: 'invalid', problems: [problem('A snapshot is imported from a JSON string.')] };
  if (json.length > SNAPSHOT_BYTES || new TextEncoder().encode(json).length > SNAPSHOT_BYTES)
    return { status: 'invalid', problems: [problem('The snapshot JSON is larger than its limit.')] };
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return { status: 'invalid', problems: [problem('The snapshot is not JSON.')] }; }
  const other = unsupported(schemaOf(parsed), REPORT);
  if (other) return other;
  try {
    rejectDuplicateKeys(json);
    return { status: 'ok', snapshot: fromRetained(importRetained(JSON.stringify(toRetained(parsed)), redaction) as unknown as Snapshot) };
  } catch (error) { return failure(error, REPORT); }
}
/** Serializes a checked snapshot to deterministic JSON, redacted again. */
export function exportSnapshot(snapshot: unknown): ReportResult<{ json: string }> {
  const other = unsupported(schemaOf(snapshot), REPORT);
  if (other) return other;
  try { return { status: 'ok', json: JSON.stringify(fromRetained(JSON.parse(exportRetained(toRetained(snapshot) as never)) as Snapshot)) }; }
  catch (error) { return failure(error, REPORT); }
}

/** Checks a `claims:0.1.0` claim set; never throws. */
export function validateClaimSet(value: unknown): ReportResult<{ schema: typeof CLAIMS }> {
  const other = unsupported(schemaOf(value), CLAIMS);
  if (other) return other;
  const checked = validateClaimRetained(value);
  return checked.valid ? { status: 'ok', schema: CLAIMS } :
    { status: 'invalid', problems: checked.errors.map(message => problem(message, typeof checked.path === 'string' ? checked.path : '')) };
}
/** Parses a claim-set JSON document; a rejected one carries the unchanged input in `original`. */
export function readClaimSet(json: string): ReportResult<{ claimSet: ClaimSet }> | { status: 'invalid'; problems: Problem[]; original: string } {
  let declared: unknown;
  try { declared = schemaOf(JSON.parse(json)); } catch { declared = undefined; }
  const other = unsupported(declared, CLAIMS);
  if (other) return other;
  const read = readRetained(json) as { status: string; claimSet?: unknown; errors?: string[]; path?: string; original?: string };
  if (read.status === 'supported') return { status: 'ok', claimSet: read.claimSet as ClaimSet };
  return { status: 'invalid', problems: (read.errors ?? []).map(message => problem(message, read.path ?? '')), original: read.original ?? '' };
}
/** Projects a claim set deterministically: dedup, conflicts, calculations by their exact predicates, ordered actions. */
export function projectClaims(claimSet: unknown): ReportResult<{ projection: ClaimsProjection }> {
  const other = unsupported(schemaOf(claimSet), CLAIMS);
  if (other) return other;
  try {
    const { schema: _schema, ...projection } = projectRetained(claimSet) as unknown as Snapshot;
    return { status: 'ok', projection: projection as ClaimsProjection };
  } catch (error) { return failure(error, CLAIMS); }
}
