import { performance } from 'node:perf_hooks';
import { join, relative } from 'node:path';
import { isProxy } from 'node:util/types';
import { installedDistribution } from './internal/installed-distribution.js';
import { projectRoot, userHomeRoot } from './internal/host-files.js';
import { readOwnership, readOwnershipReceipts, stateRoot } from './internal/state.js';
import type { Ownership } from './internal/state.js';
import { type Claim } from './internal/recipe-lifecycle.js';
import type { Diagnostic } from './types.js';
import { readTrustCustody, readPendingTrust, pendingEntries, readTrustOwner } from './internal/trust-custody.js';
import { readMacosCustody, sessionFilesMatch } from './internal/macos-session-custody.js';
import { checkMember, memberPointer, publicKind, type CustodyItem } from './internal/custody-items.js';
import { transaction } from './recipe-engine.js';
import { validateOrganizationPolicy } from './contracts.js';
import { approvalGiven, bindingApprovalLocation, bindingPermissionStep } from '../harness/delivery-review.mjs';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { Owner } from './internal/state.js';
import type { CatalogItemRef, InclusionOrigin, OrganizationPolicy, SelectionMetadata } from './types.js';

const SCHEMA = 'urn:aihq:core:managed-inventory-result:1.0.0' as const;
const SCHEMA_11 = 'urn:aihq:core:managed-inventory-result:1.1.0' as const;
const CHECK_BUDGET_BYTES = 64 * 1024 * 1024;
const DEFAULT_BUDGET_MS = 30000;

export interface ManagedInventoryRequest {
  target: { project: string };
  scope: 'project' | 'user' | 'both';
  /** Select inventory 1.1.0; omitted keeps 1.0.0. */
  format?: typeof SCHEMA_11;
  /** Inventory 1.1.0: the consumer's complete current index, from which `updateState` is derived. */
  index?: ManagedInventoryIndex;
  /** Inventory 1.1.0, Enterprise only: the organization document whose admission `policyState` reports. */
  organization?: { document: OrganizationPolicy };
}
/** Consumer-supplied index and supersession data; Core never reads a Catalog itself. */
export interface ManagedInventoryIndex {
  /** Every item version the index currently offers. */
  offered: SelectionMetadata['item'][];
  /** Revoked items; identities, when given, narrow the revocation to that exact version. */
  revoked?: (CatalogItemRef & { contentSha256?: string; behaviourSha256?: string })[];
  superseded?: { item: CatalogItemRef; by: CatalogItemRef }[];
}
export interface ManagedInventoryControls { signal?: AbortSignal; budgetMs?: number }
export interface ManagedInventorySelection {
  managementId: string;
  scope: 'project' | 'user';
  custody: 'claim' | 'legacy-reconcile';
  memberCount: number;
  sharedMemberCount: number;
}
export interface ManagedInventoryMember {
  kind: 'file' | 'text-block' | 'config-entry' | 'config-member' | 'hook-group-member';
  path: string; pointer?: string; blockId?: string; groupId?: string;
  fileState: 'matches' | 'changed' | 'missing' | 'unchecked' | 'block-changed' | 'block-missing';
}
/** Inventory 1.1.0: a redacted projection of protected custody; no digest, previous value or approval value. */
export interface ManagedInventorySelection11 extends ManagedInventorySelection {
  name: string | null; kind: SelectionMetadata['kind'] | null; framework: string | null;
  item: SelectionMetadata['item'] | null; tool: string | null; origins: InclusionOrigin[];
  members: ManagedInventoryMember[];
  updateState: 'current' | 'update-available' | 'no-longer-offered' | 'superseded' | 'revoked' | 'unknown';
  policyState?: 'required' | 'recommended' | 'permitted' | 'prohibited' | 'not-admitted' | 'unknown';
  approval: 'needed' | 'not-needed' | 'granted-by-aih' | null;
  installState: 'complete' | 'interrupted';
}
export interface ManagedInventoryResult11 extends Omit<ManagedInventoryResult, 'schema' | 'selections' | 'limits'> {
  schema: typeof SCHEMA_11;
  selections: ManagedInventorySelection11[];
  limits: ManagedInventoryResult['limits'] & { checkedBytes: number; checkBudgetBytes: number };
}
export interface ManagedInventoryResult {
  schema: typeof SCHEMA;
  package: { name: string; version: string };
  status: 'complete' | 'incomplete' | 'invalid' | 'cancelled';
  target?: { project: string };
  scope?: ManagedInventoryRequest['scope'];
  selections: ManagedInventorySelection[];
  diagnostics: Diagnostic[];
  limits: { receiptCount: number; receiptBytes: number; elapsedMs: number; budgetMs: number };
}

const diagnostic = (code: string, reason: string, message: string): Diagnostic => ({ code, reason, message });

interface Collected { members: { root: string; key: string; owner: Owner }[]; items: CustodyItem[] }
/** Per root and member key, the publishable path of a member whose path holds a private input value. */
type RedactedPaths = Map<string, string>;
function addClaims(rows: Map<string, ManagedInventorySelection>, ownership: Ownership,
  project: string, home: string, scope: ManagedInventoryRequest['scope'], ambiguous: () => void,
  collected?: Map<string, Collected>, redacted?: RedactedPaths): void {
  const collect = (key: string): Collected => { let entry = collected!.get(key); if (!entry) collected!.set(key, entry = { members: [], items: [] }); return entry; };
  const root = ownership.target;
  const contentRoot = /^content\/[a-f0-9]{64}$/.test(relative(stateRoot(), root).replaceAll('\\', '/'));
  const visible = (claim: Claim) => claim.scope === 'project' ?
    root === project && scope !== 'user' : (root === home || contentRoot) && scope !== 'project';
  const row = (managementId: string, claimScope: 'project' | 'user', custody: ManagedInventorySelection['custody']) => {
    const key = `${claimScope}\0${managementId}`;
    let selection = rows.get(key);
    if (!selection) {
      selection = { managementId, scope: claimScope, custody, memberCount: 0, sharedMemberCount: 0 };
      rows.set(key, selection);
    } else if (custody === 'legacy-reconcile') selection.custody = custody;
    return selection;
  };
  for (const claim of Object.values(ownership.selections ?? {})) if (visible(claim))
    row(claim.managementId, claim.scope, 'claim');
  for (const [key, owner] of Object.entries(ownership.members)) {
    if (!owner.claims && root === project && root === home) { ambiguous(); continue; }
    if (!owner.claims && root !== project && root !== home && !contentRoot) continue;
    const claims: Claim[] = owner.claims ?? [{ managementId: owner.managementId,
      scope: contentRoot ? 'user' : root === project ? 'project' : 'user', sets: [], requires: [] }];
    const shared = claims.length > 1;
    for (const claim of claims) if (visible(claim)) {
      const selection = row(claim.managementId, claim.scope, owner.claims ? 'claim' : 'legacy-reconcile');
      selection.memberCount++;
      if (shared) selection.sharedMemberCount++;
      if (collected) collect(`${claim.scope}\0${claim.managementId}`).members.push({ root, key, owner });
    }
  }
  for (const item of Object.values(ownership.items ?? {}))
    for (const [key, path] of Object.entries(item.redactedPaths ?? {})) redacted?.set(`${root}\0${key}`, path);
  if (collected) for (const item of Object.values(ownership.items ?? {}))
    if (rows.has(`${item.scope}\0${item.managementId}`) && visible({ managementId: item.managementId, scope: item.scope, sets: [], requires: [] }))
      collect(`${item.scope}\0${item.managementId}`).items.push(item);
}

function plainWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.getOwnPropertyNames(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable && 'value' in descriptor;
  });
}

export async function listManagedSelections(request: ManagedInventoryRequest & { format: typeof SCHEMA_11 },
  controls?: ManagedInventoryControls): Promise<ManagedInventoryResult11>;
export async function listManagedSelections(request: ManagedInventoryRequest,
  controls?: ManagedInventoryControls): Promise<ManagedInventoryResult>;
export async function listManagedSelections(request: ManagedInventoryRequest,
  controls: ManagedInventoryControls = {}): Promise<ManagedInventoryResult | ManagedInventoryResult11> {
  const started = performance.now();
  let wants11 = false;
  try { wants11 = !!request && typeof request === 'object' && Object.hasOwn(request, 'format') && request.format === SCHEMA_11; } catch { wants11 = false; }
  const collected = wants11 ? new Map<string, Collected>() : undefined;
  const redacted: RedactedPaths = new Map();
  let described: ManagedInventorySelection11[] = []; const checks = { bytes: 0, skipped: false };
  let budgetMs = DEFAULT_BUDGET_MS;
  let identity: { name: string; version: string } = { name: '@aihq/core', version: 'unavailable' };
  let identityValid = true;
  try { identity = installedDistribution(); } catch { identityValid = false; }
  try { if (plainWithKeys(controls, ['budgetMs']) || plainWithKeys(controls, ['signal', 'budgetMs']))
    budgetMs = typeof controls.budgetMs === 'number' ? controls.budgetMs : NaN; } catch { budgetMs = NaN; }
  const result: ManagedInventoryResult = {
    schema: SCHEMA, package: identity, status: 'complete', selections: [], diagnostics: [],
    limits: { receiptCount: 0, receiptBytes: 0, elapsedMs: 0,
      budgetMs: Number.isInteger(budgetMs) && budgetMs >= 1 && budgetMs <= 120000 ? budgetMs : 0 }
  };
  const finish = (): ManagedInventoryResult | ManagedInventoryResult11 => {
    result.limits.elapsedMs = Math.max(0, Math.round(performance.now() - started));
    if (!wants11) return result;
    const { selections: _rows, ...rest } = result;
    return { ...rest, schema: SCHEMA_11, selections: result.status === 'invalid' || result.status === 'cancelled' ? [] : described,
      limits: { ...result.limits, checkedBytes: checks.bytes, checkBudgetBytes: CHECK_BUDGET_BYTES } };
  };
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 120000) {
    result.status = 'invalid';
    result.diagnostics.push(diagnostic('INPUT_INVALID', 'budget-ms', 'The inventory time budget is invalid.'));
    return finish();
  }
  let admitted = false;
  try {
    const optional = ['format', 'index', 'organization'].filter(key => Object.hasOwn(request, key));
    admitted = (optional.length === 0 || wants11) && plainWithKeys(request, ['target', 'scope', ...optional]) &&
    plainWithKeys(request.target, ['project']) && typeof request.target.project === 'string' &&
    ['project', 'user', 'both'].includes(request.scope) &&
    !!controls && typeof controls === 'object' && !isProxy(controls) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(controls)) &&
    Object.getOwnPropertySymbols(controls).length === 0 &&
    Object.getOwnPropertyNames(controls).every(key => (key === 'signal' || key === 'budgetMs') &&
      Object.getOwnPropertyDescriptor(controls, key)?.enumerable &&
      'value' in Object.getOwnPropertyDescriptor(controls, key)!) &&
    (controls.signal === undefined || controls.signal instanceof AbortSignal) &&
    (request.index === undefined || validIndex(request.index)); } catch { admitted = false; }
  if (!admitted) {
    result.status = 'invalid';
    result.diagnostics.push(diagnostic('INPUT_INVALID', 'request-shape', 'The inventory request is invalid.'));
    return finish();
  }
  if (admitted && request.organization !== undefined) {
    let organized = false;
    try { organized = plainWithKeys(request.organization, ['document']) && validateOrganizationPolicy(request.organization.document).valid; } catch { organized = false; }
    if (!organized) {
      result.status = 'invalid';
      result.diagnostics.push(diagnostic('INPUT_INVALID', 'organization-policy', 'The organization document is invalid.'));
      return finish();
    }
  }
  let project: string;
  try { project = projectRoot(request.target.project); }
  catch {
    result.status = 'invalid';
    result.diagnostics.push(diagnostic('INPUT_INVALID', 'request-shape', 'The inventory request is invalid.'));
    return finish();
  }
  result.target = { project }; result.scope = request.scope;
  try {
    const check = () => {
      if (controls.signal?.aborted) throw new Error('inventory-cancelled');
      if (performance.now() - started > budgetMs) throw new Error('inventory-time-budget');
    };
    check();
    if (!identityValid) {
      result.status = 'incomplete';
      result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', 'core-distribution-identity',
        'The installed Core distribution identity could not be verified.'));
      return finish();
    }
    const home = userHomeRoot();
    const rows = new Map<string, ManagedInventorySelection>();
    let ambiguous = false;
    if (request.scope === 'project') {
      const receipt = readOwnership(project);
      if (receipt.digest) { result.limits.receiptCount++; result.limits.receiptBytes += receipt.bytes; }
      check();
      addClaims(rows, receipt.value, project, home, request.scope, () => { ambiguous = true; }, collected, redacted);
    } else {
      const inventory = readOwnershipReceipts(check);
      result.limits.receiptCount = inventory.count;
      result.limits.receiptBytes = inventory.bytes;
      for (const receipt of inventory.receipts) {
        check();
        addClaims(rows, receipt, project, home, request.scope, () => { ambiguous = true; }, collected, redacted);
      }
    }
    if (request.scope !== 'project') {
      const session = readMacosCustody();
      for (const entry of session.value.entries) {
        check();
        if (!sessionFilesMatch(entry)) {
          const key = `user\0${entry.managementId}`;
          if (!rows.has(key)) rows.set(key, { managementId: entry.managementId, scope: 'user', custody: 'legacy-reconcile', memberCount: 0, sharedMemberCount: 0 });
          else rows.get(key)!.custody = 'legacy-reconcile';
          result.status = 'incomplete'; result.diagnostics.push(diagnostic('STATE_CONFLICT', 'session-config-drift', 'Managed session files and ownership disagree.'));
        }
      }
      const trust = readTrustCustody(true);const pending=readPendingTrust(trust);
      if(pending) {
        result.status='incomplete';result.diagnostics.push(diagnostic('STATE_CONFLICT','trust-custody-pending','Review the pending trust selection before restoration or removal.'));
        for(const entry of pendingEntries(pending)) {
          const key=`user\0${entry.managementId}`;
          if(!rows.has(key))rows.set(key,{managementId:entry.managementId,scope:'user',custody:'legacy-reconcile',memberCount:0,sharedMemberCount:0});
          else rows.get(key)!.custody='legacy-reconcile';
        }
      }
      for (const entry of trust.value.entries) {
        check(); const key = `user\0${entry.managementId}`;
        const {owner}=readTrustOwner(entry);
        if (!owner || owner.sha256 !== entry.outputSha256 || owner.recipeIdentity !== entry.recipeIdentity) {
          if (!rows.has(key)) rows.set(key,{managementId:entry.managementId,scope:'user',custody:'legacy-reconcile',memberCount:0,sharedMemberCount:0});
          result.status='incomplete'; result.diagnostics.push(diagnostic('STATE_CONFLICT','trust-custody-conflict','Retained trust provenance requires reviewed reconciliation.'));
        }
      }
    }
    result.selections = [...rows.values()].sort((a, b) => a.scope === b.scope ?
      a.managementId < b.managementId ? -1 : a.managementId > b.managementId ? 1 : 0 :
      a.scope === 'project' ? -1 : 1);
    check();
    if (collected) {
      described = describe(result.selections, collected, redacted, request, check, checks);
      if (checks.skipped) {
        result.status = 'incomplete';
        result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', 'check-budget', 'Some member file states exceeded the read budget and are unchecked.'));
      }
    }
    if (ambiguous) {
      result.status = 'incomplete';
      result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', 'ambiguous-scope',
        'Claimless custody has no provable project or user scope.'));
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024 || Buffer.byteLength(JSON.stringify(described)) > 4 * 1024 * 1024) {
      result.selections = []; described = [];
      throw new Error('ownership-limit');
    }
    return finish();
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (reason === 'inventory-cancelled') {
      result.status = 'cancelled';
      result.diagnostics.push(diagnostic('CANCELLED', 'cancelled', 'Inventory was cancelled.'));
    } else {
      result.status = 'incomplete';
      if (['trust-custody-pending', 'trust-custody-conflict', 'session-custody-unavailable', 'session-recovery-required'].includes(reason)) {
        result.diagnostics.push(diagnostic('STATE_CONFLICT',reason,'Protected trust custody requires reviewed reconciliation.'));
        return finish();
      }
      const kind = reason === 'inventory-time-budget' ? 'time-budget' :
        reason === 'ownership-limit' ? 'limit-exceeded' : 'ownership-unverifiable';
      result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', kind,
        kind === 'limit-exceeded' ? 'Managed inventory exceeded its safe bounds.' :
        kind === 'time-budget' ? 'Managed inventory exceeded its time budget.' :
        'Protected managed custody could not be verified.'));
    }
    return finish();
  }
}

const isHex = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isId = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 128;
const isRef = (value: unknown, identities: 'required' | 'optional' | 'none'): boolean => {
  const keys = ['framework', 'itemId', ...(identities === 'required' ? ['contentSha256', 'behaviourSha256'] : [])];
  const optional = identities === 'optional' ? ['contentSha256', 'behaviourSha256'] : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return keys.every(key => Object.hasOwn(record, key)) && Object.keys(record).every(key => keys.includes(key) || optional.includes(key)) &&
    isId(record.framework) && isId(record.itemId) && [...keys, ...optional].slice(2).every(key => record[key] === undefined || isHex(record[key]));
};
function validIndex(value: unknown): value is ManagedInventoryIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const index = value as Record<string, unknown>;
  const list = (entry: unknown, check: (item: unknown) => boolean) => Array.isArray(entry) && entry.length <= 65536 && entry.every(check);
  return Object.keys(index).every(key => ['offered', 'revoked', 'superseded'].includes(key)) && list(index.offered, item => isRef(item, 'required')) &&
    (index.revoked === undefined || list(index.revoked, item => isRef(item, 'optional'))) &&
    (index.superseded === undefined || list(index.superseded, item => !!item && typeof item === 'object' && !Array.isArray(item) &&
      Object.keys(item).length === 2 && isRef((item as { item: unknown }).item, 'none') && isRef((item as { by: unknown }).by, 'none')));
}

const same = (a: CatalogItemRef, b: CatalogItemRef) => a.framework === b.framework && a.itemId === b.itemId;
/** Derived only from the consumer's index; without an index or a recorded identity the state is unknown. */
function updateState(item: SelectionMetadata['item'] | null, index: ManagedInventoryIndex | undefined): ManagedInventorySelection11['updateState'] {
  if (!item || !index) return 'unknown';
  if (index.revoked?.some(entry => same(entry, item) && (entry.contentSha256 === undefined || entry.contentSha256 === item.contentSha256) &&
    (entry.behaviourSha256 === undefined || entry.behaviourSha256 === item.behaviourSha256))) return 'revoked';
  if (index.superseded?.some(entry => same(entry.item, item))) return 'superseded';
  const offered = index.offered.filter(entry => same(entry, item));
  if (!offered.length) return 'no-longer-offered';
  return offered.some(entry => entry.contentSha256 === item.contentSha256 && entry.behaviourSha256 === item.behaviourSha256) ? 'current' : 'update-available';
}
const STRENGTH = ['required', 'recommended', 'permitted'] as const;
/** Enterprise admission of the recorded recipe identity; a target selector Core cannot evaluate here reads unknown. */
function policyState(document: OrganizationPolicy, scope: 'project' | 'user', identities: Set<string>): NonNullable<ManagedInventorySelection11['policyState']> {
  if (identities.size !== 1) return 'unknown';
  const [identity] = identities;
  const entries = document.selections.filter(entry => entry.recipeIdentity === identity && entry.scopes.includes(scope));
  if (!entries.length) return 'not-admitted';
  if (entries.some(entry => 'clients' in entry && entry.clients !== undefined || 'repositories' in entry && entry.repositories !== undefined)) return 'unknown';
  const obligations = entries.map(entry => 'obligation' in entry ? entry.obligation : 'permitted');
  if (obligations.includes('prohibited')) return 'prohibited';
  return STRENGTH.find(strength => obligations.includes(strength)) ?? 'permitted';
}

function describe(rows: ManagedInventorySelection[], collected: Map<string, Collected>, redacted: RedactedPaths, request: ManagedInventoryRequest,
  check: () => void, checks: { bytes: number; skipped: boolean }): ManagedInventorySelection11[] {
  const lives = new Map<string, ReturnType<ReturnType<typeof transaction>['inspect']>>();
  const live = (root: string, path: string) => {
    const key = `${root}\0${path}`; let found = lives.get(key);
    if (found) return found;
    if (checks.bytes > CHECK_BUDGET_BYTES) { checks.skipped = true; return { state: 'unreadable' as const, detail: 'check-budget' }; }
    try { found = transaction(root).inspect(path); } catch { found = { state: 'unreadable' as const, detail: 'unreadable' }; }
    if (found.state === 'present') checks.bytes += found.bytes.length;
    lives.set(key, found); return found;
  };
  return rows.map(row => {
    check();
    const detail = collected.get(`${row.scope}\0${row.managementId}`) ?? { members: [], items: [] };
    const facts = detail.items.find(item => item.name !== null || item.item !== null) ?? detail.items[0];
    const members: ManagedInventoryMember[] = detail.members.map(({ root, key, owner }) => {
      const descriptor = owner.descriptor ?? { kind: 'file' as const, path: key };
      const state = checkMember(descriptor, live(root, descriptor.path), owner.sha256);
      const block = descriptor.kind === 'block';
      return { kind: publicKind(descriptor), path: join(root, redacted.get(`${root}\0${key}`) ?? descriptor.path),
        ...(memberPointer(descriptor) !== undefined ? { pointer: memberPointer(descriptor)! } : {}),
        ...(block ? { blockId: descriptor.blockId } : {}), ...(descriptor.kind === 'hook' ? { groupId: descriptor.groupId } : {}),
        fileState: state === 'present-matching' ? 'matches' : state === 'present-different' ? block ? 'block-changed' : 'changed' :
          state === 'absent' ? block ? 'block-missing' : 'missing' : 'unchecked' };
    });
    members.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.pointer ?? a.blockId ?? a.groupId ?? '') < (b.pointer ?? b.blockId ?? b.groupId ?? '') ? -1 : 1);
    // Granted only by an approval Core wrote and still holds; a person's own approval is never Core's.
    const granted = detail.members.some(({ owner }) => owner.approval !== undefined);
    const tool = facts?.tool ?? null, kind = facts?.kind ?? null;
    // A person who already allowed the server in the tool's approval location needs no further OK; unreadable means unknown, so still needed.
    const givenByPerson = (): boolean => {
      const bound = tool !== null && kind !== null ? bindingApprovalLocation(tool, kind) : undefined;
      if (!bound) return false;
      const { register, location } = bound;
      return detail.members.some(({ root, owner }) => {
        const descriptor = owner.descriptor;
        if (descriptor?.kind !== 'entry' || descriptor.path !== register.file || descriptor.entry.length <= register.container.length ||
            register.container.some((segment, index) => descriptor.entry[index] !== segment)) return false;
        const found = live(root, location.file);
        if (found.state !== 'present') return false;
        const errors: ParseError[] = [];
        const document = parseJsonc(found.bytes.toString('utf8'), errors, { allowTrailingComma: true }) as unknown;
        return errors.length === 0 && approvalGiven(location, document, descriptor.entry[register.container.length]!);
      });
    };
    return { ...row, name: facts?.name ?? null, kind, framework: facts?.framework ?? null, item: facts?.item ?? null, tool,
      origins: facts?.origins ?? [], members, updateState: updateState(facts?.item ?? null, request.index),
      ...(request.organization ? { policyState: policyState(request.organization.document, row.scope,
        new Set(detail.members.map(member => member.owner.recipeIdentity))) } : {}),
      approval: granted ? 'granted-by-aih' : tool === null || kind === null ? null : bindingPermissionStep(tool, kind) === undefined || givenByPerson() ? 'not-needed' : 'needed',
      installState: detail.items.some(item => item.installState === 'interrupted') ? 'interrupted' : 'complete' };
  });
}
