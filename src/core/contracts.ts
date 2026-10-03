import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { distribution } from '../distribution.mjs';
import policySchema from './schemas/execution-policy/1.0.0.json' with { type: 'json' };
import recipeSchema from './schemas/recipe/1.0.0.json' with { type: 'json' };
import preparedSchema from './schemas/prepared-work/1.0.0.json' with { type: 'json' };
import resultSchema from './schemas/run-result/1.0.0.json' with { type: 'json' };
import policySchema11 from './schemas/execution-policy/1.1.0.json' with { type: 'json' };
import recipeSchema11 from './schemas/recipe/1.1.0.json' with { type: 'json' };
import preparedSchema11 from './schemas/prepared-work/1.1.0.json' with { type: 'json' };
import resultSchema11 from './schemas/run-result/1.1.0.json' with { type: 'json' };
import organizationSchema from './schemas/organization-policy/1.0.0.json' with { type: 'json' };
import fileStateSchema from './schemas/file-state-result/1.0.0.json' with { type: 'json' };
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { canonicalJson } from './internal/canonical.js';
import type { Diagnostic, ExecutionPolicy, OrganizationParseResult, OrganizationPolicy, ParseResult, ValidationResult } from './types.js';
import { organizationSemantics, policySemantics, recipeSemantics } from './internal/policy-validation.js';
export type * from './types.js';
export type * from './file-state-types.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
validator.addSchema(recipeSchema);
validator.addSchema(recipeSchema11);
const checkPolicy = validator.compile(policySchema);
const checkPolicy11 = validator.compile(policySchema11);
const checkRecipe = validator.getSchema(recipeSchema.$id)! as ValidateFunction;
const checkRecipe11 = validator.getSchema(recipeSchema11.$id)! as ValidateFunction;
const checkOrganization = validator.compile(organizationSchema);
const schemaVersion = (id: string): string => id.split(':')[4]!;
export const contractSupport = Object.freeze({
  schema: 'urn:aihq:package-support:1.0.0',
  package: distribution,
  contracts: [policySchema, recipeSchema, preparedSchema, resultSchema, organizationSchema,
    policySchema11, recipeSchema11, preparedSchema11, resultSchema11, fileStateSchema].map(schema => ({
    id: schema.$id, role: [preparedSchema, resultSchema, fileStateSchema, preparedSchema11, resultSchema11].includes(schema as never) ? 'produces' : 'accepts',
    schemaExport: `@aihq/core/schemas/${schema.$id.split(':')[3]}/${schemaVersion(schema.$id)}.json`
  })),
  entries: [
    { export: '@aihq/core/contracts', runtime: 'portable' },
    { export: '@aihq/core/support', runtime: 'portable' },
    { export: '@aihq/core/harness', runtime: 'portable' },
    { export: '@aihq/core/harness/runtime', runtime: 'node', nodeRange: '>=24.15.0 <25' },
    { export: '@aihq/core', runtime: 'node', nodeRange: '>=24.15.0 <25' }
  ]
});

type Accepted = Record<string, ValidateFunction>;
function validate(value: unknown, accepted: Accepted, semantics: (document: never) => Diagnostic[]): ValidationResult {
  try {
    const safe = cloneJsonValueStructureV1(value, 'document', 32);
    assertStrictJsonValueV1(safe, 'document');
    if (new TextEncoder().encode(canonicalJson(safe)).length > 1_000_000) throw new Error('document byte limit');
    const found = safe && typeof safe === 'object' ? (safe as { schema?: unknown }).schema : undefined;
    if (typeof found === 'string' && !Object.hasOwn(accepted, found)) return {
      valid: false, schema: found, diagnostics: [{ code: 'SCHEMA_UNSUPPORTED', reason: 'schema-id',
        message: 'This format is not supported.', path: '/schema', encountered: found, supported: Object.keys(accepted) }]
    };
    // A 1.0.0 policy cannot carry a 1.1.0 recipe, even when that recipe's own schema is valid.
    const selections = found === policySchema.$id && safe && typeof safe === 'object' ?
      (safe as { selections?: unknown }).selections : undefined;
    if (Array.isArray(selections)) for (const [index, selection] of selections.entries()) {
      const inline = (selection as { recipe?: { inline?: { schema?: unknown } } } | null)?.recipe?.inline;
      if (inline?.schema === recipeSchema11.$id) return { valid: false, schema: policySchema.$id, diagnostics: [{ code: 'SCHEMA_UNSUPPORTED',
        reason: 'recipe-schema', message: 'This policy version does not support that recipe format.',
        path: `/selections/${index}/recipe/inline/schema`, encountered: recipeSchema11.$id, supported: [recipeSchema.$id] }] };
    }
    const check = typeof found === 'string' ? accepted[found]! : Object.values(accepted)[0]!;
    const schema = typeof found === 'string' ? found : Object.keys(accepted)[0]!;
    const valid = check(safe);
    if (valid) {
      const diagnostics = semantics(safe as never);
      return { valid: diagnostics.length === 0, schema, diagnostics };
    }
    return { valid, ...(typeof found === 'string' ? { schema: found } : {}), diagnostics: valid ? [] :
      (check.errors ?? []).map(error => ({ code: 'INPUT_INVALID', reason: error.keyword,
        message: 'The document does not satisfy the published schema.', path: error.instancePath })) };
  } catch {
    return { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] };
  }
}
export const validatePolicy = (value: unknown): ValidationResult =>
  validate(value, { [policySchema.$id]: checkPolicy, [policySchema11.$id]: checkPolicy11 }, policySemantics as never);
export const validateRecipe = (value: unknown): ValidationResult =>
  validate(value, { [recipeSchema.$id]: checkRecipe, [recipeSchema11.$id]: checkRecipe11 }, recipeSemantics as never);
export const validateOrganizationPolicy = (value: unknown): ValidationResult =>
  validate(value, { [organizationSchema.$id]: checkOrganization }, organizationSemantics as never);
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
