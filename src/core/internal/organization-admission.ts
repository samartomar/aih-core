// Portable admission of derived Enterprise selections against an organization document.
// Pure data comparison: no host, Harness, network or filesystem effects.
import { canonicalJson } from './canonical.js';
import { inputAccepts, isOrganizationPolicy11 } from './policy-validation.js';
import { contentFactsOf, matchContent, SetMembership, type ContentFacts, type ContentMatch } from './organization-content.js';
import type { CatalogItemRef, Diagnostic, InputSpec, Json, OrganizationAdvisoryResult, OrganizationApplicability, OrganizationFulfillmentResult,
  OrganizationInputPermission, OrganizationPolicy, OrganizationSelection12, OrganizationTarget,
  OrganizationTargetFact, OrganizationTargetFacts, SelectionMetadata } from '../types.js';

export interface AdmissionSelection {
  id: string;
  organizationSelectionId: string;
  scope: 'project' | 'user';
  recipeIdentity: string;
  inputs: Record<string, InputSpec>;
  configuration: Record<string, Json>;
  privateInputs: string[];
  /** Organization 1.2.0 content facts, declared by the caller (execution policy 1.4.0 selection metadata); never inferred. */
  kind?: SelectionMetadata['kind'];
  item?: CatalogItemRef;
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
  'prohibited': 'The organization prohibits this recipe or its content.',
  'client': 'The organization entry does not apply to this client.',
  'repository': 'The organization entry does not apply to this repository.',
  'target-unknown': 'The organization entry depends on a target or content fact that was not declared.',
  'input-not-permitted': 'The organization entry does not permit this input.',
  'input-value': 'The configured input value is not permitted by the organization entry.',
  'organization-permission-incomplete': 'The organization entry does not name this input and the recipe has no default.',
  'organization-input-spec': 'The organization entry permits a value incompatible with the recipe input definition.',
  'lifecycle-replace': 'The organization entry does not permit replacing this selection.',
  'lifecycle-adopt': 'The organization entry does not permit adopting this selection.',
  'lifecycle-remove': 'No organization entry permits removing this selection.',
  'content': 'The organization entry does not apply to this content.',
  'set-membership-unavailable': 'The organization entry selects a set whose Catalog-resolved members were not supplied.'
} as const;
/** Every entry shape: 1.0.0 and 1.1.0 entries always name a recipe; a 1.2.0 entry may name only content. */
type Entry = Omit<OrganizationSelection12, 'obligation'>;
const factsOf = (selection: Pick<AdmissionSelection, 'kind' | 'item'>): ContentFacts => contentFactsOf(selection);

function admitIdentity(entry: Entry, item: Pick<AdmissionSelection, 'recipeIdentity' | 'scope' | 'path'>,
    finding: Finding): void {
  if (entry.recipeIdentity !== item.recipeIdentity)
    finding('AUTHORITY_DENIED', 'recipe-identity', `${item.path}/recipeIdentity`, entry.recipeIdentity === undefined ?
      'The organization entry names content, not a recipe, and admits no selection.' : MESSAGES['recipe-identity']);
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

function admitInputs(entry: Entry, selection: AdmissionSelection, finding: Finding): void {
  const permissions = entry.inputs ?? {};
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

const entriesOf = (organization: OrganizationPolicy): OrganizationSelection12[] =>
  isOrganizationPolicy11(organization) ? organization.selections : [];

/** Declared mismatches and undeclared facts for an entry's client and repository selectors. */
function selectorState(entry: OrganizationSelection12, target: OrganizationTargetFacts): { mismatch: OrganizationTargetFact[]; unknown: OrganizationTargetFact[] } {
  const mismatch: OrganizationTargetFact[] = []; const unknown: OrganizationTargetFact[] = [];
  for (const [fact, listed] of [['client', entry.clients], ['repository', entry.repositories]] as const) {
    if (listed === undefined) continue;
    const declared = target[fact];
    if (declared === undefined) unknown.push(fact);
    else if (!(listed as readonly string[]).includes(declared)) mismatch.push(fact);
  }
  return { mismatch, unknown };
}

function applicability(entry: OrganizationSelection12, target: OrganizationTarget): { applicability: OrganizationApplicability; unknown: OrganizationTargetFact[] } {
  const state = selectorState(entry, target);
  if (!entry.scopes.includes(target.scope) || state.mismatch.length) return { applicability: 'not-applicable', unknown: [] };
  return state.unknown.length ? { applicability: 'unknown', unknown: state.unknown } : { applicability: 'applies', unknown: [] };
}

/** Referenced entry's selectors; returns whether an undeclared fact left applicability unknown. */
function admitSelectors(entry: OrganizationSelection12, selection: AdmissionSelection, target: OrganizationTargetFacts,
    finding: Finding): boolean {
  if (!entry.scopes.includes(selection.scope)) return false;
  const state = selectorState(entry, target);
  for (const fact of state.mismatch) finding('AUTHORITY_DENIED', fact, selection.path, MESSAGES[fact]);
  return !state.mismatch.length && state.unknown.length > 0;
}

/**
 * Ordinary prohibition enforcement: any applicable prohibition of the same recipe, or of matching content, denies. One that
 * needs an undeclared fact fails closed once per choice; one over a set without supplied members is never matched and
 * fails closed as `set-membership-unavailable`.
 */
function admitProhibitions(prohibitions: OrganizationSelection12[], selection: AdmissionSelection, target: OrganizationTargetFacts,
    unknown: boolean, unavailable: boolean, membership: SetMembership, finding: Finding): void {
  let applies = false;
  for (const other of prohibitions) {
    if (other.recipeIdentity !== undefined && other.recipeIdentity !== selection.recipeIdentity) continue;
    const state = applicability(other, { scope: selection.scope, ...target }).applicability;
    const content = other.content ? matchContent(other.content, factsOf(selection), membership) : 'matches';
    if (state === 'not-applicable' || content === 'mismatch') continue;
    if (state === 'applies' && content === 'matches') applies = true;
    else if (content === 'unavailable') unavailable = true;
    else unknown = true;
  }
  if (applies) finding('AUTHORITY_DENIED', 'prohibited', selection.path, MESSAGES['prohibited']);
  if (unknown) finding('AUTHORITY_DENIED', 'target-unknown', selection.path, MESSAGES['target-unknown']);
  if (unavailable) finding('AUTHORITY_DENIED', 'set-membership-unavailable', selection.path, MESSAGES['set-membership-unavailable']);
}

export function admitOrganizationSelections(organization: OrganizationPolicy, selections: AdmissionSelection[],
    lifecycle: AdmissionLifecycle[], target: OrganizationTargetFacts = {}, membership = new SetMembership(undefined)): Diagnostic[] {
  const findings: Diagnostic[] = [];
  const finding: Finding = (code, reason, path, message) => findings.push({ code, reason, path, message });
  // 1.1.0 and 1.2.0 entries by identity; a 1.0.0 document has none, so its findings are unchanged.
  const governed = new Map(entriesOf(organization).map(entry => [entry.selectionId, entry]));
  const prohibitions = [...governed.values()].filter(entry => entry.obligation === 'prohibited');
  const entries: Entry[] = organization.selections;
  for (const selection of selections) {
    const entry = entries.find(candidate => candidate.selectionId === selection.organizationSelectionId);
    if (entry === undefined) {
      finding('AUTHORITY_DENIED', 'selection-not-admitted', selection.path, MESSAGES['selection-not-admitted']);
      continue;
    }
    const rules = governed.get(entry.selectionId);
    if (rules?.obligation === 'prohibited') {
      finding('AUTHORITY_DENIED', 'prohibited', selection.path, MESSAGES['prohibited']);
      continue;
    }
    admitIdentity(entry, selection, finding);
    // Exact recipe admission: a content-only entry admits nothing, so its inputs and prohibitions are not compared.
    if (entry.recipeIdentity === undefined) continue;
    let unknown = rules !== undefined && admitSelectors(rules, selection, target, finding);
    const content = rules?.content ? matchContent(rules.content, factsOf(selection), membership) : 'matches';
    if (content === 'mismatch') finding('AUTHORITY_DENIED', 'content', selection.path, MESSAGES['content']);
    if (content === 'unknown') unknown = true;
    admitInputs(entry, selection, finding);
    if (rules) admitProhibitions(prohibitions, selection, target, unknown, content === 'unavailable', membership, finding);
  }
  for (const item of lifecycle) {
    if (item.action === 'remove') {
      // A retained selection's obsolete members follow its own current entry; a removed
      // selection needs an entry admitting the exact identity that wrote the member.
      const permits = (entry: Entry) => entry.scopes.includes(item.scope) && entry.lifecycle?.remove === true;
      const permitted = item.organizationSelectionId === undefined ?
        entries.some(entry => entry.recipeIdentity === item.recipeIdentity && permits(entry)) :
        entries.some(entry => entry.selectionId === item.organizationSelectionId &&
          entry.recipeIdentity === item.recipeIdentity && permits(entry));
      if (!permitted) finding('AUTHORITY_DENIED', 'lifecycle-remove', item.path, MESSAGES['lifecycle-remove']);
      continue;
    }
    const entry = item.organizationSelectionId === undefined ? undefined :
      entries.find(candidate => candidate.selectionId === item.organizationSelectionId);
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
 * A selection takes a recipe entry only when it names that entry and admission left no finding at or below its path; it
 * takes a content-only 1.2.0 entry when its declared content matches and admission left no finding. A set selector without
 * supplied members is `unavailable`, never taken or fulfilled.
 */
export function evaluateOrganizationObligations(organization: OrganizationPolicy, selections: AdmissionSelection[],
    findings: Diagnostic[], target: OrganizationTarget, membership = new SetMembership(undefined)): { advisory: OrganizationAdvisoryResult[]; fulfillment: OrganizationFulfillmentResult[] } {
  const advisory: OrganizationAdvisoryResult[] = []; const fulfillment: OrganizationFulfillmentResult[] = [];
  const clean = (selection: AdmissionSelection) =>
    !findings.some(item => item.path === selection.path || item.path?.startsWith(`${selection.path}/`));
  for (const entry of entriesOf(organization)) {
    if (entry.obligation !== 'required' && entry.obligation !== 'recommended') continue;
    const taken = selections.filter(selection => selection.scope === target.scope && clean(selection) && (entry.recipeIdentity === undefined ?
      matchContent(entry.content!, factsOf(selection), membership) === 'matches' :
      selection.organizationSelectionId === entry.selectionId && selection.recipeIdentity === entry.recipeIdentity)).map(selection => selection.id);
    const { applicability: state, unknown } = applicability(entry, target);
    const unavailable = entry.content?.set !== undefined && membership.members(entry.content.set) === undefined;
    const base = { selectionId: entry.selectionId, ...(entry.recipeIdentity === undefined ? {} : { recipeIdentity: entry.recipeIdentity }),
      ...(entry.content === undefined ? {} : { content: structuredClone(entry.content) }), applicability: state, unknown, selections: taken };
    if (entry.obligation === 'recommended') advisory.push({ ...base, status: unavailable && state !== 'not-applicable' ? 'unavailable' :
      taken.length ? 'taken' : 'not-taken' });
    else fulfillment.push({ ...base, status: state === 'not-applicable' ? 'not-applicable' : unavailable ? 'unavailable' :
      state === 'unknown' ? 'unknown' : taken.length ? 'fulfilled' : 'not-fulfilled' });
  }
  return { advisory, fulfillment };
}

export interface OrganizationContentEntryResult {
  selectionId: string; obligation: OrganizationSelection12['obligation'];
  applicability: Exclude<OrganizationApplicability, 'not-applicable'>; match: Exclude<ContentMatch, 'mismatch'>;
  unknown: OrganizationTargetFact[];
}
/**
 * Which content-bearing 1.2.0 entries may govern a Catalog item for a declared target, in document order. Recipe entries
 * name no item and are omitted. `required` and `prohibited` hold only when an entry applies and matches; an undeclared fact
 * or a set without supplied members is reported, never claimed.
 */
export function evaluateOrganizationContent(organization: OrganizationPolicy, facts: Required<ContentFacts>, target: OrganizationTarget,
    membership: SetMembership): { entries: OrganizationContentEntryResult[]; required: boolean; prohibited: boolean } {
  const entries: OrganizationContentEntryResult[] = [];
  for (const entry of entriesOf(organization)) {
    if (entry.recipeIdentity !== undefined || entry.content === undefined) continue;
    const { applicability: state, unknown } = applicability(entry, target);
    const match = matchContent(entry.content, facts, membership);
    if (state === 'not-applicable' || match === 'mismatch') continue;
    entries.push({ selectionId: entry.selectionId, obligation: entry.obligation, applicability: state, match, unknown });
  }
  const claims = (obligation: string) => entries.some(item => item.obligation === obligation && item.applicability === 'applies' && item.match === 'matches');
  return { entries, required: claims('required'), prohibited: claims('prohibited') };
}
