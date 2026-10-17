// Shared admission for Core's portable contract validators.
//
// Importing this module performs no host access and compiles nothing. Every
// contract schema Core owns is registered in one Ajv instance, which is created
// and populated on the first validation; each schema is compiled on its own first
// use and cached. Documents are read once through the strict-JSON rules, refused
// on an unaccepted schema ID without fallback, then checked against the schema.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, STRICT_JSON_MAX_DEPTH_V1 } from './strict-json.js';
import { canonicalJson } from './canonical.js';
import { recipeFormatsForPolicy } from './recipe-formats.js';
import type { Diagnostic, ValidationResult } from '../types.js';

type Data = Record<string, unknown>;
interface SchemaDocument { $id: string }
/** A schema check compiled on its first call. */
export type LazyCheck = () => ValidateFunction;

let registry: Ajv2020 | undefined;
const registered = new Map<string, SchemaDocument>();
const pending: SchemaDocument[] = [];
function instance(): Ajv2020 {
  if (!registry) {
    registry = new Ajv2020({ allErrors: true, strict: true });
    for (const schema of pending.splice(0)) registry.addSchema(schema);
  }
  return registry;
}
/** Registers schemas by `$id` without compiling them; registering the same document again is a no-op. */
export function registerSchemas(...schemas: readonly SchemaDocument[]): void {
  for (const schema of schemas) {
    const existing = registered.get(schema.$id);
    if (existing === schema) continue;
    if (existing) throw new Error(`conflicting schema registration: ${schema.$id}`);
    registered.set(schema.$id, schema);
    if (registry) registry.addSchema(schema); else pending.push(schema);
  }
}
function once(make: () => ValidateFunction): LazyCheck {
  let compiled: ValidateFunction | undefined;
  return () => compiled ??= make();
}
/** The registered schema with this `$id`, compiled on first use. */
export const schemaCheck = (id: string): LazyCheck => once(() => {
  const check = instance().getSchema(id);
  if (!check) throw new Error(`unregistered schema: ${id}`);
  return check as ValidateFunction;
});
/** A registered schema fragment (`<id>#/<pointer>`), compiled on first use. */
export const fragmentCheck = (ref: string): LazyCheck => once(() => instance().compile({ $ref: ref }));

const strictJsonInvalid = (): ValidationResult =>
  ({ valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] });
/** Bounded strict JSON read once; `maxBytes` undefined leaves size to the producer's own output limits. */
function admit(value: unknown, maxBytes: number | undefined, requireObject: boolean): unknown {
  const safe = cloneJsonValueStructureV1(value, 'document', STRICT_JSON_MAX_DEPTH_V1, maxBytes ?? Infinity);
  assertStrictJsonValueV1(safe, 'document');
  if (requireObject && (safe === null || typeof safe !== 'object' || Array.isArray(safe))) throw new TypeError('document root must be an object');
  if (maxBytes !== undefined && new TextEncoder().encode(canonicalJson(safe)).length > maxBytes) throw new TypeError('document byte limit');
  return safe;
}
const schemaErrors = (check: ValidateFunction, reason: (keyword: string) => string): Diagnostic[] =>
  (check.errors ?? []).map(error => ({ code: 'INPUT_INVALID', reason: reason(error.keyword),
    message: 'The document does not satisfy the published schema.', path: error.instancePath }));

/**
 * Accepted-format validation (policies, recipes, organization documents and
 * targets): one of several accepted IDs, a missing ID checked against the first,
 * a 1,000,000-byte cap, the schema before semantics. An unaccepted ID reports
 * reason `schema-id` with every supported ID.
 */
export function validateAcceptedDocument(value: unknown, accepted: Readonly<Record<string, LazyCheck>>,
  semantics: (document: never) => Diagnostic[]): ValidationResult {
  try {
    const safe = admit(value, 1_000_000, false);
    const found = safe && typeof safe === 'object' ? (safe as { schema?: unknown }).schema : undefined;
    if (typeof found === 'string' && !Object.hasOwn(accepted, found)) return {
      valid: false, schema: found, diagnostics: [{ code: 'SCHEMA_UNSUPPORTED', reason: 'schema-id',
        message: 'This format is not supported.', path: '/schema', encountered: found, supported: Object.keys(accepted) }]
    };
    const supportedRecipes = recipeFormatsForPolicy(found);
    const selections = supportedRecipes.length && safe && typeof safe === 'object' ?
      (safe as { selections?: unknown }).selections : undefined;
    if (Array.isArray(selections)) for (const [index, selection] of selections.entries()) {
      const inline = (selection as { recipe?: { inline?: { schema?: unknown } } } | null)?.recipe?.inline;
      if (typeof inline?.schema === 'string' && !supportedRecipes.includes(inline.schema)) return { valid: false, schema: found as string, diagnostics: [{ code: 'SCHEMA_UNSUPPORTED',
        reason: 'recipe-schema', message: 'This policy version does not support that recipe format.',
        path: `/selections/${index}/recipe/inline/schema`, encountered: inline.schema, supported: supportedRecipes }] };
    }
    const check = (typeof found === 'string' ? accepted[found]! : Object.values(accepted)[0]!)();
    const schema = typeof found === 'string' ? found : Object.keys(accepted)[0]!;
    if (check(safe)) {
      const diagnostics = semantics(safe as never);
      return { valid: diagnostics.length === 0, schema, diagnostics };
    }
    return { valid: false, ...(typeof found === 'string' ? { schema: found } : {}), diagnostics: schemaErrors(check, keyword => keyword) };
  } catch {
    return strictJsonInvalid();
  }
}

/**
 * Exact-format validation (produced reviews and results, trust, macOS session and
 * custody documents): an object root, exactly one ID, the caller's byte policy,
 * semantics before the schema. A different ID reports reason `schema-unsupported`
 * and an undeclared field reason `unknown-field`.
 */
export function validateExactDocument(value: unknown, expected: string, check: LazyCheck,
  semantics: (document: Data) => Diagnostic[], maxBytes?: number): ValidationResult {
  let safe: Data;
  try { safe = admit(value, maxBytes, true) as Data; } catch { return strictJsonInvalid(); }
  const found = safe.schema;
  if (typeof found === 'string' && found !== expected) return {
    valid: false, schema: found, diagnostics: [{
      code: 'SCHEMA_UNSUPPORTED', reason: 'schema-unsupported', message: 'This format is not supported.',
      path: '/schema', encountered: found, supported: [expected]
    }]
  };
  const semantic = semantics(safe);
  if (semantic.length > 0) return { valid: false, schema: expected, diagnostics: semantic };
  const compiled = check();
  if (compiled(safe)) return { valid: true, schema: expected, diagnostics: [] };
  return { valid: false, schema: expected, diagnostics: schemaErrors(compiled, keyword => keyword === 'additionalProperties' ? 'unknown-field' : keyword) };
}
