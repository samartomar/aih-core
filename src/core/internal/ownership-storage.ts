// Ownership 1.7.0 storage: the bytes of a record hold what 1.6.0 holds, without what the record derives from itself.
// A record in memory is the same in both; only `storedOwnership` and `expandOwnership` see the stored form.
//
// One installed pick writes a copy of each Catalog item per tool, and each copy owns a member per file. Version 1.6.0
// repeated per member what its selection already records, and per copy what the Catalog item already says:
// - a file member's descriptor `{ path, kind: 'file' }`, whose path is the member's key;
// - each member claim's management ID (the owner's) and its sets and requires (those of its selection record);
// - each item's typed members, which `validItems` requires to equal those derived from the members;
// - each copy's Catalog facts (name, kind, framework, Catalog item and origins).
// Version 1.7.0 leaves each of those out, and stores item facts once in `facts`. Expansion restores exactly the 1.6.0
// data, and a record is admitted only when its bytes are the one stored form of that data.
import type { Claim } from './recipe-lifecycle.js';
import type { Ownership, Owner } from './state.js';
import { itemMembersOf } from './custody-items.js';

export const OWNERSHIP_17 = 'urn:aihq:core:ownership:1.7.0';
const FACTS = ['name', 'kind', 'framework', 'item', 'origins'] as const;
type Stored = Record<string, unknown>;

const isRecord = (value: unknown): value is Stored => !!value && typeof value === 'object' && !Array.isArray(value);
const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((entry, index) => entry === b[index]);
const invalid = (): never => { throw new Error('ownership-invalid'); };

/**
 * The selection records by scope and management ID. Validation keys each record by the claim identity of exactly these
 * two, so this finds the same record as that key without depending on the home folder.
 */
function recordedClaims(selections: unknown): Map<string, Claim> {
  const recorded = new Map<string, Claim>();
  if (isRecord(selections)) for (const claim of Object.values(selections))
    if (isRecord(claim) && typeof claim.scope === 'string' && typeof claim.managementId === 'string' && Array.isArray(claim.sets) && Array.isArray(claim.requires))
      recorded.set(`${claim.scope}\0${claim.managementId}`, claim as unknown as Claim);
  return recorded;
}
const fileAt = (key: string, descriptor: unknown): boolean => isRecord(descriptor) && Object.keys(descriptor).length === 2 &&
  descriptor.path === key && descriptor.kind === 'file';

/** The bytes-to-be of a sealed record: 1.7.0 without its derivable data, every earlier version as it is. */
export function storedOwnership(value: Ownership): Stored {
  if (value.schema !== OWNERSHIP_17) return value as unknown as Stored;
  const recorded = recordedClaims(value.selections);
  const members: Stored = {};
  for (const [key, owner] of Object.entries(value.members)) {
    const stored: Stored = {};
    for (const [field, data] of Object.entries(owner)) {
      if (field === 'descriptor' && fileAt(key, data)) continue;
      stored[field] = field === 'claims' ? (data as Claim[]).map(claim => storedClaim(claim, owner, recorded)) : data;
    }
    members[key] = stored;
  }
  const facts: unknown[] = []; const shared = new Map<string, number>();
  let items: Stored | undefined;
  if (value.items) {
    items = {};
    for (const [id, item] of Object.entries(value.items)) {
      const fact = Object.fromEntries(FACTS.map(field => [field, item[field]]));
      const text = JSON.stringify(fact);
      let index = shared.get(text);
      if (index === undefined) { shared.set(text, index = facts.length); facts.push(fact); }
      // Expansion puts the claim fields first, so the stored item does too: one record has one stored form.
      const stored: Stored = { facts: index, managementId: item.managementId, scope: item.scope };
      for (const [field, data] of Object.entries(item)) if (field !== 'members' && !(FACTS as readonly string[]).includes(field)) stored[field] = data;
      items[id] = stored;
    }
  }
  const result: Stored = {};
  for (const [field, data] of Object.entries(value)) result[field] = field === 'members' ? members : field === 'items' ? items : data;
  if (items) result.facts = facts;
  return result;
}
function storedClaim(claim: Claim, owner: Owner, recorded: Map<string, Claim>): Stored {
  const selection = recorded.get(`${claim.scope}\0${claim.managementId}`);
  const derived = selection ? sameList(selection.sets, claim.sets) && sameList(selection.requires, claim.requires) : !claim.sets.length && !claim.requires.length;
  return { ...(claim.managementId === owner.managementId ? {} : { managementId: claim.managementId }), scope: claim.scope,
    ...(derived ? {} : { sets: claim.sets, requires: claim.requires }) };
}

/**
 * The record a parsed 1.7.0 receipt holds, every earlier version as it is. Anything malformed is left for validation to
 * refuse, or refused here when it cannot be expanded.
 */
export function expandOwnership(stored: Stored): Stored {
  if (stored.schema !== OWNERSHIP_17) return stored;
  if (!isRecord(stored.members) || Object.hasOwn(stored, 'facts') !== Object.hasOwn(stored, 'items')) invalid();
  const recorded = recordedClaims(stored.selections);
  const members: Record<string, Stored> = {};
  for (const [key, owner] of Object.entries(stored.members as Stored)) {
    if (!isRecord(owner)) invalid();
    const expanded: Stored = {};
    for (const [field, data] of Object.entries(owner as Stored)) {
      if (field !== 'claims') { expanded[field] = data; continue; }
      if (!Array.isArray(data)) invalid();
      if (!Object.hasOwn(owner as Stored, 'descriptor')) expanded.descriptor = { path: key, kind: 'file' };
      expanded.claims = (data as unknown[]).map(claim => expandClaim(claim, (owner as Stored).managementId, recorded));
    }
    members[key] = expanded;
  }
  let items: Record<string, Stored> | undefined;
  if (Object.hasOwn(stored, 'items')) {
    const facts = stored.facts;
    if (!isRecord(stored.items) || !Array.isArray(facts) || !facts.every(fact => isRecord(fact) && Object.keys(fact).length === FACTS.length &&
        FACTS.every(field => Object.hasOwn(fact, field)))) invalid();
    items = {};
    for (const [id, item] of Object.entries(stored.items as Stored)) {
      if (!isRecord(item) || !Number.isSafeInteger(item.facts) || (item.facts as number) < 0 || (item.facts as number) >= (facts as unknown[]).length ||
          Object.hasOwn(item, 'members') || FACTS.some(field => Object.hasOwn(item, field))) invalid();
      const { facts: index, ...rest } = item as Stored;
      items[id] = { managementId: rest.managementId, scope: rest.scope, ...(facts as Stored[])[index as number], ...rest };
    }
  }
  const result: Stored = {};
  for (const [field, data] of Object.entries(stored)) if (field !== 'facts') result[field] = field === 'members' ? members : field === 'items' ? items : data;
  // Typed members are derived from the expanded members, as every seal derives them.
  if (items) {
    const owned = itemMembersOf(result as unknown as Ownership);
    for (const item of Object.values(items)) {
      if (typeof item.scope !== 'string' || typeof item.managementId !== 'string') invalid();
      item.members = owned(item.scope as string, item.managementId as string);
    }
  }
  return result;
}
function expandClaim(claim: unknown, owner: unknown, recorded: Map<string, Claim>): Stored {
  if (!isRecord(claim) || Object.keys(claim).some(key => !['managementId', 'scope', 'sets', 'requires'].includes(key)) ||
      Object.hasOwn(claim, 'sets') !== Object.hasOwn(claim, 'requires')) invalid();
  const managementId = Object.hasOwn(claim as Stored, 'managementId') ? (claim as Stored).managementId : owner;
  const selection = recorded.get(`${String((claim as Stored).scope)}\0${String(managementId)}`);
  return { managementId, scope: (claim as Stored).scope,
    sets: Object.hasOwn(claim as Stored, 'sets') ? (claim as Stored).sets : [...(selection?.sets ?? [])],
    requires: Object.hasOwn(claim as Stored, 'requires') ? (claim as Stored).requires : [...(selection?.requires ?? [])] };
}

/** A sealed record's stored text: what is written, measured against the bound and digested. */
export const ownershipText = (value: Ownership): string => JSON.stringify(storedOwnership(value));
