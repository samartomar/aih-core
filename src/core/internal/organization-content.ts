// Organization policy 1.2.0 content selectors: portable matching and overlap over supplied facts only.
// Set membership is Catalog's and arrives as data; a set without supplied members is `unavailable`, never guessed.
import { canonicalJson } from './canonical.js';
import type { CatalogItemRef, CatalogSetRef, OrganizationContentSelector, OrganizationPolicy, OrganizationSelection12,
  OrganizationSetMembers, SelectionMetadata } from '../types.js';

type Kind = SelectionMetadata['kind'];
type Member = CatalogItemRef & { kind?: Kind };
/** A selection's declared content facts; an absent fact is unknown, never inferred. */
export interface ContentFacts { kind?: Kind; item?: CatalogItemRef }
export type ContentMatch = 'matches' | 'mismatch' | 'unknown' | 'unavailable';
/** `yes` only when supplied facts prove shared content; `unknown` when an item's kind is not known; never guessed. */
export type ContentOverlap = 'yes' | 'no' | 'unknown' | 'unavailable';

const KINDS: readonly Kind[] = ['skill', 'agent', 'command', 'rule', 'hook', 'mcp-server', 'document'];
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SETS = 4096; const MAX_MEMBERS = 65536;
const itemKey = (item: CatalogItemRef): string => canonicalJson([item.framework, item.itemId]);
const setKey = (set: CatalogSetRef): string => canonicalJson([set.framework, set.setId, set.setSha256]);
const plain = (value: unknown, keys: string[], required: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key));
const catalogId = (value: unknown): boolean => typeof value === 'string' && value.length <= 128 && CATALOG_ID.test(value);
const validSet = (value: unknown): value is CatalogSetRef => plain(value, ['framework', 'setId', 'setSha256'], ['framework', 'setId', 'setSha256']) &&
  catalogId(value.framework) && catalogId(value.setId) && typeof value.setSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.setSha256);
const validMember = (value: unknown): value is Member => plain(value, ['framework', 'itemId', 'kind'], ['framework', 'itemId']) &&
  catalogId(value.framework) && catalogId(value.itemId) && (value.kind === undefined || KINDS.includes(value.kind as Kind));

/** Supplied Catalog-resolved membership, by exact set identity. */
export class SetMembership {
  private readonly sets = new Map<string, Map<string, Member>>();
  /** Throws on malformed or duplicated data; callers report that as invalid supplied membership. */
  constructor(setMembers: unknown) {
    if (setMembers === undefined) return;
    if (!Array.isArray(setMembers) || setMembers.length > MAX_SETS) throw new TypeError('set-members');
    let total = 0;
    for (const entry of setMembers) {
      if (!plain(entry, ['set', 'members'], ['set', 'members']) || !validSet(entry.set) || !Array.isArray(entry.members))
        throw new TypeError('set-members');
      const key = setKey(entry.set);
      if (this.sets.has(key)) throw new TypeError('set-members');
      total += entry.members.length;
      if (total > MAX_MEMBERS) throw new TypeError('set-members');
      const members = new Map<string, Member>();
      for (const member of entry.members) {
        if (!validMember(member) || members.has(itemKey(member))) throw new TypeError('set-members');
        members.set(itemKey(member), { framework: member.framework, itemId: member.itemId, ...(member.kind ? { kind: member.kind } : {}) });
      }
      this.sets.set(key, members);
    }
  }
  members(set: CatalogSetRef): ReadonlyMap<string, Member> | undefined { return this.sets.get(setKey(set)); }
}

/** Organization 1.2.0 entries; earlier documents have none with content. */
export const contentEntries = (organization: OrganizationPolicy): OrganizationSelection12[] =>
  organization.schema === 'urn:aihq:core:organization-policy:1.2.0' ? organization.selections : [];

/** Every named field must match a declared fact. A declared mismatch wins; then missing membership, then an undeclared fact. */
export function matchContent(selector: OrganizationContentSelector, facts: ContentFacts, membership: SetMembership): ContentMatch {
  let unknown = false; let unavailable = false;
  if (selector.kind !== undefined) {
    if (facts.kind === undefined) unknown = true; else if (facts.kind !== selector.kind) return 'mismatch';
  }
  for (const framework of [selector.framework, selector.item?.framework]) if (framework !== undefined) {
    if (facts.item === undefined) unknown = true; else if (facts.item.framework !== framework) return 'mismatch';
  }
  if (selector.item !== undefined && facts.item !== undefined && itemKey(selector.item) !== itemKey(facts.item)) return 'mismatch';
  if (selector.set !== undefined) {
    const members = membership.members(selector.set);
    if (members === undefined) unavailable = true;
    else if (facts.item === undefined) unknown = true;
    else if (!members.has(itemKey(facts.item))) return 'mismatch';
  }
  return unavailable ? 'unavailable' : unknown ? 'unknown' : 'matches';
}

/** An upper bound on the items a selector can match (`null` is unbounded), and whether a set's members were missing. */
function candidates(selector: OrganizationContentSelector, membership: SetMembership): { items: Member[] | null; unavailable: boolean } {
  let items: Member[] | null = selector.item ? [selector.item] : null; let unavailable = false;
  if (selector.set !== undefined) {
    const members = membership.members(selector.set);
    if (members === undefined) unavailable = true;
    else items = items ? items.filter(item => members.has(itemKey(item))).map(item => members.get(itemKey(item))!) : [...members.values()];
  }
  return { items, unavailable };
}
const frameworks = (selector: OrganizationContentSelector): Set<string> =>
  new Set([selector.framework, selector.item?.framework].filter((value): value is string => value !== undefined));
const admits = (selector: OrganizationContentSelector, member: Member): boolean =>
  (selector.kind === undefined || member.kind === undefined || member.kind === selector.kind) &&
  [...frameworks(selector)].every(framework => member.framework === framework);

/** Whether two selectors select shared content: `no` when supplied facts rule it out, `yes` only when they prove it. */
export function contentOverlap(left: OrganizationContentSelector, right: OrganizationContentSelector, membership: SetMembership): ContentOverlap {
  if (left.kind !== undefined && right.kind !== undefined && left.kind !== right.kind) return 'no';
  const named = new Set([...frameworks(left), ...frameworks(right)]);
  if (named.size > 1) return 'no';
  const a = candidates(left, membership); const b = candidates(right, membership);
  // The same set selected on both sides overlaps with itself whatever its members are, unless an item narrows a side.
  if (left.set && right.set && !left.item && !right.item && setKey(left.set) === setKey(right.set)) a.unavailable = b.unavailable = false;
  const leftItems = a.items?.filter(item => admits(left, item) && admits(right, item));
  const rightItems = b.items?.filter(item => admits(left, item) && admits(right, item));
  if (leftItems?.length === 0 || rightItems?.length === 0) return 'no';
  const shared = leftItems && rightItems ? leftItems.flatMap(item => {
    const other = rightItems.find(candidate => itemKey(candidate) === itemKey(item));
    return other ? [{ ...item, ...(item.kind ?? other.kind ? { kind: item.kind ?? other.kind } : {}) }] : [];
  }) : leftItems ?? rightItems;
  if (shared?.length === 0) return 'no';
  if (a.unavailable || b.unavailable) return 'unavailable';
  // A named kind over specific items overlaps only where an item's supplied kind is that kind.
  const kind = left.kind ?? right.kind;
  return kind === undefined || shared === undefined || shared.some(item => item.kind === kind) ? 'yes' : 'unknown';
}

/**
 * Whether two entries govern overlapping content. Different recipe identities never overlap. A recipe-only entry and a
 * content-only entry cannot be compared while authoring (a recipe identity names no content); runtime prohibition
 * enforcement still applies to the selections they meet.
 */
export function entriesOverlap(left: OrganizationSelection12, right: OrganizationSelection12, membership: SetMembership): ContentOverlap {
  if (left.recipeIdentity !== undefined && right.recipeIdentity !== undefined) {
    if (left.recipeIdentity !== right.recipeIdentity) return 'no';
    return contentOverlap(left.content ?? {}, right.content ?? {}, membership);
  }
  return left.content && right.content ? contentOverlap(left.content, right.content, membership) : 'no';
}
