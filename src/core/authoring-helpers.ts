import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import recipeSchema from './schemas/recipe/1.3.0.json' with { type: 'json' };
import { validateRecipe, validatePolicy, validateOrganizationPolicy } from './contracts.js';
import { admitOrganizationSelections, evaluateOrganizationContent, evaluateOrganizationObligations, type AdmissionSelection, type AdmissionLifecycle,
  type OrganizationContentEntryResult } from './internal/organization-admission.js';
import { inputAccepts, inputDefinitionSemantics, isNativeClient, isRepositoryIdentity } from './internal/policy-validation.js';
import { SetMembership } from './internal/organization-content.js';
import { canonicalJson } from './internal/canonical.js';
import { recipeIdentityDescriptor } from './internal/recipe-identity.js';
import { checkedReference, checkedInlineMaterials, MaterialCaptureError } from './internal/material-descriptors.js';
import { sha256 } from './internal/sha256.js';
import { cloneJsonValueStructureV1, assertStrictJsonValueV1, parseStrictJsonObjectV1 } from './internal/strict-json.js';
import type { Diagnostic as CoreDiagnostic, MaterialIdentity, MaterialRecipeReference, Recipe, OrganizationPolicy,
  OrganizationAdvisoryResult, OrganizationFulfillmentResult, OrganizationTarget, OrganizationSetMembers, CatalogItemRef, SelectionMetadata } from './types.js';

/** Owning Core diagnostics retain their complete public shape. */
export type PackageDetails = { owner: 'core'; diagnostics: CoreDiagnostic[] };
export interface AuthoringDiagnostic {
  code: string; path: string; message: string; related?: string[]; reason?: string; details?: PackageDetails;
}
export type AuthoringResult<T> = { status: 'ok'; value: T; diagnostics: [] } |
  { status: 'refused'; diagnostics: AuthoringDiagnostic[] };
export type DeriveRecipeIdentityRequest = { recipe: Recipe; recipeBytes?: never; reference?: never } |
  { recipe?: never; recipeBytes: Uint8Array; reference: MaterialRecipeReference };
export interface RecipeIdentity { recipeIdentity: string; recipeSha256: string; materials: MaterialIdentity[] }
export type OrganizationAdmissionSelection = Omit<AdmissionSelection, 'path'>;
export type OrganizationAdmissionLifecycle = Omit<AdmissionLifecycle, 'path'>;
export interface PreviewOrganizationAdmissionRequest {
  organization: OrganizationPolicy;
  selections: OrganizationAdmissionSelection[];
  lifecycle: OrganizationAdmissionLifecycle[];
  /** Catalog-resolved set membership for organization 1.2.0 set selectors; without it a set selector is `unavailable`. */
  setMembers?: OrganizationSetMembers[];
}
export interface OrganizationAdmissionPreview { admitted: boolean; diagnostics: AuthoringDiagnostic[] }
export interface PreviewOrganizationObligationsRequest extends PreviewOrganizationAdmissionRequest { target: OrganizationTarget }
export interface OrganizationObligationsPreview {
  target: OrganizationTarget;
  enforced: OrganizationAdmissionPreview;
  advisory: OrganizationAdvisoryResult[];
  fulfillment: OrganizationFulfillmentResult[];
}

export type { OrganizationContentEntryResult };
/** Catalog items to compare with an organization's content selectors for one declared target. */
export interface PreviewOrganizationContentRequest {
  organization: OrganizationPolicy;
  target: OrganizationTarget;
  items: (CatalogItemRef & { kind: SelectionMetadata['kind'] })[];
  setMembers?: OrganizationSetMembers[];
}
export interface OrganizationContentItemResult {
  item: CatalogItemRef; kind: SelectionMetadata['kind'];
  /** An applicable 1.2.0 entry requires this item; pass it as `required` to Harness `checkCompatibility`. */
  required: boolean;
  prohibited: boolean;
  entries: OrganizationContentEntryResult[];
}
export interface OrganizationContentPreview { target: OrganizationTarget; items: OrganizationContentItemResult[] }

function refused(reason: string, path: string, diagnostics?: CoreDiagnostic[]): { status: 'refused'; diagnostics: AuthoringDiagnostic[] } {
  return { status: 'refused', diagnostics: [{ code: 'INPUT_INVALID', reason, path,
    message: 'The supplied authoring data cannot be compared safely.',
    ...(diagnostics ? { details: { owner: 'core' as const, diagnostics } } : {}) }] };
}

const validator = new Ajv2020({ allErrors: true, strict: true });
validator.addSchema(recipeSchema);
const id = { $ref: `${recipeSchema.$id}#/$defs/id` };
const scope = { enum: ['project', 'user'] };
const identity = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const catalogId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const previewProperties = {
  organization: { type: 'object' },
  setMembers: { type: 'array' },
  selections: { type: 'array', maxItems: 4096, items: { type: 'object', additionalProperties: false,
    required: ['id', 'organizationSelectionId', 'scope', 'recipeIdentity', 'inputs', 'configuration', 'privateInputs'],
    properties: { id, organizationSelectionId: id, scope, recipeIdentity: identity,
      kind: { enum: ['skill', 'agent', 'command', 'rule', 'hook', 'mcp-server', 'document'] },
      item: { type: 'object', additionalProperties: false, required: ['framework', 'itemId'], properties: { framework: catalogId, itemId: catalogId } },
      inputs: { type: 'object', propertyNames: id, additionalProperties: { $ref: `${recipeSchema.$id}#/$defs/input` } },
      configuration: { type: 'object', propertyNames: id },
      privateInputs: { type: 'array', uniqueItems: true, items: id } } } },
  lifecycle: { type: 'array', maxItems: 4096, items: { type: 'object', additionalProperties: false,
    required: ['action', 'scope', 'recipeIdentity'], properties: {
      action: { enum: ['replace', 'adopt', 'remove'] }, scope, recipeIdentity: identity, organizationSelectionId: id } } }
};
const checkPreview = validator.compile({ type: 'object', additionalProperties: false,
  required: ['organization', 'selections', 'lifecycle'], properties: previewProperties });
const checkObligationsPreview = validator.compile({ type: 'object', additionalProperties: false,
  required: ['organization', 'selections', 'lifecycle', 'target'], properties: { ...previewProperties,
    target: { type: 'object', additionalProperties: false, required: ['scope'], properties: {
      scope, client: { type: 'string', maxLength: 128 }, repository: { type: 'string', maxLength: 512 } } } } });
const checkContentPreview = validator.compile({ type: 'object', additionalProperties: false,
  required: ['organization', 'target', 'items'], properties: { organization: previewProperties.organization, setMembers: previewProperties.setMembers,
    target: { type: 'object', additionalProperties: false, required: ['scope'], properties: {
      scope, client: { type: 'string', maxLength: 128 }, repository: { type: 'string', maxLength: 512 } } },
    items: { type: 'array', maxItems: 4096, items: { type: 'object', additionalProperties: false, required: ['framework', 'itemId', 'kind'],
      properties: { framework: catalogId, itemId: catalogId, kind: previewProperties.selections.items.properties.kind } } } } });

/** Shared request validation; admission is the only comparison and always runs on a validated copy. */
function checkedPreview<T extends PreviewOrganizationAdmissionRequest>(request: unknown, check: ValidateFunction):
    { safe: T; membership: SetMembership } | { refusal: ReturnType<typeof refused> } {
  let safe: T;
  try {
    const descriptor = request && typeof request === 'object' ? Object.getOwnPropertyDescriptor(request, 'organization') : undefined;
    if (descriptor && 'value' in descriptor) {
      const checked = validateOrganizationPolicy(descriptor.value);
      if (!checked.valid) return { refusal: refused('organization-input-spec', '/organization', checked.diagnostics) };
    }
    safe = checkedJson(request) as T;
  }
  catch { return { refusal: refused('input-value', '') }; }
  if (!check(safe)) return { refusal: refused('input-value', check.errors?.[0]?.instancePath ?? '',
    (check.errors ?? []).map(e => ({ code: 'INPUT_INVALID', reason: e.keyword, path: e.instancePath,
      message: 'The preview request does not satisfy its contract.' }))) };
  const organization = validateOrganizationPolicy(safe.organization, safe.setMembers === undefined ? {} : { setMembers: safe.setMembers });
  if (!organization.valid) return { refusal: organization.diagnostics.some(item => item.reason === 'set-members') ?
    refused('input-value', '/setMembers', organization.diagnostics) : refused('organization-input-spec', '/organization', organization.diagnostics) };
  const membership = new SetMembership(safe.setMembers);
  const seen = new Set<string>();
  for (const [index, selection] of safe.selections.entries()) {
    const path = `/selections/${index}`;
    if (seen.has(selection.id)) return { refusal: refused('input-value', `${path}/id`) };
    seen.add(selection.id);
    const definitions = inputDefinitionSemantics(selection.inputs);
    if (definitions.length) return { refusal: refused('input-value', `${path}/inputs`, definitions) };
    for (const [name, value] of Object.entries(selection.configuration)) {
      const spec = selection.inputs[name];
      if (!Object.hasOwn(selection.inputs, name) || spec!.sensitive || !inputAccepts(spec!, value))
        return { refusal: refused('input-value', `${path}/configuration/${name}`) };
    }
    for (const [name, spec] of Object.entries(selection.inputs)) {
      if (spec.required && !spec.sensitive && !Object.hasOwn(selection.configuration, name) && spec.default === undefined)
        return { refusal: refused('input-value', `${path}/configuration/${name}`) };
      if (spec.required && spec.sensitive && !selection.privateInputs.includes(name))
        return { refusal: refused('input-value', `${path}/privateInputs`) };
    }
    if (selection.privateInputs.some(name => !Object.hasOwn(selection.inputs, name) || !selection.inputs[name]!.sensitive))
      return { refusal: refused('input-value', `${path}/privateInputs`) };
  }
  return { safe, membership };
}

const admissionInputs = (safe: PreviewOrganizationAdmissionRequest): { selections: AdmissionSelection[]; lifecycle: AdmissionLifecycle[] } => ({
  selections: safe.selections.map((selection, index) => ({ ...selection, path: `/selections/${index}` })),
  lifecycle: safe.lifecycle.map((item, index) => ({ ...item, path: `/lifecycle/${index}` }))
});
const toAdmissionPreview = (diagnostics: { code: string; reason?: string; path?: string; message: string }[]): OrganizationAdmissionPreview => {
  const mapped = diagnostics.map(d => ({ code: d.code, reason: d.reason, path: d.path ?? '', message: d.message }));
  return { admitted: mapped.length === 0, diagnostics: mapped };
};

/** Advisory comparison only. Prepare and Apply independently acquire current authority. */
export function previewOrganizationAdmission(request: PreviewOrganizationAdmissionRequest): AuthoringResult<OrganizationAdmissionPreview> {
  const checked = checkedPreview<PreviewOrganizationAdmissionRequest>(request, checkPreview);
  if ('refusal' in checked) return checked.refusal;
  const { safe, membership } = checked;
  const { selections, lifecycle } = admissionInputs(safe);
  return { status: 'ok', value: toAdmissionPreview(admitOrganizationSelections(safe.organization, selections, lifecycle, {}, membership)), diagnostics: [] };
}

/**
 * Advisory enforced admission for a declared target plus pure recommendation and requirement results.
 * Facts the caller does not declare stay unknown and are never inferred from a checkout or remote.
 */
export function previewOrganizationObligations(request: PreviewOrganizationObligationsRequest): AuthoringResult<OrganizationObligationsPreview> {
  const checked = checkedPreview<PreviewOrganizationObligationsRequest>(request, checkObligationsPreview);
  if ('refusal' in checked) return checked.refusal;
  const { safe, membership } = checked;
  const { target } = safe;
  if (target.client !== undefined && !isNativeClient(target.client)) return refused('input-value', '/target/client');
  if (target.repository !== undefined && !isRepositoryIdentity(target.repository)) return refused('input-value', '/target/repository');
  const { selections, lifecycle } = admissionInputs(safe);
  const facts = { ...(target.client === undefined ? {} : { client: target.client }),
    ...(target.repository === undefined ? {} : { repository: target.repository }) };
  const findings = admitOrganizationSelections(safe.organization, selections, lifecycle, facts, membership);
  return { status: 'ok', value: { target, enforced: toAdmissionPreview(findings),
    ...evaluateOrganizationObligations(safe.organization, selections, findings, target, membership) }, diagnostics: [] };
}
function checkedJson(value: unknown): unknown {
  const copy = cloneJsonValueStructureV1(value, 'authoring request', 32);
  assertStrictJsonValueV1(copy, 'authoring request');
  if (new TextEncoder().encode(canonicalJson(copy)).length > 1_000_000) throw new Error('document byte limit');
  return copy;
}
function exact(value: unknown, keys: string[]): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true);
}
const digestJson = (value: unknown) => sha256(new TextEncoder().encode(canonicalJson(value)));

/** Pure asynchronous Web Crypto hashing; never acquires recipe or material bytes. */
export async function deriveRecipeIdentity(request: DeriveRecipeIdentityRequest): Promise<AuthoringResult<RecipeIdentity>> {
  let recipe: Recipe, recipeSha256: string;
  try {
    // Inspect own descriptors before accessing the explicitly non-JSON byte member.
    if (!request || typeof request !== 'object' || Object.getPrototypeOf(request) !== Object.prototype ||
        Object.getOwnPropertySymbols(request).length || Object.values(Object.getOwnPropertyDescriptors(request)).some(d => !('value' in d)))
      return refused('recipe-invalid', '');
    if (exact(request, ['recipe'])) {
      const checked = validateRecipe(request.recipe);
      if (!checked.valid) return refused(checked.diagnostics.some(d => d.code === 'SCHEMA_UNSUPPORTED') ? 'unsupported-schema' : 'recipe-invalid', '/recipe', checked.diagnostics);
      recipe = checkedJson(request.recipe) as Recipe;
      if (recipe.materials.some(item => !('source' in item))) return refused('material-closure', '/recipe/materials');
      try { checkedInlineMaterials(recipe.materials); }
      catch (error) { return refused('recipe-invalid', '/recipe/materials', [{ code: 'INPUT_INVALID',
        reason: error instanceof MaterialCaptureError ? error.reason : 'invalid-inline-materials', path: '/materials',
        message: 'The materials do not satisfy declaration bounds.' }]); }
      recipeSha256 = await digestJson(recipe);
    } else if (exact(request, ['recipeBytes', 'reference'])) {
      if (!(request.recipeBytes instanceof Uint8Array) || request.recipeBytes.byteLength > 1_000_000)
        return refused('recipe-bytes-mismatch', '/recipeBytes');
      const bytes = new Uint8Array(request.recipeBytes);
      const checked = validatePolicy({ schema: 'urn:aihq:core:execution-policy:1.3.0', mode: 'vibe', selections: [{
        id: 'identity', managementId: 'identity', scope: 'project', configuration: {}, requires: [], recipe: { reference: request.reference }
      }] });
      if (!checked.valid) return refused('recipe-invalid', '/reference', checked.diagnostics);
      const reference = checkedJson(request.reference) as MaterialRecipeReference;
      try { checkedReference(reference); }
      catch (error) { return refused('recipe-invalid', '/reference', [{ code: 'INPUT_INVALID',
        reason: error instanceof MaterialCaptureError ? error.reason : 'invalid-reference', path: '/reference',
        message: 'The reference does not satisfy material declaration bounds.' }]); }
      recipeSha256 = await sha256(bytes);
      if (bytes.byteLength !== reference.byteLength || recipeSha256 !== reference.sha256)
        return refused('recipe-bytes-mismatch', '/recipeBytes');
      try { recipe = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'recipe') as unknown as Recipe; }
      catch { return refused('recipe-invalid', '/recipeBytes'); }
      const valid = validateRecipe(recipe);
      if (!valid.valid) return refused(valid.diagnostics.some(d => d.code === 'SCHEMA_UNSUPPORTED') ? 'unsupported-schema' : 'recipe-invalid', '/recipeBytes', valid.diagnostics);
      if (recipe.materials.some(m => Object.keys(m).some(k => !['id', 'sha256', 'byteLength'].includes(k))) ||
          canonicalJson(recipeIdentityDescriptor(recipeSha256, recipe.materials).materials) !==
          canonicalJson(recipeIdentityDescriptor(recipeSha256, reference.materials).materials))
        return refused('material-closure', '/reference/materials');
    } else return refused('recipe-invalid', '');
    const descriptor = recipeIdentityDescriptor(recipeSha256, recipe.materials);
    return { status: 'ok', value: { recipeIdentity: `sha256:${await digestJson(descriptor)}`,
      recipeSha256, materials: descriptor.materials }, diagnostics: [] };
  } catch { return refused('recipe-invalid', ''); }
}

/**
 * Advisory, per Catalog item: the organization 1.2.0 content entries that may govern it for a declared target. It
 * observes nothing and grants nothing; Prepare and Apply still admit exact recipes against current authority.
 */
export function previewOrganizationContent(request: PreviewOrganizationContentRequest): AuthoringResult<OrganizationContentPreview> {
  let safe: PreviewOrganizationContentRequest;
  try { safe = checkedJson(request) as PreviewOrganizationContentRequest; } catch { return refused('input-value', ''); }
  if (!checkContentPreview(safe)) return refused('input-value', checkContentPreview.errors?.[0]?.instancePath ?? '');
  const organization = validateOrganizationPolicy(safe.organization, safe.setMembers === undefined ? {} : { setMembers: safe.setMembers });
  if (!organization.valid) return organization.diagnostics.some(item => item.reason === 'set-members') ?
    refused('input-value', '/setMembers', organization.diagnostics) : refused('organization-input-spec', '/organization', organization.diagnostics);
  const { target } = safe;
  if (target.client !== undefined && !isNativeClient(target.client)) return refused('input-value', '/target/client');
  if (target.repository !== undefined && !isRepositoryIdentity(target.repository)) return refused('input-value', '/target/repository');
  const membership = new SetMembership(safe.setMembers);
  return { status: 'ok', value: { target, items: safe.items.map(({ framework, itemId, kind }) => ({ item: { framework, itemId }, kind,
    ...evaluateOrganizationContent(safe.organization, { kind, item: { framework, itemId } }, target, membership) })) }, diagnostics: [] };
}
