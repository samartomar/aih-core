// Portable admission of derived Enterprise selections against an organization document.
// Pure data comparison: no host, Harness, network or filesystem effects.
import { canonicalJson } from './canonical.js';
import { inputAccepts } from './policy-validation.js';
import type { NativeClientId } from './native-clients.js';
import type { Diagnostic, InputSpec, Json, OrganizationInputPermission, OrganizationPolicy, OrganizationSelection, OrganizationSelection11 } from '../types.js';

/** Caller-declared target facts; an absent fact is unknown, never inferred. */
export interface OrganizationTargetFacts { client?: NativeClientId; repository?: string }
export interface OrganizationTarget extends OrganizationTargetFacts { scope: 'project' | 'user' }
export type OrganizationApplicability = 'applies' | 'not-applicable' | 'unknown';
type TargetFact = 'client' | 'repository';
export interface OrganizationAdvisoryResult {
  selectionId: string; recipeIdentity: string; applicability: OrganizationApplicability; unknown: TargetFact[];
  status: 'taken' | 'not-taken'; selections: string[];
}
export interface OrganizationFulfillmentResult {
  selectionId: string; recipeIdentity: string; applicability: OrganizationApplicability; unknown: TargetFact[];
  status: 'fulfilled' | 'not-fulfilled' | 'not-applicable' | 'unknown'; selections: string[];
}

export interface AdmissionSelection {
  id: string;
  organizationSelectionId: string;
  scope: 'project' | 'user';
  recipeIdentity: string;
  inputs: Record<string, InputSpec>;
  configuration: Record<string, Json>;
  privateInputs: string[];
  path: string;
}

export interface AdmissionLifecycle {
  action: 'replace' | 'adopt' | 'remove';
  scope: 'project' | 'user';
  recipeIdentity: string;
  organizationSelectionId?: string;
  path: string;
}

type Finding = (code: 'AUTHORITY_DENIED' | 'INPUT_INVALID', reason: string, path: string, message: string) => void;

const MESSAGES = {
  'selection-not-admitted': 'The organization document does not admit this selection identity.',
  'recipe-identity': 'The organization entry admits a different recipe identity.',
  'scope': 'The organization entry does not admit this scope.',
  'prohibited': 'The organization prohibits this recipe.',
  'client': 'The organization entry does not apply to this client.',
  'repository': 'The organization entry does not apply to this repository.',
  'target-unknown': 'The organization entry depends on a target fact that was not declared.',
  'input-not-permitted': 'The organization entry does not permit this input.',
  'input-value': 'The configured input value is not permitted by the organization entry.',
  'organization-permission-incomplete': 'The organization entry does not name this input and the recipe has no default.',
  'organization-input-spec': 'The organization entry permits a value incompatible with the recipe input definition.',
  'lifecycle-replace': 'The organization entry does not permit replacing this selection.',
  'lifecycle-adopt': 'The organization entry does not permit adopting this selection.',
  'lifecycle-remove': 'No organization entry permits removing this selection.'
} as const;

function admitIdentity(entry: OrganizationSelection, item: Pick<AdmissionSelection, 'recipeIdentity' | 'scope' | 'path'>,
    finding: Finding): void {
  if (entry.recipeIdentity !== item.recipeIdentity)
    finding('AUTHORITY_DENIED', 'recipe-identity', `${item.path}/recipeIdentity`, MESSAGES['recipe-identity']);
  if (!entry.scopes.includes(item.scope))
    finding('AUTHORITY_DENIED', 'scope', `${item.path}/scope`, MESSAGES['scope']);
}

function isAllowDeclared(permission: OrganizationInputPermission): permission is { allowDeclared: true } {
  return 'allowDeclared' in permission;
}
function isFixed(permission: OrganizationInputPermission): permission is { fixed: Json } {
  return 'fixed' in permission;
}
function isChoices(permission: OrganizationInputPermission): permission is { choices: Json[] } {
  return 'choices' in permission;
}

function admitInputs(entry: OrganizationSelection, selection: AdmissionSelection, finding: Finding): void {
  const permissions = entry.inputs;
  for (const [name, spec] of Object.entries(selection.inputs)) {
    const permission = permissions[name];
    const explicit = Object.hasOwn(selection.configuration, name);
    const supplied = selection.privateInputs.includes(name);
    const path = `${selection.path}/inputs/${name}`;
    if (permission === undefined) {
      if (explicit || supplied) finding('AUTHORITY_DENIED', 'input-not-permitted', path, MESSAGES['input-not-permitted']);
      else if (spec.sensitive || spec.default === undefined) finding('AUTHORITY_DENIED',
        'organization-permission-incomplete', path, MESSAGES['organization-permission-incomplete']);
      continue;
    }
    if (spec.sensitive) {
      if (!isAllowDeclared(permission)) finding('AUTHORITY_DENIED', 'input-value', path,
        'A sensitive input may only be permitted with allowDeclared.');
      continue;
    }
    if (isFixed(permission) && !inputAccepts(spec, permission.fixed)) finding('INPUT_INVALID',
      'organization-input-spec', path, MESSAGES['organization-input-spec']);
    else if (isChoices(permission) && permission.choices.some(choice => !inputAccepts(spec, choice)))
      finding('INPUT_INVALID', 'organization-input-spec', path, MESSAGES['organization-input-spec']);
    const value = explicit ? selection.configuration[name] : spec.default;
    if (value === undefined) continue;
    if (isFixed(permission)) {
      if (canonicalJson(value) !== canonicalJson(permission.fixed)) finding('AUTHORITY_DENIED',
        'input-value', path, MESSAGES['input-value']);
    } else if (isChoices(permission)) {
      if (!permission.choices.some(choice => canonicalJson(choice) === canonicalJson(value)))
        finding('AUTHORITY_DENIED', 'input-value', path, MESSAGES['input-value']);
    } else if (!inputAccepts(spec, value)) {
      finding('AUTHORITY_DENIED', 'input-value', path, MESSAGES['input-value']);
    }
  }
  for (const name of Object.keys(selection.configuration)) {
    if (!Object.hasOwn(selection.inputs, name) && !Object.hasOwn(permissions, name))
      finding('AUTHORITY_DENIED', 'input-not-permitted', `${selection.path}/configuration/${name}`, MESSAGES['input-not-permitted']);
  }
  for (const name of selection.privateInputs) {
    if (!Object.hasOwn(selection.inputs, name) && !Object.hasOwn(permissions, name))
      finding('AUTHORITY_DENIED', 'input-not-permitted', `${selection.path}/privateInputs/${name}`, MESSAGES['input-not-permitted']);
  }
}

const isCurrent = (organization: OrganizationPolicy): boolean => organization.schema === 'urn:aihq:core:organization-policy:1.1.0';
const entriesOf = (organization: OrganizationPolicy): OrganizationSelection11[] =>
  isCurrent(organization) ? organization.selections as OrganizationSelection11[] : [];

/** Declared mismatches and undeclared facts for an entry's client and repository selectors. */
function selectorState(entry: OrganizationSelection11, target: OrganizationTargetFacts): { mismatch: TargetFact[]; unknown: TargetFact[] } {
  const mismatch: TargetFact[] = []; const unknown: TargetFact[] = [];
  for (const [fact, listed] of [['client', entry.clients], ['repository', entry.repositories]] as const) {
    if (listed === undefined) continue;
    const declared = target[fact];
    if (declared === undefined) unknown.push(fact);
    else if (!(listed as readonly string[]).includes(declared)) mismatch.push(fact);
  }
  return { mismatch, unknown };
}

function applicability(entry: OrganizationSelection11, target: OrganizationTarget): { applicability: OrganizationApplicability; unknown: TargetFact[] } {
  const state = selectorState(entry, target);
  if (!entry.scopes.includes(target.scope) || state.mismatch.length) return { applicability: 'not-applicable', unknown: [] };
  return state.unknown.length ? { applicability: 'unknown', unknown: state.unknown } : { applicability: 'applies', unknown: [] };
}

export function admitOrganizationSelections(organization: OrganizationPolicy, selections: AdmissionSelection[],
    lifecycle: AdmissionLifecycle[], target: OrganizationTargetFacts = {}): Diagnostic[] {
  const findings: Diagnostic[] = [];
  const finding: Finding = (code, reason, path, message) => findings.push({ code, reason, path, message });
  const current = isCurrent(organization);
  const prohibitions = new Map<string, OrganizationSelection11[]>();
  for (const entry of entriesOf(organization)) if (entry.obligation === 'prohibited')
    prohibitions.set(entry.recipeIdentity, [...prohibitions.get(entry.recipeIdentity) ?? [], entry]);
  for (const selection of selections) {
    const entry = organization.selections.find(candidate => candidate.selectionId === selection.organizationSelectionId);
    if (entry === undefined) {
      finding('AUTHORITY_DENIED', 'selection-not-admitted', selection.path, MESSAGES['selection-not-admitted']);
      continue;
    }
    if (current && (entry as OrganizationSelection11).obligation === 'prohibited') {
      finding('AUTHORITY_DENIED', 'prohibited', selection.path, MESSAGES['prohibited']);
      continue;
    }
    admitIdentity(entry, selection, finding);
    if (current && entry.scopes.includes(selection.scope)) {
      const state = selectorState(entry as OrganizationSelection11, target);
      for (const fact of state.mismatch) finding('AUTHORITY_DENIED', fact, selection.path, MESSAGES[fact]);
      if (!state.mismatch.length && state.unknown.length)
        finding('AUTHORITY_DENIED', 'target-unknown', selection.path, MESSAGES['target-unknown']);
    }
    admitInputs(entry, selection, finding);
    if (!current) continue;
    const states = (prohibitions.get(selection.recipeIdentity) ?? [])
      .map(other => applicability(other, { scope: selection.scope, ...target }).applicability);
    if (states.includes('applies')) finding('AUTHORITY_DENIED', 'prohibited', selection.path, MESSAGES['prohibited']);
    if (states.includes('unknown') && !findings.some(item => item.reason === 'target-unknown' && item.path === selection.path))
      finding('AUTHORITY_DENIED', 'target-unknown', selection.path, MESSAGES['target-unknown']);
  }
  for (const item of lifecycle) {
    if (item.action === 'remove') {
      // A retained selection's obsolete members follow its own current entry; a removed
      // selection needs an entry admitting the exact identity that wrote the member.
      const permits = (entry: OrganizationSelection) => entry.scopes.includes(item.scope) && entry.lifecycle?.remove === true;
      const permitted = item.organizationSelectionId === undefined ?
        organization.selections.some(entry => entry.recipeIdentity === item.recipeIdentity && permits(entry)) :
        organization.selections.some(entry => entry.selectionId === item.organizationSelectionId &&
          entry.recipeIdentity === item.recipeIdentity && permits(entry));
      if (!permitted) finding('AUTHORITY_DENIED', 'lifecycle-remove', item.path, MESSAGES['lifecycle-remove']);
      continue;
    }
    const entry = item.organizationSelectionId === undefined ? undefined :
      organization.selections.find(candidate => candidate.selectionId === item.organizationSelectionId);
    // Prepare supplies lifecycle tuples from its already-compared selections. Public
    // advisory callers may supply standalone tuples; check those without duplicating
    // the existing paired-selection findings or changing host admission diagnostics.
    const alreadyCompared = selections.some(selection => selection.organizationSelectionId === item.organizationSelectionId &&
      selection.recipeIdentity === item.recipeIdentity && selection.scope === item.scope);
    if (entry && !alreadyCompared) admitIdentity(entry, item, finding);
    const granted = item.action === 'replace' ? entry?.lifecycle?.replace === true : entry?.lifecycle?.adopt === true;
    if (!granted) finding('AUTHORITY_DENIED', `lifecycle-${item.action}`, item.path, MESSAGES[`lifecycle-${item.action}`]);
  }
  return findings;
}

/**
 * Pure advisory evaluation over the same findings admission produced for this target.
 * A selection takes an entry only when admission left no finding at or below its path.
 */
export function evaluateOrganizationObligations(organization: OrganizationPolicy, selections: AdmissionSelection[],
    findings: Diagnostic[], target: OrganizationTarget): { advisory: OrganizationAdvisoryResult[]; fulfillment: OrganizationFulfillmentResult[] } {
  const advisory: OrganizationAdvisoryResult[] = []; const fulfillment: OrganizationFulfillmentResult[] = [];
  for (const entry of entriesOf(organization)) {
    if (entry.obligation !== 'required' && entry.obligation !== 'recommended') continue;
    const taken = selections.filter(selection => selection.organizationSelectionId === entry.selectionId &&
      selection.recipeIdentity === entry.recipeIdentity && selection.scope === target.scope &&
      !findings.some(item => item.path === selection.path || item.path?.startsWith(`${selection.path}/`))).map(selection => selection.id);
    const { applicability: state, unknown } = applicability(entry, target);
    const base = { selectionId: entry.selectionId, recipeIdentity: entry.recipeIdentity, applicability: state, unknown, selections: taken };
    if (entry.obligation === 'recommended') advisory.push({ ...base, status: taken.length ? 'taken' : 'not-taken' });
    else fulfillment.push({ ...base, status: state === 'not-applicable' ? 'not-applicable' : state === 'unknown' ? 'unknown' :
      taken.length ? 'fulfilled' : 'not-fulfilled' });
  }
  return { advisory, fulfillment };
}
