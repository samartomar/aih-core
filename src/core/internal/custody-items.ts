// Internal custody items (ownership 1.6.0): what a person chose, per claim, beside the
// authoritative target-keyed members. Typed members are derived from those members on
// every seal, so they can never diverge from the claims, markers, modes and selectors
// that Core actually enforces. Restoration data stays inside protected custody.
import { canonicalJson } from './canonical.js';
import { RecipeEditError, configArrayMemberBytes, configMemberBytes, blockMemberBytes } from './recipe-editors.js';
import { locateHookGroups } from './hook-group.js';
import { sha256 } from './host-files.js';
import { sharedBlockMarker, sharedBlockRole } from './shared-blocks.js';
import type { Claim, MemberDescriptor } from './recipe-lifecycle.js';
import type { GitMaterialProvenance, InclusionOrigin, Json, SelectionMetadata } from '../types.js';
import type { Owner } from './state.js';
import { githubName } from './material-descriptors.js';

export type TypedMember =
  | { kind: 'file'; path: string; sha256: string; executable: boolean }
  | { kind: 'text-block'; file: string; blockId: string; sha256: string }
  | { kind: 'entry-block'; file: string; marker: string; sha256: string }
  | { kind: 'entry-pointer'; file: string; marker: string; sha256: string }
  | { kind: 'config-entry'; file: string; pointer: string; sha256: string }
  | { kind: 'config-member'; file: string; pointer: string; 'value-sha256': string }
  | { kind: 'hook-group-member'; file: string; selector: { path: (string | number)[]; valueSha256: string }; sha256: string }
  | { kind: 'approval-change'; tool: string; file: string; pointer: string };
/** Descriptive facts about one claimed selection; never operations or authority. */
export interface ItemFacts {
  managementId: string; scope: 'project' | 'user';
  name: string | null; kind: SelectionMetadata['kind'] | null; framework: string | null;
  item: SelectionMetadata['item'] | null; tool: string | null; origins: InclusionOrigin[];
  /** Project facts the consumer reviewed for this selection; redacted projection only ever shows them as facts. */
  projectFacts?: SelectionMetadata['projectFacts'];
  /** The exact git commit the selection's referenced recipe was last applied from; absent for every other source. */
  materialSource?: GitMaterialProvenance;
}
export interface CustodyItem extends ItemFacts {
  members: TypedMember[];
  /** Protected restoration data: the person's value found at an owned pointer before Core wrote it. */
  preExisting?: Record<string, { value: Json }>;
  /**
   * Set before an Apply's first effect for this selection (the pending receipt); cleared once all its reviewed
   * operations succeed. An interrupted item stays even before any member is written.
   */
  installState?: 'interrupted';
  /**
   * Members of a file effect Apply is attempting: written ahead of the commit and cleared with the custody published
   * after it. Only a crash between the two leaves an entry; `resolvePending` then reads the target to settle it.
   */
  pending?: PendingMember[];
  /** Publishable member paths, keyed by member, where a private input value formed part of the path. */
  redactedPaths?: Record<string, string>;
}
/**
 * A member a step is about to change: its custody once written (`null` when the step removes it), and for a write the
 * identity (device and inode) of the very file Apply publishes, so no later copy of the same bytes can stand in for it.
 */
export interface PendingMember { key: string; descriptor: MemberDescriptor; owner: Owner | null; identity?: string; redactedPath?: string; preExisting?: { value: Json } }
/** An interrupted install counts as a claim of its selection, also before it wrote a member. */
export const interruptedClaim = (item: Pick<CustodyItem, 'managementId' | 'scope'>): Claim =>
  ({ managementId: item.managementId, scope: item.scope, sets: [], requires: [] });
interface Owned { managementId: string; sha256: string; mode: number; descriptor?: MemberDescriptor; claims?: Claim[]; approval?: { tool: string } }
interface Custody { members: Record<string, Owned>; selections?: Record<string, Claim>; items?: Record<string, CustodyItem> }

const KINDS = ['skill', 'agent', 'command', 'rule', 'hook', 'mcp-server', 'document'];
/** An RFC 6901 JSON Pointer naming a configuration entry path. */
export const pointerOf = (segments: readonly string[]): string =>
  segments.map(segment => '/' + segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('');
/** The published kind of a target-keyed member. */
export function publicKind(descriptor: MemberDescriptor): 'file' | 'text-block' | 'entry-block' | 'entry-pointer' | 'config-entry' | 'config-member' | 'hook-group-member' {
  if (descriptor.kind === 'block') {
    const marker = sharedBlockMarker(descriptor.startMarker);
    if (marker === 'aih:shared') return 'entry-block';
    if (marker === 'aih:shared:pointer') return 'entry-pointer';
    return 'text-block';
  }
  return descriptor.kind === 'file' ? 'file' : descriptor.kind === 'entry' ? 'config-entry' :
    descriptor.kind === 'member' ? 'config-member' : 'hook-group-member';
}
/** The RFC 6901 pointer of an entry or of the array holding a member. */
export function memberPointer(descriptor: MemberDescriptor): string | undefined {
  return descriptor.kind === 'entry' ? pointerOf(descriptor.entry) : descriptor.kind === 'member' ? pointerOf(descriptor.container) : undefined;
}
/** A target-keyed member's typed custody; an approval Core wrote is also an `approval-change` at the same pointer. */
export function typedMembers(key: string, owner: Owned): TypedMember[] {
  const descriptor = owner.descriptor ?? { kind: 'file' as const, path: key };
  const approval = (pointer: string): TypedMember[] => owner.approval ? [{ kind: 'approval-change', tool: owner.approval.tool, file: descriptor.path, pointer }] : [];
  if (descriptor.kind === 'file') return [{ kind: 'file', path: descriptor.path, sha256: owner.sha256, executable: (owner.mode & 0o111) !== 0 }];
  if (descriptor.kind === 'block') {
    const role = sharedBlockRole(descriptor.startMarker, descriptor.endMarker);
    if (role === 'guidance') return [{ kind: 'entry-block', file: descriptor.path, marker: 'aih:shared', sha256: owner.sha256 }];
    if (role === 'pointer') return [{ kind: 'entry-pointer', file: descriptor.path, marker: 'aih:shared:pointer', sha256: owner.sha256 }];
    return [{ kind: 'text-block', file: descriptor.path, blockId: descriptor.blockId, sha256: owner.sha256 }];
  }
  if (descriptor.kind === 'entry') return [{ kind: 'config-entry', file: descriptor.path, pointer: pointerOf(descriptor.entry), sha256: owner.sha256 },
    ...approval(pointerOf(descriptor.entry))];
  if (descriptor.kind === 'member') return [{ kind: 'config-member', file: descriptor.path, pointer: pointerOf(descriptor.container),
    'value-sha256': descriptor.valueSha256 }, ...approval(pointerOf(descriptor.container))];
  return [{ kind: 'hook-group-member', file: descriptor.path, selector: { path: [...descriptor.selector.path], valueSha256: descriptor.selector.valueSha256 }, sha256: owner.sha256 }];
}

const claimed = (owner: Owned, scope: string, managementId: string): boolean =>
  !!owner.claims?.some(claim => claim.scope === scope && claim.managementId === managementId);
/** Target-keyed members a claim owns, in key order. */
export function claimedMembers(value: Custody, scope: string, managementId: string): [string, Owned][] {
  return Object.entries(value.members).filter(([, owner]) => claimed(owner, scope, managementId))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Refresh items against the authoritative members: drop an item no claim in this root
 * still names, re-derive its typed members and keep member-keyed data (restoration values
 * and redacted paths) with a claim that still owns the member. When the recording claim goes
 * while another claim keeps the member, that data moves to the remaining claim's item, so the
 * last removal can still restore the value and the path stays redacted.
 */
export function refreshItems(value: Custody, identity: (scope: 'project' | 'user', managementId: string) => string): Record<string, CustodyItem> | undefined {
  if (!value.items) return undefined;
  const items: Record<string, CustodyItem> = {};
  const orphaned = { preExisting: {} as Record<string, { value: Json }>, redactedPaths: {} as Record<string, string> };
  for (const [id, item] of Object.entries(value.items)) {
    const owned = claimedMembers(value, item.scope, item.managementId);
    const keys = new Set(owned.map(([key]) => key));
    for (const field of ['preExisting', 'redactedPaths'] as const)
      for (const [key, entry] of Object.entries(item[field] ?? {})) if (!keys.has(key) && value.members[key]) (orphaned[field] as Record<string, unknown>)[key] ??= entry;
    if (!owned.length && !value.selections?.[id] && !item.installState) continue;
    const kept = <T>(record?: Record<string, T>) => Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => keys.has(key)));
    const preExisting = kept(item.preExisting), redactedPaths = kept(item.redactedPaths);
    const { preExisting: _prior, redactedPaths: _paths, ...facts } = item;
    items[id] = { ...facts, members: owned.flatMap(([key, owner]) => typedMembers(key, owner)),
      ...(Object.keys(preExisting).length ? { preExisting } : {}), ...(Object.keys(redactedPaths).length ? { redactedPaths } : {}) };
  }
  for (const field of ['preExisting', 'redactedPaths'] as const) for (const [key, entry] of Object.entries(orphaned[field])) {
    const claim = value.members[key]!.claims?.[0];
    if (!claim) continue;
    const id = identity(claim.scope, claim.managementId);
    const heir: CustodyItem = items[id] ?? { managementId: claim.managementId, scope: claim.scope, name: null, kind: null, framework: null, item: null,
      tool: null, origins: [], members: claimedMembers(value, claim.scope, claim.managementId).flatMap(([member, owner]) => typedMembers(member, owner)) };
    const record = { ...(heir[field] as Record<string, unknown> | undefined) };
    record[key] ??= entry;
    items[id] = { ...heir, [field]: record };
  }
  return Object.keys(items).length ? items : undefined;
}

const text = (value: unknown, bound: number): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= bound;
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: string[], optional: string[] = []): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && keys.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
function validOrigin(value: unknown): boolean {
  if (exact(value, ['reasonIncluded']) && value.reasonIncluded === 'chosen') return true;
  if (exact(value, ['reasonIncluded', 'set'], ['options']) && value.reasonIncluded === 'in-set')
    return exact(value.set, ['framework', 'setId', 'setSha256']) && text(value.set.framework, 128) && text(value.set.setId, 128) && hex(value.set.setSha256) &&
      (value.options === undefined || exact(value.options, []) || !!value.options && typeof value.options === 'object' && !Array.isArray(value.options) &&
        Object.values(value.options).every(choice => Array.isArray(choice) && choice.length <= 64 && choice.every(entry => text(entry, 128))));
  return exact(value, ['reasonIncluded', 'requiredBy']) && value.reasonIncluded === 'required-by' &&
    exact(value.requiredBy, ['itemId'], ['framework']) && text(value.requiredBy.itemId, 128) &&
    (value.requiredBy.framework === undefined || text(value.requiredBy.framework, 128));
}

function validProvenance(value: unknown): boolean {
  if (!exact(value, ['kind', 'repository', 'commit', 'identity']) || value.kind !== 'git' ||
      typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)) return false;
  const name = githubName(value.repository);
  return !!name && value.identity === `${name.owner}/${name.repo}@${value.commit}`;
}
/** Reviewed project facts recorded with a selection; the vocabulary Core renders into Project basics. */
export function validProjectFacts(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  const FACT_FIELD = /^[a-z][A-Za-z0-9]{0,63}$/;
  return value.every(fact => exact(fact, ['field', 'value', 'confidence']) && typeof fact.field === 'string' &&
    FACT_FIELD.test(fact.field) && typeof fact.value === 'string' && fact.value.length > 0 && fact.value.length <= 256 &&
    (fact.confidence === 'detected' || fact.confidence === 'inferred'));
}

/** Strict item validation: facts are well formed and typed members equal the derived custody. */
export function validItems(value: Custody, identity: (scope: 'project' | 'user', managementId: string) => string): boolean {
  const items = value.items as unknown;
  if (!items || typeof items !== 'object' || Array.isArray(items) || Object.keys(items).length === 0 || Object.keys(items).length > 4096) return false;
  for (const [id, item] of Object.entries(items as Record<string, unknown>)) {
    if (!exact(item, ['managementId', 'scope', 'name', 'kind', 'framework', 'item', 'tool', 'origins', 'members'],
        ['preExisting', 'installState', 'redactedPaths', 'pending', 'materialSource', 'projectFacts']) ||
        item.installState !== undefined && item.installState !== 'interrupted') return false;
    // Pending members belong to an interrupted install; their owners are validated with the receipt's members.
    if (item.pending !== undefined && (item.installState !== 'interrupted' || !Array.isArray(item.pending) || item.pending.length === 0 || item.pending.length > 8192 ||
        !item.pending.every(entry => exact(entry, ['key', 'descriptor', 'owner'], ['identity', 'redactedPath', 'preExisting']) && text(entry.key, 8192) &&
          (entry.identity === undefined ? entry.owner === null : typeof entry.identity === 'string' && /^\d{1,40}:\d{1,40}$/.test(entry.identity)) &&
          (entry.redactedPath === undefined || text(entry.redactedPath, 4096)) && (entry.preExisting === undefined || exact(entry.preExisting, ['value']))))) return false;
    if (!text(item.managementId, 128) || !['project', 'user'].includes(item.scope as string) || identity(item.scope as 'project' | 'user', item.managementId) !== id) return false;
    if (item.name !== null && !text(item.name, 512) || item.kind !== null && !KINDS.includes(item.kind as string) ||
        item.framework !== null && !text(item.framework, 128) || item.tool !== null && !text(item.tool, 128)) return false;
    if (item.item !== null && !(exact(item.item, ['framework', 'itemId', 'contentSha256', 'behaviourSha256']) && text(item.item.framework, 128) &&
        text(item.item.itemId, 128) && hex(item.item.contentSha256) && hex(item.item.behaviourSha256) && item.item.framework === item.framework)) return false;
    if (!Array.isArray(item.origins) || item.origins.length > 256 || !item.origins.every(validOrigin)) return false;
    if (item.materialSource !== undefined && !validProvenance(item.materialSource)) return false;
    if (!validProjectFacts(item.projectFacts)) return false;
    const owned = claimedMembers(value, item.scope as string, item.managementId);
    if (!owned.length && !value.selections?.[id] && item.installState !== 'interrupted') return false;
    if (!Array.isArray(item.members) || item.members.length > 8192) return false;
    if (canonicalJson(item.members) !== canonicalJson(owned.flatMap(([key, owner]) => typedMembers(key, owner)))) return false;
    if (item.preExisting !== undefined) {
      const restorable = new Set(owned.filter(([, owner]) => owner.descriptor?.kind === 'entry' && ['json', 'jsonc'].includes(owner.descriptor.format)).map(([key]) => key));
      if (!item.preExisting || typeof item.preExisting !== 'object' || Array.isArray(item.preExisting) || Object.keys(item.preExisting).length === 0 ||
          !Object.entries(item.preExisting).every(([key, entry]) => restorable.has(key) && exact(entry, ['value']))) return false;
    }
    if (item.redactedPaths !== undefined) {
      const keys = new Set(owned.map(([key]) => key));
      if (!item.redactedPaths || typeof item.redactedPaths !== 'object' || Array.isArray(item.redactedPaths) || Object.keys(item.redactedPaths).length === 0 ||
          !Object.entries(item.redactedPaths).every(([key, path]) => keys.has(key) && text(path, 4096))) return false;
    }
  }
  return true;
}

/** The publishable path recorded for a member whose path holds a private input value, if any. */
export function redactedPathFor(value: Custody, key: string): string | undefined {
  for (const item of Object.values(value.items ?? {})) if (item.redactedPaths && Object.hasOwn(item.redactedPaths, key)) return item.redactedPaths[key];
  return undefined;
}
/** Restoration data recorded for an owned member in this root, if any. */
export function preExistingFor(value: Custody, key: string): { value: Json } | undefined {
  for (const item of Object.values(value.items ?? {})) if (item.preExisting && Object.hasOwn(item.preExisting, key)) return item.preExisting[key];
  return undefined;
}

export type MemberCheck = 'present-matching' | 'present-different' | 'absent' | 'unchecked';
type Located = string | null | 'different';
/** The selected member's digest in `bytes`: absent (`null`), its digest, or present but not uniquely selectable. */
export function locateMember(descriptor: MemberDescriptor, bytes: Buffer | null): Located {
  if (bytes === null) return null;
  try {
    if (descriptor.kind === 'file') return sha256(bytes);
    if (descriptor.kind === 'entry') { const member = configMemberBytes(descriptor.format, bytes, descriptor.entry); return member === null ? null : sha256(member); }
    if (descriptor.kind === 'block') { const member = blockMemberBytes(bytes, { ...descriptor, action: 'remove' }); return member === null ? null : sha256(member); }
    if (descriptor.kind === 'member') { const member = configArrayMemberBytes(descriptor.format, bytes, descriptor.container, descriptor.valueSha256); return member === null ? null : sha256(member); }
    const found = locateHookGroups(descriptor.format, bytes, descriptor.container, descriptor.selector);
    return found.candidates.length === 0 ? null : found.candidates.length === 1 ? found.candidates[0]!.rawSha256 : 'different';
  } catch (error) {
    if (error instanceof RecipeEditError) return 'different';
    throw error;
  }
}
/** Compare the live member with its expected state; `expected === null` expects absence. */
export function checkMember(descriptor: MemberDescriptor, live: { state: 'present' | 'absent' | 'unreadable'; bytes?: Buffer },
  expected: string | null): MemberCheck {
  if (live.state === 'unreadable') return 'unchecked';
  let found: Located;
  try { found = locateMember(descriptor, live.state === 'present' ? live.bytes! : null); } catch { return 'unchecked'; }
  if (found === null) return 'absent';
  return expected !== null && found === expected ? 'present-matching' : 'present-different';
}

/**
 * Record a selection's facts in a root. Described facts replace earlier ones; a run without a description keeps them.
 * The first restoration value recorded for a member wins, so a later replacement never hides the person's original.
 * `installing` marks the selection interrupted until `completeItem` runs for it.
 */
export function upsertItem(value: Custody, item: { id: string; named: boolean; facts: ItemFacts },
  record: { preExisting?: Record<string, Json>; redactedPaths?: Record<string, string>; installing?: boolean } = {}): void {
  const prior = value.items?.[item.id];
  const restoration = { ...Object.fromEntries(Object.entries(record.preExisting ?? {}).map(([key, entry]) => [key, { value: entry }])), ...prior?.preExisting };
  const redactedPaths = { ...prior?.redactedPaths, ...record.redactedPaths };
  const facts = item.named || !prior ? item.facts : prior;
  // Provenance always follows the recipe source of the latest run, described or not.
  const source = item.facts.materialSource;
  value.items = { ...value.items, [item.id]: { managementId: facts.managementId, scope: facts.scope, name: facts.name, kind: facts.kind,
    framework: facts.framework, item: facts.item, tool: facts.tool, origins: facts.origins,
    ...(facts.projectFacts ? { projectFacts: facts.projectFacts } : {}),
    ...(source ? { materialSource: source } : {}), members: prior?.members ?? [],
    ...(Object.keys(restoration).length ? { preExisting: restoration } : {}),
    ...(Object.keys(redactedPaths).length ? { redactedPaths } : {}),
    ...(record.installing || prior?.installState ? { installState: 'interrupted' as const } : {}),
    ...(prior?.pending ? { pending: prior.pending } : {}) } };
}
/**
 * Mark a selection's install complete in this root; reports whether anything changed. An item that only carried the
 * interrupted state (no described facts or protected data) goes with it, so undescribed selections keep their format.
 */
export function completeItem(value: Custody, id: string): boolean {
  const item = value.items?.[id];
  if (!item?.installState) return false;
  const { installState: _done, pending: _pending, ...rest } = item;
  const items = { ...value.items, [id]: rest };
  if (rest.name === null && rest.kind === null && rest.item === null && rest.tool === null && !rest.origins.length && !rest.materialSource && !rest.preExisting && !rest.redactedPaths)
    delete items[id];
  value.items = items;
  return true;
}
/** Record the members a file effect is about to change, before it commits. */
export function attemptItem(value: Custody, id: string, entries: PendingMember[]): void {
  const item = value.items?.[id];
  if (!item || !entries.length) return;
  const keys = new Set(entries.map(entry => entry.key));
  value.items = { ...value.items, [id]: { ...item, installState: 'interrupted', pending: [...(item.pending ?? []).filter(entry => !keys.has(entry.key)), ...entries] } };
}
/** Clear pending members whose custody was just published. */
export function settleItem(value: Custody, id: string, keys: readonly string[]): void {
  const item = value.items?.[id];
  if (!item?.pending) return;
  const pending = item.pending.filter(entry => !keys.includes(entry.key));
  const { pending: _prior, ...rest } = item;
  value.items = { ...value.items, [id]: pending.length ? { ...rest, pending } : rest };
}
/**
 * Removal releases an interrupted install: its pending members go, and the item goes once no claim or selection
 * record keeps it. Kept members leave it listed and still interrupted.
 */
export function releaseItem(value: Custody, id: string): void {
  const item = value.items?.[id];
  if (!item) return;
  settleItem(value, id, (item.pending ?? []).map(entry => entry.key));
  if (claimedMembers(value, item.scope, item.managementId).length || value.selections?.[id]) return;
  const items = { ...value.items }; delete items[id];
  value.items = items;
}
/**
 * Settle members a crash left pending between a file effect and its custody. A written member is the very file the
 * effect published (same identity) holding exactly the bytes it wrote; a removed one is gone. Only then is its custody
 * published here; anything else was not written by Core and is dropped, so a later copy of the same bytes never counts.
 * A target that cannot be read keeps its entry for a later read. Returns whether anything changed.
 */
export function resolvePending(value: Custody,
  inspect: (path: string) => { state: 'present' | 'absent' | 'unreadable'; bytes?: Buffer; identity?: string }): boolean {
  // One read per file: a step's members share it.
  const reads = new Map<string, ReturnType<typeof inspect>>();
  const read = (path: string) => { let found = reads.get(path); if (!found) reads.set(path, found = inspect(path)); return found; };
  let changed = false;
  for (const [id, item] of Object.entries(value.items ?? {})) {
    if (!item.pending) continue;
    const kept: PendingMember[] = [];
    let preExisting = item.preExisting, redactedPaths = item.redactedPaths;
    for (const entry of item.pending) {
      let found: Located, identity: string | undefined;
      try {
        const live = read(entry.descriptor.path);
        if (live.state === 'unreadable') { kept.push(entry); continue; }
        found = locateMember(entry.descriptor, live.state === 'present' ? live.bytes! : null); identity = live.identity;
      } catch { kept.push(entry); continue; }
      changed = true;
      // A file system without inode numbers gives no identity to bind to, so nothing is promoted there.
      if (entry.owner ? !entry.identity || entry.identity.endsWith(':0') || identity !== entry.identity || found !== entry.owner.sha256 : found !== null) continue;
      if (entry.owner) value.members[entry.key] = entry.owner; else delete value.members[entry.key];
      if (entry.preExisting && !preExisting?.[entry.key]) preExisting = { ...preExisting, [entry.key]: entry.preExisting };
      if (entry.redactedPath) redactedPaths = { ...redactedPaths, [entry.key]: entry.redactedPath };
    }
    if (kept.length === item.pending.length) continue;
    const { pending: _prior, preExisting: _values, redactedPaths: _paths, ...rest } = item;
    value.items = { ...value.items, [id]: { ...rest, ...(preExisting ? { preExisting } : {}), ...(redactedPaths ? { redactedPaths } : {}), ...(kept.length ? { pending: kept } : {}) } };
  }
  return changed;
}
