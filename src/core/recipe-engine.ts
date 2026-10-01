import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { isProxy } from 'node:util/types';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { contractSupport, parseOrganizationPolicy, validatePolicy, validateRecipe } from './contracts.js';
import { readGitHubPolicy, type ReadGitHubPolicyResult } from '../harness/runtime.mjs';
import { admitOrganizationSelections, type AdmissionLifecycle, type AdmissionSelection } from './internal/organization-admission.js';
import { canonicalJson } from './internal/canonical.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, deepFreezeStrictJsonV1, parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { dependencyOrder, inputAccepts } from './internal/policy-validation.js';
import { fileTransaction, pathPins, pinsMatch, projectRoot, userHomeRoot, sha256, validSegment, type PathPin } from './internal/host-files.js';
import { ownershipInventory, lockTarget, ownershipPath, protectState, readOwnership, validateOwnership, stageOwnership, stateFiles, stateRoot, writeHistory, type Ownership, type Owner } from './internal/state.js';
import { captureRecipeReference, captureInlineMaterials, createMaterialCaptureBudget, MaterialCaptureError,
  type MaterialCaptureBudget } from './internal/material.js';
import { renderConfigEntries, renderTextBlock } from './internal/recipe-editors.js';
import { claimIdentity, overlappingMembers, memberKey, memberBytes, subtractMember, type MemberDescriptor, type Claim } from './internal/recipe-lifecycle.js';
import { RecipeEditError } from './internal/recipe-editors.js';
import { resolveExecutable, runApprovedProcess, type ResolvedExecutable } from './internal/approved-process.js';
import { OwnedFileTransaction, type OwnedFileRead, type OwnedFileStep } from './internal/owned-file-transaction.js';
import { readRegularFile } from './internal/fsxn.js';
import { readPolicyEvidence } from './internal/policy-evidence.js';
import type { EvidenceAssociation } from './evidence/types.js';
import type { Diagnostic, ExecutionPolicy, Json, Operation, OrganizationPolicy, ProcessInvocation, Recipe, RecipeCheck, Slot, TargetPath } from './types.js';
import type { Authorization, CheckResult, Effective, HostControls, OrganizationBinding, PolicyRequest, PreparationResult, PreparedHandle, PreparedReview, ReviewCheck, ReviewOperation, RunResult } from './host-types.js';

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
}
interface PreparedState {
  request: PolicyRequest; requestDigest: string; privateInputs: HostControls['privateInputs']; privateDigest: string;
  review: PreparedReview; steps: PreparedStep[]; project: string; home: string;
  ownership: Map<string, { value: Ownership; digest: string | null }>;
  selectionUpdates: Map<string, Record<string, { claim: Claim | null; requires: string[] }>>;
  inventory?: Map<string, string>; bindings: PathPin[]; captures: { recheck(): Promise<boolean> }[];
  organization?: Pick<OrganizationBinding, 'source' | 'resolvedCommit' | 'blobId' | 'contentDigest'>;
  evidence?: EvidenceAssociation[];
}
// Authority read outcome that is not a successful read; carried as a precise diagnostic.
class AuthorityFailure extends Error {
  constructor(readonly status: 'invalid' | 'blocked' | 'cancelled', readonly detail: Diagnostic) { super(detail.reason); }
}
function authorityFailure(read: Exclude<ReadGitHubPolicyResult, { status: 'read' }>): AuthorityFailure {
  const detail: Diagnostic = { code: read.code, reason: read.reason, message: read.message,
    ...(read.retryAfterSeconds === undefined ? {} : { guidance: `Retry after ${read.retryAfterSeconds} seconds.` }) };
  return new AuthorityFailure(read.status === 'invalid' ? 'invalid' : read.status === 'cancelled' ? 'cancelled' : 'blocked', detail);
}
async function readOrganization(source: unknown, controls: HostControls): Promise<Extract<ReadGitHubPolicyResult, { status: 'read' }>> {
  const read = await readGitHubPolicy(source, {
    ...(controls.authentication === undefined ? {} : { authentication: controls.authentication }),
    ...(controls.signal === undefined ? {} : { signal: controls.signal }) });
  if (read.status !== 'read') throw authorityFailure(read);
  return read;
}
// Unavailable material has no computed identity: admission borrows the named entry's
// identity (membership and scope still apply; the selection has no effects) or, with
// no entry, uses this value, which no admitted recipe can hash to.
const UNMATCHED_RECIPE_IDENTITY = `sha256:${'0'.repeat(64)}`;
// Internal adapter input: never accepted through public request or host controls.
interface CapturedUnavailableInvocations { operations: Record<string, string>; checks: Record<string, string> }
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
  dataObject(controls, ['signal', 'logging', 'privateInputs', 'materialRoots', 'authentication', 'evidence']);
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
function safeText(text: string, privateValues: string[]): string {
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
function resolveSlot(slot: Slot, bound: Record<string, Json>): Json {
  const value = 'literal' in slot ? slot.literal : bound[slot.input];
  if (value === undefined) throw new Error('input-unbound');
  return value;
}
function resolveString(slot: Slot, bound: Record<string, Json>): string {
  const value = resolveSlot(slot, bound);
  if (typeof value !== 'string') throw new Error('string-slot');
  return value;
}
function resolvePath(target: TargetPath, scope: 'project' | 'user', bound: Record<string, Json>, project: string, selectionKey: string): { root: string; path: string; absolute: string } {
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
    budget: MaterialCaptureBudget, signal?: AbortSignal): Promise<{ recipe: Recipe; recipeSha256: string; material: { readMaterial(id: string): Buffer | undefined; recheck(): Promise<boolean> } }> {
  if ('reference' in selection.recipe) {
    const captured = await captureRecipeReference(selection.recipe.reference, roots, { signal, budget });
    const recipe = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(captured.readRecipe()), 'recipe') as unknown as Recipe;
    if (!validateRecipe(recipe).valid) throw new Error('recipe-invalid');
    const declared = [...recipe.materials].map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength })).sort((a, b) => a.id.localeCompare(b.id));
    const acquired = [...captured.materials].map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength })).sort((a, b) => a.id.localeCompare(b.id));
    if (canonicalJson(declared) !== canonicalJson(acquired)) throw new Error('material-closure');
    return { recipe, recipeSha256: captured.recipeSha256, material: captured };
  }
  const recipe = selection.recipe.inline;
  if (recipe.materials.some(item => !('source' in item))) throw new Error('material-source-missing');
  const captured = await captureInlineMaterials(recipe.materials.filter(item => 'source' in item), roots, { signal, budget });
  return { recipe, recipeSha256: digest(recipe), material: captured };
}

function isManagedContentRoot(root: string): boolean {
  return /^content\/[a-f0-9]{64}$/.test(relative(stateRoot(), root).replaceAll('\\', '/'));
}
function transaction(root: string) {
  if (!isManagedContentRoot(root)) return fileTransaction(root, stateRoot());
  // userState is a Core-assigned content child, never the reserved state root.
  const create = () => new OwnedFileTransaction(root, { label: 'Core managed content', maxFileBytes: 16 * 1024 * 1024,
    contentDirectoryMode: 0o700, stateDirectoryMode: 0o700, statePaths: new Set<string>(),
    assertOwnedPath(path: string) { if (path.split('/').some(part => !validSegment(part))) throw new Error('invalid-path'); },
    assertResolvedSegments(parts: readonly string[]) { if (parts.some(part => !validSegment(part))) throw new Error('invalid-path'); } });
  if (pathPins(root).at(-1)?.identity !== 'absent') return create();
  return {
    inspect(path: string): OwnedFileRead {
      if (path.split('/').some(part => !validSegment(part))) return { state: 'unreadable', detail: 'invalid-path' };
      if (pathPins(root).at(-1)?.identity === 'absent') return { state: 'absent' };
      return create().inspect(path);
    },
    commit(steps: readonly OwnedFileStep[]): void {
      if (pathPins(root).at(-1)?.identity !== 'absent') throw new Error('review-stale');
      protectState(); mkdirSync(root, { recursive: true, mode: 0o700 });
      protectState([`content/${basename(root)}`]);
      create().commit(steps);
    }
  };
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
    unavailableInvocations?: CapturedUnavailableInvocations): Promise<PreparationResult> {
  const runId = randomUUID();
  let result: PreparationResult = { status: 'invalid', runId, diagnostics: [], record: disabled };
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
    if (Number(process.versions.node.split('.')[0]) !== 24 || Number(process.versions.node.split('.')[1]) < 15) throw new Error('node-runtime');
    dataObject(request, ['useCase', 'policy', 'target', 'resolutions', 'organizationSource']);
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
    const captureBudget = createMaterialCaptureBudget();
    for (const selection of policy.selections) {
      if ('reference' in selection.recipe) captureBudget.declareReference(selection.recipe.reference);
      else captureBudget.declareInline(selection.recipe.inline.materials);
    }
    captureBudget.seal();
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
      if ('inline' in selection.recipe) for (const name of Object.keys(values))
        if (!Object.hasOwn(selection.recipe.inline.inputs, name) || !selection.recipe.inline.inputs[name]?.sensitive)
          throw new Error('private-input-unknown');
    }
    const privateValues = Object.values(privateInputs).flatMap(inputs => Object.values(inputs)).map(String);
    privateValues.push(...secrets);
    // Fresh authority read precedes any material capture; failure yields no handle.
    let organization: { read: Awaited<ReturnType<typeof readOrganization>>; document: OrganizationPolicy } | undefined;
    if (enterprise) {
      const read = await readOrganization(clone(request.organizationSource), controls);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes); }
      catch {
        result.diagnostics = [diagnostic('INPUT_INVALID', 'organization-document-encoding', 'The organization document is not valid UTF-8.')];
        return finish();
      }
      const parsed = parseOrganizationPolicy(text);
      if (!parsed.valid || !parsed.document) { result.diagnostics = parsed.diagnostics; return finish(); }
      organization = { read, document: parsed.document };
    }
    const admissions: AdmissionSelection[] = [];
    const steps: PreparedStep[] = [];
    const overlays = new Map<string, { initial: Buffer | null; after: Buffer | null; priorId: string }>();
    const inputs: PreparedReview['effectiveOptions']['inputs'] = {};
    const conflicts: Diagnostic[] = []; const omissions: Diagnostic[] = []; const observations: PreparedReview['observations'] = [];
    const ownership = new Map<string, { value: Ownership; digest: string | null }>();
    const captures: { recheck(): Promise<boolean> }[] = [];
    const selectionOps = new Map<string, string[]>();
    const unavailableSelections = new Set<string>();
    const usedResolutions = new Set<string>();
    const knownProcesses = new Set<string>(); const knownChecks = new Set<string>();
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
            privateInputs: Object.keys(privateInputs[selection.id] ?? {}), path: `/selections/${policy.selections.indexOf(selection)}` });
        }
        continue;
      }
      const { recipe, recipeSha256, material } = captured;
      for (const op of recipe.operations) if (op.kind === 'process.run') knownProcesses.add(`${selection.id}/${op.id}`);
      for (const check of recipe.checks) if (check.kind === 'process.exit') knownChecks.add(`${selection.id}/${check.id}`);
      captures.push(material);
      const recipeValidation = validateRecipe(recipe);
      if (!recipeValidation.valid) { result.diagnostics = recipeValidation.diagnostics; return finish(); }
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
      const recipeIdentity = `sha256:${digest({ schema: 'urn:aihq:core:recipe-identity:1.0.0', recipeSha256,
        materials: recipe.materials.map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength })).sort((a, b) => a.id.localeCompare(b.id)) })}`;
      if (organization) admissions.push({ id: selection.id, organizationSelectionId: selection.organizationSelectionId!, scope: selection.scope,
        recipeIdentity, inputs: recipe.inputs, configuration: selection.configuration,
        privateInputs: Object.keys(privateInputs[selection.id] ?? {}), path: `/selections/${policy.selections.indexOf(selection)}` });
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
        let ownerKey: string | undefined; let preparedProcess: PreparedProcess | undefined;
        let details: ReviewOperation['details'] = {}; let effect: ReviewOperation['effects'] = 'already-satisfied';
        let editConflict: string | undefined;
        let ownerState: 'managed' | 'unowned' = 'unowned'; let resolution: 'replace' | 'adopt' | undefined;
        if (op.kind === 'process.run') {
          const resolved = resolveProcess(op, bound, project, selectionKey, material, privateValues, capturedUnavailable.operations[id]);
          preparedProcess = resolved.process; details = { ...resolved.review, declaredEffects: op.effects.map(item => safeText(item, privateValues)) };
          effect = 'opaque-process';
        } else {
          const target = resolvePath(op.target, op.scope, bound, project, selectionKey);
          root = target.root; path = target.path; pins = pathPins(target.absolute); ownerKey = path;
          const key = `${root}:${process.platform === 'win32' ? path.toLowerCase() : path}`;
          const overlay = overlays.get(key);
          if (overlay) requires.push(overlay.priorId);
          const tx = transaction(root); const live = tx.inspect(path);
          if (live.state === 'unreadable') throw new Error('target-unreadable');
          initialBefore = live.state === 'present' ? Buffer.from(live.bytes) : null;
          before = overlay ? overlay.after : initialBefore;
          mode = op.kind === 'file.write' ? op.mode ?? (live.state === 'present' ? live.mode : 0o600) :
            live.state === 'present' ? live.mode : 0o600;
          const stored = ownership.get(root) ?? readOwnership(root); ownership.set(root, stored);
          const projected: Ownership = { ...stored.value, members: { ...stored.value.members } };
          for (const prior of steps.filter(step => step.root === root && step.custody && (['create-file', 'replace-file', 'remove-file'].includes(step.review.effects) || step.resolution === 'adopt' || step.custodyOnly))) updateCustody(projected, prior);
          const owner = Object.hasOwn(projected.members, ownerKey) ? projected.members[ownerKey] : undefined;
          let managed = owner?.managementId === selection.managementId && (!owner.claims || owner.claims.some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope)) && before !== null && owner.sha256 === sha256(before);
          ownerState = managed ? 'managed' : 'unowned';
          if (op.kind === 'file.write') {
            after = op.material ? material.readMaterial(op.material) : Buffer.from(resolveString(op.content!, bound));
            if (!after) throw new Error('material-missing');
          } else if (op.kind === 'config.entries') {
            const entries = op.entries.map(entry => entry.action === 'set' ? { ...entry, value: resolveSlot(entry.value, bound) } : entry);
            details = { format: op.format, entries: entries.map((entry, index) => {
              if (entry.action === 'remove') return { path: entry.path, action: entry.action };
              const source = op.entries[index]!;
              const sensitive = source.action === 'set' && 'input' in source.value && recipe.inputs[source.value.input]?.sensitive;
              return { path: entry.path, action: entry.action,
                value: sensitive ? '[REDACTED]' : canonicalJson(redactJson(entry.value, privateValues)) };
            }) };
            try { after = renderConfigEntries(op.format, before, entries); }
            catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; after = before; }
          } else if (op.kind === 'text.block') {
            details = { blockId: op.blockId, startMarker: op.startMarker, endMarker: op.endMarker,
              blockAction: op.action, ...(op.content ? { content: redactExact(resolveString(op.content, bound), privateValues) } : {}) };
            try { after = renderTextBlock(before, { blockId: op.blockId, startMarker: op.startMarker,
              endMarker: op.endMarker, action: op.action, ...(op.content ? { content: resolveString(op.content, bound) } : {}) }); }
            catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; after = before; }
          } else after = null;
          if (after && after.byteLength > 16 * 1024 * 1024) throw new Error('file-limit');
          const descriptors: MemberDescriptor[] = op.kind === 'config.entries' ? op.entries.map(entry => ({ path: path!, kind: 'entry', format: op.format, entry: entry.path })) :
            op.kind === 'text.block' ? [{ path, kind: 'block', blockId: op.blockId, startMarker: op.startMarker, endMarker: op.endMarker }] : [{ path, kind: 'file' }];
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
              return [key, bytes === null ? null : { managementId: selection.managementId, recipeIdentity, sha256: sha256(bytes), mode: mode!, descriptor: member,
                claims: [...(prior?.claims ?? []).filter(item => item.managementId !== claim.managementId || item.scope !== claim.scope),
                  { ...claim, sets: [...new Set([...(prior?.claims?.find(item => item.managementId === claim.managementId && item.scope === claim.scope)?.sets ?? []).filter(id => !policy.managedSelections?.some(set => set.id === id && set.scope === claim.scope)), ...claim.sets])] }] }];
            }));
          } catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; }
          if (custody && owner && !owner.descriptor && managed && !descriptors.some(member => memberKey(member) === ownerKey)) custody[ownerKey!] = null;
          const currentDigest = before === null ? null : sha256(before);
          const choice = resolutions.find(item => item.selectionId === selection.id && item.operationId === op.id);
          if (choice) {
            usedResolutions.add(`${selection.id}/${op.id}`);
            if (choice.observedSha256 !== currentDigest) throw new Error('resolution-stale');
            resolution = choice.choice;
          }
          const same = before === null ? after === null : after !== null && before.equals(after) &&
            (op.kind !== 'file.write' || op.mode === undefined || process.platform === 'win32' ||
              live.state === 'present' && live.mode === op.mode);
          if (op.kind === 'file.remove' && Object.values(projected.members).some(owner => owner.descriptor?.path === path && owner.descriptor?.kind !== 'file')) managed = false;
          const changingOwned = managed && before !== null;
          const selectedAbsent = !editConflict && descriptors.every(member => { const bytes = memberBytes(member, before!); const prior = projected.members[memberKey(member)];
            return bytes === null || !!prior && bytes !== null && prior.sha256 === sha256(bytes) && (prior.claims ?? []).some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope); });
          const drift = !editConflict && descriptors.some(member => { const prior = projected.members[memberKey(member)]; const bytes = memberBytes(member, before!);
            return prior && (prior.claims ?? []).some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope) && (bytes === null || prior.sha256 !== sha256(bytes)); });
          const sharedChange = !editConflict && descriptors.some(member => { const prior = projected.members[memberKey(member)]; const oldBytes = memberBytes(member, before!); const newBytes = memberBytes(member, after!);
            return prior?.claims?.some(claim => claim.managementId !== selection.managementId || claim.scope !== selection.scope) && (oldBytes === null ? newBytes !== null : newBytes === null || !oldBytes.equals(newBytes)); });
          let overlap = false;
          try { overlap = descriptors.some(member => Object.values(projected.members).some(owner => owner.descriptor && memberKey(owner.descriptor) !== memberKey(member) &&
            (overlappingMembers(member, owner.descriptor, before) || overlappingMembers(member, owner.descriptor, after)))); }
          catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; }

          if (editConflict || sharedChange || overlap) effect = 'conflict';
          else if (drift && !resolution) effect = 'conflict';
          else if (same) effect = 'already-satisfied';
          else if (before === null && after !== null) effect = 'create-file';
          else if (before !== null && after === null) effect = changingOwned || resolution === 'replace' && descriptors.every(member => { const prior = projected.members[memberKey(member)]; return prior?.claims?.some(claim => claim.managementId === selection.managementId && claim.scope === selection.scope); }) ? 'remove-file' : 'conflict';
          else effect = changingOwned || selectedAbsent || resolution === 'replace' ? 'replace-file' : 'conflict';
          if (!editConflict && custody && !resolution) for (const member of descriptors) {
            const key = memberKey(member); const bytes = memberBytes(member, before!); const prior = projected.members[key];
            const desired = memberBytes(member, after!);
            if (bytes && desired && bytes.equals(desired) && !prior) delete custody[key];
          }
          custodyOnly = same && (managed || resolution === 'replace' && drift) && canonicalJson(custody) !== canonicalJson(Object.fromEntries(Object.keys(custody ?? {}).map(key => [key, projected.members[key] ?? null])));
          if (resolution === 'adopt' && (!same || before === null || managed)) throw new Error('resolution-invalid');
          if (effect === 'conflict') conflicts.push({ ...diagnostic('STATE_CONFLICT', editConflict ?? 'existing-content',
            'Existing, edited or unsupported content requires an exact reviewed resolution or a narrower edit.'), path: safeText(path, privateValues) });
          details = { ...details, target: safeText(target.absolute, privateValues),
            ...(op.kind === 'file.write' && op.material ? { material: op.material,
              materialSha256: sha256(after!), materialBytes: after!.byteLength } : {}),
            ...(op.kind === 'file.write' && op.content ? { content: 'input' in op.content && recipe.inputs[op.content.input]?.sensitive ?
              '[REDACTED]' : redactExact(resolveString(op.content, bound), privateValues) } : {}),
            mode, ...(resolution ? { reason: `explicit-${resolution}` } : {}), ...(editConflict ? { reason: editConflict } : {}) };
          if (!['conflict', 'unavailable'].includes(effect)) overlays.set(key, { initial: overlay?.initial ?? initialBefore!, after: after!, priorId: id });
        }
        const unavailable = prerequisite ?? (preparedProcess && 'missing' in preparedProcess.executable ? 'executable-missing' :
          checks.some(check => check.process && 'missing' in check.process.executable) ? 'check-executable-missing' : undefined);
        if (unavailable) { effect = 'unavailable'; omissions.push(diagnostic('PREREQUISITE_UNAVAILABLE', unavailable, 'This operation cannot run on the selected host.')); }
        const review: ReviewOperation = { id, purpose: safeText(op.purpose, privateValues), kind: op.kind, scope: op.scope,
          effects: effect, ownership: ownerState, requires: [...new Set(requires)], checks: preparedChecks.map(item => item.review), details };
        steps.push({ review, root, path, ownerKey, initialBefore, before, after, mode, pins, managementId: selection.managementId,
          recipeIdentity, checks, process: preparedProcess, unavailable, resolution, custody, custodyOnly });
      }
      selectionOps.set(selection.id, currentIds);
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
    const candidates = new Set<string>(); const retained = new Set<string>(); const dependencies = new Map<string, string[]>();
    const claimId = (claim: Pick<Claim, 'scope' | 'managementId'>, target = project!) => claimIdentity(claim.scope, claim.managementId, target);
    const effectRoot = (root: string) => root === project || root === userHomeRoot() || isManagedContentRoot(root);
    for (const [root, stored] of ownership) for (const claim of [...Object.values(stored.value.selections ?? {}), ...Object.values(stored.value.members).flatMap(owner => owner.claims ?? [])]) {
      const id = claimId(claim, root); dependencies.set(id, [...new Set([...(dependencies.get(id) ?? []), ...claim.requires])]);
      const sets = claim.sets.map(setId => policy.managedSelections?.find(set => set.id === setId && set.scope === claim.scope));
      if (effectRoot(root) && (policy.removals?.some(removal => claimId(removal) === id) || sets.length && sets.every(set => !!set && !set.members.includes(claim.managementId)))) candidates.add(id);
      else retained.add(id);
    }
    const priorDependencies = new Map(dependencies);
    for (const selection of policy.selections) {
      const id = claimId(selection); retained.add(id); candidates.delete(id);
      dependencies.set(id, selection.requires.map(required => { const dependency = policy.selections.find(item => item.id === required)!; return claimId(dependency); }));
    }
    if (foreignUnverifiable) for (const id of candidates) if (id.startsWith('user:')) retained.add(id);
    const queue = [...retained];
    for (let index = 0; index < queue.length; index++) for (const dependency of dependencies.get(queue[index]!) ?? [])
      if (!retained.has(dependency)) { retained.add(dependency); queue.push(dependency); }
    for (const selection of policy.selections.filter(selection => !unavailableSelections.has(selection.id))) {
      const root = selection.scope === 'project' ? project : userHomeRoot(); const key = claimId(selection);
      const old = ownership.get(root)!.value.selections?.[key];
      const claim: Claim = { managementId: selection.managementId, scope: selection.scope,
        sets: [...new Set([...(old?.sets ?? []).filter(id => !policy.managedSelections?.some(set => set.id === id && set.scope === selection.scope)),
          ...(policy.managedSelections ?? []).filter(set => set.scope === selection.scope && set.members.includes(selection.managementId)).map(set => set.id)])],
        requires: selection.requires.map(required => claimId(policy.selections.find(item => item.id === required)!)) };
      if ((old || claim.sets.length || claim.requires.length) && (!old || canonicalJson(old) !== canonicalJson(claim))) {
        const updates = selectionUpdates.get(root) ?? Object.create(null); updates[key] = { claim, requires: selectionOps.get(selection.id) ?? [] }; selectionUpdates.set(root, updates);
      }
    }
    for (const [root, stored] of ownership) if (effectRoot(root)) for (const [key, claim] of Object.entries(stored.value.selections ?? {})) {
      if (!candidates.has(key) || retained.has(key)) continue;
      const updates = selectionUpdates.get(root) ?? Object.create(null); updates[key] = { claim: null, requires: [] }; selectionUpdates.set(root, updates);
      observations.push({ id: `lifecycle/root-${observations.length}`, reason: `remove-management-root:${claim.managementId}` });
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
    const members = [...ownership].flatMap(([root, stored]) => Object.entries(stored.value.members).map(([key, owner]) => ({ root, key, owner })));
    members.sort((a, b) => Math.min(...(a.owner.claims ?? []).map(claim => rank.get(claimId(claim, a.root)) ?? 0)) - Math.min(...(b.owner.claims ?? []).map(claim => rank.get(claimId(claim, b.root)) ?? 0)));
    const removedIdentities = new Map<PreparedStep, string[]>();
    let removalIndex = 0;
    for (const { root, key, owner } of members) {
      if (!effectRoot(root)) continue;
      const claims = owner.claims ?? [];
      const obsolete = (claim: Claim) => {
        const selection = policy.selections.find(selection => claimId(selection) === claimId(claim, root));
        return !!selection && !unavailableSelections.has(selection.id) && !steps.some(step => step.managementId === claim.managementId && step.review.scope === claim.scope && step.root === root && Object.hasOwn(step.custody ?? {}, key));
      };
      const removed = claims.filter(claim => candidates.has(claimId(claim, root)) && !retained.has(claimId(claim, root)) || obsolete(claim));
      if (!removed.length) continue;
      const remaining = claims.filter(claim => !removed.includes(claim));
      const descriptor = owner.descriptor ?? { path: key, kind: 'file' as const };
      const live = transaction(root).inspect(descriptor.path);
      if (live.state === 'unreadable') throw new Error('target-unreadable');
      const destination = `${root}:${process.platform === 'win32' ? descriptor.path.toLowerCase() : descriptor.path}`;
      const overlay = overlays.get(destination);
      const initialBefore = live.state === 'present' ? Buffer.from(live.bytes) : null;
      const before = overlay ? overlay.after : initialBefore;
      let after: Buffer | null = before; let effect: ReviewOperation['effects'] = 'already-satisfied';
      let matching = false;
      try { const bytes = memberBytes(descriptor, before); matching = bytes === null || sha256(bytes) === owner.sha256;
        if (matching && Object.values(ownership.get(root)!.value.members).some(other => other.descriptor && memberKey(other.descriptor) !== key && overlappingMembers(descriptor, other.descriptor, before))) matching = false;
        if (!remaining.length && matching) after = subtractMember(descriptor, before);
      } catch (error) { if (!(error instanceof RecipeEditError)) throw error; }
      if (!matching) { effect = 'conflict'; conflicts.push(diagnostic('STATE_CONFLICT', 'managed-content-changed', 'Changed or unverifiable managed content is preserved.')); }
      else if (before !== null && after === null) effect = 'remove-file';
      else if (before !== null && after !== null && !before.equals(after)) effect = 'replace-file';
      const removedIds = removed.map(claim => claimId(claim, root));
      const retainingAncestors = new Set(removedIds.flatMap(id => [...ancestors(id)]));
      const droppedDependencyGuards = policy.selections.flatMap(selection => retainingAncestors.has(claimId(selection)) ? selectionOps.get(selection.id) ?? [] : []);
      let id: string; do { id = `lifecycle/remove-${removalIndex++}`; } while (steps.some(step => step.review.id === id));
      steps.push({ review: { id, purpose: 'Remove selected managed member', kind: descriptor.kind === 'entry' ? 'config.entries' : descriptor.kind === 'block' ? 'text.block' : 'file.remove',
        scope: removed[0]!.scope, effects: effect, ownership: 'managed', requires: [...new Set([...(overlay ? [overlay.priorId] : []), ...droppedDependencyGuards, ...removed.flatMap(claim => { const selection = policy.selections.find(selection => claimId(selection) === claimId(claim, root)); return selection ? selectionOps.get(selection.id) ?? [] : []; })])], checks: [], details: { target: join(root, descriptor.path), reason: 'explicit-managed-removal',
          ...(descriptor.kind === 'entry' ? { format: descriptor.format, entries: [{ path: descriptor.entry, action: 'remove' as const }] } : descriptor.kind === 'block' ? { blockId: descriptor.blockId, startMarker: descriptor.startMarker, endMarker: descriptor.endMarker, blockAction: 'remove' as const } : {}) } },
        root, path: descriptor.path, ownerKey: key, initialBefore, before, after, pins: pathPins(join(root, descriptor.path)), mode: live.state === 'present' ? live.mode : owner.mode,
        managementId: owner.managementId, recipeIdentity: owner.recipeIdentity, checks: [], lifecycle: true, custody: { [key]: remaining.length ? { ...owner, claims: remaining } : null },
        custodyOnly: matching && effect === 'already-satisfied' });
      removedIdentities.set(steps.at(-1)!, removedIds);
      if (matching) overlays.set(destination, { initial: overlay?.initial ?? initialBefore, after, priorId: id });
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
      const findings = admitOrganizationSelections(organization.document, admissions, lifecycle);
      if (findings.length) {
        result.status = findings.some(finding => finding.code === 'INPUT_INVALID') ? 'invalid' : 'blocked';
        result.diagnostics = findings;
        return finish();
      }
    }
    if (Object.keys(capturedUnavailable.operations).some(id => !knownProcesses.has(id)) ||
        Object.keys(capturedUnavailable.checks).some(id => !knownChecks.has(id))) throw new Error('captured-prerequisite-invalid');
    if (steps.length > 8192) throw new Error('operation-limit');
    const bindings = [...pathPins(project), ...pathPins(homedir())];
    const evidence = await readPolicyEvidence(policy.evidence, controls.evidence, controls.signal);
    const base = { schema: 'urn:aihq:core:prepared-work:1.0.0' as const, useCase: 'policy' as const, mode: organization ? 'enterprise' as const : 'vibe' as const,
      target: { scope: 'project' as const, project }, inputs: { policySha256: digest(policy), package: contractSupport.package,
        ...(organization ? { organization: clone({ source: organization.read.source, resolvedCommit: organization.read.resolvedCommit,
          blobId: organization.read.blobId, contentDigest: organization.read.contentDigest, policyId: organization.document.id,
          helper: organization.read.helper }) as unknown as OrganizationBinding } : {}) },
      operations: steps.map(step => step.review), observations, conflicts, omissions, evidence,
      effectiveOptions: { logging: loggingOption(controls), inputs } };
    const review: PreparedReview = deepFreezeStrictJsonV1({ ...base,
      reviewDigest: digest({ review: base, bindings, steps: steps.map(step => ({ id: step.review.id, before: step.before ? sha256(step.before) : null,
        after: step.after ? sha256(step.after) : null })), privateDigest: digest(privateInputs), nonce: randomBytes(32).toString('hex') }) });
    const available = steps.length === 0 || steps.some(step => step.review.effects !== 'conflict' && step.review.effects !== 'unavailable');
    result = { status: conflicts.length || omissions.length ? available ? 'partial' : 'blocked' : 'ready', runId, review,
      diagnostics: [...conflicts, ...omissions], record: disabled, evidence };
    if (available) {
      const prepared = Object.freeze({}) as PreparedHandle;
      handles.set(prepared, { request, requestDigest: digest(clone(request)), privateInputs: controls.privateInputs,
        privateDigest: digest(privateInputs), review, steps, project, home: homedir(), ownership, selectionUpdates, inventory: inventory ? new Map(inventory.entries) : undefined, bindings, captures,
        ...(policy.evidence === undefined ? {} : { evidence: clone(policy.evidence) }),
        ...(organization ? { organization: clone({ source: organization.read.source, resolvedCommit: organization.read.resolvedCommit,
          blobId: organization.read.blobId, contentDigest: organization.read.contentDigest }) } : {}) });
      result.prepared = prepared;
    }
  } catch (error) {
    if (error instanceof AuthorityFailure) { result.status = error.status; result.diagnostics = [error.detail]; return finish(); }
    const reason = error instanceof MaterialCaptureError ? error.reason : error instanceof Error ? error.message : 'preparation-failed';
    result.status = reason === 'cancelled' ? 'cancelled' : 'invalid';
    const unavailable = ['archive-download-failed', 'archive-decompression-failed', 'archive-incomplete',
      'local-file-unavailable', 'local-root-unavailable', 'acquisition-deadline'].includes(reason);
    result.diagnostics = [diagnostic(reason === 'cancelled' ? 'CANCELLED' : unavailable ? 'PREREQUISITE_UNAVAILABLE' : 'INPUT_INVALID',
      /^[a-z-]{1,64}$/.test(reason) ? reason : 'preparation-failed', 'Preparation could not admit the requested work.')];
  }
  return finish();
  function finish(): PreparationResult {
    const record = { ...result, prepared: undefined,
      review: result.review ? { ...result.review, operations: result.review.operations.map(op => ({ ...op,
        checks: op.checks.map(check => ({ ...check, details: historyDetails(check.details) })),
        details: historyDetails(op.details) })) } : undefined };
    result.record = writeHistory(runId, historySafe(record, project, secrets), logging);
    if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason,
      'Routine history could not be saved; the returned outcomes remain available.'));
    return result;
  }
}

function historyDetails(details: ReviewOperation['details']): ReviewOperation['details'] {
  return { ...details, content: details.content === undefined ? undefined : '[OMITTED]',
    stdin: details.stdin === undefined ? undefined : '[OMITTED]',
    entries: details.entries?.map(entry => ({ ...entry, ...(entry.value === undefined ? {} : { value: '[OMITTED]' }) })),
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
  try {
    validateControls(controls); result.effectiveOptions.logging = loggingOption(controls);
    await yieldToHost();
    state = prepared && typeof prepared === 'object' ? handles.get(prepared) : undefined;
    if (!state) throw new Error('handle-unavailable');
    result.inputs = state.review.inputs;
    result.diagnostics.push(...state.review.omissions);
    result.operations = state.steps.map(step => ({ id: step.review.id, application: 'not-attempted',
      verification: { status: 'unverified', reason: 'no-supplied-check' } }));
    result.checks = state.steps.flatMap(step => step.checks.map(check => ({ id: check.id, operationId: step.review.id,
      status: 'skipped' as const, reason: 'not-attempted' })));
    dataObject(authorization, ['reviewDigest', 'origin', 'approved', 'allowPartial']);
    if (authorization.approved !== true || !['interactive', 'automation'].includes(authorization.origin) ||
        authorization.allowPartial !== undefined && typeof authorization.allowPartial !== 'boolean') throw new Error('approval-required');
    if (authorization.reviewDigest !== state.review.reviewDigest) throw new Error('review-stale');
    const allowPartial = authorization.allowPartial ?? false;
    result.authorization = { origin: authorization.origin,
      allowPartial: { value: allowPartial, origin: authorization.allowPartial === undefined ? 'default' : 'explicit' } };
    if (controls.signal?.aborted) throw new Error('cancelled');
    if (state.organization) {
      // Fresh online authority for this Apply call; Prepare's credential and result are never reused.
      const read = await readOrganization(state.organization.source, controls);
      if (canonicalJson(read.source) !== canonicalJson(state.organization.source) || read.resolvedCommit !== state.organization.resolvedCommit ||
          read.blobId !== state.organization.blobId || read.contentDigest !== state.organization.contentDigest) throw new Error('review-stale');
    }
    const assertInputs = () => {
      try {
        if (!state || homedir() !== state.home || digest(clone(state.request)) !== state.requestDigest ||
            digest(clone(state.privateInputs ?? {})) !== state.privateDigest || !pinsMatch(state.bindings) ||
            state.inventory && canonicalJson([...state.inventory].sort()) !== canonicalJson(ownershipInventory().entries.sort())) throw new Error('changed');
      } catch { throw new Error('review-stale'); }
    };
    assertInputs();
    for (const capture of state.captures) if (!await capture.recheck()) throw new Error('review-stale');
    const assertStep = (step: PreparedStep, initial = false) => {
      if (!step.path || !step.root) return;
      const live = transaction(step.root).inspect(step.path);
      let pinsOkay = pinsMatch(step.pins ?? []);
      if (!pinsOkay && isManagedContentRoot(step.root) &&
          step.before === null && live.state === 'absent' &&
          step.pins?.some(pin => pin.identity === 'absent' &&
            pathPins(stateRoot()).some(parent => parent.path === pin.path))) {
        protectState(); step.pins = pathPins(join(step.root, ...step.path.split('/'))); pinsOkay = true;
      }
      if (!pinsOkay || live.state === 'unreadable' ||
          (live.state === 'absent' ? null : sha256(live.bytes)) !== ((initial ? step.initialBefore : step.before) ? sha256((initial ? step.initialBefore : step.before)!) : null))
        throw new Error('review-stale');
    };
    for (const step of state.steps) assertStep(step, true);
    for (const [root, ownership] of state.ownership)
      if (readOwnership(root).digest !== ownership.digest) throw new Error('review-stale');
    await preEffectCheck?.();
    if (preEffectCheck) {
      assertInputs();
      for (const step of state.steps) assertStep(step, true);
      for (const [root, ownership] of state.ownership)
        if (readOwnership(root).digest !== ownership.digest) throw new Error('review-stale');
    }
    const unresolved = state.review.omissions.length > 0 || state.steps.some(step =>
      step.review.effects === 'conflict' || step.review.effects === 'unavailable');
    if (unresolved && !allowPartial) throw new Error('partial-approval-required');
    const mutatingRoots = [...new Set([...state.selectionUpdates.keys(), ...state.steps.filter(step => step.path &&
      (['create-file', 'replace-file', 'remove-file'].includes(step.review.effects) || step.resolution === 'adopt' || step.custodyOnly)).map(step => step.root!)])].sort();
    if (mutatingRoots.length) protectState();
    for (const root of mutatingRoots) {
      unlocks.push(lockTarget(root));
      for (const step of state.steps.filter(item => item.root === root)) assertStep(step, true);
      if (readOwnership(root).digest !== state.ownership.get(root)?.digest) throw new Error('review-stale');
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
          try { validateOwnership({ schema: current.schema, target: root, members: { [key]: owner } }, root); }
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
      releases.push(stageOwnership(root, runId, next));
    }
    handles.delete(prepared);
    if (mutatingRoots.length) {
      try { result.recovery = stageRecovery(runId, state.steps, state.project); }
      catch { throw new Error('recovery-unavailable'); }
    }
    const outcomes = new Map<string, boolean>(); let stop = false;
    const metadataState = state;
    const publishMetadata = () => {
      // Byte custody follows each successful mutation. Selection metadata advances
      // only when all its reviewed operations and required checks succeeded.
      for (const root of mutatingRoots) {
        const tracked = metadataState.ownership.get(root)!;
        const next: Ownership = { ...tracked.value, members: { ...tracked.value.members } };
        let changed = false;
        for (const step of metadataState.steps.filter(step => step.root === root && outcomes.get(step.review.id) === true)) {
          const selectionSteps = metadataState.steps.filter(other => other.managementId === step.managementId && other.review.scope === step.review.scope && !other.lifecycle);
          if (!selectionSteps.every(other => outcomes.get(other.review.id) === true)) continue;
          for (const [key, desired] of Object.entries(step.custody ?? {})) {
            const current = next.members[key]; if (!desired || !current) continue;
            const claims = (current.claims ?? []).map(claim => desired.claims?.find(item => item.managementId === claim.managementId && item.scope === claim.scope) ?? claim);
            const owner = { ...current, claims };
            if (canonicalJson(owner) !== canonicalJson(current)) { next.members[key] = owner; changed = true; }
          }
        }
        for (const [key, update] of Object.entries(metadataState.selectionUpdates.get(root) ?? {})) {
          if (!update.requires.every(id => outcomes.get(id) === true)) continue;
          next.selections = { ...next.selections };
          if (update.claim) next.selections[key] = update.claim; else delete next.selections[key];
          delete metadataState.selectionUpdates.get(root)![key];
          changed = true;
        }
        if (changed) {
          if (readOwnership(root).digest !== tracked.digest) throw new Error('review-stale');
          protectState([ownershipPath(root)]);
          const receipt = Buffer.from(JSON.stringify(next)); stateFiles().writeAtomic(ownershipPath(root), receipt, 0o600);
          metadataState.ownership.set(root, { value: next, digest: sha256(receipt) });
          metadataState.inventory?.set(basename(ownershipPath(root)), sha256(receipt));
        }
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
        if (readOwnership(step.root!).digest !== state.ownership.get(step.root!)?.digest) throw new Error('review-stale');
      }
      if (step.review.effects === 'already-satisfied') operation.application = 'already-satisfied';
      else if (step.process) {
        await preEffectCheck?.();
        if (controls.signal?.aborted) throw new Error('cancelled');
        assertInputs();
        started = true;
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
        if (readOwnership(step.root).digest !== state.ownership.get(step.root)?.digest) throw new Error('review-stale');
        started = true;
        try {
          const tx = transaction(step.root);
          tx.commit([{ action: step.after === null ? 'remove' : 'write', path: step.path, mode: step.mode ?? 0o600,
            ...(step.after === null ? {} : { contents: step.after }),
            ...(step.before ? { prior: step.before, priorMode: step.mode } : {}),
            expect: step.before === null ? { absent: true } : { sha256: sha256(step.before!) } }]);
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
          operation.application = 'failed'; operation.reason = 'file-effect'; operation.effectsUncertain = true;
        }
      }
      if (operation.application === 'applied' || operation.application === 'already-satisfied') {
        if (step.root && step.path && (operation.application === 'applied' || step.resolution === 'adopt' || step.custodyOnly)) {
          try {
            const tracked = state.ownership.get(step.root)!;
            const next: Ownership = { ...tracked.value, members: { ...tracked.value.members } };
            updateCustody(next, step, true);
            protectState([ownershipPath(step.root)]);
            const receipt = Buffer.from(JSON.stringify(next)); stateFiles().writeAtomic(ownershipPath(step.root), receipt, 0o600);
            state.ownership.set(step.root, { value: next, digest: sha256(receipt) });
            state.inventory?.set(basename(ownershipPath(step.root)), sha256(receipt));
          } catch { operation.effectsUncertain = true; operation.reason = 'custody-write'; throw new Error('state-unwritable'); }
        }
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
    result.completion = state.review.omissions.length === 0 && result.operations.every(op => ['applied', 'already-satisfied'].includes(op.application) &&
      ['unverified', 'passed'].includes(op.verification.status)) ? 'complete' : 'incomplete';
  } catch (error) {
    const authority = error instanceof AuthorityFailure ? error : undefined;
    const reason = error instanceof Error ? error.message : 'execution-failed';
    const safeReason = /^[a-z-]{1,64}$/.test(reason) ? reason : 'execution-failed';
    result.completion = reason === 'cancelled' ? 'cancelled' : started ? 'incomplete' : 'rejected';
    if (reason === 'cancelled') for (const check of result.checks)
      if (check.status === 'skipped' && check.reason === 'not-attempted') check.reason = 'cancelled';
    const code = reason === 'cancelled' ? 'CANCELLED' : reason === 'review-stale' || reason === 'handle-unavailable' ? 'REVIEW_STALE' :
      reason === 'certificate-invalid' ? 'INPUT_INVALID' :
      reason === 'approval-required' || reason === 'partial-approval-required' || reason === 'request-object' || reason === 'request-field' ? 'APPROVAL_REQUIRED' :
      reason === 'state-unwritable' || reason === 'state-protection' || reason === 'recovery-unavailable' ? 'PREREQUISITE_UNAVAILABLE' :
      started ? 'EXECUTION_FAILED' : 'PREREQUISITE_UNAVAILABLE';
    result.diagnostics.push(authority ? authority.detail : diagnostic(code, safeReason, 'The run could not complete the requested work.'));
    result.followUp.push('Inspect the reported outcomes, prepare again and approve the new review before further changes.');
  } finally {
    for (const release of releases.reverse()) try { release(); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'work-cleanup', 'Inspect remaining temporary work before deliberate cleanup.')); }
    for (const unlock of unlocks.reverse()) try { unlock(); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'lock-release', 'Inspect the remaining state lock before another run.')); }
  }
  if (state) result.evidence = await readPolicyEvidence(state.evidence, controls.evidence, controls.signal);
  result.record = writeHistory(runId, historySafe(result, state?.project, bearerSecrets(controls)), result.effectiveOptions.logging.value);
  if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason,
    'Routine history could not be saved; the returned outcomes remain available.'));
  return result;
}

async function executeProcess(invocation: PreparedProcess, runId: string, signal?: AbortSignal) {
  if (!pinsMatch(invocation.cwdPins)) return { status: 'unavailable' as const, reason: 'cwd-changed', effectsUncertain: false, terminationUnconfirmed: false };
  if ('missing' in invocation.executable) return { status: 'unavailable' as const, reason: 'executable-missing', effectsUncertain: false, terminationUnconfirmed: false };
  let executable: ResolvedExecutable;
  let work: { path: string; dir: string; pins: PathPin[] } | undefined;
  if ('material' in invocation.executable) {
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
}
