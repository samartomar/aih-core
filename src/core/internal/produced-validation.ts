// Exact-ID dispatch to the validator that owns each prepared-work and run-result
// family Core produces. Importing this module performs no host access and
// compiles nothing. Trust and macOS session families use their owning validators
// unchanged. The policy families, whose owner publishes only a schema, bind the
// shared exact-format admission to that schema with the same produced-fact size
// policy as the trust families. An unknown or future ID is refused, never mapped
// onto a nearby version.
import preparedWork10Schema from '../schemas/prepared-work/1.0.0.json' with { type: 'json' };
import preparedWork11Schema from '../schemas/prepared-work/1.1.0.json' with { type: 'json' };
import preparedWork14Schema from '../schemas/prepared-work/1.4.0.json' with { type: 'json' };
import preparedWork15Schema from '../schemas/prepared-work/1.5.0.json' with { type: 'json' };
import preparedWork16Schema from '../schemas/prepared-work/1.6.0.json' with { type: 'json' };
import runResult14Schema from '../schemas/run-result/1.4.0.json' with { type: 'json' };
import preparedWork17Schema from '../schemas/prepared-work/1.7.0.json' with { type: 'json' };
import runResult15Schema from '../schemas/run-result/1.5.0.json' with { type: 'json' };
import runResult10Schema from '../schemas/run-result/1.0.0.json' with { type: 'json' };
import runResult11Schema from '../schemas/run-result/1.1.0.json' with { type: 'json' };
import { PREPARED_WORK_1_2_0, RUN_RESULT_1_2_0, validatePreparedWork12, validatePreparedWork14, validateRunResult12 } from '../trust-contracts.js';
import { MACOS_PREPARED_WORK_SCHEMA, MACOS_RUN_RESULT_SCHEMA, validatePreparedWork13, validateRunResult13 } from '../macos-session-contracts.js';
import { registerSchemas, schemaCheck, validateExactDocument } from './contract-validation.js';
import type { ValidationResult } from '../types.js';

type Validator = (value: unknown) => ValidationResult;
// prepared-work 1.5.0, 1.6.0 and 1.7.0 resolve the 1.4.0 policy definitions in the shared registry.
registerSchemas(preparedWork10Schema, preparedWork11Schema, preparedWork14Schema, preparedWork15Schema, preparedWork16Schema, preparedWork17Schema, runResult10Schema, runResult11Schema, runResult14Schema, runResult15Schema);
const schemaOnly = (id: string): Validator => {
  const check = schemaCheck(id);
  return value => validateExactDocument(value, id, check, () => []);
};

/** Owning validator per produced prepared-work ID. */
export const preparedWorkValidators: Readonly<Record<string, Validator>> = Object.freeze({
  [preparedWork10Schema.$id]: schemaOnly(preparedWork10Schema.$id),
  [preparedWork11Schema.$id]: schemaOnly(preparedWork11Schema.$id),
  [PREPARED_WORK_1_2_0]: validatePreparedWork12,
  [MACOS_PREPARED_WORK_SCHEMA]: validatePreparedWork13,
  [preparedWork14Schema.$id]: validatePreparedWork14,
  [preparedWork15Schema.$id]: schemaOnly(preparedWork15Schema.$id),
  [preparedWork16Schema.$id]: schemaOnly(preparedWork16Schema.$id),
  [preparedWork17Schema.$id]: schemaOnly(preparedWork17Schema.$id)
});
/** Owning validator per produced run-result ID. */
export const runResultValidators: Readonly<Record<string, Validator>> = Object.freeze({
  [runResult10Schema.$id]: schemaOnly(runResult10Schema.$id),
  [runResult11Schema.$id]: schemaOnly(runResult11Schema.$id),
  [RUN_RESULT_1_2_0]: validateRunResult12,
  [MACOS_RUN_RESULT_SCHEMA]: validateRunResult13,
  [runResult14Schema.$id]: schemaOnly(runResult14Schema.$id),
  [runResult15Schema.$id]: schemaOnly(runResult15Schema.$id)
});

function dispatch(validators: Readonly<Record<string, Validator>>, value: unknown): ValidationResult {
  // Read as a data property only, so a getter is never invoked before strict admission.
  const descriptor = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, 'schema') : undefined;
  const schema = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof schema !== 'string')
    return { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'schema-id', message: 'Expected a produced result format.', path: '/schema' }] };
  if (!Object.hasOwn(validators, schema)) return { valid: false, schema, diagnostics: [{ code: 'SCHEMA_UNSUPPORTED', reason: 'schema-unsupported',
    message: 'This format is not supported.', path: '/schema', encountered: schema, supported: Object.keys(validators) }] };
  return validators[schema]!(value);
}
/** Validates one produced review through the validator that owns its exact schema ID. */
export const validateProducedPreparedWork = (value: unknown): ValidationResult => dispatch(preparedWorkValidators, value);
/** Validates one produced run result through the validator that owns its exact schema ID. */
export const validateProducedRunResult = (value: unknown): ValidationResult => dispatch(runResultValidators, value);
