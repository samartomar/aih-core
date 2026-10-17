// Portable validation of every prepared-work and run-result family Core produces.
//
// Importing or calling anything here performs no host observation, process
// execution, network access, writes or state lookup. Families that already have
// an owning validator delegate to it unchanged (trust and macOS session work).
// The policy families that have only a published schema are checked against that
// schema with the same strict-JSON admission. Dispatch is by exact schema ID: an
// unknown or future ID is refused, never mapped onto a nearby version.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import preparedWork10Schema from '../schemas/prepared-work/1.0.0.json' with { type: 'json' };
import preparedWork11Schema from '../schemas/prepared-work/1.1.0.json' with { type: 'json' };
import preparedWork14Schema from '../schemas/prepared-work/1.4.0.json' with { type: 'json' };
import preparedWork15Schema from '../schemas/prepared-work/1.5.0.json' with { type: 'json' };
import runResult10Schema from '../schemas/run-result/1.0.0.json' with { type: 'json' };
import runResult11Schema from '../schemas/run-result/1.1.0.json' with { type: 'json' };
import { validatePreparedWork12, validatePreparedWork14, validateRunResult12 } from '../trust-contracts.js';
import { validatePreparedWork13, validateRunResult13 } from '../macos-session-contracts.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, STRICT_JSON_MAX_DEPTH_V1 } from './strict-json.js';
import { canonicalJson } from './canonical.js';
import type { ValidationResult } from '../types.js';

type Validator = (value: unknown) => ValidationResult;

const ajv = new Ajv2020({ allErrors: true, strict: true });
// prepared-work 1.5.0 reuses the 1.4.0 policy definitions by reference.
ajv.addSchema(preparedWork14Schema);

/** Strict bounded JSON, exact schema identity, then the published schema; no semantics beyond it exist. */
function schemaOnly(schema: { $id: string }): Validator {
  const check: ValidateFunction = ajv.compile(schema);
  return value => {
    let safe: unknown;
    try {
      safe = cloneJsonValueStructureV1(value, 'document', STRICT_JSON_MAX_DEPTH_V1);
      assertStrictJsonValueV1(safe, 'document');
      if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) throw new TypeError('document root must be an object');
      if (new TextEncoder().encode(canonicalJson(safe)).length > 1_000_000) throw new TypeError('document byte limit');
    } catch {
      return { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] };
    }
    const found = (safe as { schema?: unknown }).schema;
    if (typeof found === 'string' && found !== schema.$id) return { valid: false, schema: found, diagnostics: [{
      code: 'SCHEMA_UNSUPPORTED', reason: 'schema-id', message: 'This format is not supported.', path: '/schema', encountered: found, supported: [schema.$id] }] };
    if (check(safe)) return { valid: true, schema: schema.$id, diagnostics: [] };
    return { valid: false, schema: schema.$id, diagnostics: (check.errors ?? []).map(error => ({
      code: 'INPUT_INVALID', reason: error.keyword, message: 'The document does not satisfy the published schema.', path: error.instancePath })) };
  };
}

/** Owning validator per produced prepared-work ID. */
export const preparedWorkValidators: Readonly<Record<string, Validator>> = Object.freeze({
  [preparedWork10Schema.$id]: schemaOnly(preparedWork10Schema),
  [preparedWork11Schema.$id]: schemaOnly(preparedWork11Schema),
  'urn:aihq:core:prepared-work:1.2.0': validatePreparedWork12,
  'urn:aihq:core:prepared-work:1.3.0': validatePreparedWork13,
  [preparedWork14Schema.$id]: validatePreparedWork14,
  [preparedWork15Schema.$id]: schemaOnly(preparedWork15Schema)
});
/** Owning validator per produced run-result ID. */
export const runResultValidators: Readonly<Record<string, Validator>> = Object.freeze({
  [runResult10Schema.$id]: schemaOnly(runResult10Schema),
  [runResult11Schema.$id]: schemaOnly(runResult11Schema),
  'urn:aihq:core:run-result:1.2.0': validateRunResult12,
  'urn:aihq:core:run-result:1.3.0': validateRunResult13
});

function dispatch(validators: Readonly<Record<string, Validator>>, value: unknown): ValidationResult {
  try {
    const found = value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.hasOwn(value, 'schema') ? Object.getOwnPropertyDescriptor(value, 'schema') : undefined;
    const schema = found && 'value' in found ? found.value : undefined;
    if (typeof schema !== 'string')
      return { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'schema-id', message: 'Expected a produced result format.', path: '/schema' }] };
    if (!Object.hasOwn(validators, schema)) return { valid: false, schema, diagnostics: [{ code: 'SCHEMA_UNSUPPORTED', reason: 'schema-id',
      message: 'This format is not supported.', path: '/schema', encountered: schema, supported: Object.keys(validators) }] };
    return validators[schema]!(value);
  } catch {
    return { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] };
  }
}
/** Validates one produced review through the validator that owns its exact schema ID. */
export const validateProducedPreparedWork = (value: unknown): ValidationResult => dispatch(preparedWorkValidators, value);
/** Validates one produced run result through the validator that owns its exact schema ID. */
export const validateProducedRunResult = (value: unknown): ValidationResult => dispatch(runResultValidators, value);
