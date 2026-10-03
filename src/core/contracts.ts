import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { distribution } from '../distribution.mjs';
import policySchema from './schemas/execution-policy/1.0.0.json' with { type: 'json' };
import recipeSchema from './schemas/recipe/1.0.0.json' with { type: 'json' };
import preparedSchema from './schemas/prepared-work/1.0.0.json' with { type: 'json' };
import resultSchema from './schemas/run-result/1.0.0.json' with { type: 'json' };
import organizationSchema from './schemas/organization-policy/1.0.0.json' with { type: 'json' };
import fileStateSchema from './schemas/file-state-result/1.0.0.json' with { type: 'json' };
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { canonicalJson } from './internal/canonical.js';
import type { ExecutionPolicy, OrganizationParseResult, OrganizationPolicy, ParseResult, Recipe, ValidationResult } from './types.js';
import { organizationSemantics, policySemantics, recipeSemantics } from './internal/policy-validation.js';
export type * from './types.js';
export type * from './file-state-types.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
validator.addSchema(recipeSchema);
const checkPolicy = validator.compile(policySchema);
const checkRecipe = validator.getSchema(recipeSchema.$id)! as ValidateFunction;
const checkOrganization = validator.compile(organizationSchema);
export const contractSupport = Object.freeze({
  schema: 'urn:aihq:package-support:1.0.0',
  package: distribution,
  contracts: [policySchema, recipeSchema, preparedSchema, resultSchema, organizationSchema, fileStateSchema].map(schema => ({
    id: schema.$id, role: schema === preparedSchema || schema === resultSchema || schema === fileStateSchema ? 'produces' : 'accepts',
    schemaExport: `@aihq/core/schemas/${schema.$id.split(':')[3]}/1.0.0.json`
  })),
  entries: [
    { export: '@aihq/core/contracts', runtime: 'portable' },
    { export: '@aihq/core/support', runtime: 'portable' },
    { export: '@aihq/core/harness', runtime: 'portable' },
    { export: '@aihq/core/harness/runtime', runtime: 'node', nodeRange: '>=24.15.0 <25' },
    { export: '@aihq/core', runtime: 'node', nodeRange: '>=24.15.0 <25' }
  ]
});

function validate(value: unknown, schema: string, check: ValidateFunction): ValidationResult {
  try {
    const safe = cloneJsonValueStructureV1(value, 'document', 32);
    assertStrictJsonValueV1(safe, 'document');
    if (new TextEncoder().encode(canonicalJson(safe)).length > 1_000_000) throw new Error('document byte limit');
    const found = safe && typeof safe === 'object' ? (safe as { schema?: unknown }).schema : undefined;
    if (typeof found === 'string' && found !== schema) return {
      valid: false, schema: found, diagnostics: [{ code: 'SCHEMA_UNSUPPORTED', reason: 'schema-id',
        message: 'This format is not supported.', path: '/schema', encountered: found, supported: [schema] }]
    };
    const valid = check(safe);
    if (valid) {
      const diagnostics = schema === policySchema.$id ? policySemantics(safe as ExecutionPolicy)
        : schema === organizationSchema.$id ? organizationSemantics(safe as OrganizationPolicy)
        : recipeSemantics(safe as Recipe);
      return { valid: diagnostics.length === 0, schema, diagnostics };
    }
    return { valid, ...(typeof found === 'string' ? { schema: found } : {}), diagnostics: valid ? [] :
      (check.errors ?? []).map(error => ({ code: 'INPUT_INVALID', reason: error.keyword,
        message: 'The document does not satisfy the published schema.', path: error.instancePath })) };
  } catch {
    return { valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] };
  }
}
export const validatePolicy = (value: unknown): ValidationResult => validate(value, policySchema.$id, checkPolicy);
export const validateRecipe = (value: unknown): ValidationResult => validate(value, recipeSchema.$id, checkRecipe);
export const validateOrganizationPolicy = (value: unknown): ValidationResult =>
  validate(value, organizationSchema.$id, checkOrganization);
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
