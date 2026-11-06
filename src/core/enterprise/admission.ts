// Enterprise admission (contract 11, C25, C31, C57, C71): portable evaluation of supplied facts against an organization
// document. Three kinds of result: enforced denials (which block the whole request), advisory recommendations and
// required fulfilment (which never block). Facts are declared or recorded, never inferred; a fact a prohibition needs
// that is missing fails closed, and a missing fact an obligation needs reads `unknown`, never fulfilled.
import { canonicalJson } from '../internal/canonical.js';
import { inputAccepts } from '../internal/policy-validation.js';
import { isChangeEntry, permissionFits, type ChangeEntry, type ContentEntry, type ContentSelector, type Narrowing, type Organization,
  type OrganizationEntry, type ScanSigner } from './organization.js';
import type { InputSpec, Json } from '../types.js';
import type { Origin } from '../plan/types.js';

/** What the caller declared for this request (contract 11 "Targets"): Core never infers the client or repository. */
export interface DeclaredTarget { scope: 'project' | 'user'; client: { id: string; surface: 'cli' | 'ide' } | null; repository: string | null }
/** One piece of content a step names (D108): an item, or a framework, with its kind when the content documents give one. */
export interface Subject { item: string | null; framework: string | null; kind: string | null }
/** One plan step as admission sees it: where it lands, the CLIs it serves (`null`: none recorded) and what it names. */
export interface StepFacts { step: number; managementId: string; scope: 'project' | 'user'; clis: (string | null)[]; subjects: Subject[] }
export interface PlanFacts {
  steps: StepFacts[];
  data: { repository: string; commit: string } | null;
  /** The origin Core proved (C44), or `chosen`. */
  origin: Origin;
  /** The recipe the plan names, proven or not: an unproven claim never satisfies a selector, but a prohibition fails closed on it. */
  recipe: { id: string; sha256: string; commit: string } | null;
}
/** One claim (receipt) as fulfilment counts it: recorded facts only. */
export interface ClaimFacts {
  key: string; managementId: string; scope: 'project' | 'user';
  /** The CLIs the claim is held for: its one CLI, or every CLI of its plan when it recorded none (contract 5). */
  clis: string[];
  origin: Origin | null; items: string[]; kind: string | null; framework: string | null;
  /** A change claim's identity (`sha256:…`); `null` for plan claims. */
  change: string | null;
  /** A preview's planned claim: the recipe its plan names but nobody proved, so a recipe selector reads `unknown` for it. */
  claimed?: PlanFacts['recipe'];
}
export interface ChangeFacts {
  managementId: string; identity: string; scope: 'project' | 'user';
  inputs: Record<string, InputSpec>; configuration: Record<string, Json>; privateInputs: string[];
  /** The reviewed conflict choices this change makes. */
  lifecycle: ('replace' | 'adopt')[];
}
export interface Denial {
  code: 'AUTHORITY_DENIED'; reason: string; message: string;
  /** The organization entry that denies, or the source rule. */
  entry?: string; rule?: 'sources.published' | 'sources.own';
  managementId?: string; step?: number; input?: string;
}
export type Applicability = 'applies' | 'not-applicable' | 'unknown';
export type Fact = 'client' | 'repository' | 'content' | 'origin';
export interface AdvisoryResult { entry: string; status: 'taken' | 'not-taken'; applicability: Applicability; unknown: Fact[]; managementIds: string[] }
export interface FulfilmentResult { entry: string; status: 'fulfilled' | 'not-fulfilled' | 'not-applicable' | 'unknown'; unknown: Fact[]; managementIds: string[] }
export interface Obligations { advisory: AdvisoryResult[]; fulfilment: FulfilmentResult[] }

type Match = 'matches' | 'mismatch' | 'unknown';
const worst = (states: Match[]): Match => states.includes('mismatch') ? 'mismatch' : states.includes('unknown') ? 'unknown' : 'matches';
const fold = (value: string) => value.toLowerCase();

/** Scope, client and repository narrowing for one entry, given the client facts of what it is compared with. */
function narrowing(entry: Narrowing, scope: 'project' | 'user', clients: string[] | null, repository: string | null): { state: Applicability; unknown: Fact[] } {
  if (entry.scopes && !entry.scopes.includes(scope)) return { state: 'not-applicable', unknown: [] };
  const unknown: Fact[] = [];
  if (entry.clients) {
    if (clients === null || clients.length === 0) unknown.push('client');
    else if (!clients.some(client => entry.clients!.includes(client))) return { state: 'not-applicable', unknown: [] };
  }
  if (entry.repositories) {
    if (repository === null) unknown.push('repository');
    else if (!entry.repositories.some(listed => fold(listed) === fold(repository))) return { state: 'not-applicable', unknown: [] };
  }
  return { state: unknown.length ? 'unknown' : 'applies', unknown };
}
const one = (cli: string | null, target: DeclaredTarget): string[] | null => cli !== null ? [cli] : target.client ? [target.client.id] : null;

/** A proven origin against a recipe selector; an unproven named recipe is `unknown` only where the caller asks (prohibitions). */
function recipeMatch(selector: NonNullable<ContentSelector['recipe']>, origin: Origin | null, claimed: PlanFacts['recipe'] | undefined): Match {
  if (origin && origin !== 'chosen') return origin.recipe.id === selector.id && (selector.sha256 === undefined || selector.sha256 === origin.recipe.sha256) &&
    (selector.commit === undefined || selector.commit === origin.recipe.commit) ? 'matches' : 'mismatch';
  return claimed && claimed.id === selector.id ? 'unknown' : 'mismatch';
}
function contentMatch(selector: ContentSelector, subject: Subject, origin: Origin | null, claimed?: PlanFacts['recipe']): Match {
  const states: Match[] = [];
  for (const field of ['item', 'kind', 'framework'] as const) if (selector[field] !== undefined)
    states.push(subject[field] === null ? 'unknown' : subject[field] === selector[field] ? 'matches' : 'mismatch');
  if (selector.recipe) states.push(recipeMatch(selector.recipe, origin, claimed));
  return worst(states);
}

const contentEntries = (organization: Organization) => organization.entries.filter((entry): entry is ContentEntry => !isChangeEntry(entry));
const changeEntries = (organization: Organization) => organization.entries.filter(isChangeEntry);

/** Enforced admission of a plan: prohibitions over every step's content, and the source rules (C31). */
export function admitPlan(organization: Organization, target: DeclaredTarget, plan: PlanFacts): Denial[] {
  const denials: Denial[] = [];
  const add = (denial: Omit<Denial, 'code'>) => {
    if (!denials.some(known => known.reason === denial.reason && known.entry === denial.entry && known.rule === denial.rule &&
        known.managementId === denial.managementId)) denials.push({ code: 'AUTHORITY_DENIED', ...denial });
  };
  const sources = organization.sources;
  if (plan.data === null && sources?.own?.kinds) {
    const kinds = sources.own.kinds;
    for (const step of plan.steps) for (const subject of step.subjects) {
      if (subject.kind === null) add({ reason: 'target-unknown', rule: 'sources.own', managementId: step.managementId, step: step.step,
        message: `The organization allows own content only of kinds ${kinds.map(kind => `\`${kind}\``).join(', ') || '(none)'}, and the kind of \`${subject.item ?? subject.framework}\` is not known.` });
      else if (!kinds.includes(subject.kind)) add({ reason: 'own-content', rule: 'sources.own', managementId: step.managementId, step: step.step,
        message: `The organization's \`sources.own\` rule does not allow own content of kind \`${subject.kind}\` (\`${subject.item ?? subject.framework}\`).` });
    }
  }
  if (plan.data !== null && sources?.published) {
    const data = plan.data;
    const listed = sources.published.filter(entry => fold(entry.repository) === fold(data.repository));
    if (!listed.length) add({ reason: 'source-published', rule: 'sources.published',
      message: `The organization's \`sources.published\` rule does not list the data repository \`${data.repository}\`.` });
    else if (!listed.some(entry => entry.commit === undefined || entry.commit === data.commit)) add({ reason: 'source-pin', rule: 'sources.published',
      message: `The organization's \`sources.published\` rule pins \`${data.repository}\` to another commit than \`${data.commit}\`.` });
  }
  for (const entry of contentEntries(organization)) {
    if (entry.obligation !== 'prohibited') continue;
    for (const step of plan.steps) for (const cli of step.clis) for (const subject of step.subjects) {
      const narrowed = narrowing(entry, step.scope, one(cli, target), target.repository);
      if (narrowed.state === 'not-applicable') continue;
      const match = contentMatch(entry.content, subject, plan.origin, plan.recipe);
      if (match === 'mismatch') continue;
      if (narrowed.state === 'applies' && match === 'matches') add({ reason: 'prohibited', entry: entry.id, managementId: step.managementId, step: step.step,
        message: `The organization entry \`${entry.id}\` prohibits \`${subject.item ?? subject.framework}\`.` });
      else add({ reason: 'target-unknown', entry: entry.id, managementId: step.managementId, step: step.step,
        message: `The organization entry \`${entry.id}\` may prohibit \`${subject.item ?? subject.framework}\`, and a fact it needs ` +
          `(${[...narrowed.unknown, ...(match === 'unknown' ? [plan.recipe && entry.content.recipe ? 'a proven recipe origin' : 'content'] : [])].join(', ')}) is not declared.` });
    }
  }
  return denials;
}

/** The change entries that govern one change identity at this place, by applicability. */
function governing(organization: Organization, identity: string, scope: 'project' | 'user', target: DeclaredTarget) {
  return changeEntries(organization).filter(entry => entry.change.identity === identity)
    .map(entry => ({ entry, ...narrowing(entry, scope, target.client ? [target.client.id] : null, target.repository) }))
    .filter(item => item.state !== 'not-applicable');
}

/** Enforced admission of changes (contract 11 "Change entries"): by identity, with input and lifecycle permissions. */
export function admitChanges(organization: Organization, target: DeclaredTarget, changes: ChangeFacts[]): Denial[] {
  const denials: Denial[] = [];
  const deny = (denial: Omit<Denial, 'code'>) => denials.push({ code: 'AUTHORITY_DENIED', ...denial });
  for (const change of changes) {
    const entries = governing(organization, change.identity, change.scope, target);
    const prohibited = entries.find(item => item.entry.obligation === 'prohibited');
    if (prohibited) {
      deny(prohibited.state === 'applies' ? { reason: 'prohibited', entry: prohibited.entry.id, managementId: change.managementId,
        message: `The organization entry \`${prohibited.entry.id}\` prohibits the change \`${change.managementId}\`.` } :
        { reason: 'target-unknown', entry: prohibited.entry.id, managementId: change.managementId,
          message: `The organization entry \`${prohibited.entry.id}\` may prohibit the change \`${change.managementId}\`, and a fact it needs (${prohibited.unknown.join(', ')}) is not declared.` });
      continue;
    }
    const admitting = entries.find(item => item.state === 'applies');
    if (!admitting) {
      const unknown = entries[0];
      deny(unknown ? { reason: 'target-unknown', entry: unknown.entry.id, managementId: change.managementId,
        message: `The organization entry \`${unknown.entry.id}\` admits this change only for a ${unknown.unknown.join(' and ')} that was not declared.` } :
        { reason: 'change-not-admitted', managementId: change.managementId,
          message: `No organization entry admits the change \`${change.managementId}\` (identity \`${change.identity}\`).` });
      continue;
    }
    for (const denial of admitInputs(admitting.entry, change)) deny(denial);
    for (const action of new Set(change.lifecycle)) if (admitting.entry.lifecycle?.[action] !== true)
      deny({ reason: `lifecycle-${action}`, entry: admitting.entry.id, managementId: change.managementId,
        message: `The organization entry \`${admitting.entry.id}\` does not permit ${action === 'replace' ? 'replacing' : 'adopting'} existing content for \`${change.managementId}\`.` });
  }
  return denials;
}

/** Input permissions of one change entry, as recipe entries had them (14.2): explicit values, defaults and secrets. */
function admitInputs(entry: ChangeEntry, change: ChangeFacts): Omit<Denial, 'code'>[] {
  const found: Omit<Denial, 'code'>[] = [];
  const deny = (reason: string, input: string, message: string) => found.push({ reason, entry: entry.id, managementId: change.managementId, input, message });
  const permissions = entry.inputs ?? {};
  for (const [name, spec] of Object.entries(change.inputs)) {
    const permission = permissions[name];
    const explicit = Object.hasOwn(change.configuration, name);
    const supplied = change.privateInputs.includes(name);
    if (permission === undefined) {
      if (explicit || supplied) deny('input-not-permitted', name, `The organization entry \`${entry.id}\` does not permit the input \`${name}\`.`);
      else if (spec.sensitive || spec.default === undefined) deny('organization-permission-incomplete', name,
        `The organization entry \`${entry.id}\` does not name the input \`${name}\`, and it has no default.`);
      continue;
    }
    if (spec.sensitive) {
      if (!('allowDeclared' in permission)) deny('input-value', name, `A secret input such as \`${name}\` may only be permitted with \`allowDeclared\`.`);
      continue;
    }
    if (!permissionFits(spec, permission)) { deny('organization-input-spec', name, `The organization entry \`${entry.id}\` permits a value \`${name}\` can't hold.`); continue; }
    const value = explicit ? change.configuration[name] : spec.default;
    if (value === undefined) continue;
    const allowed = 'fixed' in permission ? canonicalJson(value) === canonicalJson(permission.fixed) :
      'choices' in permission ? permission.choices.some(choice => canonicalJson(choice) === canonicalJson(value)) : inputAccepts(spec, value);
    if (!allowed) deny('input-value', name, `The organization entry \`${entry.id}\` does not permit this value of \`${name}\`.`);
  }
  for (const name of [...Object.keys(change.configuration), ...change.privateInputs])
    if (!Object.hasOwn(change.inputs, name) && !Object.hasOwn(permissions, name))
      deny('input-not-permitted', name, `The organization entry \`${entry.id}\` does not permit the input \`${name}\`.`);
  return found;
}

/** Enforced admission of removals: a change claim goes only where its entry permits removal; content removal is not gated. */
export function admitRemovals(organization: Organization, target: DeclaredTarget, released: ClaimFacts[]): Denial[] {
  const denials: Denial[] = [];
  for (const claim of released) {
    if (claim.change === null || denials.some(known => known.managementId === claim.managementId)) continue;
    const entries = governing(organization, claim.change, claim.scope, target).filter(item => item.state === 'applies');
    if (!entries.some(item => item.entry.lifecycle?.remove === true)) denials.push({ code: 'AUTHORITY_DENIED', reason: 'lifecycle-remove',
      ...(entries[0] ? { entry: entries[0].entry.id } : {}), managementId: claim.managementId,
      message: `No organization entry permits removing the change \`${claim.managementId}\`.` });
  }
  return denials;
}

/** How one claim meets one entry: whether the entry's narrowing applies to it and whether its content matches. */
function claimMeets(entry: OrganizationEntry, claim: ClaimFacts, target: DeclaredTarget): { match: Match; unknown: Fact[] } {
  // A change records no CLI: it is judged for the declared client, as its admission was.
  const held = claim.change !== null ? (target.client ? [target.client.id] : []) : claim.clis;
  const clients = target.client ? (held.includes(target.client.id) ? [target.client.id] : []) : held;
  if (target.client && !clients.length) return { match: 'mismatch', unknown: [] };
  const narrowed = narrowing(entry, claim.scope, clients.length ? clients : null, target.repository);
  if (narrowed.state === 'not-applicable') return { match: 'mismatch', unknown: [] };
  let match: Match;
  if (isChangeEntry(entry)) match = claim.change === entry.change.identity ? 'matches' : 'mismatch';
  else if (claim.change !== null) match = 'mismatch';
  else {
    const subjects: Subject[] = claim.items.length ? claim.items.map(item => ({ item, framework: claim.framework, kind: claim.kind })) :
      [{ item: null, framework: claim.framework, kind: claim.kind }];
    const states = subjects.map(subject => contentMatch(entry.content, subject, claim.origin, claim.claimed));
    match = states.includes('matches') ? 'matches' : states.includes('unknown') ? 'unknown' : 'mismatch';
  }
  if (match === 'mismatch') return { match, unknown: [] };
  const unknown: Fact[] = [...narrowed.unknown, ...(match === 'unknown' ? ['content' as const] : [])];
  return { match: unknown.length ? 'unknown' : 'matches', unknown };
}

/**
 * Advisory and fulfilment results (C57, C71). A recommended entry is `taken` when what this request adds matches it.
 * A required entry is fulfilled when a claim in `after` (the claims that exist once the request is carried out, or that
 * a run left) matches it for the declared client and scope; `unknown` when only an undeclared fact could decide it.
 */
export function obligations(organization: Organization, target: DeclaredTarget, added: ClaimFacts[], after: ClaimFacts[]): Obligations {
  const advisory: AdvisoryResult[] = []; const fulfilment: FulfilmentResult[] = [];
  for (const entry of organization.entries) {
    if (entry.obligation !== 'recommended' && entry.obligation !== 'required') continue;
    const place = narrowing(entry, target.scope, target.client ? [target.client.id] : entry.clients ? null : [], target.repository);
    // Without a declared client, a client-narrowed entry is judged over each claim's own recorded CLI.
    const open = place.unknown.filter(fact => fact !== 'client' || !!target.client);
    const state: Applicability = place.state === 'not-applicable' ? 'not-applicable' : open.length ? 'unknown' : 'applies';
    const pool = entry.obligation === 'recommended' ? added : after;
    const met = pool.map(claim => ({ claim, ...claimMeets(entry, claim, target) }));
    const matching = met.filter(item => item.match === 'matches').map(item => item.claim.managementId);
    const unknown = [...new Set([...(state === 'unknown' ? open : []), ...met.filter(item => item.match === 'unknown').flatMap(item => item.unknown)])];
    const ids = [...new Set(matching)].sort();
    if (entry.obligation === 'recommended') advisory.push({ entry: entry.id, status: ids.length && state !== 'not-applicable' ? 'taken' : 'not-taken',
      applicability: state, unknown, managementIds: ids });
    else fulfilment.push({ entry: entry.id, status: state === 'not-applicable' ? 'not-applicable' : ids.length && state === 'applies' ? 'fulfilled' :
      state === 'unknown' || unknown.length ? 'unknown' : 'not-fulfilled', unknown: state === 'not-applicable' ? [] : unknown, managementIds: ids });
  }
  return { advisory, fulfilment };
}

/** The label prefix the review shows for a signer the organization supplied that is not one of Core's defaults. */
export const ORGANIZATION_ADDED = 'organization-added: ';
/**
 * The allowed Scan signers: the defaults, replaced or extended by the organization (C35). Never a gate. A signer the
 * organization supplies that is not a default (by issuer and subject) is labelled `organization-added`, so it can't
 * borrow a default signer's name in the review.
 */
export function allowedSigners(defaults: readonly ScanSigner[], organization: Organization | undefined): ScanSigner[] {
  const signers = organization?.scanSigners;
  const defaultKeys = new Set(defaults.map(signer => `${signer.issuer} ${signer.subject}`));
  const label = (signer: ScanSigner): ScanSigner => defaultKeys.has(`${signer.issuer} ${signer.subject}`) ? structuredClone(signer) :
    { ...structuredClone(signer), identity: (ORGANIZATION_ADDED + (signer.identity ?? signer.subject)).slice(0, 2048) };
  const base = signers?.replace ? signers.replace.map(label) : defaults.map(signer => structuredClone(signer));
  const all = [...base, ...(signers?.add ?? []).map(label)];
  const seen = new Set<string>();
  return all.filter(signer => { const key = `${signer.issuer}\0${signer.subject}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
