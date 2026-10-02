// Portable Enterprise administrator authoring: review a Scan report, author an
// organization policy, and derive an execution policy that stays inside it.
// Browser-safe imports only; digests use WebCrypto. This is example content, not
// an admin product: the administrator publishes the organization document to the
// selected GitHub source, and Core re-admits every selection at Prepare and Apply.
import { parsePolicy, validateOrganizationPolicy } from '@aihq/core/contracts';
import { checkConfiguration, getItem } from '@aihq/catalog/reader';
import { authorPolicy } from './authoring.js';
import { presentReport, readScanBytes } from './report-view.js';

const ORGANIZATION_SCHEMA = 'urn:aihq:core:organization-policy:1.0.0';
const RECIPE_IDENTITY_SCHEMA = 'urn:aihq:core:recipe-identity:1.0.0';

// Core's canonical JSON: keys sorted by UTF-16 code unit, no whitespace. Like Core,
// it throws on values with no canonical form instead of normalizing them.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('canonical JSON numbers must be finite and not negative zero');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const prototype = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (typeof value !== 'object' || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// The identity Core derives for a captured recipe: the recipe's own sha256 plus
// its materials' id/sha256/byteLength, sorted by id. For a catalog item these are
// the release's pinned values, so no material bytes are needed to compute it.
export async function recipeIdentity({ recipeSha256, materials }) {
  const pinned = materials.map(({ id, sha256, byteLength }) => ({ id, sha256, byteLength }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return `sha256:${await digest({ schema: RECIPE_IDENTITY_SCHEMA, recipeSha256, materials: pinned })}`;
}

const problem = (code, reason, message, path) =>
  ({ code, reason, message, blocking: true, ...(path !== undefined ? { path } : {}) });

// Reading a report is not authenticating it. The result is presentation data
// whose authenticity is always 'unchecked'; Core's producer authentication runs
// at Prepare/Apply for evidence the derived policy associates.
export async function reviewReport(artifactBytes) {
  const view = presentReport(await readScanBytes(artifactBytes));
  return { ...view, authenticity: 'unchecked' };
}

// Core rejects (organization-input-spec) a fixed value or choice the recipe input would
// not accept, and permits a sensitive input only with allowDeclared. Mirror both so the
// administrator learns at authoring time; values go through the Catalog reader's own
// input check. Core re-checks everything when it reads the published document.
function permissionProblems(item, name, permission, path) {
  const spec = item.inputs[name];
  const invalid = message => [problem('INPUT_INVALID', 'organization-input-spec', message, path)];
  if (spec.sensitive === true) {
    return Object.hasOwn(permission, 'allowDeclared') ? [] : invalid('A sensitive input may only be permitted with allowDeclared.');
  }
  const values = Object.hasOwn(permission, 'fixed') ? [permission.fixed]
    : Array.isArray(permission.choices) ? permission.choices : [];
  for (const value of values) {
    const found = [];
    checkConfiguration(item, { [name]: value }, found, { path: '' });
    if (found.some(entry => entry.path === `/${name}`)) {
      return invalid('The organization entry permits a value incompatible with the recipe input definition.');
    }
  }
  return [];
}

// permitted: [{ selectionId, itemId, scopes, inputs: {name: {fixed}|{choices}|{allowDeclared:true}}, lifecycle? }]
// Evidence is deliberately absent: it lives on the derived execution policy.
export async function authorOrganizationPolicy({ release, id, permitted }) {
  const diagnostics = [];
  const selections = [];
  for (const [index, entry] of permitted.entries()) {
    const path = `/selections/${index}`;
    const found = getItem(release, entry.itemId);
    if (!found.found) { diagnostics.push(...found.diagnostics); continue; }
    const { item } = found;
    for (const scope of entry.scopes ?? []) {
      if (!item.scopes.includes(scope)) {
        diagnostics.push(problem('INPUT_INVALID', 'scope-not-offered', `${entry.itemId} does not offer scope ${scope}.`, `${path}/scopes`));
      }
    }
    for (const name of Object.keys(entry.inputs ?? {})) {
      if (!Object.hasOwn(item.inputs, name)) {
        diagnostics.push(problem('INPUT_INVALID', 'input-undeclared', `${entry.itemId} declares no input ${name}.`, `${path}/inputs/${name}`));
      }
    }
    for (const [name, permission] of Object.entries(entry.inputs ?? {})) {
      if (Object.hasOwn(item.inputs, name)) diagnostics.push(...permissionProblems(item, name, permission, `${path}/inputs/${name}`));
    }
    selections.push({
      selectionId: entry.selectionId,
      recipeIdentity: await recipeIdentity({ recipeSha256: item.recipe.sha256, materials: item.materials }),
      scopes: [...(entry.scopes ?? [])],
      inputs: structuredClone(entry.inputs ?? {}),
      ...(entry.lifecycle !== undefined ? { lifecycle: { ...entry.lifecycle } } : {})
    });
  }
  const document = { schema: ORGANIZATION_SCHEMA, id, selections };
  const result = validateOrganizationPolicy(document);
  diagnostics.push(...result.diagnostics);
  return { valid: result.valid && !diagnostics.some(entry => entry.blocking), document, diagnostics };
}

// Local mirror of Core's admission rules for early, readable feedback. Core stays
// the authority: it re-checks against the organization document it reads itself.
async function precheck(release, organization, policy, choices) {
  const findings = [];
  for (const [index, selection] of policy.selections.entries()) {
    const path = `/selections/${index}`;
    const entry = organization.selections.find(candidate => candidate.selectionId === selection.organizationSelectionId);
    if (entry === undefined) {
      findings.push(problem('AUTHORITY_DENIED', 'selection-not-admitted', 'The organization policy does not admit this selection.', path));
      continue;
    }
    const { sha256, materials } = selection.recipe.reference;
    if (entry.recipeIdentity !== await recipeIdentity({ recipeSha256: sha256, materials })) {
      findings.push(problem('AUTHORITY_DENIED', 'recipe-identity', 'The organization entry admits a different recipe identity.', `${path}/recipeIdentity`));
    }
    if (!entry.scopes.includes(selection.scope)) {
      findings.push(problem('AUTHORITY_DENIED', 'scope', 'The organization entry does not admit this scope.', `${path}/scope`));
    }
    for (const [name, spec] of Object.entries(getItem(release, choices[index].itemId).item.inputs)) {
      const permission = entry.inputs[name];
      const explicit = Object.hasOwn(selection.configuration, name);
      const inputPath = `${path}/inputs/${name}`;
      if (permission === undefined) {
        if (explicit) findings.push(problem('AUTHORITY_DENIED', 'input-not-permitted', 'The organization entry does not permit this input.', inputPath));
        else if (spec.sensitive === true || spec.default === undefined) findings.push(problem('AUTHORITY_DENIED', 'organization-permission-incomplete', 'The organization entry does not name this input and the recipe has no default.', inputPath));
        continue;
      }
      if (spec.sensitive === true) {
        if (!Object.hasOwn(permission, 'allowDeclared')) findings.push(problem('AUTHORITY_DENIED', 'input-value', 'A sensitive input may only be permitted with allowDeclared.', inputPath));
        continue;
      }
      const value = explicit ? selection.configuration[name] : spec.default;
      if (value === undefined) continue;
      const allowed = Object.hasOwn(permission, 'fixed') ? canonical(value) === canonical(permission.fixed)
        : Object.hasOwn(permission, 'choices') ? permission.choices.some(choice => canonical(choice) === canonical(value))
          : true;
      if (!allowed) findings.push(problem('AUTHORITY_DENIED', 'input-value', 'The configured input value is not permitted by the organization entry.', inputPath));
    }
  }
  return findings;
}

// choices: [{ id, organizationSelectionId, managementId, scope, itemId, configuration }]
// evidence: admin-selected [{ schema, scanId, location }] associations, copied unchanged
// into the execution policy's `evidence`; parsePolicy decides which are supported.
// materialSource names where the catalog's recipe materials are read (see authorPolicy).
export async function deriveExecutionPolicy({ release, organization, choices, evidence, materialSource }) {
  const checked = validateOrganizationPolicy(organization);
  if (!checked.valid) return { valid: false, diagnostics: checked.diagnostics };
  const authored = authorPolicy({
    release, mode: 'enterprise', materialSource,
    selections: choices.map(({ id, managementId, scope, itemId, configuration }) =>
      ({ id, managementId, scope, itemId, configuration: configuration ?? {} }))
  });
  if (!authored.valid) return { valid: false, diagnostics: authored.diagnostics };
  const policy = {
    ...authored.policy,
    selections: authored.policy.selections.map((selection, index) =>
      ({ ...selection, organizationSelectionId: choices[index].organizationSelectionId })),
    ...(evidence !== undefined ? { evidence: structuredClone(evidence) } : {})
  };
  const findings = await precheck(release, organization, policy, choices);
  if (findings.length) return { valid: false, diagnostics: findings };
  const parsed = parsePolicy(JSON.stringify(policy));
  return parsed.valid
    ? { valid: true, policy: parsed.document, diagnostics: parsed.diagnostics }
    : { valid: false, diagnostics: parsed.diagnostics };
}
