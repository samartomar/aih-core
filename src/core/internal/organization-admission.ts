// Portable admission of derived Enterprise selections against an organization document.
// Pure data comparison: no host, Harness, network or filesystem effects.
import { canonicalJson } from './canonical.js';
import { inputAccepts } from './policy-validation.js';
import type { Diagnostic, InputSpec, Json, OrganizationInputPermission, OrganizationPolicy, OrganizationSelection } from '../types.js';

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
  'input-not-permitted': 'The organization entry does not permit this input.',
  'input-value': 'The configured input value is not permitted by the organization entry.',
  'organization-permission-incomplete': 'The organization entry does not name this input and the recipe has no default.',
  'organization-input-spec': 'The organization entry permits a value incompatible with the recipe input definition.',
  'lifecycle-replace': 'The organization entry does not permit replacing this selection.',
  'lifecycle-adopt': 'The organization entry does not permit adopting this selection.',
  'lifecycle-remove': 'No organization entry permits removing this selection.'
} as const;

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

export function admitOrganizationSelections(organization: OrganizationPolicy, selections: AdmissionSelection[],
    lifecycle: AdmissionLifecycle[]): Diagnostic[] {
  const findings: Diagnostic[] = [];
  const finding: Finding = (code, reason, path, message) => findings.push({ code, reason, path, message });
  for (const selection of selections) {
    const entry = organization.selections.find(candidate => candidate.selectionId === selection.organizationSelectionId);
    if (entry === undefined) {
      finding('AUTHORITY_DENIED', 'selection-not-admitted', selection.path, MESSAGES['selection-not-admitted']);
      continue;
    }
    if (entry.recipeIdentity !== selection.recipeIdentity)
      finding('AUTHORITY_DENIED', 'recipe-identity', `${selection.path}/recipeIdentity`, MESSAGES['recipe-identity']);
    if (!entry.scopes.includes(selection.scope))
      finding('AUTHORITY_DENIED', 'scope', `${selection.path}/scope`, MESSAGES['scope']);
    admitInputs(entry, selection, finding);
  }
  for (const item of lifecycle) {
    if (item.action === 'remove') {
      const permitted = organization.selections.some(entry => entry.recipeIdentity === item.recipeIdentity &&
        entry.scopes.includes(item.scope) && entry.lifecycle?.remove === true);
      if (!permitted) finding('AUTHORITY_DENIED', 'lifecycle-remove', item.path, MESSAGES['lifecycle-remove']);
      continue;
    }
    const entry = item.organizationSelectionId === undefined ? undefined :
      organization.selections.find(candidate => candidate.selectionId === item.organizationSelectionId);
    const granted = item.action === 'replace' ? entry?.lifecycle?.replace === true : entry?.lifecycle?.adopt === true;
    if (!granted) finding('AUTHORITY_DENIED', `lifecycle-${item.action}`, item.path, MESSAGES[`lifecycle-${item.action}`]);
  }
  return findings;
}
