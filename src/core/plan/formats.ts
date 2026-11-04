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
