import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { isProxy } from 'node:util/types';
import { nodeRuntimeSupported } from './internal/node-runtime.js';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { contractSupport, parseOrganizationPolicy, validateOrganizationTarget, validatePolicy, validateRecipe } from './contracts.js';
import { readGitHubPolicy, readLocalPolicy, type ReadGitHubPolicyResult, type ReadLocalPolicyResult, type GitHubPolicySource,
  type LocalPolicySource } from '../harness/runtime.mjs';
import { localPolicySourceLabel } from '../harness/local-policy.mjs';
import { contentFactsOf, SetMembership } from './internal/organization-content.js';
import { selectTool } from '../harness/tool-registry.mjs';
import { bindingLayout, bindingPermissionNotice, hookGroupCommands, selectionDeliveredSize, type DeliveredEntry } from '../harness/delivery-review.mjs';
import { isNativeClient } from './internal/policy-validation.js';
import { admitOrganizationSelections, evaluateOrganizationObligations, type AdmissionLifecycle, type AdmissionSelection } from './internal/organization-admission.js';
import { canonicalJson, codeUnitCompare } from './internal/canonical.js';
import { recipeIdentityDescriptor } from './internal/recipe-identity.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, deepFreezeStrictJsonV1, parseStrictJsonObjectV1, sameJsonDataV1 } from './internal/strict-json.js';
import { bindHookGroup, redactHookBindings } from './internal/hook-bindings.js';
import { recipeFormatsForPolicy } from './internal/recipe-formats.js';
import { dependencyOrder, inputAccepts } from './internal/policy-validation.js';
import { directoryIdentity, directoryMap, directoryRecords, directoryParents, removeCreatedDirectories, type CreatedDirectories } from './internal/created-directories.js';
import { fileTransaction, pathPins, pinsMatch, projectRoot, userHomeRoot, sha256, validSegment, type PathPin } from './internal/host-files.js';
import { admitWrittenOwnership, contentTransaction, isContentRoot, ownershipDigest, ownershipInventory, lockTarget, ownershipPath, protectState, readOwnership, validateOwnership, stageOwnership, sealOwnership, stateFiles, stateRoot, writeHistory, type AdmittedImage, type AdmittedReceipts, type Ownership, type Owner } from './internal/state.js';
import { captureRecipeReference, captureInlineMaterials, createMaterialCaptureBudget, MaterialCaptureError,
  type MaterialCaptureBudget } from './internal/material.js';
import { gitProvenance } from './internal/material-descriptors.js';
import { configMemberBytes, memberDigest, renderConfigEntries, renderConfigMember, renderTextBlock, removeCreatedTomlTable, tomlTableOf, type TomlTableCustody } from './internal/recipe-editors.js';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { attemptItem, checkMember, completeItem, locateMember, memberPointer, preExistingFor, publicKind, redactedPathFor, releaseItem, settleItem, upsertItem, type ItemFacts, type MemberCheck, type PendingMember } from './internal/custody-items.js';
import { claimIdentity, classifyStoredClaims, retainClaimDependencies, overlappingMembers, memberKey, memberBytes, subtractMember, type ByteMember, type MemberDescriptor, type Claim, type HookDescriptor } from './internal/recipe-lifecycle.js';
import { decideHookCleanup, decideHookStep, type HookDecision, type HookStepInput, type RetainedHook } from './internal/hook-prepare.js';
import { missingContainers, pruneEmptyContainers } from './internal/hook-group.js';
import { USER_NOTES_FILE, extractBlockBody, personLinesInside, sharedBlockRole } from './internal/shared-blocks.js';
import { hookConflictMessage, hookGuidanceText } from './internal/hook-guidance.js';
import { RecipeEditError } from './internal/recipe-editors.js';
import { resolveExecutable, runApprovedProcess, type ResolvedExecutable } from './internal/approved-process.js';
import { OwnedFileTransaction, type OwnedFileRead, type OwnedFileStep } from './internal/owned-file-transaction.js';
import { readRegularFile } from './internal/fsxn.js';
import { readEvidence, readPolicyEvidence } from './internal/policy-evidence.js';
import { selectionScan, type OwnMaterial, type ScanArtifact, type SelectionScan } from './internal/item-scan.js';
import { releaseIndexStatus, validIndex, type ReleaseIndexStatus } from './internal/release-index.js';
import { renderRecipelessSelections } from './internal/recipeless.js';
import type { AssociationResult, EvidenceAssociation } from './evidence/types.js';
import type { NativeClientId } from './internal/native-clients.js';
import type { Diagnostic, ExecutionPolicy, GitMaterialProvenance, Json, Operation, OrganizationPolicy, OrganizationTargetDeclaration, OrganizationTargetFacts, ProcessInvocation, Recipe, RecipeCheck, Slot, TargetPath } from './types.js';
import type { Authorization, CheckResult, RunMember, Effective, HostControls, OperationSelection, OrganizationBinding, OrganizationObligationsReview, PolicyRequest, PreparationResult, PreparedHandle, PreparedReview, PreparedSelection, ResolutionInput, ReviewCheck, ReviewOperation, RunResult, StaleBinding } from './host-types.js';
import type { TrustEngineParticipant } from './internal/trust-participant.js';
import { guardTrustMember } from './internal/trust-custody.js';
import { isLegalFile, type CleanupOptions, type CleanupPlanRow } from './internal/removal-plan.js';
import type { PlannedMember, UpdateOptions } from './internal/update-plan.js';

interface PreparedProcess {
  executable: ResolvedExecutable | { material: string; bytes: Buffer; filename: string } | { missing: string };
  args: string[]; cwd: string; cwdPins: PathPin[]; env: Record<string, string>; stdin?: string;
  timeoutMs: number; maxOutputBytes: number; acceptedExitCodes: number[];
}
interface PreparedCheck { id: string; kind: 'file.sha256' | 'process.exit'; path?: string; sha256?: string; process?: PreparedProcess }
interface PreparedStep {
  review: ReviewOperation; root?: string; path?: string; ownerKey?: string;
  initialBefore?: Buffer | null; before?: Buffer | null; after?: Buffer | null; mode?: number; pins?: PathPin[];
  managementId: string; recipeIdentity: string; checks: PreparedCheck[];
  process?: PreparedProcess; unavailable?: string; resolution?: 'replace' | 'adopt';
  custody?: Record<string, Owner | null>; custodyOnly?: boolean; lifecycle?: boolean;
  /** Custody keys the step only updates to hand over a removed TOML header's line break; it does not author or supply them. */
  inherited?: string[];
  directoryCleanup?: CreatedDirectories;
  /** Keyed resolution address of an authored operation; generated lifecycle cleanup has none. */
  authored?: { selectionId: string; operationId: string; overlayKey?: string; choices: ('replace' | 'adopt')[] };
  /** The members this step writes, removes or restores, checked directly after Apply. */
  members?: MemberDescriptor[];
  /** Item facts recorded with this selection's custody (every authored step); `named` when the policy described the item. */
  item?: { id: string; named: boolean; facts: ItemFacts };
  /** Protected restoration data: the person's value at each replaced, previously unowned JSON pointer. */
  preExisting?: Record<string, Json>;
  /** Publishable paths of members whose path contains a private input value, keyed by member. */
  redactedPaths?: Record<string, string>;
  /** A cleanup step that writes the recorded pre-existing value back instead of removing the member. */
  restores?: boolean;
  /** Removal preparation 1.2.0: a cleanup step that keeps its member and the claims on it, with the reason. */
  kept?: { action: 'keep-changed' | 'keep-required'; reason: string };
  /** Why a `conflict` step leaves its member as it is, named per member by managed update preparation. */
  conflictReason?: string;
}
interface PreparedState {
  trustParticipant?: TrustEngineParticipant;
  request: PolicyRequest; requestDigest: string; privateInputs: HostControls['privateInputs']; privateDigest: string;
  review: PreparedReview; steps: PreparedStep[]; project: string; home: string;
  ownership: Map<string, { value: Ownership; digest: string | null }>;
  selectionUpdates: Map<string, Record<string, { claim: Claim | null; requires: string[] }>>;
  /**
   * Item facts to record for selections whose custody is otherwise unchanged, published once their operations succeed.
   * `finish` completes an interrupted install; `release` lets a removed interrupted install go.
   */
  itemUpdates: Map<string, Record<string, { item: NonNullable<PreparedStep['item']>; requires: string[]; action?: 'finish' | 'release' }>>;
  inventory?: Map<string, string>; bindings: PathPin[]; captures: { recheck(): Promise<boolean> }[];
  /** The selected source and the identities Apply's fresh read must match; a local source has no commit or blob. */
  organization?: { source: GitHubPolicySource | LocalPolicySource; resolvedCommit?: string; blobId?: string; contentDigest: string };
  /** Declared target bound with the organization; Apply rejects a request that no longer declares exactly this. */
  organizationTarget?: OrganizationTargetDeclaration;
  evidence?: EvidenceAssociation[];
  /**
   * Prepared work 1.7.0: what Apply checks again. The bytes each item selection delivers, to re-check its scan records,
   * and each item's status in the consumer's release index at Prepare.
   */
  rechecks?: { own: Map<string, OwnMaterial[]>; indexStatus: Record<string, ReleaseIndexStatus> };
}
// Authority read outcome that is not a successful read; carried as a precise diagnostic.
class AuthorityFailure extends Error {
  constructor(readonly status: 'invalid' | 'blocked' | 'cancelled', readonly detail: Diagnostic) { super(detail.reason); }
}
type OrganizationRead = Extract<ReadGitHubPolicyResult, { status: 'read' }> | Extract<ReadLocalPolicyResult, { status: 'read' }>;
function authorityFailure(read: Exclude<ReadGitHubPolicyResult | ReadLocalPolicyResult, { status: 'read' }>): AuthorityFailure {
  const detail: Diagnostic = { code: read.code, reason: read.reason, message: read.message,
    ...('retryAfterSeconds' in read && read.retryAfterSeconds !== undefined ? { guidance: `Retry after ${read.retryAfterSeconds} seconds.` } : {}) };
  return new AuthorityFailure(read.status === 'invalid' ? 'invalid' : read.status === 'cancelled' ? 'cancelled' : 'blocked', detail);
}
const isLocalSource = (source: unknown): boolean => !!source && typeof source === 'object' && (source as { provider?: unknown }).provider === 'local';
/** The caller-selected source: a local file, read offline, or a GitHub repository path. Nothing selects one from data. */
async function readOrganization(source: unknown, controls: HostControls): Promise<OrganizationRead> {
  const read = isLocalSource(source) ? await readLocalPolicy(source, controls.signal === undefined ? undefined : { signal: controls.signal }) :
    await readGitHubPolicy(source, {
      ...(controls.authentication === undefined ? {} : { authentication: controls.authentication }),
      ...(controls.signal === undefined ? {} : { signal: controls.signal }) });
  if (read.status !== 'read') throw authorityFailure(read);
  return read;
}
// Unavailable material has no computed identity: admission borrows the named entry's
// identity (membership and scope still apply; the selection has no effects) or, with
// no entry, uses this value, which no admitted recipe can hash to.
/** A selection's declared organization 1.2.0 content facts (execution policy 1.4.0 metadata); never inferred. */
const contentFacts = (selection: ExecutionPolicy['selections'][number]): Pick<AdmissionSelection, 'kind' | 'item'> => contentFactsOf(selection);
const UNMATCHED_RECIPE_IDENTITY = `sha256:${'0'.repeat(64)}`;
// Internal adapter input: never accepted through public request or host controls.
interface CapturedUnavailableInvocations { operations: Record<string, string>; checks: Record<string, string> }
const POLICY_14 = 'urn:aihq:core:execution-policy:1.4.0';
const POLICY_15 = 'urn:aihq:core:execution-policy:1.5.0';
const POLICY_16 = 'urn:aihq:core:execution-policy:1.6.0';
const POLICY_13 = 'urn:aihq:core:execution-policy:1.3.0';
const POLICY_12 = 'urn:aihq:core:execution-policy:1.2.0';
const PREPARED_14 = 'urn:aihq:core:prepared-work:1.4.0' as const;
const PREPARED_15 = 'urn:aihq:core:prepared-work:1.5.0' as const;
const PREPARED_16 = 'urn:aihq:core:prepared-work:1.6.0' as const;
const PREPARED_17 = 'urn:aihq:core:prepared-work:1.7.0' as const;
const RESULT_14 = 'urn:aihq:core:run-result:1.4.0' as const;
const RESULT_15 = 'urn:aihq:core:run-result:1.5.0' as const;
/** The run result 1.4.0 schema's bound on `members`. */
const MEMBER_REPORT_LIMIT = 65536;
/** A reviewed binding that no longer holds at Apply; prepared work 1.6.0 reports which one. */
class ReviewStale extends Error {
  /** `detail` names what changed (a reviewed target, or a selection's name); run result 1.5.0 reports it. */
  constructor(readonly changed: StaleBinding, readonly detail?: string) { super('review-stale'); }
}
const stale = (changed: StaleBinding, detail?: string): ReviewStale => new ReviewStale(changed, detail);
/**
 * Run result 1.5.0's closed list for each Apply guard: a changed recipe or private input changes how the item is
 * installed (`binding`); host, ownership and trust custody guard the reviewed target files.
 */
const OWNER_STALE: Readonly<Record<StaleBinding, StaleBinding>> = Object.freeze({ policy: 'policy', 'index-status': 'index-status',
  'scan-state': 'scan-state', binding: 'binding', 'target-file': 'target-file', recipe: 'binding', input: 'binding',
  host: 'target-file', ownership: 'target-file', trust: 'target-file' });
/**
 * Prepared work 1.7.0's Apply re-check beyond the files: each item's release-index status from the consumer's index now,
 * its scan state from the evidence read again, and the binding Core now ships for its tool and kind.
 */
async function recheckReview(state: PreparedState, controls: HostControls): Promise<{ results: AssociationResult[]; scans: Map<string, SelectionScan> }> {
  const { policy } = state.request;
  const items = (state.review.selections ?? []).filter(selection => selection.layout !== undefined);
  const statuses = indexStatuses(policy, controls.index);
  for (const selection of items)
    if (statuses[selection.selectionId] !== state.rechecks!.indexStatus[selection.selectionId]) throw stale('index-status', selection.name);
  const read = await readEvidence(state.evidence, controls.evidence, controls.signal);
  const scans = selectionScans(policy, state.rechecks!.own, read.artifacts);
  for (const selection of items) {
    const now = scans.get(selection.selectionId)!;
    if (canonicalJson({ scanId: now.scanId ?? null, coverage: now.coverage ?? null, scanState: now.scanState }) !==
        canonicalJson({ scanId: selection.scanId ?? null, coverage: selection.coverage ?? null, scanState: selection.scanState })) throw stale('scan-state', selection.name);
  }
  for (const selection of items)
    if (bindingLayout(selection.tool!, selection.kind!)?.bindingDigest !== selection.layout!.bindingDigest) throw stale('binding', selection.name);
  return { results: read.results, scans };
}
/** Custody guards that refuse because trust or session custody now claims a reviewed path; recovery and permission states pass through. */
const TRUST_CLAIMS = new Set(['new-custody-legacy-request', 'trust-custody-conflict', 'session-ownership-conflict']);
const POLICY_11 = 'urn:aihq:core:execution-policy:1.1.0';
const RECIPE_10 = 'urn:aihq:core:recipe:1.0.0';
const RECIPE_11 = 'urn:aihq:core:recipe:1.1.0';
const PREPARED_10 = 'urn:aihq:core:prepared-work:1.0.0' as const;
const PREPARED_11 = 'urn:aihq:core:prepared-work:1.1.0' as const;
const RESULT_10 = 'urn:aihq:core:run-result:1.0.0' as const;
const RESULT_11 = 'urn:aihq:core:run-result:1.1.0' as const;
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Whether `owner` holds a TOML entry in the table with key `table` (see `tomlTableOf`) of `path`. */
const inTomlTable = (owner: Owner, path: string, table: string): boolean => owner.descriptor?.kind === 'entry' && owner.descriptor.format === 'toml' &&
  samePath(owner.descriptor.path, path) && tomlTableOf(owner.descriptor.entry)?.key === table;
/** Whether Core created this TOML entry's table: this setup's header, else the recorded value, else a sibling key's in the same table. */
function createdTableCustody(member: Extract<ByteMember, { kind: 'entry' }>, created: Map<string, TomlTableCustody>, prior: Owner | undefined,
    members: Record<string, Owner>): TomlTableCustody | undefined {
  const table = tomlTableOf(member.entry);
  return table && (created.get(table.key) ?? prior?.tomlTable ?? Object.values(members).find(owner => owner.tomlTable && inTomlTable(owner, member.path, table.key))?.tomlTable);
}
/** The line break Core added before a removed header now precedes the created tables `heirs` name: their owners record it. */
function inheritTomlBreak(members: Record<string, Owner>, path: string, heirs: string[]): Record<string, Owner> {
  return Object.fromEntries(Object.entries(members).filter(([, owner]) => owner.tomlTable && owner.tomlTable !== 'created-after-newline' &&
    heirs.some(table => inTomlTable(owner, path, table))).map(([key, owner]) => [key, { ...owner, tomlTable: 'created-after-newline' as const }]));
}
function hookConflict(decision: HookDecision, groupId: string, path: string, privateValues: string[]): Diagnostic {
  const reason = decision.reason!;
  return { code: 'STATE_CONFLICT', reason, message: hookConflictMessage(safeText(groupId, privateValues), decision.neighbor === undefined ? undefined : safeText(decision.neighbor, privateValues)),
    path: safeText(path, privateValues), guidance: hookGuidanceText(reason) };
}
/**
 * Prepared work 1.7.0: each item selection's scan state from its records, checked against the bytes this preparation
 * captured for it. A selection whose material was unavailable has no bytes to check, so no record can count for it.
 */
function selectionScans(policy: ExecutionPolicy, owned: ReadonlyMap<string, OwnMaterial[]>,
    artifacts: ReadonlyMap<string, ScanArtifact>): Map<string, SelectionScan> {
  const scans = new Map<string, SelectionScan>();
  for (const selection of policy.selections) {
    if (selection.item === undefined) continue;
    scans.set(selection.id, selectionScan(selection.item, selection.scanRecords, selection.itemMaterials ?? [], owned.get(selection.id) ?? [], artifacts));
  }
  return scans;
}
/**
 * An authenticated artifact counts only when a record naming it passed the check against some selection's own bytes with
 * matched coverage; any other is never reported as authenticated.
 */
function coveredEvidence(results: AssociationResult[], scans: ReadonlyMap<string, SelectionScan>): AssociationResult[] {
  const covering = new Set([...scans.values()].flatMap(scan => scan.covering));
  return results.map(result => result.status === 'authenticated' && !covering.has(result.scanId!) ?
    { scanId: result.scanId!, status: 'unverifiable', reason: 'not-covered' } : result);
}
/** Each item selection's status in the consumer's release index, as the inventory derives it; `unknown` without one. */
function indexStatuses(policy: ExecutionPolicy, index: HostControls['index']): Record<string, ReleaseIndexStatus> {
  return Object.fromEntries(policy.selections.flatMap(selection => selection.item === undefined ? [] :
    [[selection.id, releaseIndexStatus(selection.item, index)]]));
}
const handles = new WeakMap<PreparedHandle, PreparedState>();
const disabled = { status: 'disabled', reason: 'logging-off' } as const;
const clone = <T>(value: T): T => cloneJsonValueStructureV1(value, 'request', 32);
const digest = (value: unknown): string => sha256(canonicalJson(value));
const diagnostic = (code: string, reason: string, message: string): Diagnostic => ({ code, reason, message });
const loggingOption = (controls: HostControls): Effective<'on' | 'off'> => ({ value: controls.logging ?? 'on', origin: controls.logging === undefined ? 'default' : 'explicit' });

export function dataObject(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error('request-object');
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !d?.enumerable || !('value' in d)) throw new Error('request-field');
  }
}
export function validateControls(controls: HostControls): void {
  dataObject(controls, ['signal', 'logging', 'privateInputs', 'materialRoots', 'authentication', 'evidence', 'index']);
  if (controls.index !== undefined && !validIndex(clone(controls.index))) throw new Error('release-index');
  if (controls.logging !== undefined && !['on', 'off'].includes(controls.logging)) throw new Error('logging');
  if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) throw new Error('signal');
  if (controls.authentication !== undefined) {
    const authentication = controls.authentication as { kind?: unknown; token?: unknown };
    if (authentication?.kind === 'none') dataObject(authentication, ['kind']);
    else {
      dataObject(authentication, ['kind', 'token']);
      if (authentication.kind !== 'bearer' || typeof authentication.token !== 'string' || authentication.token.length === 0 ||
          authentication.token.length > 4096 || /[\x00-\x1f\x7f]/.test(authentication.token)) throw new Error('authentication');
    }
  }
  if (controls.privateInputs !== undefined) assertStrictJsonValueV1(clone(controls.privateInputs), 'private inputs');
  if (controls.materialRoots !== undefined) {
    dataObject(controls.materialRoots, Object.keys(controls.materialRoots));
    for (const [id, root] of Object.entries(controls.materialRoots))
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || typeof root !== 'string' || !isAbsolute(root)) throw new Error('material-root');
  }
}
function bearerSecrets(controls: HostControls): string[] {
  const authentication = controls?.authentication as { kind?: unknown; token?: unknown } | undefined;
  return authentication?.kind === 'bearer' && typeof authentication.token === 'string' ? [authentication.token] : [];
}
export function safeText(text: string, privateValues: string[]): string {
  let result = text;
  for (const secret of privateValues) if (secret) result = result.split(secret).join('[REDACTED]');
  return result.replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 4096);
}
function redactExact(text: string, privateValues: string[]): string {
  let result = text;
  for (const secret of privateValues) if (secret) result = result.split(secret).join('[REDACTED]');
  return result;
}
function redactJson(value: Json, privateValues: string[]): Json {
  if (typeof value === 'string') return redactExact(value, privateValues);
  if (Array.isArray(value)) return value.map(item => redactJson(item, privateValues));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [redactExact(key, privateValues), redactJson(item, privateValues)]));
  return value;
}
function historySafe(result: unknown, project?: string, secrets: string[] = []): unknown {
  let text = JSON.stringify(result);
  for (const secret of secrets) if (secret) text = text.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
  for (const [path, label] of [[project, '<project>'], [homedir(), '<home>']])
    if (path) for (const variant of [path, path.replaceAll('\\', '/')]) text = text.split(JSON.stringify(variant).slice(1, -1)).join(label!);
  return JSON.parse(text);
}
export function resolveSlot(slot: Slot, bound: Record<string, Json>): Json {
  const value = 'literal' in slot ? slot.literal : bound[slot.input];
  if (value === undefined) throw new Error('input-unbound');
  return value;
}
export function resolveString(slot: Slot, bound: Record<string, Json>): string {
  const value = resolveSlot(slot, bound);
  if (typeof value !== 'string') throw new Error('string-slot');
  return value;
}
export function resolvePath(target: TargetPath, scope: 'project' | 'user', bound: Record<string, Json>, project: string, selectionKey: string): { root: string; path: string; absolute: string } {
  if (scope === 'project' ? target.root !== 'project' : target.root === 'project') throw new Error('scope-mismatch');
  const segments = target.segments.map(slot => resolveString(slot, bound));
  if (segments.some(segment => !validSegment(segment))) throw new Error('invalid-path');
  const root = target.root === 'project' ? project : target.root === 'userHome' ? userHomeRoot() : join(stateRoot(), 'content', selectionKey);
  return { root, path: segments.join('/'), absolute: join(root, ...segments) };
}
function resolveProcess(invocation: ProcessInvocation, bound: Record<string, Json>, project: string, selectionKey: string,
    material: { readMaterial(id: string): Buffer | undefined }, privateValues: string[], capturedMissing?: string): { process: PreparedProcess; review: ReviewOperation['details'] } {
  const cwd = resolvePath(invocation.cwd, invocation.cwd.root === 'project' ? 'project' : 'user', bound, project, selectionKey);
  const executable = 'name' in invocation.executable ? resolveExecutable(invocation.executable.name) : undefined;
  const materialId = 'material' in invocation.executable ? invocation.executable.material : undefined;
  const materialBytes = materialId ? material.readMaterial(materialId) : undefined;
  const resolvedExecutable: PreparedProcess['executable'] = executable ?? (materialBytes ?
    { material: materialId!, bytes: materialBytes, filename: materialId! } :
    { missing: 'name' in invocation.executable ? invocation.executable.name : materialId! });
  const args = invocation.args.map(slot => resolveString(slot, bound));
  const env = Object.fromEntries(Object.entries(invocation.env).map(([key, slot]) => [key, resolveString(slot, bound)]));
  const stdin = invocation.stdin ? resolveString(invocation.stdin, bound) : undefined;
  const timeoutMs = invocation.timeoutMs ?? 300_000; const maxOutputBytes = invocation.maxOutputBytes ?? 65_536;
  return { process: { executable: capturedMissing ? { missing: capturedMissing } : resolvedExecutable,
    args, cwd: cwd.absolute, cwdPins: pathPins(cwd.absolute), env, stdin,
    timeoutMs, maxOutputBytes, acceptedExitCodes: invocation.acceptedExitCodes },
    review: { executable: executable?.launchPath ?? (materialId ? `material:${materialId}` : `unavailable:${'name' in invocation.executable ? invocation.executable.name : ''}`),
      ...(executable ? { executableSha256: executable.sha256 } : materialBytes ? { executableSha256: sha256(materialBytes) } : {}),
      args: args.map(arg => JSON.stringify(redactExact(arg, privateValues))), cwd: safeText(cwd.absolute, privateValues),
      env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, JSON.stringify(redactExact(value, privateValues))])),
      stdinProtected: stdin !== undefined, ...(stdin === undefined ? {} : { stdin: redactExact(stdin, privateValues) }),
      timeoutMs: { value: timeoutMs, origin: invocation.timeoutMs === undefined ? 'default' : 'explicit' },
      maxOutputBytes: { value: maxOutputBytes, origin: invocation.maxOutputBytes === undefined ? 'default' : 'explicit' },
      acceptedExitCodes: [...invocation.acceptedExitCodes],
      ...(capturedMissing ? { reason: `executable-missing:${capturedMissing}` } : {}) } };
}
async function captureSelection(selection: ExecutionPolicy['selections'][number], roots: Record<string, string>,
    budget: MaterialCaptureBudget, signal?: AbortSignal): Promise<{ recipe: Recipe; recipeSha256: string; material: { readonly materials: readonly OwnMaterial[];
      readMaterial(id: string): Buffer | undefined; recheck(): Promise<boolean> } }> {
  // A recipe-less selection was rendered before any capture.
  const selected = selection.recipe!;
  if ('reference' in selected) {
    const captured = await captureRecipeReference(selected.reference, roots, { signal, budget });
    const recipe = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(captured.readRecipe()), 'recipe') as unknown as Recipe;
    if (!validateRecipe(recipe).valid) throw new Error('recipe-invalid');
    const declared = [...recipe.materials].map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength })).sort((a, b) => codeUnitCompare(a.id, b.id));
    const acquired = [...captured.materials].map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength })).sort((a, b) => codeUnitCompare(a.id, b.id));
    if (canonicalJson(declared) !== canonicalJson(acquired)) throw new Error('material-closure');
    return { recipe, recipeSha256: captured.recipeSha256, material: captured };
  }
  const recipe = selected.inline;
  if (recipe.materials.some(item => !('source' in item))) throw new Error('material-source-missing');
  const captured = await captureInlineMaterials(recipe.materials.filter(item => 'source' in item), roots, { signal, budget });
  return { recipe, recipeSha256: digest(recipe), material: captured };
}

export function transaction(root: string, directoryCreated?: (path: string) => void) {
  if (!isContentRoot(root)) return fileTransaction(root, stateRoot(), directoryCreated);
  // userState is a Core-assigned content child, never the reserved state root.
  const create = () => contentTransaction(root, directoryCreated);
  if (pathPins(root).at(-1)?.identity !== 'absent') return create();
  return {
    inspect(path: string): OwnedFileRead {
      if (path.split('/').some(part => !validSegment(part))) return { state: 'unreadable', detail: 'invalid-path' };
      if (pathPins(root).at(-1)?.identity === 'absent') return { state: 'absent' };
      return create().inspect(path);
    },
    commit(steps: readonly OwnedFileStep[]): void {
      if (pathPins(root).at(-1)?.identity !== 'absent') throw stale('target-file');
      protectState(); mkdirSync(root, { recursive: true, mode: 0o700 });
      protectState([`content/${basename(root)}`]);
      create().commit(steps);
    }
  };
}
/** Does this JSON/JSONC document hold any value beyond empty objects and arrays? */
function hasJsonContent(bytes: Buffer): boolean {
  const errors: ParseError[] = [];
  const value = parseJsonc(bytes.toString('utf8'), errors, { allowTrailingComma: true }) as Json | undefined;
  if (errors.length) return true;
  const empty = (item: Json | undefined): boolean => item === null || item === undefined ? true :
    Array.isArray(item) ? item.every(empty) : typeof item === 'object' ? Object.values(item as Record<string, Json | undefined>).every(empty) : false;
  return !empty(value);
}

function stageRecovery(runId: string, steps: PreparedStep[], project: string): string {
  const base = `recovery/${runId}`;
  pathPins(join(stateRoot(), base));
  mkdirSync(join(stateRoot(), base), { recursive: true, mode: 0o700 });
  protectState([base]);
  const records: { id: string; root: string; path: string; before: string | null; intendedSha256: string | null; snapshot?: string }[] = [];
  for (const [index, step] of steps.entries()) {
    if (!step.path || !['create-file', 'replace-file', 'remove-file'].includes(step.review.effects)) continue;
    const record: (typeof records)[number] = { id: step.review.id, root: step.root!, path: step.path,
      before: step.before ? sha256(step.before) : null, intendedSha256: step.after ? sha256(step.after) : null };
    if (step.before) {
      const snapshot = `${base}/${index}.bin`; const absolute = join(stateRoot(), snapshot);
      pathPins(absolute);
      writeFileSync(absolute, step.before, { flag: 'wx', mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(absolute, 0o600);
      protectState([snapshot]); record.snapshot = snapshot;
    }
    records.push(record);
  }
  const reference = `${base}/manifest.json`;
  stateFiles().writeAtomic(reference, Buffer.from(JSON.stringify({ target: project, operations: records,
    instruction: 'Inspect current state before manual recovery; this is not execution authority.' })), 0o600);
  return reference;
}

export async function prepare(request: PolicyRequest, controls: HostControls = {},
    unavailableInvocations?: CapturedUnavailableInvocations,
    custodyImageStillCurrent?: () => boolean,
    trustParticipant?: TrustEngineParticipant, cleanup?: CleanupOptions, update?: UpdateOptions): Promise<PreparationResult> {
  const runId = randomUUID();
  // Only repair adapts this engine through captured invocations; its trust-resolution contract has no keyed hints.
  const hinted = unavailableInvocations === undefined;
  let result: PreparationResult = { status: 'invalid', runId, diagnostics: [], record: disabled, ...(hinted ? { resolutionInputs: [], operationSelections: [] } : {}) };
  let logging: 'on' | 'off' = 'off'; let project: string | undefined; let secrets: string[] = [];
  try {
    validateControls(controls); logging = loggingOption(controls).value; secrets = bearerSecrets(controls);
    const capturedUnavailable = clone(unavailableInvocations ?? { operations: {}, checks: {} });
    dataObject(capturedUnavailable, ['operations', 'checks']);
    for (const entries of [capturedUnavailable.operations, capturedUnavailable.checks]) {
      dataObject(entries, Object.keys(entries));
      for (const [id, name] of Object.entries(entries))
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ||
            typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('captured-prerequisite-invalid');
    }
    if (controls.signal?.aborted) throw new Error('cancelled');
    if (!nodeRuntimeSupported()) throw new Error('node-runtime');
    dataObject(request, ['useCase', 'policy', 'target', 'resolutions', 'organizationSource', 'organizationTarget', 'organizationSetMembers']);
    dataObject(request.target, ['project']);
    if (request.useCase !== 'policy') throw new Error('use-case-unsupported');
    const validation = validatePolicy(request.policy);
    if (!validation.valid) { result.diagnostics = validation.diagnostics; return finish(); }
    const policy = clone(request.policy);
    const enterprise = policy.mode === 'enterprise';
    if (enterprise && request.organizationSource === undefined) {
      result.diagnostics = [diagnostic('INPUT_INVALID', 'organization-source-required', 'Enterprise preparation requires an independently selected organization source.')];
      return finish();
    }
    if (!enterprise && request.organizationSource !== undefined) {
      result.diagnostics = [diagnostic('INPUT_INVALID', 'organization-source-vibe', 'A Vibe policy does not accept an organization source.')];
      return finish();
    }
    if (!enterprise && request.organizationSetMembers !== undefined) {
      result.diagnostics = [diagnostic('INPUT_INVALID', 'organization-set-members-vibe', 'A Vibe policy does not accept organization set membership.')];
      return finish();
    }
    if (isLocalSource(request.organizationSource) && policy.schema !== POLICY_14 && policy.schema !== POLICY_15 && policy.schema !== POLICY_16) {
      result.diagnostics = [diagnostic('INPUT_INVALID', 'organization-source-local-review',
        'A local organization source needs execution policy 1.4.0 or later, whose review names the file.')];
      return finish();
    }
    let organizationTarget: OrganizationTargetDeclaration | undefined;
    if (request.organizationTarget !== undefined) {
      if (!enterprise) {
        result.diagnostics = [diagnostic('INPUT_INVALID', 'organization-target-vibe', 'A Vibe policy does not accept an organization target.')];
        return finish();
      }
      const checked = validateOrganizationTarget(request.organizationTarget);
      if (!checked.valid) { result.diagnostics = checked.diagnostics; return finish(); }
      organizationTarget = clone(request.organizationTarget);
      if ('tool' in organizationTarget) {
        // A registry tool without an observed binding cell is never a preparation target.
        const selected = selectTool(organizationTarget.tool.id);
        if (selected.status !== 'selected') {
          result.status = 'blocked';
          result.diagnostics = [diagnostic('PREREQUISITE_UNAVAILABLE', 'tool-not-observed', 'The organization target names a tool that has not been observed.')];
          return finish();
        }
        // Prepared work 1.5.0 records the declared target as a native client id.
        if (!isNativeClient(selected.tool.id)) {
          result.status = 'blocked';
          result.diagnostics = [diagnostic('PREREQUISITE_UNAVAILABLE', 'tool-target-unsupported', 'This Core cannot yet record that tool as a declared target.')];
          return finish();
        }
      }
    }
    const targetClient = organizationTarget === undefined ? undefined :
      ('tool' in organizationTarget ? organizationTarget.tool.id : organizationTarget.client) as NativeClientId;
    const targetFacts: OrganizationTargetFacts | undefined = organizationTarget === undefined ? undefined :
      { client: targetClient, ...(organizationTarget.repository === undefined ? {} : { repository: organizationTarget.repository }) };
    // Recipes the policy carries are declared now; recipe-less ones after the authority read renders them (below).
    const captureBudget = createMaterialCaptureBudget();
    for (const { recipe } of policy.selections) {
      if (recipe === undefined) continue;
      if ('reference' in recipe) captureBudget.declareReference(recipe.reference);
      else captureBudget.declareInline(recipe.inline.materials);
    }
    const resolutions = clone(request.resolutions ?? []);
    if (!Array.isArray(resolutions) || new Set(resolutions.map(item => `${item.selectionId}/${item.operationId}`)).size !== resolutions.length)
      throw new Error('resolution-invalid');
    for (const item of resolutions) {
      dataObject(item, ['selectionId', 'operationId', 'choice', 'observedSha256']);
      if (typeof item.selectionId !== 'string' || typeof item.operationId !== 'string' ||
          !['replace', 'adopt'].includes(item.choice) || item.observedSha256 !== null &&
          (typeof item.observedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.observedSha256))) throw new Error('resolution-invalid');
    }
    project = projectRoot(request.target.project);
    const privateInputs = clone(controls.privateInputs ?? {});
    for (const [selectionId, values] of Object.entries(privateInputs)) {
      const selection = policy.selections.find(item => item.id === selectionId);
      if (!selection || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error('private-input-unknown');
      const recipe = selection.recipe;
      if (recipe !== undefined && 'inline' in recipe) for (const name of Object.keys(values))
        if (!Object.hasOwn(recipe.inline.inputs, name) || !recipe.inline.inputs[name]?.sensitive)
          throw new Error('private-input-unknown');
    }
    const privateValues = Object.values(privateInputs).flatMap(inputs => Object.values(inputs)).map(String);
    privateValues.push(...secrets);
    // Fresh authority read precedes any material capture; failure yields no handle.
    let organization: { read: OrganizationRead; document: OrganizationPolicy; membership: SetMembership } | undefined;
    if (enterprise) {
      const read = await readOrganization(clone(request.organizationSource), controls);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes); }
      catch {
        result.diagnostics = [diagnostic('INPUT_INVALID', 'organization-document-encoding', 'The organization document is not valid UTF-8.')];
        return finish();
      }
      const setMembers = clone(request.organizationSetMembers);
      const parsed = parseOrganizationPolicy(text, setMembers === undefined ? {} : { setMembers });
      if (!parsed.valid || !parsed.document) { result.diagnostics = parsed.diagnostics; return finish(); }
      organization = { read, document: parsed.document, membership: new SetMembership(setMembers) };
    }
    // Execution policy 1.6.0: Core renders each recipe-less selection from its shipped binding and named Catalog release,
    // only now that any authority has been read. Its reads count against the same budget; every later step sees the
    // rendered recipe as it would an inline one.
    const recipeless = policy.selections.filter(selection => selection.recipe === undefined);
    const rendering = await renderRecipelessSelections(policy, controls.materialRoots ?? {}, captureBudget, controls.signal);
    if (rendering.diagnostics.length) { result.diagnostics = rendering.diagnostics; return finish(); }
    for (const selection of recipeless) {
      const recipe = (selection.recipe as { inline: Recipe }).inline;
      captureBudget.declareInline(recipe.materials);
      for (const name of Object.keys(privateInputs[selection.id] ?? {}))
        if (!Object.hasOwn(recipe.inputs, name) || !recipe.inputs[name]?.sensitive) throw new Error('private-input-unknown');
    }
    captureBudget.seal();
    const admissions: AdmissionSelection[] = [];
    let obligations: OrganizationObligationsReview | undefined;
    const steps: PreparedStep[] = [];
    const overlays = new Map<string, { initial: Buffer | null; after: Buffer | null; priorId: string }>();
    // The last reviewed rescue step per notes path: a later rescue composes on its bytes, so the steps
    // must run in creation order even after the review's topological re-sort.
    const rescueChains = new Map<string, string>();
    // Members whose step conflicted: later same-member steps are blocked, not guessed.
    const hookConflicts = new Map<string, string>();
    const inputs: PreparedReview['effectiveOptions']['inputs'] = {};
    const conflicts: Diagnostic[] = []; const omissions: Diagnostic[] = []; const observations: PreparedReview['observations'] = [];
    const ownership = new Map<string, { value: Ownership; digest: string | null }>();
    const captures: { recheck(): Promise<boolean> }[] = [...rendering.captures];
    const selectionOps = new Map<string, string[]>();
    const unavailableSelections = new Set<string>();
    const usedResolutions = new Set<string>();
    const knownProcesses = new Set<string>(); const knownChecks = new Set<string>();
    const namesSelections = policy.schema === POLICY_14 || policy.schema === POLICY_15 || policy.schema === POLICY_16;
    // Prepared work 1.7.0 adds each item's framework, layout and checked scan state, and the items left out.
    const checksScans = policy.schema === POLICY_15 || policy.schema === POLICY_16;
    // Prepared work 1.6.0: what each selection delivers, measured from the bytes this preparation computed.
    const selectionFacts = new Map<string, { inputs: string[]; delivered: DeliveredEntry[]; hookCommands: string[]; own: OwnMaterial[] }>();
    for (const selection of dependencyOrder(policy.selections)) {
      if (controls.signal?.aborted) throw new Error('cancelled');
      let captured: Awaited<ReturnType<typeof captureSelection>>;
      try { captured = await captureSelection(selection, controls.materialRoots ?? {}, captureBudget, controls.signal); }
      catch (error) {
        if (!(error instanceof MaterialCaptureError) || !['archive-download-failed', 'archive-incomplete',
          'local-file-unavailable', 'local-root-unavailable', 'acquisition-deadline'].includes(error.reason)) throw error;
        omissions.push(diagnostic('PREREQUISITE_UNAVAILABLE', error.reason,
          `Selected material for ${safeText(selection.id, privateValues)} is unavailable.`));
        unavailableSelections.add(selection.id); selectionOps.set(selection.id, []);
        if (organization) {
          // Without captured material the identity is unknown; the selection still needs a matching entry.
          const entry = organization.document.selections.find(item => item.selectionId === selection.organizationSelectionId);
          admissions.push({ id: selection.id, organizationSelectionId: selection.organizationSelectionId!, scope: selection.scope,
            recipeIdentity: entry?.recipeIdentity ?? UNMATCHED_RECIPE_IDENTITY, inputs: {}, configuration: selection.configuration,
            privateInputs: Object.keys(privateInputs[selection.id] ?? {}), ...contentFacts(selection),
            path: `/selections/${policy.selections.indexOf(selection)}` });
        }
        continue;
      }
      const { recipe, recipeSha256, material } = captured;
      for (const op of recipe.operations) if (op.kind === 'process.run') knownProcesses.add(`${selection.id}/${op.id}`);
      for (const check of recipe.checks) if (check.kind === 'process.exit') knownChecks.add(`${selection.id}/${check.id}`);
      captures.push(material);
      const recipeValidation = validateRecipe(recipe);
      if (!recipeValidation.valid) { result.diagnostics = recipeValidation.diagnostics; return finish(); }
      // The enclosing policy version gates the recipe version, including acquired bytes a reference never names.
      const supportedRecipes = recipeFormatsForPolicy(policy.schema);
      if (!supportedRecipes.includes(recipe.schema)) {
        result.diagnostics = [{ code: 'SCHEMA_UNSUPPORTED', reason: 'recipe-schema', message: 'This policy version does not support that recipe format.',
          encountered: recipe.schema, supported: supportedRecipes, guidance: 'Use an execution policy version that admits the selected recipe version.' }];
        return finish();
      }
      if (!recipe.targets.includes(selection.scope) || recipe.operations.some(op => op.scope !== selection.scope)) throw new Error('scope-mismatch');
      for (const name of Object.keys(privateInputs[selection.id] ?? {}))
        if (!Object.hasOwn(recipe.inputs, name) || !recipe.inputs[name]?.sensitive) throw new Error('private-input-unknown');
      const selectionKey = sha256(`${selection.scope === 'user' ? userHomeRoot() : project}\0${selection.scope}\0${selection.managementId}`);
      const bound: Record<string, Json> = Object.create(null);
      for (const [name, value] of Object.entries(selection.configuration))
        if (!Object.hasOwn(recipe.inputs, name) || recipe.inputs[name]!.sensitive || !inputAccepts(recipe.inputs[name]!, value)) throw new Error('input-value');
      for (const [name, spec] of Object.entries(recipe.inputs)) {
        const value = spec.sensitive ? privateInputs[selection.id]?.[name] :
          Object.hasOwn(selection.configuration, name) ? selection.configuration[name] : spec.default;
        if (value === undefined && !spec.required) continue;
        if (!inputAccepts(spec, value)) throw new Error('input-value');
        bound[name] = value;
        inputs[`${selection.id}/${name}`] = { origin: spec.sensitive ? 'private' : Object.hasOwn(selection.configuration, name) ? 'explicit' : 'default' };
      }
      const recipeIdentity = `sha256:${digest(recipeIdentityDescriptor(recipeSha256, recipe.materials))}`;
      const facts = { inputs: Object.keys(bound).sort(codeUnitCompare), delivered: [] as DeliveredEntry[], hookCommands: [] as string[],
        own: material.materials.map(({ id, path, sha256: digest, byteLength }) => ({ id, path, sha256: digest, byteLength })) };
      selectionFacts.set(selection.id, facts);
      if (organization) admissions.push({ id: selection.id, organizationSelectionId: selection.organizationSelectionId!, scope: selection.scope,
        recipeIdentity, inputs: recipe.inputs, configuration: selection.configuration,
        privateInputs: Object.keys(privateInputs[selection.id] ?? {}), ...contentFacts(selection),
        path: `/selections/${policy.selections.indexOf(selection)}` });
      const priorSelections = selection.requires.flatMap(id => selectionOps.get(id) ?? []);
      const currentIds: string[] = [];
      const checkMap = new Map(recipe.checks.map(check => [check.id, check]));
      let prerequisite: string | undefined = selection.requires.some(id => unavailableSelections.has(id)) ? 'selection-unavailable' : undefined;
      for (const [index, requirement] of recipe.prerequisites.entries()) {
        const outcome = requirement.kind === 'platform' ?
          requirement.os === process.platform && requirement.architectures.includes(process.arch) ? 'available' : 'platform-unavailable' :
          resolveExecutable(requirement.name) ? 'available' : 'executable-missing';
        observations.push({ id: `${selection.id}/prerequisite-${index}`, reason: outcome });
        if (outcome !== 'available') prerequisite = outcome;
      }
      for (const op of dependencyOrder(recipe.operations)) {
        const id = `${selection.id}/${op.id}`; currentIds.push(id);
        const requires = [...priorSelections, ...op.requires.map(required => `${selection.id}/${required}`)];
        const selectedChecks = op.checks.map(checkId => checkMap.get(checkId)!);
        const preparedChecks = selectedChecks.map(check => prepareCheck(check, bound, project!, selectionKey, material, privateValues, selection.id,
          capturedUnavailable.checks[`${selection.id}/${check.id}`]));
        const checks = preparedChecks.map(item => item.prepared);
        let initialBefore: Buffer | null | undefined;
        let root: string | undefined; let path: string | undefined; let before: Buffer | null | undefined;
        let after: Buffer | null | undefined; let pins: PathPin[] | undefined; let mode: number | undefined;
        let custodyOnly = false; let custody: Record<string, Owner | null> | undefined;
        let stepMembers: MemberDescriptor[] | undefined; let preExisting: Record<string, Json> | undefined;
        let ownerKey: string | undefined; let preparedProcess: PreparedProcess | undefined;
        let details: ReviewOperation['details'] = {}; let effect: ReviewOperation['effects'] = 'already-satisfied';
        let createdContainer = false;
        let editConflict: string | undefined; let conflictReason: string | undefined; let createdTables: Map<string, TomlTableCustody> | undefined; const tomlHeirs: string[] = [];
        // Custody keys that only record an inherited line break; the operation does not author them.
        let inherited: string[] | undefined;
        let ownerState: 'managed' | 'unowned' = 'unowned'; let resolution: 'replace' | 'adopt' | undefined;
        // Reviewed choices that would change this conflict or acquire identical unowned content.
        const choices: ('replace' | 'adopt')[] = []; let overlayKey: string | undefined;
        // Project basics update: the person's own lines rescued from a shared block, with the user-owned
        // notes write that preserves them; null unless this step updates a shared block they added lines to.
        let rescuedLines: string[] | null = null;
        let rescueStep: { path: string; initial: Buffer | null; before: Buffer | null; after: Buffer; mode: number } | null = null;
        if (op.kind === 'process.run') {
          const resolved = resolveProcess(op, bound, project, selectionKey, material, privateValues, capturedUnavailable.operations[id]);
          preparedProcess = resolved.process; details = { ...resolved.review, declaredEffects: op.effects.map(item => safeText(item, privateValues)) };
          effect = 'opaque-process';
        } else {
          const target = resolvePath(op.target, op.scope, bound, project, selectionKey);
          root = target.root; path = target.path; pins = pathPins(target.absolute); ownerKey = path;
          const key = `${root}:${process.platform === 'win32' ? path.toLowerCase() : path}`; overlayKey = key;
          const overlay = overlays.get(key);
          if (overlay) requires.push(overlay.priorId);
          guardTrustMember(root, path, trustParticipant?.allows(root, path) ?? false, trustParticipant?.macosSession === true);
          const tx = transaction(root); const live = tx.inspect(path);
          if (live.state === 'unreadable') throw new Error('target-unreadable');
          initialBefore = live.state === 'present' ? Buffer.from(live.bytes) : null;
          before = overlay ? overlay.after : initialBefore;
          mode = op.kind === 'file.write' ? op.mode ?? (live.state === 'present' ? live.mode : 0o600) :
            live.state === 'present' ? live.mode : 0o600;
          const stored = ownership.get(root) ?? readOwnership(root); ownership.set(root, stored);
          const projected: Ownership = { ...stored.value, members: { ...stored.value.members } };
          for (const prior of steps.filter(step => step.root === root && step.custody && (['create-file', 'replace-file', 'remove-file'].includes(step.review.effects) || step.resolution === 'adopt' || step.custodyOnly))) updateCustody(projected, prior);
          if (op.kind === 'hook.group') {
            const authored = bindHookGroup(op, bound);
            if (authored.group) facts.hookCommands.push(...hookGroupCommands(redactJson(redactHookBindings(authored.group, op, recipe.inputs), privateValues))
              .map(command => redactExact(command, privateValues)));
            const selectorSha = sha256(authored.selector.value);
            const descriptor: HookDescriptor = { path, kind: 'hook', format: op.format, container: op.container, groupId: op.groupId,
              selector: { path: authored.selector.path, valueSha256: selectorSha } };
            const hookKey = memberKey(descriptor); ownerKey = hookKey; stepMembers = [descriptor];
            const mine = (candidate: Claim): boolean => candidate.managementId === selection.managementId && candidate.scope === selection.scope;
            const claim: Claim = { managementId: selection.managementId, scope: selection.scope,
              sets: (policy.managedSelections ?? []).filter(set => set.scope === selection.scope && set.members.includes(selection.managementId)).map(set => set.id),
              requires: selection.requires.map(id => { const dependency = policy.selections.find(item => item.id === id)!; return claimIdentity(dependency.scope, dependency.managementId, project!); }) };
            const addMine = (claims: Claim[]): Claim[] => [...claims.filter(candidate => !mine(candidate)),
              { ...claim, sets: [...new Set([...(claims.find(mine)?.sets ?? []).filter(id => !policy.managedSelections?.some(set => set.id === id && set.scope === claim.scope)), ...claim.sets])] }];
            const retained: RetainedHook[] = Object.entries(projected.members).flatMap(([memberId, member]) =>
              member.descriptor?.kind === 'hook' && memberId !== hookKey && samePath(member.descriptor.path, path!) && member.descriptor.format === op.format &&
              canonicalJson(member.descriptor.container) === canonicalJson(op.container) ? [{ key: memberId, descriptor: member.descriptor }] : []);
            const incompatible = Object.hasOwn(projected.members, memberKey({ path, kind: 'file' })) ||
              Object.entries(projected.members).some(([memberId, member]) => memberId !== hookKey && member.descriptor &&
                overlappingMembers(descriptor, member.descriptor, before));
            const currentDigest = before === null ? null : sha256(before);
            const choice = resolutions.find(item => item.selectionId === selection.id && item.operationId === op.id);
            if (choice) {
              usedResolutions.add(`${selection.id}/${op.id}`);
              if (choice.observedSha256 !== currentDigest) throw new Error('resolution-stale');
            }
            const priorConflict = hookConflicts.get(`${root}:${hookKey}`);
            if (priorConflict) requires.push(priorConflict);
            const stepInput: HookStepInput = { authored, allowSelectorChange: 'input' in op.selector, path, key: hookKey, before,
              owner: projected.members[hookKey], retained, resolution: undefined, isMine: mine, addMine, recipeIdentity, mode: mode!,
              ...(priorConflict ? { forced: 'hook-prior-conflict' } : incompatible ? { forced: 'existing-content' } : {}) };
            const decideWith = (option: 'replace' | 'adopt' | undefined): HookDecision => decideHookStep({ ...stepInput, resolution: option });
            const decision = decideWith(choice?.choice);
            if (decision.effect === 'conflict') for (const option of ['replace', 'adopt'] as const) {
              try { if (decideWith(option).effect !== 'conflict') choices.push(option); }
              catch (error) { if (!(error instanceof Error) || error.message !== 'resolution-invalid') throw error; }
            }
            effect = decision.effect; after = decision.after;
            // A file and JSON containers this run creates are remembered so the last removal can take them
            // away; a later group in the same file inherits them from the earlier owner.
            const sameFile = Object.values(projected.members).filter(member => member.descriptor?.path === path);
            const fileCreated = initialBefore === null || sameFile.some(member => member.createdFile === true);
            // Containers matter only when the file existed before; a file this run created is deleted whole.
            const createdPaths = initialBefore === null ? [] : [...new Map([...sameFile.flatMap(member => member.createdContainers ?? []),
              ...missingContainers(op.format, initialBefore, op.container)].map(item => [JSON.stringify(item), item])).values()];
            const boundedPaths = createdPaths.length && JSON.stringify(createdPaths).length <= 4096 ? createdPaths : [];
            custody = { [hookKey]: decision.custody === null ? null : { ...decision.custody,
              ...(fileCreated ? { createdFile: true as const } : {}), ...(boundedPaths.length ? { createdContainers: boundedPaths } : {}) } };
            custodyOnly = decision.custodyOnly;
            ownerState = decision.managed ? 'managed' : 'unowned';
            resolution = effect === 'conflict' ? undefined : choice?.choice;
            if (after && after.byteLength > 16 * 1024 * 1024) throw new Error('file-limit');
            const desiredGroup = decision.details.desiredGroup ? redactJson(redactHookBindings(decision.details.desiredGroup, op, recipe.inputs), privateValues) as typeof decision.details.desiredGroup : null;
            details = { target: safeText(target.absolute, privateValues), format: op.format, mode: mode!,
              ...(decision.reason ? { reason: decision.reason } : {}), hookGroup: { ...decision.details, desiredGroup } };
            if (effect === 'conflict') {
              conflicts.push(hookConflict(decision, op.groupId, path, privateValues)); conflictReason = conflicts.at(-1)!.reason;
              hookConflicts.set(`${root}:${hookKey}`, id);
            } else overlays.set(key, { initial: overlay?.initial ?? initialBefore!, after: after!, priorId: id });
            emit();
            continue;
          }
          const owner = Object.hasOwn(projected.members, ownerKey) ? projected.members[ownerKey] : undefined;
          if (owner?.managementId.startsWith('ca-export-') && !(trustParticipant?.allows(root,path) ?? false)) throw new Error('trust-custody-conflict');
          let managed = owner?.managementId === selection.managementId && (!owner.claims || owner.claims.some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope)) && before !== null && owner.sha256 === sha256(before);
          ownerState = managed ? 'managed' : 'unowned';
          if (op.kind === 'file.write') {
            after = op.material ? material.readMaterial(op.material) : Buffer.from(resolveString(op.content!, bound));
            if (!after) throw new Error('material-missing');
            facts.delivered.push({ path, bytes: after, block: false });
          } else if (op.kind === 'config.entries') {
            const entries = op.entries.map(entry => entry.action === 'set' ? { ...entry, value: resolveSlot(entry.value, bound) } : entry);
            details = { format: op.format, entries: entries.map((entry, index) => {
              if (entry.action === 'remove') return { path: entry.path, action: entry.action };
              const source = op.entries[index]!;
              const sensitive = source.action === 'set' && 'input' in source.value && recipe.inputs[source.value.input]?.sensitive;
              return { path: entry.path, action: entry.action,
                value: sensitive ? '[REDACTED]' : canonicalJson(redactJson(entry.value, privateValues)) };
            }), ...(op.approval ? { approval: { tool: op.approval.tool } } : {}) };
            try {
              const created = new Map<string, TomlTableCustody>();
              after = renderConfigEntries(op.format, before, entries, created);
              if (op.format === 'toml') {
                createdTables = created;
                // A key this recipe now removes takes the header Core created with it once nothing else is in the table.
                // A table that receives a removed header's line break takes it from then on, for later removals in this operation.
                const heirRecords = new Map<string, TomlTableCustody>();
                for (const entry of entries) {
                  const table = entry.action === 'remove' ? tomlTableOf(entry.path) : undefined;
                  const recorded = table && projected.members[memberKey({ path: path!, kind: 'entry', format: 'toml', entry: entry.path })]?.tomlTable;
                  if (!table || !recorded) continue;
                  const released = removeCreatedTomlTable(after, table.segments, heirRecords.get(table.key) ?? recorded);
                  after = released.bytes;
                  if (released.heir) { tomlHeirs.push(released.heir); heirRecords.set(released.heir, 'created-after-newline'); }
                }
              }
            }
            catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; after = before; }
          } else if (op.kind === 'config.member') {
            details = { format: op.format, member: { container: op.container, action: op.action, value: canonicalJson(op.value.literal) },
              ...(op.approval ? { approval: { tool: op.approval.tool } } : {}) };
            try {
              createdContainer = op.action === 'add' && configMemberBytes(op.format, before, op.container) === null;
              after = renderConfigMember(op.format, before, { container: op.container, action: op.action, value: op.value.literal,
                ...(op.exclusiveWith ? { exclusiveWith: op.exclusiveWith } : {}) });
            } catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; after = before; }
          } else if (op.kind === 'text.block') {
            if (op.action === 'set' && op.content) facts.delivered.push({ path, bytes: Buffer.from(resolveString(op.content, bound)), block: true });
            details = { blockId: op.blockId, startMarker: op.startMarker, endMarker: op.endMarker,
              blockAction: op.action, ...(op.content ? { content: redactExact(resolveString(op.content, bound), privateValues) } : {}) };
            try { after = renderTextBlock(before, { blockId: op.blockId, startMarker: op.startMarker,
              endMarker: op.endMarker, action: op.action, ...(op.content ? { content: resolveString(op.content, bound) } : {}) }); }
            catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; after = before; }
          } else after = null;
          if (after && after.byteLength > 16 * 1024 * 1024) throw new Error('file-limit');
          // A tool approval: the person's own choice there is never replaced, adopted or owned by Core.
          const approval = (op.kind === 'config.entries' || op.kind === 'config.member') ? op.approval : undefined;
          const descriptors: ByteMember[] = op.kind === 'config.entries' ? op.entries.map(entry => ({ path: path!, kind: 'entry', format: op.format, entry: entry.path })) :
            op.kind === 'config.member' ? [{ path, kind: 'member', format: op.format, container: op.container, valueSha256: memberDigest(op.value.literal) }] :
            op.kind === 'text.block' ? [{ path, kind: 'block', blockId: op.blockId, startMarker: op.startMarker, endMarker: op.endMarker }] : [{ path, kind: 'file' }];
          stepMembers = descriptors;
          // Project basics: record the exact text of a shared block so a later update can tell a
          // person's own lines inside it from the content Core wrote.
          const sharedContent = op.kind === 'text.block' && op.action === 'set' && op.content &&
            sharedBlockRole(op.startMarker, op.endMarker) !== null ? resolveString(op.content, bound) : null;
          try {
            const claim: Claim = { managementId: selection.managementId, scope: selection.scope, sets: (policy.managedSelections ?? []).filter(set => set.scope === selection.scope && set.members.includes(selection.managementId)).map(set => set.id), requires: selection.requires.map(id => { const dependency = policy.selections.find(item => item.id === id)!; return claimIdentity(dependency.scope, dependency.managementId, project!); }) };
            const matches = descriptors.map(member => {
              const prior = projected.members[memberKey(member)];
              const bytes = memberBytes(member, before!);
              return !!prior && (prior.claims ?? [{ managementId: prior.managementId, scope: selection.scope }]).some(item => item.managementId === selection.managementId && item.scope === selection.scope) &&
                bytes !== null && prior.sha256 === sha256(bytes);
            });
            managed = managed || matches.every(Boolean);
            ownerState = managed ? 'managed' : 'unowned';
            custody = Object.fromEntries(descriptors.map(member => {
              const key = memberKey(member); const bytes = memberBytes(member, after!); const prior = projected.members[key];
              const tomlTable = createdTables && member.kind === 'entry' ? createdTableCustody(member, createdTables, prior, projected.members) : undefined;
              const fileCreated = selection.item !== undefined &&
                (initialBefore === null || Object.values(projected.members).some(owner => owner.descriptor?.path === path && owner.createdFile === true));
              return [key, bytes === null ? null : { managementId: selection.managementId, recipeIdentity, sha256: sha256(bytes), mode: mode!, descriptor: member, ...(tomlTable ? { tomlTable } : {}),
                ...(approval ? { approval: { tool: approval.tool } } : {}), ...(member.kind === 'member' && (createdContainer || prior?.createdContainer) ? { createdContainer: true as const } : {}),
                ...(fileCreated ? { createdFile: true as const } : {}),
                ...(sharedContent !== null && sharedContent.length <= 65536 ? { sharedContent } : {}),
                claims: [...(prior?.claims ?? []).filter(item => item.managementId !== claim.managementId || item.scope !== claim.scope),
                  { ...claim, sets: [...new Set([...(prior?.claims?.find(item => item.managementId === claim.managementId && item.scope === claim.scope)?.sets ?? []).filter(id => !policy.managedSelections?.some(set => set.id === id && set.scope === claim.scope)), ...claim.sets])] }] }];
            }));
            if (tomlHeirs.length) {
              // Only owners this step leaves in place inherit; one it deletes (null custody) stays deleted.
              const authoredKeys = new Set(Object.keys(custody));
              const surviving = Object.fromEntries(Object.entries({ ...projected.members, ...custody }).filter((item): item is [string, Owner] => item[1] !== null));
              const update = inheritTomlBreak(surviving, path!, tomlHeirs);
              inherited = Object.keys(update).filter(key => !authoredKeys.has(key));
              Object.assign(custody, update);
            }
          } catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; }
          if (approval) {
            // A different value the person already chose at the server's key, or the server in the tool's denied list,
            // is their decision: a conflict, never overwritten. Core's own changed approval stays a drift conflict.
            if (editConflict === 'member-excluded') editConflict = 'approval-denied';
            else if (!editConflict) try {
              const member = descriptors[0]!; const found = memberBytes(member, before!); const desired = memberBytes(member, after!);
              const prior = projected.members[memberKey(member)];
              if (found !== null && desired !== null && !found.equals(desired) && !prior?.claims?.some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope))
                editConflict = 'approval-denied';
            } catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; }
          }
          if (custody && owner && !owner.descriptor && managed && !descriptors.some(member => memberKey(member) === ownerKey)) custody[ownerKey!] = null;
          const currentDigest = before === null ? null : sha256(before);
          // Project basics update: a person's own lines added inside a shared block move to the user-owned
          // notes file, shown in this review, and the block itself updates instead of conflicting. Anything
          // but added lines (deletions or edits of Core's text) stays an ordinary conflict, never rescued.
          if (update !== undefined && op.kind === 'text.block' && op.action === 'set' && op.content && before !== null &&
              descriptors.length === 1 && sharedBlockRole(op.startMarker, op.endMarker) !== null) {
            const member = descriptors[0]!;
            const prior = projected.members[memberKey(member)];
            if (member.kind === 'block' && prior?.sharedContent !== undefined &&
                (prior.claims ?? []).some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope)) {
              const body = extractBlockBody(before.toString('utf8'), member.startMarker, member.endMarker);
              const extra = body === null ? null : personLinesInside(body, prior.sharedContent.replace(/\r\n?/g, '\n'));
              if (extra) {
                // The folder the reviewed recipe configured, which may be a nested safe relative path; the
                // notes file lands inside it either way.
                const configured = bound.projectFolder;
                const segments = typeof configured === 'string' ? configured.split('/') : [];
                const folder = segments.length >= 1 && segments.length <= 8 && segments.every(segment => validSegment(segment)) ? segments.join('/') : 'ai-coding';
                const notesPath = `${folder}/${USER_NOTES_FILE}`;
                const notesKey = `${project}:${process.platform === 'win32' ? notesPath.toLowerCase() : notesPath}`;
                const notesOverlay = overlays.get(notesKey);
                const notesLive = transaction(project!).inspect(notesPath);
                if (notesLive.state !== 'unreadable') {
                  const notesBefore = notesOverlay ? notesOverlay.after : notesLive.state === 'present' ? Buffer.from(notesLive.bytes) : null;
                  const eol = notesBefore && notesBefore.includes('\r\n') ? '\r\n' : '\n';
                  const existing = notesBefore ? notesBefore.toString('utf8') : '';
                  const base = existing && !existing.endsWith('\n') && !existing.endsWith('\r') ? existing + eol : existing;
                  const afterText = base + extra.join(eol) + eol;
                  if (Buffer.byteLength(afterText, 'utf8') <= 16 * 1024 * 1024) {
                    rescuedLines = extra;
                    // The pinned initial state is the pre-review file; the overlaid bytes are only this
                    // step's immediate input, so several rescued blocks can update in one run.
                    rescueStep = { path: notesPath, initial: notesOverlay ? notesOverlay.initial : notesBefore, before: notesBefore,
                      after: Buffer.from(afterText, 'utf8'), mode: notesLive.state === 'present' ? notesLive.mode : 0o600 };
                  }
                }
              }
            }
          }
          const choice = resolutions.find(item => item.selectionId === selection.id && item.operationId === op.id);
          if (choice) {
            usedResolutions.add(`${selection.id}/${op.id}`);
            if (choice.observedSha256 !== currentDigest) throw new Error('resolution-stale');
            resolution = choice.choice;
            if (approval) throw new Error('resolution-invalid');
          }
          const same = before === null ? after === null : after !== null && before.equals(after) &&
            (op.kind !== 'file.write' || op.mode === undefined || process.platform === 'win32' ||
              live.state === 'present' && live.mode === op.mode);
          if (op.kind === 'file.remove' && Object.values(projected.members).some(owner => owner.descriptor?.path === path && owner.descriptor?.kind !== 'file')) managed = false;
          const changingOwned = (managed && before !== null) || rescuedLines !== null;
          const selectedAbsent = !editConflict && descriptors.every(member => { const bytes = memberBytes(member, before!); const prior = projected.members[memberKey(member)];
            return bytes === null || !!prior && bytes !== null && prior.sha256 === sha256(bytes) && (prior.claims ?? []).some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope); });
          const drift = !editConflict && descriptors.some(member => {
            if (rescuedLines !== null && memberKey(member) === memberKey(descriptors[0]!)) return false;
            const prior = projected.members[memberKey(member)]; const bytes = memberBytes(member, before!);
            return prior && (prior.claims ?? []).some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope) && (bytes === null || prior.sha256 !== sha256(bytes)); });
          // The Catalog item another claim installs: from this request's selections, else as recorded at install.
          const claimItem = (claim: Claim) => policy.selections.find(item => item.managementId === claim.managementId && item.scope === claim.scope)?.item ??
            stored.value.items?.[claimIdentity(claim.scope, claim.managementId, project!)]?.item ?? undefined;
          const sameItem = (claim: Claim) => { const other = claimItem(claim);
            return !!selection.item && !!other && other.framework === selection.item.framework && other.itemId === selection.item.itemId; };
          // A claimant in this request that installs exactly this item version writes the same bytes, so it changes with us.
          const changesTogether = (claim: Claim) => { const other = policy.selections.find(item => item.managementId === claim.managementId && item.scope === claim.scope)?.item;
            return !!selection.item && !!other && canonicalJson(other) === canonicalJson(selection.item); };
          const sharedChange = !editConflict && descriptors.some(member => { const prior = projected.members[memberKey(member)]; const oldBytes = memberBytes(member, before!); const newBytes = memberBytes(member, after!);
            return prior?.claims?.some(claim => (claim.managementId !== selection.managementId || claim.scope !== selection.scope) && !changesTogether(claim)) &&
              (oldBytes === null ? newBytes !== null : newBytes === null || !oldBytes.equals(newBytes)); });
          let overlap = false;
          try { overlap = descriptors.some(member => Object.values(projected.members).some(owner => owner.descriptor && memberKey(owner.descriptor) !== memberKey(member) &&
            (overlappingMembers(member, owner.descriptor, before) || overlappingMembers(member, owner.descriptor, after)))); }
          catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; }

          const decide = (option: 'replace' | 'adopt' | undefined): ReviewOperation['effects'] => {
            if (editConflict || sharedChange || overlap || drift && !option) return 'conflict';
            if (same) return 'already-satisfied';
            if (before === null && after !== null) return 'create-file';
            if (before !== null && after === null) return changingOwned || option === 'replace' && descriptors.every(member => { const prior = projected.members[memberKey(member)]; return prior?.claims?.some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope); }) ? 'remove-file' : 'conflict';
            return changingOwned || selectedAbsent || option === 'replace' ? 'replace-file' : 'conflict';
          };
          effect = decide(resolution);
          // A file Core already installs for other selections of the same Catalog item, with exactly these bytes and
          // unchanged since it was recorded, gains this selection's claim: every such selection owns it, and removal keeps
          // it until the last one goes. Nothing is written; a person's own file or another item's is never acquired.
          const sharedCopy = op.kind === 'file.write' && same && !managed && !resolution && !editConflict && !sharedChange && !overlap && !drift &&
            custody !== undefined && descriptors.length > 0 && descriptors.every(member => {
              const prior = projected.members[memberKey(member)]; const bytes = memberBytes(member, before!);
              return !!prior?.claims?.length && prior.claims.every(sameItem) && bytes !== null && prior.sha256 === sha256(bytes);
            });
          if (sharedCopy) ownerState = 'managed';
          const adoptable = same && before !== null && !managed && !sharedCopy;
          if (effect === 'conflict' && decide('replace') !== 'conflict') choices.push('replace');
          if (effect === 'conflict' && adoptable && decide('adopt') !== 'conflict') choices.push('adopt');
          if (effect === 'already-satisfied' && adoptable && !resolution && !editConflict && !sharedChange && !overlap && !drift)
            choices.push('adopt');
          if (approval) choices.length = 0;
          if (!editConflict && custody && !resolution) for (const member of descriptors) {
            const key = memberKey(member); const bytes = memberBytes(member, before!); const prior = projected.members[key];
            const desired = memberBytes(member, after!);
            if (bytes && desired && bytes.equals(desired) && !prior) delete custody[key];
          }
          custodyOnly = same && (managed || sharedCopy || resolution === 'replace' && (drift || trustParticipant?.exactReplacement === true)) && canonicalJson(custody) !== canonicalJson(Object.fromEntries(Object.keys(custody ?? {}).map(key => [key, projected.members[key] ?? null])));
          if (resolution === 'adopt' && !adoptable) throw new Error('resolution-invalid');
          // A reviewed replacement of a person's JSON value keeps that value in protected custody for restoration.
          if (resolution === 'replace' && op.kind === 'config.entries' && (op.format === 'json' || op.format === 'jsonc') && custody && !editConflict)
            for (const member of descriptors) {
              const key = memberKey(member); const found = memberBytes(member, before!);
              if (projected.members[key] || found === null || !custody[key]) continue;
              const errors: ParseError[] = []; const value = parseJsonc(found.toString('utf8'), errors, { allowTrailingComma: true }) as Json;
              if (!errors.length && value !== undefined) (preExisting ??= {})[key] = value;
            }
          // A reviewed replacement of a person's own shared block keeps that block's content in protected
          // custody; the last removal writes the person's block back instead of leaving nothing.
          if (resolution === 'replace' && op.kind === 'text.block' && op.action === 'set' && op.content && !editConflict && before !== null &&
              sharedBlockRole(op.startMarker, op.endMarker) !== null && descriptors.length === 1) {
            const member = descriptors[0]!;
            const key = memberKey(member);
            if (member.kind === 'block' && custody?.[key]) {
              const prior = projected.members[key];
              const mine = (prior?.claims ?? []).some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope);
              const liveContent = extractBlockBody(before.toString('utf8'), member.startMarker, member.endMarker);
              const newContent = resolveString(op.content, bound);
              if (!mine && liveContent !== null && liveContent !== newContent) (preExisting ??= {})[key] = liveContent;
            }
          }
          // A member this selection installed whose bytes no longer match is the person's local edit.
          if (effect === 'conflict') conflictReason = editConflict ?? (drift ? 'managed-content-changed' : sharedChange ? 'shared-member' : overlap ? 'overlapping-member' : 'existing-content');
          if (effect === 'conflict') conflicts.push(editConflict === 'approval-denied' ? { ...diagnostic('STATE_CONFLICT', 'approval-denied',
            'The person already made a different choice for this server in the tool; Core never overwrites it.'), path: safeText(path, privateValues),
            guidance: 'Change the choice in the tool itself if you want the server allowed, then prepare again without the approval.' } :
            { ...diagnostic('STATE_CONFLICT', editConflict ?? 'existing-content',
            'Existing, edited or unsupported content requires an exact reviewed resolution or a narrower edit.'), path: safeText(path, privateValues) });
          details = { ...details, target: safeText(target.absolute, privateValues),
            ...(op.kind === 'file.write' && op.material ? { material: op.material,
              materialSha256: sha256(after!), materialBytes: after!.byteLength } : {}),
            ...(op.kind === 'file.write' && op.content ? { content: 'input' in op.content && recipe.inputs[op.content.input]?.sensitive ?
              '[REDACTED]' : redactExact(resolveString(op.content, bound), privateValues) } : {}),
            mode, ...(resolution ? { reason: `explicit-${resolution}` } : {}), ...(editConflict ? { reason: editConflict } : {}) };
          if (!['conflict', 'unavailable'].includes(effect)) overlays.set(key, { initial: overlay?.initial ?? initialBefore!, after: after!, priorId: id });
        }
        emit();
        // The companion write is reviewed but never claimed: PROJECT.md stays user-owned, so removal
        // never touches it and later edits are never conflicts. It requires the block step it rescues for.
        if (rescuedLines !== null && rescueStep) {
          const rescueId = `${selection.id}/${op.id}-rescued`;
          const rescueKey = `${project}:${process.platform === 'win32' ? rescueStep.path.toLowerCase() : rescueStep.path}`;
          const priorRescue = rescueChains.get(rescueKey);
          const rescueReview: ReviewOperation = { id: rescueId, purpose: `Move your lines from the aih:shared block to ${rescueStep.path}`,
            kind: 'file.write', scope: op.scope,
            effects: rescueStep.before === null ? 'create-file' : rescueStep.before.equals(rescueStep.after) ? 'already-satisfied' : 'replace-file',
            ownership: 'unowned', requires: [...new Set([id, ...(priorRescue ? [priorRescue] : [])])], checks: [],
            details: { target: safeText(join(project!, rescueStep.path), privateValues),
              content: redactExact(rescueStep.after.toString('utf8'), privateValues), mode: rescueStep.mode },
            ...(namesSelections ? { selectionId: selection.id } : {}) };
          steps.push({ review: rescueReview, root: project!, path: rescueStep.path, initialBefore: rescueStep.initial, before: rescueStep.before,
            after: rescueStep.after, mode: rescueStep.mode, pins: pathPins(join(project!, rescueStep.path)), managementId: selection.managementId,
            recipeIdentity, checks: [], authored: { selectionId: selection.id, operationId: `${op.id}-rescued`, overlayKey: rescueKey, choices: [] },
            item: selectionItem(selection, project!, privateValues) });
          overlays.set(rescueKey, { initial: rescueStep.initial, after: rescueStep.after, priorId: rescueId });
          rescueChains.set(rescueKey, rescueId);
          currentIds.push(rescueId);
        }
        function emit(): void {
          const unavailable = prerequisite ?? (preparedProcess && 'missing' in preparedProcess.executable ? 'executable-missing' :
            checks.some(check => check.process && 'missing' in check.process.executable) ? 'check-executable-missing' : undefined);
          if (unavailable) { effect = 'unavailable'; omissions.push(diagnostic('PREREQUISITE_UNAVAILABLE', unavailable, 'This operation cannot run on the selected host.')); }
          const review: ReviewOperation = { id, purpose: safeText(op.purpose, privateValues), kind: op.kind, scope: op.scope,
            effects: effect, ownership: ownerState, requires: [...new Set(requires)], checks: preparedChecks.map(item => item.review), details,
            ...(namesSelections ? { selectionId: selection.id } : {}) };
          // A private input value inside a member path never leaves protected custody; inventory publishes the redacted path.
          const redactedPaths = path && stepMembers && safeText(path, privateValues) !== path ?
            Object.fromEntries(stepMembers.map(member => [memberKey(member), safeText(path!, privateValues)])) : undefined;
          steps.push({ review, root, path, ownerKey, initialBefore, before, after, mode, pins, managementId: selection.managementId,
            recipeIdentity, checks, process: preparedProcess, unavailable, resolution, custody, custodyOnly, inherited,
            ...(effect === 'conflict' && conflictReason ? { conflictReason } : {}),
            authored: { selectionId: selection.id, operationId: op.id, overlayKey, choices },
            ...(stepMembers ? { members: stepMembers } : {}), ...(preExisting ? { preExisting } : {}), ...(redactedPaths ? { redactedPaths } : {}),
            // Every authored step carries its selection's item, so Apply can record the install as pending before its first effect.
            item: selectionItem(selection, project!, privateValues) });
        }
      }
      selectionOps.set(selection.id, currentIds);
    }
    // In prepared order, an unresolved operation may change every later overlay and digest on its target: no later hint.
    const unresolvedTargets = new Set<string>();
    for (const { authored, review } of steps) {
      if (authored?.overlayKey === undefined) continue;
      if (unresolvedTargets.has(authored.overlayKey)) authored.choices = [];
      else if (review.effects === 'conflict' || review.effects === 'unavailable' || authored.choices.length > 0)
        unresolvedTargets.add(authored.overlayKey);
    }
    // Omitted sets retain their roots. Explicit sets reconcile only their prior claims.
    for (const root of [project, userHomeRoot()]) if (!ownership.has(root)) ownership.set(root, readOwnership(root));
    const inventoriesNeeded = policy.managedSelections?.length || policy.removals?.length;
    const inventory = inventoriesNeeded ? ownershipInventory() : undefined;
    let foreignUnverifiable = inventory?.unverifiable ?? false;
    for (const root of inventory?.targets ?? []) if (!ownership.has(root)) {
      try { ownership.set(root, readOwnership(root)); }
      catch { foreignUnverifiable = true; }
    }
    if (foreignUnverifiable && (policy.removals?.some(item => item.scope === 'user') || policy.managedSelections?.some(item => item.scope === 'user' && item.members.length === 0)))
      omissions.push(diagnostic('PREREQUISITE_UNAVAILABLE', 'dependency-custody-unverifiable', 'User cleanup requires verifiable retained dependency custody.'));

    const selectionUpdates = new Map<string, Record<string, { claim: Claim | null; requires: string[] }>>();
    const claimId = (claim: Pick<Claim, 'scope' | 'managementId'>, target = project!) => claimIdentity(claim.scope, claim.managementId, target);
    const effectRoot = (root: string) => root === project || root === userHomeRoot() || isContentRoot(root);
    const { candidates, retained, dependencies } = classifyStoredClaims(ownership, (claim, root, id) => {
      const sets = claim.sets.map(setId => policy.managedSelections?.find(set => set.id === setId && set.scope === claim.scope));
      return effectRoot(root) && (policy.removals?.some(removal => claimId(removal) === id) ||
        !!sets.length && sets.every(set => !!set && !set.members.includes(claim.managementId)));
    });
    const priorDependencies = new Map(dependencies);
    // An update keeps the edges recorded at install, so a dependency it does not name is still retained.
    const keptEdges = (id: string, edges: string[]) => update ? [...new Set([...(priorDependencies.get(id) ?? []), ...edges])] : edges;
    for (const selection of policy.selections) {
      const id = claimId(selection); retained.add(id); candidates.delete(id);
      dependencies.set(id, keptEdges(id, selection.requires.map(required => { const dependency = policy.selections.find(item => item.id === required)!; return claimId(dependency); })));
    }
    if (foreignUnverifiable) for (const id of candidates) if (id.startsWith('user:')) retained.add(id);
    retainClaimDependencies(retained, dependencies);
    for (const selection of policy.selections.filter(selection => !unavailableSelections.has(selection.id))) {
      const root = selection.scope === 'project' ? project : userHomeRoot(); const key = claimId(selection);
      const old = ownership.get(root)!.value.selections?.[key];
      const claim: Claim = { managementId: selection.managementId, scope: selection.scope,
        sets: [...new Set([...(old?.sets ?? []).filter(id => !policy.managedSelections?.some(set => set.id === id && set.scope === selection.scope)),
          ...(policy.managedSelections ?? []).filter(set => set.scope === selection.scope && set.members.includes(selection.managementId)).map(set => set.id)])],
        requires: keptEdges(key, selection.requires.map(required => claimId(policy.selections.find(item => item.id === required)!))) };
      if ((old || claim.sets.length || claim.requires.length) && (!old || canonicalJson(old) !== canonicalJson(claim))) {
        const updates = selectionUpdates.get(root) ?? Object.create(null); updates[key] = { claim, requires: selectionOps.get(selection.id) ?? [] }; selectionUpdates.set(root, updates);
      }
    }
    // Facts for a described selection whose owned members this run leaves unchanged, such as one first installed
    // under an older policy. Custody-writing steps record their facts with the members they write.
    const itemUpdates: PreparedState['itemUpdates'] = new Map();
    for (const step of steps) {
      if (!step.item || !step.root || !step.authored || writesCustody(step)) continue;
      const stored = ownership.get(step.root)!.value;
      if (!Object.values(stored.members).some(owner => owner.claims?.some(claim => claim.scope === step.review.scope && claim.managementId === step.managementId))) continue;
      const prior = stored.items?.[step.item.id];
      // An undescribed run keeps the recorded description but still records or retires git provenance.
      if (!step.item.named && canonicalJson(prior?.materialSource ?? null) === canonicalJson(step.item.facts.materialSource ?? null)) continue;
      if (prior && canonicalJson(factsOf(prior)) === canonicalJson(step.item.facts)) continue;
      const updates = itemUpdates.get(step.root) ?? Object.create(null);
      updates[step.item.id] = { item: step.item, requires: selectionOps.get(step.authored.selectionId) ?? [] }; itemUpdates.set(step.root, updates);
    }
    // A fresh review of an interrupted install's selection finishes it: the install completes once all its operations
    // succeed, also when every member is already in place.
    for (const step of steps) {
      if (!step.item || !step.root || !step.authored || ownership.get(step.root)!.value.items?.[step.item.id]?.installState !== 'interrupted') continue;
      const updates = itemUpdates.get(step.root) ?? Object.create(null);
      if (updates[step.item.id]?.action === 'finish') continue;
      updates[step.item.id] = { item: step.item, requires: selectionOps.get(step.authored.selectionId) ?? [], action: 'finish' }; itemUpdates.set(step.root, updates);
      observations.push({ id: `lifecycle/finish-${observations.length}`, reason: `finish-interrupted-install:${step.managementId}` });
    }
    // A released inclusion rewrites only the kept selection's recorded origins; its members and claims stay.
    for (const release of cleanup?.originReleases ?? []) {
      const updates = itemUpdates.get(release.root) ?? Object.create(null);
      updates[release.id] = { item: { id: release.id, named: true, facts: release.facts }, requires: [] }; itemUpdates.set(release.root, updates);
      observations.push({ id: `lifecycle/origin-${observations.length}`, reason: `remove-origin:${release.facts.managementId}` });
    }
    for (const [root, stored] of ownership) if (effectRoot(root)) for (const [key, claim] of Object.entries(stored.value.selections ?? {})) {
      if (!candidates.has(key) || retained.has(key)) continue;
      const updates = selectionUpdates.get(root) ?? Object.create(null); updates[key] = { claim: null, requires: [] }; selectionUpdates.set(root, updates);
      observations.push({ id: `lifecycle/root-${observations.length}`, reason: `remove-management-root:${claim.managementId}` });
    }
    // Removing an interrupted install lets its record go too, including one that never wrote a member.
    for (const [root, stored] of ownership) if (effectRoot(root)) for (const [key, item] of Object.entries(stored.value.items ?? {})) {
      if (item.installState !== 'interrupted' || !candidates.has(key) || retained.has(key)) continue;
      const updates = itemUpdates.get(root) ?? Object.create(null);
      updates[key] = { item: { id: key, named: false, facts: factsOf(item) }, requires: [], action: 'release' }; itemUpdates.set(root, updates);
      observations.push({ id: `lifecycle/root-${observations.length}`, reason: `remove-interrupted-install:${item.managementId}` });
    }
    const ancestors = (id: string): Set<string> => {
      const result = new Set<string>(); const queue = [id];
      for (let index = 0; index < queue.length; index++) for (const [parent, required] of priorDependencies)
        if (required.includes(queue[index]!) && !result.has(parent)) { result.add(parent); queue.push(parent); }
      return result;
    };
    // Generate retaining-root subtraction before dependency subtraction so
    // same-destination overlays and interruption preserve the old graph.
    const graphIds = [...new Set([...priorDependencies.keys(), ...[...priorDependencies.values()].flat()])];
    const removalOrder = dependencyOrder(graphIds.map(id => ({ id, requires: [...priorDependencies].filter(([, required]) => required.includes(id)).map(([parent]) => parent) })));
    const rank = new Map(removalOrder.map((item, index) => [item.id, index]));
    // Containers and files an install created belong to the target path, not one member: collect them from every
    // receipt so the last owned group can remove them even when earlier groups were already removed.
    const createdFiles = new Set<string>(); const createdContainers = new Map<string, string[][]>();
    for (const [root, stored] of ownership) if (effectRoot(root)) for (const owner of Object.values(stored.value.members)) {
      const descriptor = owner.descriptor; if (!descriptor) continue;
      const id = `${root}:${descriptor.path}`;
      if (owner.createdFile) createdFiles.add(id);
      if (owner.createdContainers?.length) {
        const paths = [...new Map([...(createdContainers.get(id) ?? []), ...owner.createdContainers].map(item => [JSON.stringify(item), item])).values()];
        createdContainers.set(id, paths);
      }
    }
    const members = [...ownership].flatMap(([root, stored]) => Object.entries(stored.value.members).map(([key, owner]) => ({ root, key, owner })));
    members.sort((a, b) => Math.min(...(a.owner.claims ?? []).map(claim => rank.get(claimId(claim, a.root)) ?? 0)) - Math.min(...(b.owner.claims ?? []).map(claim => rank.get(claimId(claim, b.root)) ?? 0)));
    const removedIdentities = new Map<PreparedStep, string[]>();
    // The management ids whose claims each cleanup step releases.
    const releasedIds = new Map<PreparedStep, string[]>();
    const stepOwners = new Map<PreparedStep, Owner>();
    let removalIndex = 0;
    const projectedMembers = (root: string): Record<string, Owner> => {
      const value: Ownership = { ...ownership.get(root)!.value, members: { ...ownership.get(root)!.value.members } };
      for (const prior of steps.filter(step => step.root === root && step.custody && (['create-file', 'replace-file', 'remove-file'].includes(step.review.effects) || step.resolution === 'adopt' || step.custodyOnly)))
        updateCustody(value, prior);
      return value.members;
    };
    for (const { root, key, owner: storedOwner } of members) {
      if (!effectRoot(root)) continue;
      let owner = storedOwner;
      // A hook member reads and writes back its projected owner after the authored steps, never the stored one.
      if (storedOwner.descriptor?.kind === 'hook') {
        const live = projectedMembers(root)[key];
        if (!live) continue;
        owner = live;
      } else if (storedOwner.descriptor?.kind === 'entry' && storedOwner.descriptor.format === 'toml') {
        // An earlier removal may have handed this table the line break Core added: read the projected record, not the stored one.
        const live = projectedMembers(root)[key];
        if (live && live.tomlTable !== storedOwner.tomlTable) {
          const { tomlTable: _stored, ...rest } = storedOwner;
          owner = { ...rest, ...(live.tomlTable ? { tomlTable: live.tomlTable } : {}) };
        }
      }
      const claims = owner.claims ?? [];
      const obsolete = (claim: Claim) => {
        const selection = policy.selections.find(selection => claimId(selection) === claimId(claim, root));
        return !!selection && !unavailableSelections.has(selection.id) && !steps.some(step => step.managementId === claim.managementId && step.review.scope === claim.scope && step.root === root && Object.hasOwn(step.custody ?? {}, key) && !step.inherited?.includes(key));
      };
      const removed = claims.filter(claim => candidates.has(claimId(claim, root)) && !retained.has(claimId(claim, root)) || obsolete(claim));
      if (!removed.length) continue;
      const remaining = claims.filter(claim => !removed.includes(claim));
      const descriptor = owner.descriptor ?? { path: key, kind: 'file' as const };
      if (descriptor.kind === 'entry' && ['ini', 'yaml', 'properties'].includes(descriptor.format) && policy.schema !== POLICY_12 && policy.schema !== POLICY_13 && policy.schema !== POLICY_14 && policy.schema !== POLICY_15 && policy.schema !== POLICY_16) {
        result.diagnostics = [{ code: 'SCHEMA_UNSUPPORTED', reason: 'bounded-config-policy-version',
          message: 'Bounded configuration custody requires execution-policy 1.2.0 for cleanup.', encountered: policy.schema, supported: [POLICY_12] }];
        return finish();
      }
      if (owner.managementId.startsWith('ca-export-') && !(trustParticipant?.allows(root,descriptor.path) ?? false)) throw new Error('trust-custody-conflict');
      guardTrustMember(root, descriptor.path, trustParticipant?.allows(root, descriptor.path) ?? false, trustParticipant?.macosSession === true);
      const live = transaction(root).inspect(descriptor.path);
      if (live.state === 'unreadable') throw new Error('target-unreadable');
      const destination = `${root}:${process.platform === 'win32' ? descriptor.path.toLowerCase() : descriptor.path}`;
      const overlay = overlays.get(destination);
      const initialBefore = live.state === 'present' ? Buffer.from(live.bytes) : null;
      const before = overlay ? overlay.after : initialBefore;
      let after: Buffer | null = before; let effect: ReviewOperation['effects'] = 'already-satisfied'; let heir: string | undefined;
      let matching = false; let hookDecision: HookDecision | undefined; let priorHookConflict: string | undefined; let restores = false;
      let kept: PreparedStep['kept'];
      if (descriptor.kind === 'hook') {
        // A 1.0.0 policy never synthesizes a hook-group review under a 1.0.0 prepared/result identity.
        if (policy.schema !== POLICY_11 && policy.schema !== POLICY_12 && policy.schema !== POLICY_13 && policy.schema !== POLICY_14 && policy.schema !== POLICY_15 && policy.schema !== POLICY_16) {
          result.diagnostics = [{ code: 'SCHEMA_UNSUPPORTED', reason: 'hook-group-policy-version', message: 'This policy would change owned hook-group custody.',
            encountered: policy.schema, supported: [POLICY_11], guidance: 'Author an execution-policy 1.1.0 document to remove or reconcile owned hook groups.' }];
          return finish();
        }
        priorHookConflict = hookConflicts.get(`${root}:${key}`);
        const currentMembers = projectedMembers(root);
        const projectedOthers: RetainedHook[] = Object.entries(currentMembers).flatMap(([memberId, member]) =>
          member.descriptor?.kind === 'hook' && memberId !== key && samePath(member.descriptor.path, descriptor.path) && member.descriptor.format === descriptor.format &&
          canonicalJson(member.descriptor.container) === canonicalJson(descriptor.container) ? [{ key: memberId, descriptor: member.descriptor }] : []);
        const incompatibleHook = Object.entries(currentMembers).some(([memberId, member]) => memberId !== key &&
          member.descriptor?.kind === 'hook' && overlappingMembers(descriptor, member.descriptor, before));
        hookDecision = decideHookCleanup({ owner, remaining, before, retained: projectedOthers, key,
          ...(priorHookConflict ? { forced: 'hook-prior-conflict' } : incompatibleHook ? { forced: 'hook-selector-overlap' } : {}) });
      } else try { const bytes = memberBytes(descriptor, before); matching = bytes === null || sha256(bytes) === owner.sha256;
        if (matching && Object.values(ownership.get(root)!.value.members).some(other => other.descriptor && memberKey(other.descriptor) !== key && overlappingMembers(descriptor, other.descriptor, before))) matching = false;
        if (!remaining.length && matching) {
          // A member that replaced the person's value gives that value back instead of leaving the pointer
          // empty; a member the person already deleted stays deleted: only Core's present, unchanged value
          // is given back. Shared blocks join this rule: the person's earlier block content is restored.
          const shared = descriptor.kind === 'block' && sharedBlockRole(descriptor.startMarker, descriptor.endMarker) !== null;
          const recorded = bytes !== null && (descriptor.kind === 'entry' && (descriptor.format === 'json' || descriptor.format === 'jsonc') || shared) ?
            preExistingFor(ownership.get(root)!.value, key) : undefined;
          if (recorded && descriptor.kind === 'entry') { after = renderConfigEntries(descriptor.format, before, [{ path: descriptor.entry, action: 'set', value: recorded.value }]); restores = true; }
          else if (recorded && shared && typeof recorded.value === 'string' && descriptor.kind === 'block') {
            after = renderTextBlock(before, { blockId: descriptor.blockId, startMarker: descriptor.startMarker,
              endMarker: descriptor.endMarker, action: 'set', content: recorded.value });
            restores = true;
          }
          else {
            ({ bytes: after, heir } = subtractMember(descriptor, before, owner));
            // Removing a shared block never removes the entry file: when the block was the file's only
            // content the file stays behind empty, and the person's other text always survives.
            if (after === null && shared) after = Buffer.alloc(0);
            // A JSON entry in a file Core created takes the file with it, as an owned hook group does, once only
            // empty containers are left and no other Core member lives in that file.
            if (after !== null && descriptor.kind === 'entry' && (descriptor.format === 'json' || descriptor.format === 'jsonc') &&
              createdFiles.has(`${root}:${descriptor.path}`) && !hasJsonContent(after) && !Object.entries(projectedMembers(root)).some(([other, member]) =>
                other !== key && member.descriptor !== undefined && samePath(member.descriptor.path, descriptor.path))) after = null;
          }
        }
      } catch (error) { if (!(error instanceof RecipeEditError)) throw error; }
      if (hookDecision) {
        matching = hookDecision.effect !== 'conflict'; after = hookDecision.after; effect = hookDecision.effect;
        const fileId = `${root}:${descriptor.path}`;
        if (matching && !remaining.length && after !== null) {
          const pruned = createdContainers.has(fileId) ? pruneEmptyContainers((descriptor as HookDescriptor).format, after, createdContainers.get(fileId)!) : after;
          if (createdFiles.has(fileId) && !hasJsonContent(pruned)) { after = null; effect = 'remove-file'; }
          else if (!pruned.equals(after)) { after = pruned; effect = before !== null && after.equals(before) ? 'already-satisfied' : 'replace-file'; }
        }
        if (!matching && cleanup) kept = { action: 'keep-changed', reason: hookDecision.reason ?? 'managed-content-changed' };
        else if (!matching) conflicts.push(hookConflict(hookDecision, hookDecision.details.groupId, descriptor.path, []));
      }
      // Removal preparation 1.2.0 names the keep instead of reporting a conflict; the member and its claims stay.
      else if (!matching && cleanup) kept = { action: 'keep-changed', reason: 'managed-content-changed' };
      else if (!matching) { effect = 'conflict'; conflicts.push({
        ...diagnostic('STATE_CONFLICT', 'managed-content-changed', 'Changed or unverifiable managed content is preserved.'),
        ...(policy.schema !== 'urn:aihq:core:execution-policy:1.0.0' ? { guidance: 'Restore the recorded content or reconcile this managed member manually, then prepare again. Generated cleanup has no keyed replace resolution.' } : {})
      }); }
      else if (before !== null && after === null) effect = 'remove-file';
      else if (before !== null && after !== null && !before.equals(after)) effect = 'replace-file';
      if (kept) { after = before; effect = 'already-satisfied'; }
      const removedIds = removed.map(claim => claimId(claim, root));
      const retainingAncestors = new Set(removedIds.flatMap(id => [...ancestors(id)]));
      const droppedDependencyGuards = policy.selections.flatMap(selection => retainingAncestors.has(claimId(selection)) ? selectionOps.get(selection.id) ?? [] : []);
      // An array Core created that still holds another of Core's members passes that record on, so it goes with the last one.
      const arrayHeir = descriptor.kind === 'member' && owner.createdContainer && !remaining.length && matching ? Object.entries(projectedMembers(root)).find(([other, member]) =>
        other !== key && member.descriptor?.kind === 'member' && samePath(member.descriptor.path, descriptor.path) && member.descriptor.format === descriptor.format &&
        canonicalJson(member.descriptor.container) === canonicalJson(descriptor.container) && !member.createdContainer) : undefined;
      const inheritance = heir ? inheritTomlBreak(projectedMembers(root), descriptor.path, [heir]) :
        arrayHeir ? { [arrayHeir[0]]: { ...arrayHeir[1], createdContainer: true as const } } : undefined;
      let id: string; do { id = `lifecycle/remove-${removalIndex++}`; } while (steps.some(step => step.review.id === id));
      // Cleanup runs without the private inputs that formed a path; the redaction recorded at install stands in.
      const redactedPath = redactedPathFor(ownership.get(root)!.value, key);
      steps.push({ review: { id, purpose: kept ? 'Keep changed managed member' : 'Remove selected managed member', kind: descriptor.kind === 'entry' ? 'config.entries' : descriptor.kind === 'member' ? 'config.member' : descriptor.kind === 'block' ? 'text.block' : descriptor.kind === 'hook' ? 'hook.group' : 'file.remove',
        scope: removed[0]!.scope, effects: effect, ownership: 'managed', requires: [...new Set([...(overlay ? [overlay.priorId] : []), ...(priorHookConflict ? [priorHookConflict] : []), ...droppedDependencyGuards, ...removed.flatMap(claim => { const selection = policy.selections.find(selection => claimId(selection) === claimId(claim, root)); return selection ? selectionOps.get(selection.id) ?? [] : []; })])], checks: [], details: { target: join(root, redactedPath ?? descriptor.path), reason: kept ? kept.action : hookDecision?.reason ?? (restores ? 'restore-pre-existing' : 'explicit-managed-removal'),
          ...(descriptor.kind === 'hook' ? { format: descriptor.format, hookGroup: hookDecision!.details } : {}),
          ...(descriptor.kind === 'entry' ? { format: descriptor.format, entries: [restores ? { path: descriptor.entry, action: 'set' as const, value: '[REDACTED]' } : { path: descriptor.entry, action: 'remove' as const }] } :
            descriptor.kind === 'member' ? { format: descriptor.format, member: { container: descriptor.container, action: 'remove' as const } } :
            descriptor.kind === 'block' ? { blockId: descriptor.blockId, startMarker: descriptor.startMarker, endMarker: descriptor.endMarker,
              blockAction: restores ? 'set' as const : 'remove' as const, ...(restores ? { content: '[REDACTED]' } : {}) } : {}) },
          ...(namesSelections ? { selectionId: null } : {}) },
        root, path: descriptor.path, ownerKey: key, initialBefore, before, after, pins: pathPins(join(root, descriptor.path)), mode: live.state === 'present' ? live.mode : owner.mode,
        managementId: owner.managementId, recipeIdentity: owner.recipeIdentity, checks: [], lifecycle: true, members: [descriptor], ...(restores ? { restores } : {}),
        ...(redactedPath ? { redactedPaths: { [key]: redactedPath } } : {}), ...(kept ? { kept } : {}),
        ...(effect === 'conflict' ? { conflictReason: hookDecision?.reason ?? 'managed-content-changed' } : {}),
        custody: { [key]: kept ? owner : hookDecision ? hookDecision.custody : remaining.length ? { ...owner, claims: remaining } : null, ...inheritance },
        ...(inheritance ? { inherited: Object.keys(inheritance) } : {}),
        custodyOnly: kept ? false : hookDecision ? hookDecision.custodyOnly : matching && effect === 'already-satisfied' });
      stepOwners.set(steps.at(-1)!, owner);
      if (hookDecision && !matching) hookConflicts.set(`${root}:${key}`, id);
      removedIdentities.set(steps.at(-1)!, removedIds); releasedIds.set(steps.at(-1)!, removed.map(claim => claim.managementId));
      if (matching) overlays.set(destination, { initial: overlay?.initial ?? initialBefore, after, priorId: id });
    }
    if (cleanup) {
      // An item kept as changed keeps its licence and notice files too, so its content never stands without them.
      const changed = new Set([...removedIdentities].filter(([step]) => step.kept?.action === 'keep-changed').flatMap(([, ids]) => ids));
      for (const [step, removedIds] of removedIdentities) {
        if (step.kept || step.review.effects !== 'remove-file' || !isLegalFile(step.members![0]!) || !removedIds.some(id => changed.has(id))) continue;
        step.kept = { action: 'keep-required', reason: 'licence-or-notice' };
        step.after = step.before; step.review.effects = 'already-satisfied'; step.custodyOnly = false;
        step.custody = { [step.ownerKey!]: stepOwners.get(step)! };
        step.review.purpose = 'Keep required managed member'; step.review.details.reason = 'keep-required';
        overlays.delete(`${step.root}:${process.platform === 'win32' ? step.path!.toLowerCase() : step.path}`);
      }
    }
    for (const [step, removedIds] of removedIdentities) {
      const parents = new Set(removedIds.flatMap(id => [...ancestors(id)]));
      const retainingRemovals = [...removedIdentities].filter(([other, ids]) => other !== step && ids.some(id => parents.has(id))).map(([other]) => other.review.id);
      step.review.requires = [...new Set([...step.review.requires, ...retainingRemovals])];
    }
    // Validate the removal ordering before any effects; ambiguous shared cycles
    // cannot become partially executable cleanup.
    const orderedSteps = dependencyOrder(steps.map(step => ({ id: step.review.id, requires: step.review.requires, step })));
    steps.splice(0, steps.length, ...orderedSteps.map(item => item.step));
    for (const [root, updates] of selectionUpdates) for (const [key, update] of Object.entries(updates)) if (update.claim === null) {
      update.requires = [...removedIdentities].filter(([, identities]) => identities.includes(key)).map(([step]) => step.review.id);
    }
    for (const updates of itemUpdates.values()) for (const [key, update] of Object.entries(updates)) if (update.action === 'release') {
      update.requires = [...removedIdentities].filter(([, identities]) => identities.includes(key)).map(([step]) => step.review.id);
    }
    if (usedResolutions.size !== resolutions.length) throw new Error('resolution-unknown');
    if (organization) {
      const lifecycle: AdmissionLifecycle[] = []; const seenLifecycle = new Set<string>();
      for (const item of resolutions) {
        const index = policy.selections.findIndex(candidate => candidate.id === item.selectionId);
        const selection = policy.selections[index]!;
        if (seenLifecycle.has(`${index}:${item.choice}`)) continue;
        seenLifecycle.add(`${index}:${item.choice}`);
        lifecycle.push({ action: item.choice, scope: selection.scope, recipeIdentity: admissions.find(entry => entry.id === selection.id)!.recipeIdentity,
          ...(selection.organizationSelectionId === undefined ? {} : { organizationSelectionId: selection.organizationSelectionId }),
          path: `/selections/${index}` });
      }
      for (const [step, removedIds] of removedIdentities) for (const removedId of removedIds) {
        const index = policy.selections.findIndex(selection => claimId(selection) === removedId);
        if (index >= 0) {
          // Obsolete members of a retained selection: governed by its newly admitted identity.
          const selection = policy.selections[index]!;
          if (seenLifecycle.has(`${index}:remove`)) continue;
          seenLifecycle.add(`${index}:remove`);
          lifecycle.push({ action: 'remove', scope: selection.scope, organizationSelectionId: selection.organizationSelectionId!,
            recipeIdentity: admissions.find(entry => entry.id === selection.id)!.recipeIdentity, path: `/selections/${index}` });
          continue;
        }
        const removal = (policy.removals ?? []).findIndex(item => claimId(item) === removedId);
        const set = (policy.managedSelections ?? []).findIndex(item => item.scope === step.review.scope);
        lifecycle.push({ action: 'remove', scope: step.review.scope, recipeIdentity: step.recipeIdentity,
          path: removal >= 0 ? `/removals/${removal}` : set >= 0 ? `/managedSelections/${set}` : '/selections' });
      }
      const findings = admitOrganizationSelections(organization.document, admissions, lifecycle, targetFacts, organization.membership);
      if (findings.length) {
        result.status = findings.some(finding => finding.code === 'INPUT_INVALID') ? 'invalid' : 'blocked';
        result.diagnostics = findings;
        return finish();
      }
      if (organizationTarget && targetFacts) {
        // Unavailable material has no computed identity, so it is never counted as taking an entry.
        const taken = admissions.filter(item => !unavailableSelections.has(item.id));
        const scoped = (['project', 'user'] as const).map(scope => ({ scope,
          ...evaluateOrganizationObligations(organization!.document, taken, [], { scope, ...targetFacts }, organization!.membership) }));
        // Prepared work 1.6.0 reviews content entries and `unavailable` sets as they are. Prepared work 1.5.0 names only
        // recipe entries, so there a content-only entry is left out and an unavailable set reads `unknown` or `not-taken`.
        const recipes = <T extends { recipeIdentity?: string; content?: unknown }>(item: T): T[] => namesSelections ? [item] :
          item.recipeIdentity === undefined ? [] : [(({ content: _content, ...rest }) => rest)(item) as T];
        const legacy = <S extends string>(status: S | 'unavailable', replacement: S): S | 'unavailable' =>
          status === 'unavailable' && !namesSelections ? replacement : status;
        obligations = { target: { basis: 'declared', client: targetClient!, ...targetFacts },
          fulfillment: scoped.flatMap(({ scope, fulfillment }) => fulfillment.flatMap(recipes).flatMap(item =>
            item.status === 'not-applicable' ? [] : [{ scope, ...item, status: legacy(item.status, 'unknown') }])),
          advisory: scoped.flatMap(({ scope, advisory }) => advisory.flatMap(recipes).filter(item => item.applicability !== 'not-applicable')
            .map(item => ({ scope, ...item, status: legacy(item.status, 'not-taken') }))) };
      }
    }
    if (Object.keys(capturedUnavailable.operations).some(id => !knownProcesses.has(id)) ||
        Object.keys(capturedUnavailable.checks).some(id => !knownChecks.has(id))) throw new Error('captured-prerequisite-invalid');
    if (steps.length > 8192) throw new Error('operation-limit');
    // Bound every projected physical receipt before a new-Core ready review.
    preflightOwnershipCapacity(steps, ownership, selectionUpdates, itemUpdates);
    trustParticipant?.preflight(steps, ownership);
    const bindings = [...pathPins(project), ...pathPins(homedir())];
    const read = await readEvidence(policy.evidence, controls.evidence, controls.signal);
    // Prepared work 1.7.0: each item's scan state, its release-index status and the binding its recipe was rendered from.
    const owned = new Map([...selectionFacts].map(([id, facts]) => [id, facts.own]));
    const scans = checksScans ? selectionScans(policy, owned, read.artifacts) : new Map<string, SelectionScan>();
    const evidence = checksScans ? coveredEvidence(read.results, scans) : read.results;
    const indexStatus = checksScans ? indexStatuses(policy, controls.index) : undefined;
    const layouts = new Map<string, NonNullable<PreparedSelection['layout']>>();
    if (checksScans) for (const selection of policy.selections) {
      if (selection.item === undefined) continue;
      const shipped = bindingLayout(selection.tool!, selection.kind!);
      if (!shipped) throw new Error('unknown-tool');
      // The review names the binding the recipe was rendered from; one Core no longer ships is a conflict here and stale at Apply.
      layouts.set(selection.id, { ...shipped, bindingDigest: selection.bindingDigest ?? shipped.bindingDigest });
      if (selection.bindingDigest !== undefined && selection.bindingDigest !== shipped.bindingDigest)
        conflicts.push(diagnostic('STATE_CONFLICT', 'binding-changed',
          `${safeText(selection.name!, privateValues)} was rendered for another binding of ${safeText(selection.tool!, privateValues)}; render it again.`));
    }
    const selections: PreparedSelection[] | undefined = namesSelections ? policy.selections.map(selection => {
      const facts = selectionFacts.get(selection.id);
      // The server no longer waits for the person's OK when this review writes its approval or finds it already given;
      // a denied or unavailable approval still does.
      const approved = steps.some(step => step.authored?.selectionId === selection.id && step.review.details.approval !== undefined &&
        step.review.effects !== 'conflict' && step.review.effects !== 'unavailable');
      const step = selection.tool === undefined || selection.kind === undefined || approved ? undefined : bindingPermissionNotice(selection.tool, selection.kind);
      const source = selectionSource(selection);
      return { selectionId: selection.id, managementId: selection.managementId, scope: selection.scope,
        ...(source === undefined ? {} : { materialSource: source }),
        ...(selection.item === undefined ? {} : { item: clone(selection.item), tool: selection.tool!, name: safeText(selection.name!, privateValues),
          kind: selection.kind!, origins: clone(selection.origins!) }),
        ...(checksScans && selection.item !== undefined ? { framework: selection.item.framework, layout: layouts.get(selection.id)!,
          ...(({ scanId, coverage, scanState }) => clone({ ...(scanId ? { scanId, coverage } : {}), scanState }))(scans.get(selection.id)!) } : {}),
        ...(selection.projectFacts === undefined ? {} : { projectFacts: selection.projectFacts.map(fact => ({ ...fact, value: safeText(fact.value, privateValues) })) }),
        ...(facts?.hookCommands.length ? { hookCommands: facts.hookCommands } : {}),
        ...(step === undefined ? {} : { permissionStep: step }),
        inputs: facts?.inputs ?? [],
        // Unavailable material delivers nothing this preparation could measure.
        ...(facts ? { deliveredSize: selectionDeliveredSize(selection.kind, facts.delivered) } : {}) };
    }) : undefined;
    const base = { schema: checksScans ? PREPARED_17 : namesSelections ? PREPARED_16 : obligations ? PREPARED_15 : policy.schema === POLICY_12 || policy.schema === POLICY_13 ? PREPARED_14 : policy.schema === POLICY_11 ? PREPARED_11 : PREPARED_10, useCase: 'policy' as const, mode: organization ? 'enterprise' as const : 'vibe' as const,
      target: { scope: 'project' as const, project }, inputs: { policySha256: digest(policy), package: contractSupport.package,
        ...(organization ? { organization: clone('resolvedCommit' in organization.read ? { source: organization.read.source,
          resolvedCommit: organization.read.resolvedCommit, blobId: organization.read.blobId, contentDigest: organization.read.contentDigest,
          policyId: organization.document.id, helper: organization.read.helper } : { source: localPolicySourceLabel(organization.read.source),
          contentDigest: organization.read.contentDigest, policyId: organization.document.id, helper: organization.read.helper }) as unknown as OrganizationBinding } : {}) },
      operations: steps.map(step => step.review), ...(selections ? { selections } : {}),
      ...(checksScans ? { excluded: (policy.excludedItems ?? []).map(item => ({ item: { framework: item.framework, itemId: item.itemId },
        reason: 'excluded-in-request' as const })) } : {}),
      observations, conflicts, omissions, evidence,
      effectiveOptions: { logging: loggingOption(controls), inputs },
      ...(obligations ? { organizationObligations: obligations } : {}) };
    for (const step of steps) if (step.root && step.path && step.review.effects === 'remove-file') {
      const stored = directoryMap(ownership.get(step.root)!.value.directories);
      step.directoryCleanup = Object.fromEntries(directoryParents(step.path).filter(path => {
        try { return stored[path] !== undefined && directoryIdentity(step.root!, path) === stored[path]; }
        catch { return false; }
      }).map(path => [path, stored[path]!]));
      if (Object.keys(step.directoryCleanup).length) step.review.details.declaredEffects =
        Object.keys(step.directoryCleanup).map(path => `Remove setup-created directory if empty: ${safeText(path, privateValues)}`);
    }
    cleanup?.plan([...removedIdentities].map(([step, removed]): CleanupPlanRow => {
      const owner = stepOwners.get(step)!; const remaining = step.custody?.[step.ownerKey!];
      const action = step.kept?.action ?? (remaining ? 'keep-shared' : step.restores ? 'restore' : step.review.effects === 'already-satisfied' ? 'unregister' : 'remove');
      const reason = step.kept?.reason ?? { 'keep-shared': 'another-selection', restore: 'pre-existing-value', unregister: 'already-absent', remove: undefined }[action as string];
      return { operationId: step.review.id, root: step.root!, descriptor: step.members![0]!, removed,
        ...(owner.approval ? { approval: { tool: owner.approval.tool } } : {}),
        ...(step.redactedPaths?.[step.ownerKey!] ? { redactedPath: step.redactedPaths[step.ownerKey!] } : {}),
        action, ...(reason === undefined ? {} : { reason }) };
    }));
    update?.plan(steps.flatMap(step => step.root && step.members ? step.members.map(descriptor => planMember(step, descriptor,
      step.lifecycle ? releasedIds.get(step) ?? [] : [step.managementId], stepOwners.get(step)?.approval ?? step.review.details.approval)) : []));
    const review: PreparedReview = deepFreezeStrictJsonV1({ ...base,
      reviewDigest: digest({ review: base, bindings, steps: steps.map(step => ({ id: step.review.id, before: step.before ? sha256(step.before) : null,
        after: step.after ? sha256(step.after) : null })), privateDigest: digest(privateInputs),...(trustParticipant?{trustBinding:trustParticipant.reviewBinding}:{}), nonce: randomBytes(32).toString('hex') }) });
    const available = steps.length === 0 || steps.some(step => step.review.effects !== 'conflict' && step.review.effects !== 'unavailable');
    result = { status: conflicts.length || omissions.length ? available ? 'partial' : 'blocked' : 'ready', runId, review,
      diagnostics: [...conflicts, ...omissions], record: disabled, evidence, ...(hinted ? { resolutionInputs: resolutionInputs(steps), operationSelections: operationSelections(steps) } : {}) };
    if (available) {
      const prepared = Object.freeze({}) as PreparedHandle;
      handles.set(prepared, { request, requestDigest: digest(clone(request)), privateInputs: controls.privateInputs,
        privateDigest: digest(privateInputs), review, steps, project, home: homedir(), ownership, selectionUpdates, itemUpdates, inventory: inventory ? new Map(inventory.entries) : undefined, bindings, captures, trustParticipant,
        ...(policy.evidence === undefined ? {} : { evidence: clone(policy.evidence) }),
        ...(checksScans ? { rechecks: { own: owned, indexStatus: indexStatus! } } : {}),
        ...(organization ? { organization: clone({ source: organization.read.source, contentDigest: organization.read.contentDigest,
          ...('resolvedCommit' in organization.read ? { resolvedCommit: organization.read.resolvedCommit, blobId: organization.read.blobId } : {}) }) } : {}),
        ...(organizationTarget ? { organizationTarget } : {}) });
      result.prepared = prepared;
    }
  } catch (error) {
    if (error instanceof AuthorityFailure) { result.status = error.status; result.diagnostics = [error.detail]; return finish(); }
    const reason = error instanceof MaterialCaptureError ? error.reason : error instanceof Error ? error.message : 'preparation-failed';
    result.status = reason === 'cancelled' ? 'cancelled' : ['custody-record-limit','output-path-alias','new-custody-legacy-request','trust-custody-conflict','trust-custody-pending'].includes(reason) ? 'blocked' : 'invalid';
    const unavailable = ['archive-download-failed', 'archive-decompression-failed', 'archive-incomplete',
      'local-file-unavailable', 'local-root-unavailable', 'acquisition-deadline'].includes(reason);
    result.diagnostics = [diagnostic(reason === 'cancelled' ? 'CANCELLED' : reason === 'custody-record-limit' ? 'SOURCE_LIMIT' : result.status === 'blocked' ? 'STATE_CONFLICT' : unavailable ? 'PREREQUISITE_UNAVAILABLE' : 'INPUT_INVALID',
      /^[a-z-]{1,64}$/.test(reason) ? reason : 'preparation-failed', 'Preparation could not admit the requested work.')];
  }
  return finish();
  function finish(): PreparationResult {
    // A managed-removal caller can classify custody before Prepare, then reject a
    // changed image before a handle or routine history escapes this call.
    if (custodyImageStillCurrent) {
      let current = false;
      try { current = custodyImageStillCurrent(); } catch { /* An unreadable image is not current. */ }
      if (!current) {
        if (result.prepared) handles.delete(result.prepared);
        return { status: 'invalid', runId, diagnostics: [diagnostic('PREREQUISITE_UNAVAILABLE',
          'ownership-changed', 'Protected custody changed during preparation; request removal again.')],
          record: disabled, ...(hinted ? { resolutionInputs: [], operationSelections: [] } : {}) };
      }
    }
    const requirements = result.review ? historyRequires(result.review.operations) : undefined;
    const record = { ...result, prepared: undefined,
      ...(result.review && historyDerives(result.review.operations, result.operationSelections) ? { operationSelections: undefined } : {}),
      review: result.review ? { ...result.review, operations: result.review.operations.map(op => ({ ...op,
        ...requirements!(op),
        checks: op.checks.map(check => ({ ...check, details: historyDetails(check.details) })),
        details: historyDetails(op.details) })) } : undefined };
    result.record = writeHistory(runId, historySafe(record, project, secrets), logging);
    if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason,
      'Routine history could not be saved; the returned outcomes remain available.'));
    return result;
  }
}

/** Digest hints in review operation order: exactly the target bytes each authored conflict compared, never content. */
function resolutionInputs(steps: PreparedStep[]): ResolutionInput[] {
  return steps.flatMap(step => step.authored && step.authored.choices.length &&
    (step.review.effects === 'conflict' || step.review.effects === 'already-satisfied') ?
    [{ selectionId: step.authored.selectionId, operationId: step.authored.operationId,
      observedSha256: step.before ? sha256(step.before) : null, availableChoices: [...step.authored.choices] }] : []);
}
/** The selection behind each review operation, in review operation order; generated lifecycle cleanup has none. */
function operationSelections(steps: PreparedStep[]): OperationSelection[] {
  return steps.map(step => ({ id: step.review.id, selectionId: step.authored?.selectionId ?? null,
    operationId: step.authored?.operationId ?? null }));
}
/**
 * An operation's requirements as routine history records them. A requirer depends on every operation of each selection
 * it requires, so a shared document's requirers would each repeat its whole operation list. History names such a
 * selection once in `requiresSelections`, meaning every operation of the record's review with that `selectionId`, and
 * keeps the other ids in `requires`; together they are exactly the reviewed set.
 */
function historyRequires(operations: readonly ReviewOperation[]): (op: ReviewOperation) => { requires: string[]; requiresSelections?: string[] } {
  const owner = new Map<string, string>(); const members = new Map<string, number>();
  for (const op of operations) if (op.selectionId) {
    owner.set(op.id, op.selectionId); members.set(op.selectionId, (members.get(op.selectionId) ?? 0) + 1);
  }
  return op => {
    const counts = new Map<string, number>();
    for (const id of new Set(op.requires)) { const selection = owner.get(id); if (selection) counts.set(selection, (counts.get(selection) ?? 0) + 1); }
    const whole = new Set([...counts].filter(([selection, count]) => selection !== op.selectionId && count > 1 &&
      count === members.get(selection)).map(([selection]) => selection));
    if (!whole.size) return { requires: op.requires };
    return { requires: op.requires.filter(id => !whole.has(owner.get(id)!)), requiresSelections: [...whole] };
  };
}
/**
 * Whether `operationSelections` repeats only what the review operations record: each entry is the operation at its
 * position, with that operation's `selectionId` (or null) and the rest of its id after `<selectionId>/`. History then
 * leaves the list out.
 */
function historyDerives(operations: readonly ReviewOperation[], selections: OperationSelection[] | undefined): boolean {
  return selections !== undefined && selections.length === operations.length && selections.every((entry, index) => {
    const op = operations[index]!; const selectionId = op.selectionId ?? null;
    return entry.id === op.id && entry.selectionId === selectionId && entry.operationId === (selectionId === null ? null :
      op.id.startsWith(`${selectionId}/`) ? op.id.slice(selectionId.length + 1) : undefined);
  });
}
function historyDetails(details: ReviewOperation['details']): ReviewOperation['details'] {
  return { ...details, content: details.content === undefined ? undefined : '[OMITTED]',
    stdin: details.stdin === undefined ? undefined : '[OMITTED]',
    entries: details.entries?.map(entry => ({ ...entry, ...(entry.value === undefined ? {} : { value: '[OMITTED]' }) })),
    hookGroup: details.hookGroup === undefined ? undefined : { ...details.hookGroup, desiredGroup: null },
    args: details.args?.map(() => '[OMITTED]'),
    env: details.env ? Object.fromEntries(Object.keys(details.env).map(key => [key, '[OMITTED]'])) : undefined };
}
function prepareCheck(check: RecipeCheck, bound: Record<string, Json>, project: string, selectionKey: string,
    material: { readMaterial(id: string): Buffer | undefined }, privateValues: string[], selectionId: string,
    capturedMissing?: string): { prepared: PreparedCheck; review: ReviewCheck } {
  const id = `${selectionId}/${check.id}`;
  if (check.kind === 'file.sha256') {
    const target = resolvePath(check.target, check.target.root === 'project' ? 'project' : 'user', bound, project, selectionKey);
    return { prepared: { id, kind: check.kind, path: target.absolute, sha256: check.sha256 },
      review: { id, purpose: safeText(check.purpose, privateValues), kind: check.kind,
        details: { target: safeText(target.absolute, privateValues), content: `sha256:${check.sha256}` } } };
  }
  const resolved = resolveProcess(check, bound, project, selectionKey, material, privateValues, capturedMissing);
  return { prepared: { id, kind: check.kind, process: resolved.process },
    review: { id, purpose: safeText(check.purpose, privateValues), kind: check.kind, details: resolved.review } };
}

export async function apply(prepared: PreparedHandle, authorization: Authorization, controls: HostControls = {},
    preEffectCheck?: () => void | Promise<void>): Promise<RunResult> {
  const runId = randomUUID(); let state: PreparedState | undefined; let started = false;
  const result: RunResult = { schema: 'urn:aihq:core:run-result:1.0.0', runId, useCase: 'policy', completion: 'rejected',
    effectiveOptions: { logging: { value: 'off', origin: 'default' } }, operations: [], checks: [], diagnostics: [], record: disabled, followUp: [] };
  const unlocks: (() => void)[] = []; const releases: (() => void)[] = [];
  // Prepared work 1.6.0 reviews name the changed binding; older reviews keep their original diagnostics.
  let reportsChangedBinding = false;
  // Prepared work 1.7.0 reviews name it from the owner's closed list (run result 1.5.0).
  let ownerList = false;
  let rechecked: Awaited<ReturnType<typeof recheckReview>> | undefined;
  try {
    validateControls(controls); result.effectiveOptions.logging = loggingOption(controls);
    await yieldToHost();
    state = prepared && typeof prepared === 'object' ? handles.get(prepared) : undefined;
    // A lost or consumed handle carries no review, so its version is unknowable and the 1.0.0 default is the only truthful label.
    if (!state) throw new Error('handle-unavailable');
    reportsChangedBinding = state.review.schema === PREPARED_16 || state.review.schema === PREPARED_17;
    ownerList = state.review.schema === PREPARED_17;
    result.schema = ownerList ? RESULT_15 : reportsChangedBinding ? RESULT_14 : [PREPARED_11, PREPARED_14, PREPARED_15].includes(state.review.schema as never) ? RESULT_11 : RESULT_10;
    result.inputs = state.review.inputs;
    result.diagnostics.push(...state.review.omissions);
    result.operations = state.steps.map(step => ({ id: step.review.id, application: 'not-attempted',
      verification: { status: 'unverified', reason: 'no-supplied-check' } }));
    result.checks = state.steps.flatMap(step => step.checks.map(check => ({ id: check.id, operationId: step.review.id,
      status: 'skipped' as const, reason: 'not-attempted' })));
    dataObject(authorization, ['reviewDigest', 'origin', 'approved', 'allowPartial']);
    if (authorization.approved !== true || !['interactive', 'automation'].includes(authorization.origin) ||
        authorization.allowPartial !== undefined && typeof authorization.allowPartial !== 'boolean') throw new Error('approval-required');
    if (authorization.reviewDigest !== state.review.reviewDigest) throw new Error(reportsChangedBinding ? 'digest-mismatch' : 'review-stale');
    const allowPartial = authorization.allowPartial ?? false;
    result.authorization = { origin: authorization.origin,
      allowPartial: { value: allowPartial, origin: authorization.allowPartial === undefined ? 'default' : 'explicit' },
      ...(reportsChangedBinding ? { reviewDigest: state.review.reviewDigest } : {}) };
    if (controls.signal?.aborted) throw new Error('cancelled');
    if (state.organization) {
      // Fresh authority for this Apply call (GitHub online, or the local file again); Prepare's credential and result are never reused.
      const read = await readOrganization(state.organization.source, controls);
      const identity = (value: { resolvedCommit?: string; blobId?: string }) => [value.resolvedCommit ?? null, value.blobId ?? null];
      if (canonicalJson(read.source) !== canonicalJson(state.organization.source) ||
          canonicalJson(identity(read as { resolvedCommit?: string })) !== canonicalJson(identity(state.organization)) ||
          read.contentDigest !== state.organization.contentDigest) throw stale('policy');
      let declared: string;
      try { declared = canonicalJson(clone(state.request.organizationTarget ?? null)); } catch { throw stale('policy'); }
      if (declared !== canonicalJson(state.organizationTarget ?? null)) throw stale('policy');
    }
    // Each reviewed binding in a fixed order; an unreadable binding counts as changed.
    const holds = (check: () => boolean): boolean => { try { return check(); } catch { return false; } };
    const held = state;
    // The last copy of the request and of the private inputs whose digest matched the review. A value still holding
    // exactly that copy's data would copy and digest the same, so only a value that differs is copied and digested again.
    const copies: { request?: unknown; privateInputs?: unknown } = {};
    const unchanged = (field: 'request' | 'privateInputs', value: unknown, expected: string): boolean => {
      if (Object.hasOwn(copies, field) && sameJsonDataV1(value, copies[field])) return true;
      const copy = clone(value);
      if (digest(copy) !== expected) return false;
      copies[field] = copy;
      return true;
    };
    const assertInputs = () => {
      if (!holds(() => homedir() === held.home && pinsMatch(held.bindings))) throw stale('host');
      // The request (recipes, selections, metadata) is not an organization's policy: run result 1.5.0 reports it as how
      // the items are installed; earlier results keep `policy`.
      if (!holds(() => unchanged('request', held.request, held.requestDigest))) throw stale(ownerList ? 'binding' : 'policy');
      if (!holds(() => unchanged('privateInputs', held.privateInputs ?? {}, held.privateDigest))) throw stale('input');
      if (held.inventory && !holds(() => canonicalJson([...held.inventory!].sort()) === canonicalJson(ownershipInventory().entries.sort()))) throw stale('ownership');
    };
    assertInputs();
    await state.trustParticipant?.recheck();
    for (const capture of state.captures) if (!await capture.recheck()) throw stale('recipe');
    if (state.rechecks) rechecked = await recheckReview(state, controls);
    const assertStep = (step: PreparedStep, initial = false) => {
      if (!step.path || !step.root) return;
      try { guardTrustMember(step.root,step.path,state?.trustParticipant?.allows(step.root,step.path) ?? false, state?.trustParticipant?.macosSession === true); }
      catch (error) { if (reportsChangedBinding && error instanceof Error && TRUST_CLAIMS.has(error.message)) throw stale('trust'); throw error; }
      const live = transaction(step.root).inspect(step.path);
      let pinsOkay = pinsMatch(step.pins ?? []);
      if (!pinsOkay && isContentRoot(step.root) &&
          step.before === null && live.state === 'absent' &&
          step.pins?.some(pin => pin.identity === 'absent' &&
            pathPins(stateRoot()).some(parent => parent.path === pin.path))) {
        protectState(); step.pins = pathPins(join(step.root, ...step.path.split('/'))); pinsOkay = true;
      }
      if (!pinsOkay || live.state === 'unreadable' ||
          (live.state === 'absent' ? null : sha256(live.bytes)) !== ((initial ? step.initialBefore : step.before) ? sha256((initial ? step.initialBefore : step.before)!) : null))
        throw stale('target-file', step.review.details.target);
    };
    for (const step of state.steps) assertStep(step, true);
    for (const [root, ownership] of state.ownership)
      if (ownershipDigest(root) !== ownership.digest) throw stale('ownership');
    await preEffectCheck?.();
    if (preEffectCheck) {
      assertInputs();
      for (const step of state.steps) assertStep(step, true);
      for (const [root, ownership] of state.ownership)
        if (ownershipDigest(root) !== ownership.digest) throw stale('ownership');
    }
    const unresolved = state.review.omissions.length > 0 || state.steps.some(step =>
      step.review.effects === 'conflict' || step.review.effects === 'unavailable');
    if (unresolved && !allowPartial) throw new Error('partial-approval-required');
    const mutatingRoots = [...new Set([...state.selectionUpdates.keys(), ...state.itemUpdates.keys(), ...state.steps.filter(step => step.path &&
      (['create-file', 'replace-file', 'remove-file'].includes(step.review.effects) || step.resolution === 'adopt' || step.custodyOnly)).map(step => step.root!)])].sort();
    if (mutatingRoots.length) protectState();
    // Acquire roots and the aggregate trust lock in one lexical order.
    for (const root of [...new Set([...mutatingRoots, ...(state.trustParticipant ? [state.trustParticipant.lockRoot] : [])])].sort()) unlocks.push(lockTarget(root));
    await state.trustParticipant?.recheck();
    for (const root of mutatingRoots) {
      for (const step of state.steps.filter(item => item.root === root)) assertStep(step, true);
      if (ownershipDigest(root) !== state.ownership.get(root)?.digest) throw stale('ownership');
      const current = state.ownership.get(root)!.value;
      // Reserve a conservative upper bound for every intermediate receipt,
      // including old members awaiting subtraction and selection intent.
      const next: Ownership = { ...current, members: { ...current.members }, selections: { ...current.selections } };
      const larger = <T>(prior: T | undefined, proposed: T): T => prior && Buffer.byteLength(JSON.stringify(prior)) > Buffer.byteLength(JSON.stringify(proposed)) ? prior : proposed;
      for (const step of state.steps.filter(item => item.root === root &&
        (['create-file', 'replace-file', 'remove-file'].includes(item.review.effects) || item.resolution === 'adopt' || item.custodyOnly))) {
        for (const [key, owner] of Object.entries(step.custody ?? {})) if (owner) {
          // Byte size does not bound semantic counts: a shorter primary ID can
          // hide an overflowing proposed claim list behind a larger old owner.
          try { validateOwnership(sealOwnership({ schema: current.schema, target: root, members: { [key]: owner } }), root); }
          catch { throw new Error('state-unwritable'); }
          next.members[key] = larger(next.members[key], owner);
          const deferred: Ownership = { ...current, members: { ...current.members } };
          updateCustody(deferred, { ...step, custody: { [key]: owner } }, true);
          next.members[key] = larger(next.members[key], deferred.members[key]!);
        }
      }
      for (const [key, update] of Object.entries(state.selectionUpdates.get(root) ?? {})) if (update.claim) {
        try { validateOwnership({ schema: current.schema, target: root, members: {}, selections: { [key]: update.claim } }, root); }
        catch { throw new Error('state-unwritable'); }
        next.selections![key] = larger(next.selections![key], update.claim);
      }
      for (const update of Object.values(state.itemUpdates.get(root) ?? {})) upsertItem(next, update.item);
      reservePending(next, state.steps.filter(item => item.root === root));
      // Reserve directory evidence too, before any target effect. These placeholders
      // establish capacity only; only successful mkdir callbacks publish evidence.
      reserveDirectoryCapacity(next, state.steps.filter(item => item.root === root));
      releases.push(stageOwnership(root, runId, next));
    }
    handles.delete(prepared);
    if (mutatingRoots.length || state.trustParticipant) {
      try { result.recovery = stageRecovery(runId, state.steps, state.project); }
      catch { throw new Error('recovery-unavailable'); }
    }
    state.trustParticipant?.stage(runId, result.recovery);
    const createdDirectories = new Map<string, CreatedDirectories>();
    const outcomes = new Map<string, boolean>(); let stop = false;
    const metadataState = state;
    // Receipt bytes already admitted per root: those Prepare read, and those this Apply wrote once they pass the same
    // admission. A stale check reads and digests the stored receipt every time; it only skips re-admitting those bytes.
    const admitted = new Map<string, AdmittedReceipts>();
    const admittedFor = (root: string): AdmittedReceipts => {
      let receipts = admitted.get(root);
      if (!receipts) admitted.set(root, receipts = { home: metadataState.home, digests: new Set() });
      return receipts;
    };
    for (const [root, tracked] of state.ownership) if (tracked.digest) admittedFor(root).digests.add(tracked.digest);
    const receiptDigest = (root: string): string | null => ownershipDigest(root, admittedFor(root));
    /** Per root, the last receipt this Apply wrote and admitted, from which the next one is admitted part by part. */
    const images = new Map<string, AdmittedImage | undefined>();
    /** Seal and write one root's receipt, tracking the new digest for later stale checks. */
    const persist = (root: string, next: Ownership) => {
      protectState([ownershipPath(root)]);
      const sealed = sealOwnership(next);
      const text = JSON.stringify(sealed);
      const receipt = Buffer.from(text); stateFiles().writeAtomic(ownershipPath(root), receipt, 0o600);
      const written = sha256(receipt);
      metadataState.ownership.set(root, { value: sealed, digest: written });
      metadataState.inventory?.set(basename(ownershipPath(root)), written);
      // Bytes that are not admitted here stay unadmitted, so the next stale check admits them in full, exactly as before.
      const image = homedir() === metadataState.home ? admitWrittenOwnership(images.get(root), sealed, text, root) : undefined;
      images.set(root, image);
      if (image) admittedFor(root).digests.add(written);
    };
    // The pending receipt: immediately before the run's first effect, every selection it writes custody for is
    // recorded as an interrupted install. Members are added only as each is written; completion clears the state.
    let pendingWritten = false;
    const writePending = () => {
      if (pendingWritten) return;
      pendingWritten = true;
      for (const root of mutatingRoots) {
        const installing = metadataState.steps.filter(step => step.root === root && step.item && !step.lifecycle && writesCustody(step));
        if (!installing.length) continue;
        const tracked = metadataState.ownership.get(root)!;
        const next: Ownership = { ...tracked.value, members: { ...tracked.value.members } };
        for (const step of installing) upsertItem(next, step.item!, { installing: true });
        if (receiptDigest(root) !== tracked.digest) throw stale('ownership');
        try { persist(root, next); } catch { throw new Error('state-unwritable'); }
        started = true;
      }
    };
    // A step's selection metadata is published once every non-lifecycle step of its selection (management id and scope)
    // succeeded; it stays complete, as outcomes are final. Its claims are re-applied only to members it could still
    // change: its own members when it completes, and any member whose custody changed since the last publication.
    // Re-applying to any other member leaves it as it is, so each publication equals the full pass over every step.
    const selectionSteps = new Map<string | undefined, Map<string, PreparedStep[]>>();
    for (const step of state.steps) if (!step.lifecycle) {
      let scoped = selectionSteps.get(step.managementId);
      if (!scoped) selectionSteps.set(step.managementId, scoped = new Map());
      const steps = scoped.get(step.review.scope);
      if (steps) steps.push(step); else scoped.set(step.review.scope, [step]);
    }
    const stepOrder = new Map(state.steps.map((step, index) => [step, index]));
    const inOrder = (list: PreparedStep[], step: PreparedStep) => {
      let at = list.length;
      while (at > 0 && stepOrder.get(list[at - 1]!)! > stepOrder.get(step)!) at--;
      list.splice(at, 0, step);
    };
    const completed = new Set<PreparedStep>();
    /** Per root: completed steps in step order, and those holding desired custody for each member key. */
    const completedSteps = new Map<string, PreparedStep[]>();
    const completedOwners = new Map<string, Map<string, PreparedStep[]>>();
    const publishedMembers = new Map<string, Record<string, Owner>>();
    const publishMetadata = () => {
      // Byte custody follows each successful mutation. Selection metadata advances
      // only when all its reviewed operations and required checks succeeded.
      const fresh: PreparedStep[] = [];
      for (const step of metadataState.steps) {
        if (completed.has(step) || outcomes.get(step.review.id) !== true) continue;
        if (!(selectionSteps.get(step.managementId)?.get(step.review.scope) ?? []).every(other => outcomes.get(other.review.id) === true)) continue;
        completed.add(step); fresh.push(step);
        if (!step.root) continue;
        let steps = completedSteps.get(step.root);
        if (!steps) completedSteps.set(step.root, steps = []);
        inOrder(steps, step);
        let owners = completedOwners.get(step.root);
        if (!owners) completedOwners.set(step.root, owners = new Map());
        for (const [key, desired] of Object.entries(step.custody ?? {})) if (desired) {
          const list = owners.get(key);
          if (list) inOrder(list, step); else owners.set(key, [step]);
        }
      }
      for (const root of mutatingRoots) {
        const tracked = metadataState.ownership.get(root)!;
        const next: Ownership = { ...tracked.value, members: { ...tracked.value.members } };
        let changed = false;
        const published = publishedMembers.get(root);
        const affected = new Set<string>();
        for (const step of fresh) if (step.root === root) for (const [key, desired] of Object.entries(step.custody ?? {})) if (desired) affected.add(key);
        for (const [key, owner] of Object.entries(next.members)) if (!published || published[key] !== owner) affected.add(key);
        for (const key of affected) for (const step of completedOwners.get(root)?.get(key) ?? []) {
          const desired = step.custody![key]!, current = next.members[key]; if (!current) continue;
          const claims = (current.claims ?? []).map(claim => desired.claims?.find(item => item.managementId === claim.managementId && item.scope === claim.scope) ?? claim);
          const owner = { ...current, claims };
          if (canonicalJson(owner) !== canonicalJson(current)) { next.members[key] = owner; changed = true; }
        }
        for (const step of completedSteps.get(root) ?? []) if (step.item && completeItem(next, step.item.id)) changed = true;
        for (const [key, update] of Object.entries(metadataState.selectionUpdates.get(root) ?? {})) {
          if (!update.requires.every(id => outcomes.get(id) === true)) continue;
          next.selections = { ...next.selections };
          if (update.claim) next.selections[key] = update.claim; else delete next.selections[key];
          delete metadataState.selectionUpdates.get(root)![key];
          changed = true;
        }
        for (const [key, update] of Object.entries(metadataState.itemUpdates.get(root) ?? {})) {
          if (!update.requires.every(id => outcomes.get(id) === true)) continue;
          if (update.action === 'release') releaseItem(next, key);
          else if (update.action === 'finish') { if (next.items?.[key]) upsertItem(next, update.item); completeItem(next, key); }
          else upsertItem(next, update.item);
          delete metadataState.itemUpdates.get(root)![key];
          changed = true;
        }
        if (changed) {
          if (receiptDigest(root) !== tracked.digest) throw stale('ownership');
          persist(root, next);
        }
        publishedMembers.set(root, { ...metadataState.ownership.get(root)!.value.members });
      }
    };
    publishMetadata();
    for (let index = 0; index < state.steps.length; index++) {
      const step = state.steps[index]!; const operation = result.operations[index]!;
      await yieldToHost();
      if (controls.signal?.aborted) throw new Error('cancelled');
      if (stop || step.review.requires.some(id => outcomes.get(id) !== true)) {
        operation.reason = 'dependency-not-satisfied'; outcomes.set(step.review.id, false);
        for (const check of result.checks.filter(item => item.operationId === step.review.id)) check.reason = 'dependency-not-satisfied';
        continue;
      }
      if (step.review.effects === 'conflict' || step.review.effects === 'unavailable') {
        operation.reason = step.review.effects; outcomes.set(step.review.id, false);
        for (const check of result.checks.filter(item => item.operationId === step.review.id)) check.reason = step.review.effects;
        if (!allowPartial) stop = true;
        continue;
      }
      assertInputs();
      if (step.path) {
        assertStep(step);
        if (receiptDigest(step.root!) !== state.ownership.get(step.root!)?.digest) throw stale('ownership');
      }
      if (step.review.effects === 'already-satisfied') operation.application = 'already-satisfied';
      else if (step.process) {
        await preEffectCheck?.();
        if (controls.signal?.aborted) throw new Error('cancelled');
        assertInputs();
        writePending(); started = true;
        const processResult = await executeProcess(step.process, runId, controls.signal);
        operation.application = processResult.status === 'passed' ? 'applied' : 'failed';
        if (processResult.status !== 'passed') {
          operation.reason = processResult.reason; operation.effectsUncertain = processResult.effectsUncertain;
          if (processResult.terminationUnconfirmed) stop = true;
        }
        if (processResult.status === 'cancelled' || controls.signal?.aborted) throw new Error('cancelled');
      } else if (step.path && step.root) {
        await preEffectCheck?.();
        if (controls.signal?.aborted) throw new Error('cancelled');
        assertInputs();
        assertStep(step);
        if (receiptDigest(step.root) !== state.ownership.get(step.root)?.digest) throw stale('ownership');
        writePending(); started = true;
        // Write ahead the members this effect changes, so a crash before its custody is published can be settled later.
        // A written file is recorded with the identity of the staged file that replaces the destination.
        const attempting = step.item && !step.lifecycle ? pendingMembers(step, state.ownership.get(step.root)!.value) : [];
        let pendingFailed = false;
        const writeAhead = (identity?: string) => {
          const tracked = metadataState.ownership.get(step.root!)!;
          const next: Ownership = { ...tracked.value, members: { ...tracked.value.members } };
          attemptItem(next, step.item!.id, attempting.map(entry => identity ? { ...entry, identity } : entry));
          try { persist(step.root!, next); } catch (error) { pendingFailed = true; throw error; }
        };
        if (attempting.length && step.after === null) {
          try { writeAhead(); } catch { operation.reason = 'custody-write'; throw new Error('state-unwritable'); }
        }
        try {
          const tx = transaction(step.root, path => {
            const identity = directoryIdentity(step.root!, path);
            if (!identity) throw new Error('unsafe-path');
            const created: CreatedDirectories = createdDirectories.get(step.root!) ?? Object.create(null);
            created[path] = identity; createdDirectories.set(step.root!, created);
          });
          tx.commit([{ action: step.after === null ? 'remove' : 'write', path: step.path, mode: step.mode ?? 0o600,
            ...(step.after === null ? {} : { contents: step.after }),
            ...(step.before ? { prior: step.before, priorMode: step.mode } : {}),
            expect: step.before === null ? { absent: true } : { sha256: sha256(step.before!) } }],
            attempting.length && step.after !== null ? (_path, identity) => writeAhead(identity) : undefined);
          operation.application = 'applied';
          const createdParents = pathPins(join(step.root, ...step.path.split('/'))).slice(0, -1);
          for (const remaining of state.steps.slice(index + 1)) {
            if (remaining.root === step.root && remaining.path === step.path) remaining.pins = pathPins(join(remaining.root!, ...remaining.path!.split('/')));
            if (remaining.pins?.some(pin => pin.identity === 'absent' && createdParents.some(parent => parent.path === pin.path)) && remaining.root && remaining.path)
              remaining.pins = pathPins(join(remaining.root, ...remaining.path.split('/')));
            for (const invocation of [remaining.process, ...remaining.checks.map(check => check.process)].filter((item): item is PreparedProcess => !!item))
              if (invocation.cwdPins.some(pin => pin.identity === 'absent' && createdParents.some(parent => parent.path === pin.path)))
                invocation.cwdPins = pathPins(invocation.cwd);
          }
        } catch {
          // A failed write-ahead leaves the destination untouched: nothing was attempted.
          if (pendingFailed) { operation.reason = 'custody-write'; throw new Error('state-unwritable'); }
          operation.application = 'failed'; operation.reason = 'file-effect'; operation.effectsUncertain = true;
        }
      }
      if (operation.application === 'applied' || operation.application === 'already-satisfied') {
        if (step.root && step.path && (operation.application === 'applied' || step.resolution === 'adopt' || step.custodyOnly)) {
          try {
            writePending();
            const tracked = state.ownership.get(step.root)!;
            const next: Ownership = { ...tracked.value, members: { ...tracked.value.members } };
            updateCustody(next, step, true);
            const created = createdDirectories.get(step.root);
            if (created) next.directories = directoryRecords({ ...directoryMap(next.directories), ...created });
            persist(step.root, next);
          } catch { operation.effectsUncertain = true; operation.reason = 'custody-write'; throw new Error('state-unwritable'); }
        }
        // Dependent configuration never runs before the output's custody pair commits.
        if (state.trustParticipant) { started = true; state.trustParticipant.committed(step); }
        if (step.checks.length) {
          let checkFailed = false;
          for (const check of step.checks) {
            if (controls.signal?.aborted) throw new Error('cancelled');
            const checkResult = await executeCheck(check, step.review.id, runId, controls.signal);
            const checkIndex = result.checks.findIndex(item => item.operationId === step.review.id && item.id === check.id);
            result.checks[checkIndex] = checkResult;
            if (checkResult.status !== 'passed') checkFailed = true;
            if (checkResult.terminationUnconfirmed) {
              stop = true;
              for (const remaining of result.checks.filter(item => item.operationId === step.review.id && item.status === 'skipped'))
                remaining.reason = 'termination-unresolved';
              if (controls.signal?.aborted) {
                operation.verification = { status: 'unavailable', reason: 'cancelled' };
                throw new Error('cancelled');
              }
              break;
            }
            if (controls.signal?.aborted) { operation.verification = { status: 'unavailable', reason: 'cancelled' }; throw new Error('cancelled'); }
          }
          operation.verification = { status: checkFailed ? 'failed' : 'passed', reason: checkFailed ? 'check-not-passed' : 'supplied-checks-passed' };
        }
      }
      if (operation.application === 'failed') for (const check of result.checks.filter(item => item.operationId === step.review.id && item.status === 'skipped'))
        check.reason = 'application-failed';
      const okay = (operation.application === 'applied' || operation.application === 'already-satisfied') &&
        ['unverified', 'passed'].includes(operation.verification.status);
      outcomes.set(step.review.id, okay);
      publishMetadata();
      if (!okay && !allowPartial) stop = true;
    }
    publishMetadata();
    // Wait until all file effects finish so removing a parent cannot invalidate
    // another reviewed step's path pins. Interrupted work keeps conservative evidence.
    for (const root of mutatingRoots) {
      const reviewed = Object.assign(Object.create(null), ...state.steps.filter(step => step.root === root &&
        outcomes.get(step.review.id) === true).map(step => step.directoryCleanup ?? {})) as CreatedDirectories;
      if (!Object.keys(reviewed).length) continue;
      const tracked = state.ownership.get(root)!;
      if (receiptDigest(root) !== tracked.digest) throw stale('ownership');
      const directories = removeCreatedDirectories(root, directoryMap(tracked.value.directories), reviewed,
        Object.entries(tracked.value.members).map(([key, owner]) => owner.descriptor?.path ?? key));
      persist(root, { ...tracked.value, directories: directoryRecords(directories) });
    }
    result.completion = state.review.omissions.length === 0 && result.operations.every(op => ['applied', 'already-satisfied'].includes(op.application) &&
      ['unverified', 'passed'].includes(op.verification.status)) ? 'complete' : 'incomplete';
    state.trustParticipant?.finish(result);
  } catch (error) {
    const authority = error instanceof AuthorityFailure ? error : undefined;
    const reason = error instanceof Error ? error.message : 'execution-failed';
    const safeReason = /^[a-z-]{1,64}$/.test(reason) ? reason : 'execution-failed';
    result.completion = reason === 'cancelled' ? 'cancelled' : started ? 'incomplete' : 'rejected';
    if (reason === 'cancelled') for (const check of result.checks)
      if (check.status === 'skipped' && check.reason === 'not-attempted') check.reason = 'cancelled';
    const code = reason === 'cancelled' ? 'CANCELLED' : ['review-stale', 'handle-unavailable', 'digest-mismatch'].includes(reason) ? 'REVIEW_STALE' :
      reason === 'certificate-invalid' ? 'INPUT_INVALID' :
      reason === 'approval-required' || reason === 'partial-approval-required' || reason === 'request-object' || reason === 'request-field' ? 'APPROVAL_REQUIRED' :
      reason === 'state-unwritable' || reason === 'state-protection' || reason === 'recovery-unavailable' ? 'PREREQUISITE_UNAVAILABLE' :
      started ? 'EXECUTION_FAILED' : 'PREREQUISITE_UNAVAILABLE';
    result.diagnostics.push(authority ? authority.detail : reportsChangedBinding && error instanceof ReviewStale ?
      { ...diagnostic(code, 'binding-changed', 'A reviewed binding changed after preparation.'),
        changed: ownerList ? OWNER_STALE[error.changed] : error.changed, ...(ownerList && error.detail ? { detail: error.detail } : {}) } :
      diagnostic(code, safeReason, 'The run could not complete the requested work.'));
    result.followUp.push('Inspect the reported outcomes, prepare again and approve the new review before further changes.');
    try { state?.trustParticipant?.finish(result); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED','trust-custody-pending','Protected trust recovery remains pending.')); }
  } finally {
    for (const release of releases.reverse()) try { release(); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'work-cleanup', 'Inspect remaining temporary work before deliberate cleanup.')); }
    for (const unlock of unlocks.reverse()) try { unlock(); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'lock-release', 'Inspect the remaining state lock before another run.')); }
  }
  // Run results 1.4 and 1.5 report the members a run touched. A removal under them is also verified from those
  // checks, and the same checks decide whether its recovery data may go; a failed, partial or kept removal keeps
  // that data for inspection. Older identities carry no member checks and keep their documented cleanup behaviour.
  if (state && (result.schema === RESULT_14 || result.schema === RESULT_15)) {
    const members = memberReports(state, result);
    // A truncated list could support a false claim, so an oversized one is withheld entirely.
    if (members.length <= MEMBER_REPORT_LIMIT) result.members = members;
    else result.diagnostics.push(diagnostic('SOURCE_LIMIT', 'member-check-limit', 'Too many touched members to report their checks; no member claim is supported.'));
    if ((state.request.policy.removals?.length ?? 0) > 0) {
      // A cleanup operation is verified from the disk it left: the owned path is absent, or the value it kept or
      // restored is present and matching. This replaces Apply's default "no supplied check" for cleanup steps.
      for (const operation of result.operations) {
        const checked = members.filter(member => member.operationId === operation.id && member.intent !== 'write');
        if (!checked.length) continue;
        if (checked.every(member => member.check === 'absent' || member.check === 'present-matching'))
          operation.verification = { status: 'passed', reason: 'member-checked' };
        else if (checked.some(member => member.check === 'present-different'))
          operation.verification = { status: 'failed', reason: 'member-changed' };
        else operation.verification = { status: 'unverified', reason: 'member-unchecked' };
      }
      if (result.completion === 'complete' && result.operations.some(operation => operation.verification.status === 'failed'))
        result.completion = 'incomplete';
      const checked = members.filter(member => member.intent !== 'write');
      const kept = state.steps.some(step => step.lifecycle && (step.kept || step.review.effects === 'conflict' || step.review.effects === 'unavailable' ||
        step.ownerKey !== undefined && step.custody?.[step.ownerKey] !== null && step.custody?.[step.ownerKey] !== undefined));
      const verified = checked.length > 0 && checked.every(member => member.check === 'absent' || member.check === 'present-matching');
      if (result.completion === 'complete' && verified && !kept) {
        try { protectState([`recovery/${runId}`]); rmSync(join(stateRoot(), 'recovery', runId), { recursive: true, force: true }); delete result.recovery; }
        catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'recovery-cleanup', 'The removal succeeded but its recovery data could not be removed.')); }
      }
    }
  }
  // The evidence Apply re-checked is the evidence it reports; it is read again only when Apply stopped before the re-check.
  if (rechecked) result.evidence = coveredEvidence(rechecked.results, rechecked.scans);
  else if (state?.rechecks) {
    const read = await readEvidence(state.evidence, controls.evidence, controls.signal);
    result.evidence = coveredEvidence(read.results, selectionScans(state.request.policy, state.rechecks.own, read.artifacts));
  } else if (state) result.evidence = await readPolicyEvidence(state.evidence, controls.evidence, controls.signal);
  result.record = writeHistory(runId, historySafe(result, state?.project, bearerSecrets(controls)), result.effectiveOptions.logging.value);
  if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason,
    'Routine history could not be saved; the returned outcomes remain available.'));
  return result;
}

/** Managed update preparation 1.0.0: what the review does to one member, from the step's planned bytes. */
function planMember(step: PreparedStep, descriptor: MemberDescriptor, managementIds: string[], approval: { tool: string } | undefined): PlannedMember {
  const base = { operationId: step.review.id, selectionId: step.authored?.selectionId ?? null, managementIds, root: step.root!, descriptor,
    ...(step.redactedPaths?.[memberKey(descriptor)] ? { redactedPath: step.redactedPaths[memberKey(descriptor)] } : {}),
    ...(approval ? { approval: { tool: approval.tool } } : {}) };
  if (step.review.effects === 'conflict') return { ...base, action: 'conflict', reason: step.conflictReason ?? 'existing-content' };
  if (step.review.effects === 'unavailable') return { ...base, action: 'conflict', reason: step.unavailable ?? 'unavailable' };
  if (step.lifecycle) {
    const action = step.custody?.[step.ownerKey!] ? 'keep-shared' : step.restores ? 'restore' : step.review.effects === 'already-satisfied' ? 'unregister' : 'remove';
    const reason = { 'keep-shared': 'another-selection', restore: 'pre-existing-value', unregister: 'already-absent', remove: undefined }[action];
    return { ...base, action, ...(reason === undefined ? {} : { reason }) };
  }
  const located = (bytes: Buffer | null | undefined) => { try { return locateMember(descriptor, bytes ?? null); } catch { return 'different'; } };
  const before = located(step.before), after = located(step.after);
  return { ...base, action: before === after ? 'unchanged' : before === null ? 'add' : after === null ? 'remove' : 'replace' };
}

/**
 * Check every member a reviewed file operation touched directly on disk. A member is compared with its state after
 * the step when the step succeeded, or before it otherwise; a member the run never attempted stays unchecked.
 */
function memberReports(state: PreparedState, result: RunResult): RunMember[] {
  const privateValues = Object.values(state.privateInputs ?? {}).flatMap(inputs => Object.values(inputs)).map(String);
  const reports: RunMember[] = [];
  state.steps.forEach((step, index) => {
    const operation = result.operations[index];
    if (!step.root || !step.path || !step.members || !operation) return;
    const succeeded = operation.application === 'applied' || operation.application === 'already-satisfied';
    let live: { state: 'present' | 'absent' | 'unreadable'; bytes?: Buffer } | undefined;
    for (const descriptor of step.members) {
      const desired = succeeded ? step.after ?? null : step.before ?? null;
      let expected: string | null | 'different';
      try { expected = locateMember(descriptor, desired); } catch { expected = 'different'; }
      let planned: string | null | 'different';
      try { planned = locateMember(descriptor, step.after ?? null); } catch { planned = 'different'; }
      const intent: RunMember['intent'] = step.lifecycle ? step.custody?.[step.ownerKey!] === null ? 'remove' : 'keep' : planned === null ? 'remove' : 'write';
      const outcome: RunMember['outcome'] = !succeeded ? 'kept' : step.lifecycle ?
        step.restores ? 'restored' : step.custody?.[step.ownerKey!] === null ? 'claim-removed' : 'kept' :
        expected === null ? 'claim-removed' : 'written';
      let check: MemberCheck = 'unchecked';
      if (operation.application !== 'not-attempted' && expected !== 'different') {
        try { live ??= transaction(step.root).inspect(step.path); } catch { live = { state: 'unreadable' }; }
        check = checkMember(descriptor, live, expected);
      }
      reports.push({ operationId: step.review.id, selectionId: step.authored?.selectionId ?? null, managementId: step.managementId,
        scope: step.review.scope, kind: publicKind(descriptor),
        path: safeText(join(step.root, step.redactedPaths?.[memberKey(descriptor)] ?? descriptor.path), privateValues),
        ...(memberPointer(descriptor) !== undefined ? { pointer: safeText(memberPointer(descriptor)!, privateValues) } : {}),
        ...(descriptor.kind === 'block' ? { blockId: descriptor.blockId } : {}),
        ...(descriptor.kind === 'hook' ? { groupId: descriptor.groupId } : {}), intent, outcome, check });
    }
  });
  return reports;
}

async function executeProcess(invocation: PreparedProcess, runId: string, signal?: AbortSignal) {
  if (!pinsMatch(invocation.cwdPins)) return { status: 'unavailable' as const, reason: 'cwd-changed', effectsUncertain: false, terminationUnconfirmed: false };
  if ('missing' in invocation.executable) return { status: 'unavailable' as const, reason: 'executable-missing', effectsUncertain: false, terminationUnconfirmed: false };
  let executable: ResolvedExecutable;
  let work: { path: string; dir: string; pins: PathPin[] } | undefined;
  if ('material' in invocation.executable) {
    // Provision the protected root before staging can create it with inherited ACLs.
    protectState();
    const dir = join(stateRoot(), 'work', runId);
    pathPins(dir); mkdirSync(dir, { recursive: true, mode: 0o700 }); protectState([`work/${runId}`]);
    const path = join(dir, randomUUID() + (process.platform === 'win32' ? '.exe' : ''));
    pathPins(path); writeFileSync(path, invocation.executable.bytes, { flag: 'wx', mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(path, 0o700);
    protectState([`work/${runId}/${basename(path)}`]);
    work = { path, dir, pins: pathPins(path) };
    const found = resolveExecutable(path);
    if (!found) {
      try { unlinkSync(path); rmdirSync(dir); } catch { /* Inert work remains for deliberate inspection. */ }
      return { status: 'unavailable' as const, reason: 'material-executable', effectsUncertain: false, terminationUnconfirmed: false };
    }
    executable = found;
  } else executable = invocation.executable;
  try { return await runApprovedProcess({ ...invocation, executable, signal }); }
  finally {
    if (work && pinsMatch(work.pins)) {
      try { unlinkSync(work.path); rmdirSync(work.dir); } catch { /* Inert work remains for deliberate inspection. */ }
    }
  }
}

async function executeCheck(check: PreparedCheck, operationId: string, runId: string, signal?: AbortSignal): Promise<CheckResult> {
  if (check.kind === 'file.sha256') {
    try {
      const bytes = readRegularFile(check.path!, { maxBytes: 16 * 1024 * 1024 });
      if (!bytes) throw new Error('file-unavailable');
      return { id: check.id, operationId, status: sha256(bytes) === check.sha256 ? 'passed' : 'failed',
        reason: sha256(bytes) === check.sha256 ? 'digest-matched' : 'digest-mismatch' };
    } catch { return { id: check.id, operationId, status: 'unavailable', reason: 'file-unavailable' }; }
  }
  const outcome = await executeProcess(check.process!, runId, signal);
  return { id: check.id, operationId, status: outcome.status === 'cancelled' ? 'unavailable' : outcome.status,
    reason: outcome.reason, ...(outcome.effectsUncertain ? { effectsUncertain: true } : {}),
    ...(outcome.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}) };
}

function reserveDirectoryCapacity(value: Ownership, steps: PreparedStep[]): void {
  const directories: CreatedDirectories = Object.assign(Object.create(null), directoryMap(value.directories));
  for (const step of steps.filter(item => item.review.effects === 'create-file'))
    for (const path of directoryParents(step.path!)) directories[path] ??= '0'.repeat(64);
  if (Object.keys(directories).length) value.directories = directoryRecords(directories);
}

function preflightOwnershipCapacity(steps: PreparedStep[], ownership: Map<string, { value: Ownership; digest: string | null }>,
    updates: PreparedState['selectionUpdates'], itemUpdates: PreparedState['itemUpdates']): void {
  for (const [root, stored] of ownership) {
    const current: Ownership = { ...stored.value, members: { ...stored.value.members }, selections: { ...stored.value.selections } };
    const check = () => {
      const sealed = sealOwnership(current);
      try { validateOwnership(sealed, root); } catch { throw new Error('custody-record-limit'); }
      if (Buffer.byteLength(JSON.stringify(sealed)) > 1_048_576) throw new Error('custody-record-limit');
    };
    reserveDirectoryCapacity(current, steps.filter(item => item.root === root));
    check();
    // First bound the union before cleanup, then each actual intermediate image.
    for (const step of steps.filter(step => step.root === root)) for (const [key, owner] of Object.entries(step.custody ?? {}))
      if (owner) {
        try { validateOwnership(sealOwnership({schema:current.schema,target:root,members:{[key]:owner}}),root); }
        catch { throw new Error('custody-record-limit'); }
        if (Buffer.byteLength(JSON.stringify(owner)) >= Buffer.byteLength(JSON.stringify(current.members[key] ?? {}))) current.members[key] = owner;
      }
    for (const [key, update] of Object.entries(updates.get(root) ?? {})) if (update.claim) current.selections![key] = update.claim;
    for (const update of Object.values(itemUpdates.get(root) ?? {})) upsertItem(current, update.item);
    reservePending(current, steps.filter(step => step.root === root));
    check();
    for (const step of steps.filter(step => step.root === root)) { updateCustody(current, step, true); check(); }
  }
}
function updateCustody(next: Ownership, step: PreparedStep, deferMetadata = false): void {
  for (const [key, owner] of Object.entries(step.custody ?? {})) {
    if (owner) {
      const prior = next.members[key];
      next.members[key] = deferMetadata && !step.lifecycle ? { ...owner, claims: owner.claims?.map(claim => {
        const old = prior?.claims?.find(old => old.managementId === claim.managementId && old.scope === claim.scope);
        return { ...claim, sets: old?.sets ?? [], requires: old?.requires ?? [] };
      }) } : owner;
    } else delete next.members[key];
  }
  // Item facts and restoration data travel with the custody of the selection that wrote them.
  if (step.item && !step.lifecycle) {
    upsertItem(next, step.item, { preExisting: step.preExisting, redactedPaths: step.redactedPaths, installing: deferMetadata });
    settleItem(next, step.item.id, Object.keys(step.custody ?? {}));
  }
}
/**
 * The members a file effect changes, with the custody each would publish. A member the effect leaves as it was is not
 * pending: finding it in place after a crash would prove nothing about this run.
 */
function pendingMembers(step: PreparedStep, value: Ownership): PendingMember[] {
  if (!step.item || !step.path || !['create-file', 'replace-file', 'remove-file'].includes(step.review.effects)) return [];
  const projected: Ownership = { ...value, members: { ...value.members } };
  updateCustody(projected, step, true);
  const located = (descriptor: MemberDescriptor, bytes: Buffer | null | undefined) => { try { return locateMember(descriptor, bytes ?? null); } catch { return 'different'; } };
  const entries: PendingMember[] = [];
  for (const key of Object.keys(step.custody ?? {})) {
    const owner = projected.members[key] ?? null;
    const descriptor = owner?.descriptor ?? step.members?.find(member => memberKey(member) === key);
    // Only custody this module can validate is written ahead; anything else keeps the earlier conservative behaviour.
    if (!descriptor || owner && !owner.claims?.some(claim => claim.managementId === step.managementId && claim.scope === step.review.scope)) continue;
    if (located(descriptor, step.before) === located(descriptor, step.after)) continue;
    entries.push({ key, descriptor, owner, ...(step.redactedPaths?.[key] ? { redactedPath: step.redactedPaths[key] } : {}),
      ...(step.preExisting && Object.hasOwn(step.preExisting, key) ? { preExisting: { value: step.preExisting[key]! } } : {}) });
  }
  return entries;
}
/** Reserve receipt capacity for the largest set of members one effect writes ahead. */
function reservePending(value: Ownership, steps: PreparedStep[]): void {
  let largest: { step: PreparedStep; entries: PendingMember[]; bytes: number } | undefined;
  for (const step of steps) {
    const entries = pendingMembers(step, value), bytes = Buffer.byteLength(JSON.stringify(entries));
    if (entries.length && (!largest || bytes > largest.bytes)) largest = { step, entries, bytes };
  }
  if (!largest) return;
  upsertItem(value, largest.step.item!, { installing: true });
  // A placeholder of the largest identity a file system reports stands in for the staged file's.
  attemptItem(value, largest.step.item!.id, largest.entries.map(entry => entry.owner ? { ...entry, identity: `${2n ** 64n - 1n}:${2n ** 64n - 1n}` } : entry));
}
/** Steps whose success changes target-keyed custody. */
function writesCustody(step: PreparedStep): boolean {
  return ['create-file', 'replace-file', 'remove-file'].includes(step.review.effects) || step.resolution === 'adopt' || !!step.custodyOnly;
}
function selectionItem(selection: ExecutionPolicy['selections'][number], project: string, privateValues: string[]): NonNullable<PreparedStep['item']> {
  const source = selectionSource(selection);
  return { id: claimIdentity(selection.scope, selection.managementId, project), named: selection.item !== undefined,
    facts: { managementId: selection.managementId, scope: selection.scope,
      name: selection.name === undefined ? null : safeText(selection.name, privateValues), kind: selection.kind ?? null,
      framework: selection.item?.framework ?? null, item: selection.item === undefined ? null : clone(selection.item),
      tool: selection.tool ?? null, origins: selection.origins === undefined ? [] : clone(selection.origins),
      ...(selection.projectFacts === undefined ? {} : { projectFacts: selection.projectFacts.map(fact => ({ ...fact, value: safeText(fact.value, privateValues) })) }),
      ...(source === undefined ? {} : { materialSource: source }) } };
}
/** The exact git provenance of a selection's referenced recipe; undefined for inline recipes and other sources. */
function selectionSource(selection: ExecutionPolicy['selections'][number]): GitMaterialProvenance | undefined {
  const recipe = selection.recipe;
  return recipe !== undefined && 'reference' in recipe && recipe.reference.source.kind === 'git' ?
    gitProvenance(recipe.reference.source) : undefined;
}
function factsOf(item: ItemFacts): ItemFacts {
  return { managementId: item.managementId, scope: item.scope, name: item.name, kind: item.kind, framework: item.framework,
    item: item.item, tool: item.tool, origins: item.origins,
    ...(item.projectFacts ? { projectFacts: clone(item.projectFacts) } : {}),
    ...(item.materialSource ? { materialSource: item.materialSource } : {}) };
}
