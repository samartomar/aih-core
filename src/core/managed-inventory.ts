import { performance } from 'node:perf_hooks';
import { relative } from 'node:path';
import { isProxy } from 'node:util/types';
import { installedDistribution } from './internal/installed-distribution.js';
import { projectRoot, userHomeRoot } from './internal/host-files.js';
import { readOwnership, readOwnershipReceipts, stateRoot } from './internal/state.js';
import type { Ownership } from './internal/state.js';
import type { Claim } from './internal/recipe-lifecycle.js';
import type { Diagnostic } from './types.js';

const SCHEMA = 'urn:aihq:core:managed-inventory-result:1.0.0' as const;
const DEFAULT_BUDGET_MS = 30000;

export interface ManagedInventoryRequest {
  target: { project: string };
  scope: 'project' | 'user' | 'both';
}
export interface ManagedInventoryControls { signal?: AbortSignal; budgetMs?: number }
export interface ManagedInventorySelection {
  managementId: string;
  scope: 'project' | 'user';
  custody: 'claim' | 'legacy-reconcile';
  memberCount: number;
  sharedMemberCount: number;
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

function addClaims(rows: Map<string, ManagedInventorySelection>, ownership: Ownership,
  project: string, home: string, scope: ManagedInventoryRequest['scope'], ambiguous: () => void): void {
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
  for (const owner of Object.values(ownership.members)) {
    if (!owner.claims && root === project && root === home) { ambiguous(); continue; }
    if (!owner.claims && root !== project && root !== home && !contentRoot) continue;
    const claims: Claim[] = owner.claims ?? [{ managementId: owner.managementId,
      scope: contentRoot ? 'user' : root === project ? 'project' : 'user', sets: [], requires: [] }];
    const shared = claims.length > 1;
    for (const claim of claims) if (visible(claim)) {
      const selection = row(claim.managementId, claim.scope, owner.claims ? 'claim' : 'legacy-reconcile');
      selection.memberCount++;
      if (shared) selection.sharedMemberCount++;
    }
  }
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

export async function listManagedSelections(request: ManagedInventoryRequest,
  controls: ManagedInventoryControls = {}): Promise<ManagedInventoryResult> {
  const started = performance.now();
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
  const finish = () => { result.limits.elapsedMs = Math.max(0, Math.round(performance.now() - started)); return result; };
  if (!identityValid) {
    result.status = 'invalid';
    result.diagnostics.push(diagnostic('INPUT_INVALID', 'package-identity', 'The installed Core package identity is invalid.'));
    return finish();
  }
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 120000) {
    result.status = 'invalid';
    result.diagnostics.push(diagnostic('INPUT_INVALID', 'budget-ms', 'The inventory time budget is invalid.'));
    return finish();
  }
  let admitted = false;
  try { admitted = plainWithKeys(request, ['target', 'scope']) &&
    plainWithKeys(request.target, ['project']) && typeof request.target.project === 'string' &&
    ['project', 'user', 'both'].includes(request.scope) &&
    !!controls && typeof controls === 'object' && !isProxy(controls) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(controls)) &&
    Object.getOwnPropertySymbols(controls).length === 0 &&
    Object.getOwnPropertyNames(controls).every(key => (key === 'signal' || key === 'budgetMs') &&
      Object.getOwnPropertyDescriptor(controls, key)?.enumerable &&
      'value' in Object.getOwnPropertyDescriptor(controls, key)!) &&
    (controls.signal === undefined || controls.signal instanceof AbortSignal); } catch { admitted = false; }
  if (!admitted) {
    result.status = 'invalid';
    result.diagnostics.push(diagnostic('INPUT_INVALID', 'request-shape', 'The inventory request is invalid.'));
    return finish();
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
    const home = userHomeRoot();
    const rows = new Map<string, ManagedInventorySelection>();
    let ambiguous = false;
    if (request.scope === 'project') {
      const receipt = readOwnership(project);
      if (receipt.digest) { result.limits.receiptCount++; result.limits.receiptBytes += receipt.bytes; }
      check();
      addClaims(rows, receipt.value, project, home, request.scope, () => { ambiguous = true; });
    } else {
      const inventory = readOwnershipReceipts(check);
      result.limits.receiptCount = inventory.count;
      result.limits.receiptBytes = inventory.bytes;
      for (const receipt of inventory.receipts) {
        check();
        addClaims(rows, receipt, project, home, request.scope, () => { ambiguous = true; });
      }
    }
    result.selections = [...rows.values()].sort((a, b) => a.scope === b.scope ?
      a.managementId < b.managementId ? -1 : a.managementId > b.managementId ? 1 : 0 :
      a.scope === 'project' ? -1 : 1);
    check();
    if (ambiguous) {
      result.status = 'incomplete';
      result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', 'ambiguous-scope',
        'Claimless custody has no provable project or user scope.'));
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) {
      result.selections = [];
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
