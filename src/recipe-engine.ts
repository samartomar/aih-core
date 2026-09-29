import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { isProxy } from 'node:util/types';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { contractSupport, validatePolicy, validateRecipe } from './contracts.js';
import { canonicalJson } from './internal/canonical.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, deepFreezeStrictJsonV1, parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { dependencyOrder, inputAccepts } from './internal/policy-validation.js';
import { fileTransaction, pathPins, pinsMatch, projectRoot, sha256, validSegment, type PathPin } from './internal/host-files.js';
import { lockTarget, ownershipPath, protectState, readOwnership, stageOwnership, stateFiles, stateRoot, writeHistory, type Ownership } from './internal/state.js';
import { captureRecipeReference, captureInlineMaterials, type CapturedRecipeReference } from './internal/material.js';
import { renderConfigEntries, renderTextBlock } from './internal/recipe-editors.js';
import { RecipeEditError } from './internal/recipe-editors.js';
import { resolveExecutable, runApprovedProcess, type ResolvedExecutable } from './internal/approved-process.js';
import { OwnedFileTransaction, type OwnedFileRead, type OwnedFileStep } from './internal/owned-file-transaction.js';
import { readRegularFile } from './internal/fsxn.js';
import type { Diagnostic, ExecutionPolicy, Json, Operation, ProcessInvocation, Recipe, RecipeCheck, Slot, TargetPath } from './types.js';
import type { Authorization, CheckResult, Effective, HostControls, PolicyRequest, PreparationResult, PreparedHandle, PreparedReview, ReviewOperation, RunResult } from './host-types.js';

interface PreparedProcess {
  executable: ResolvedExecutable | { material: string; bytes: Buffer; filename: string } | { missing: string };
  args: string[]; cwd: string; cwdPins: PathPin[]; env: Record<string, string>; stdin?: string;
  timeoutMs: number; maxOutputBytes: number; acceptedExitCodes: number[];
}
interface PreparedCheck { id: string; kind: 'file.sha256' | 'process.exit'; path?: string; sha256?: string; process?: PreparedProcess }
interface PreparedStep {
  review: ReviewOperation; root?: string; path?: string; ownerKey?: string;
  before?: Buffer | null; after?: Buffer | null; mode?: number; pins?: PathPin[];
  managementId: string; recipeIdentity: string; checks: PreparedCheck[];
  process?: PreparedProcess; unavailable?: string; resolution?: 'replace' | 'adopt';
}
interface PreparedState {
  request: PolicyRequest; requestDigest: string; privateInputs: HostControls['privateInputs']; privateDigest: string;
  review: PreparedReview; steps: PreparedStep[]; project: string; home: string;
  ownership: Map<string, { value: Ownership; digest: string | null }>;
  bindings: PathPin[]; captures: { recheck(): Promise<boolean> }[];
}
const handles = new WeakMap<PreparedHandle, PreparedState>();
const disabled = { status: 'disabled', reason: 'logging-off' } as const;
const clone = <T>(value: T): T => cloneJsonValueStructureV1(value, 'request', 32);
const digest = (value: unknown): string => sha256(canonicalJson(value));
const diagnostic = (code: string, reason: string, message: string): Diagnostic => ({ code, reason, message });
const loggingOption = (controls: HostControls): Effective<'on' | 'off'> => ({ value: controls.logging ?? 'on', origin: controls.logging === undefined ? 'default' : 'explicit' });

function dataObject(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error('request-object');
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !d?.enumerable || !('value' in d)) throw new Error('request-field');
  }
}
function validateControls(controls: HostControls): void {
  dataObject(controls, ['signal', 'logging', 'privateInputs', 'materialRoots']);
  if (controls.logging !== undefined && !['on', 'off'].includes(controls.logging)) throw new Error('logging');
  if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) throw new Error('signal');
  if (controls.privateInputs !== undefined) assertStrictJsonValueV1(clone(controls.privateInputs), 'private inputs');
  if (controls.materialRoots !== undefined) {
    dataObject(controls.materialRoots, Object.keys(controls.materialRoots));
    for (const [id, root] of Object.entries(controls.materialRoots))
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || typeof root !== 'string' || !isAbsolute(root)) throw new Error('material-root');
  }
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
function historySafe(result: unknown, project?: string): unknown {
  let text = JSON.stringify(result);
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
  const root = target.root === 'project' ? project : target.root === 'userHome' ? homedir() : join(stateRoot(), 'content', selectionKey);
  return { root, path: segments.join('/'), absolute: join(root, ...segments) };
}
function resolveProcess(invocation: ProcessInvocation, bound: Record<string, Json>, project: string, selectionKey: string,
    material: { readMaterial(id: string): Buffer | undefined }, privateValues: string[]): { process: PreparedProcess; review: ReviewOperation['details'] } {
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
  return { process: { executable: resolvedExecutable, args, cwd: cwd.absolute, cwdPins: pathPins(cwd.absolute), env, stdin,
    timeoutMs, maxOutputBytes, acceptedExitCodes: invocation.acceptedExitCodes },
    review: { executable: executable?.path ?? (materialId ? `material:${materialId}` : `unavailable:${'name' in invocation.executable ? invocation.executable.name : ''}`),
      args: args.map(arg => JSON.stringify(redactExact(arg, privateValues)).slice(0, 4096)), cwd: safeText(cwd.absolute, privateValues),
      env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, JSON.stringify(redactExact(value, privateValues)).slice(0, 4096)])),
      stdinProtected: stdin !== undefined,
      timeoutMs: { value: timeoutMs, origin: invocation.timeoutMs === undefined ? 'default' : 'explicit' },
      maxOutputBytes: { value: maxOutputBytes, origin: invocation.maxOutputBytes === undefined ? 'default' : 'explicit' } } };
}
async function captureSelection(selection: ExecutionPolicy['selections'][number], roots: Record<string, string>, signal?: AbortSignal): Promise<{ recipe: Recipe; recipeSha256: string; material: { readMaterial(id: string): Buffer | undefined; recheck(): Promise<boolean> } }> {
  if ('reference' in selection.recipe) {
    const captured = await captureRecipeReference(selection.recipe.reference, roots, { signal });
    const recipe = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(captured.readRecipe()), 'recipe') as unknown as Recipe;
    if (!validateRecipe(recipe).valid) throw new Error('recipe-invalid');
    const declared = [...recipe.materials].map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength })).sort((a, b) => a.id.localeCompare(b.id));
    const acquired = [...captured.materials].map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength })).sort((a, b) => a.id.localeCompare(b.id));
    if (canonicalJson(declared) !== canonicalJson(acquired)) throw new Error('material-closure');
    return { recipe, recipeSha256: captured.recipeSha256, material: captured };
  }
  const recipe = selection.recipe.inline;
  if (recipe.materials.some(item => !('source' in item))) throw new Error('material-source-missing');
  const captured = await captureInlineMaterials(recipe.materials.filter(item => 'source' in item), roots, { signal });
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

export async function prepare(request: PolicyRequest, controls: HostControls = {}): Promise<PreparationResult> {
  const runId = randomUUID();
  let result: PreparationResult = { status: 'invalid', runId, diagnostics: [], record: disabled };
  let logging: 'on' | 'off' = 'off'; let project: string | undefined;
  try {
    validateControls(controls); logging = loggingOption(controls).value;
    if (controls.signal?.aborted) throw new Error('cancelled');
    if (Number(process.versions.node.split('.')[0]) !== 24 || Number(process.versions.node.split('.')[1]) < 6) throw new Error('node-runtime');
    dataObject(request, ['useCase', 'policy', 'target', 'resolutions']);
    dataObject(request.target, ['project']);
    if (request.useCase !== 'policy') throw new Error('use-case-unsupported');
    const validation = validatePolicy(request.policy);
    if (!validation.valid) { result.diagnostics = validation.diagnostics; return finish(); }
    const policy = clone(request.policy);
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
    const steps: PreparedStep[] = []; const destinations = new Set<string>();
    const inputs: PreparedReview['effectiveOptions']['inputs'] = {};
    const conflicts: Diagnostic[] = []; const omissions: Diagnostic[] = []; const observations: PreparedReview['observations'] = [];
    const ownership = new Map<string, { value: Ownership; digest: string | null }>();
    const captures: { recheck(): Promise<boolean> }[] = [];
    const selectionOps = new Map<string, string[]>();
    const usedResolutions = new Set<string>();
    for (const selection of dependencyOrder(policy.selections)) {
      if (controls.signal?.aborted) throw new Error('cancelled');
      const { recipe, recipeSha256, material } = await captureSelection(selection, controls.materialRoots ?? {}, controls.signal);
      captures.push(material);
      const recipeValidation = validateRecipe(recipe);
      if (!recipeValidation.valid) { result.diagnostics = recipeValidation.diagnostics; return finish(); }
      if (!recipe.targets.includes(selection.scope) || recipe.operations.some(op => op.scope !== selection.scope)) throw new Error('scope-mismatch');
      for (const name of Object.keys(privateInputs[selection.id] ?? {}))
        if (!Object.hasOwn(recipe.inputs, name) || !recipe.inputs[name]?.sensitive) throw new Error('private-input-unknown');
      const selectionKey = sha256(`${project}\0${selection.scope}\0${selection.managementId}`);
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
      const priorSelections = selection.requires.flatMap(id => selectionOps.get(id) ?? []);
      const currentIds: string[] = [];
      const checkMap = new Map(recipe.checks.map(check => [check.id, check]));
      let prerequisite: string | undefined;
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
        const checks = selectedChecks.map(check => prepareCheck(check, bound, project!, selectionKey, material, privateValues, selection.id));
        let root: string | undefined; let path: string | undefined; let before: Buffer | null | undefined;
        let after: Buffer | null | undefined; let pins: PathPin[] | undefined; let mode: number | undefined;
        let ownerKey: string | undefined; let preparedProcess: PreparedProcess | undefined;
        let details: ReviewOperation['details'] = {}; let effect: ReviewOperation['effects'] = 'already-satisfied';
        let editConflict: string | undefined;
        let ownerState: 'managed' | 'unowned' = 'unowned'; let resolution: 'replace' | 'adopt' | undefined;
        if (op.kind === 'process.run') {
          const resolved = resolveProcess(op, bound, project, selectionKey, material, privateValues);
          preparedProcess = resolved.process; details = { ...resolved.review, declaredEffects: op.effects.map(item => safeText(item, privateValues)) };
          effect = 'opaque-process';
        } else {
          const target = resolvePath(op.target, op.scope, bound, project, selectionKey);
          root = target.root; path = target.path; pins = pathPins(target.absolute); ownerKey = path;
          const key = `${root}:${process.platform === 'win32' ? path.toLowerCase() : path}`;
          if (destinations.has(key)) throw new Error('duplicate-destination'); destinations.add(key);
          const tx = transaction(root); const live = tx.inspect(path);
          if (live.state === 'unreadable') throw new Error('target-unreadable');
          before = live.state === 'present' ? Buffer.from(live.bytes) : null;
          mode = op.kind === 'file.write' ? op.mode ?? (live.state === 'present' ? live.mode : 0o600) :
            live.state === 'present' ? live.mode : 0o600;
          const stored = ownership.get(root) ?? readOwnership(root); ownership.set(root, stored);
          const owner = Object.hasOwn(stored.value.members, ownerKey) ? stored.value.members[ownerKey] : undefined;
          const managed = owner?.managementId === selection.managementId && before !== null && owner.sha256 === sha256(before);
          ownerState = managed ? 'managed' : 'unowned';
          if (op.kind === 'file.write') {
            after = op.material ? material.readMaterial(op.material) : Buffer.from(resolveString(op.content!, bound));
            if (!after) throw new Error('material-missing');
          } else if (op.kind === 'config.entries') {
            const entries = op.entries.map(entry => entry.action === 'set' ? { ...entry, value: resolveSlot(entry.value, bound) } : entry);
            try { after = renderConfigEntries(op.format, before, entries); }
            catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; after = before; }
          } else if (op.kind === 'text.block') {
            try { after = renderTextBlock(before, { blockId: op.blockId, startMarker: op.startMarker,
              endMarker: op.endMarker, action: op.action, ...(op.content ? { content: resolveString(op.content, bound) } : {}) }); }
            catch (error) { if (!(error instanceof RecipeEditError)) throw error; editConflict = error.reason; after = before; }
          } else after = null;
          if (after && after.byteLength > 16 * 1024 * 1024) throw new Error('file-limit');
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
          const changingOwned = managed && before !== null;
          if (editConflict) effect = 'conflict';
          else if (same) effect = 'already-satisfied';
          else if (before === null && after !== null) effect = 'create-file';
          else if (before !== null && after === null) effect = changingOwned ? 'remove-file' : 'conflict';
          else effect = changingOwned || resolution === 'replace' ? 'replace-file' : 'conflict';
          if (resolution === 'adopt' && (!same || before === null || managed)) throw new Error('resolution-invalid');
          if (effect === 'conflict') conflicts.push({ ...diagnostic('STATE_CONFLICT', editConflict ?? 'existing-content',
            'Existing, edited or unsupported content requires an exact reviewed resolution or a narrower edit.'), path: safeText(path, privateValues) });
          details = { target: safeText(target.absolute, privateValues),
            ...(op.kind === 'file.write' && op.material ? { material: op.material } : {}),
            ...(op.kind === 'file.write' && op.content ? { content: 'input' in op.content && recipe.inputs[op.content.input]?.sensitive ?
              '[REDACTED]' : redactExact(resolveString(op.content, bound), privateValues) } : {}),
            mode, ...(editConflict ? { reason: editConflict } : {}) };
        }
        const unavailable = prerequisite ?? (preparedProcess && 'missing' in preparedProcess.executable ? 'executable-missing' :
          checks.some(check => check.process && 'missing' in check.process.executable) ? 'check-executable-missing' : undefined);
        if (unavailable) { effect = 'unavailable'; omissions.push(diagnostic('PREREQUISITE_UNAVAILABLE', unavailable, 'This operation cannot run on the selected host.')); }
        const review: ReviewOperation = { id, purpose: safeText(op.purpose, privateValues), kind: op.kind, scope: op.scope,
          effects: effect, ownership: ownerState, requires, checks: checks.map(check => check.id), details };
        steps.push({ review, root, path, ownerKey, before, after, mode, pins, managementId: selection.managementId,
          recipeIdentity, checks, process: preparedProcess, unavailable, resolution });
      }
      selectionOps.set(selection.id, currentIds);
    }
    if (usedResolutions.size !== resolutions.length) throw new Error('resolution-unknown');
    const bindings = pathPins(project);
    const base = { schema: 'urn:aihq:core:prepared-work:1.0.0' as const, useCase: 'policy' as const, mode: 'vibe' as const,
      target: { scope: 'project' as const, project }, inputs: { policySha256: digest(policy), package: contractSupport.package },
      operations: steps.map(step => step.review), observations, conflicts, omissions,
      effectiveOptions: { logging: loggingOption(controls), inputs } };
    const review: PreparedReview = deepFreezeStrictJsonV1({ ...base,
      reviewDigest: digest({ review: base, bindings, steps: steps.map(step => ({ id: step.review.id, before: step.before ? sha256(step.before) : null,
        after: step.after ? sha256(step.after) : null })), privateDigest: digest(privateInputs), nonce: randomBytes(32).toString('hex') }) });
    const available = steps.some(step => step.review.effects !== 'conflict' && step.review.effects !== 'unavailable');
    result = { status: conflicts.length || omissions.length ? available ? 'partial' : 'blocked' : 'ready', runId, review,
      diagnostics: [...conflicts, ...omissions], record: disabled };
    if (available) {
      const prepared = Object.freeze({}) as PreparedHandle;
      handles.set(prepared, { request, requestDigest: digest(clone(request)), privateInputs: controls.privateInputs,
        privateDigest: digest(privateInputs), review, steps, project, home: homedir(), ownership, bindings, captures });
      result.prepared = prepared;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'preparation-failed';
    result.status = reason === 'cancelled' ? 'cancelled' : 'invalid';
    result.diagnostics = [diagnostic(reason === 'cancelled' ? 'CANCELLED' : 'INPUT_INVALID',
      /^[a-z-]{1,64}$/.test(reason) ? reason : 'preparation-failed', 'Preparation could not admit the requested work.')];
  }
  return finish();
  function finish(): PreparationResult {
    const record = { ...result, prepared: undefined,
      review: result.review ? { ...result.review, operations: result.review.operations.map(op => ({ ...op,
        details: { ...op.details, content: '[OMITTED]', args: op.details.args?.map(() => '[OMITTED]'),
          env: op.details.env ? Object.fromEntries(Object.keys(op.details.env).map(key => [key, '[OMITTED]'])) : undefined } })) } : undefined };
    result.record = writeHistory(runId, historySafe(record, project), logging);
    if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason,
      'Routine history could not be saved; the returned outcomes remain available.'));
    return result;
  }
}

function prepareCheck(check: RecipeCheck, bound: Record<string, Json>, project: string, selectionKey: string,
    material: { readMaterial(id: string): Buffer | undefined }, privateValues: string[], selectionId: string): PreparedCheck {
  const id = `${selectionId}/${check.id}`;
  if (check.kind === 'file.sha256') {
    const target = resolvePath(check.target, check.target.root === 'project' ? 'project' : 'user', bound, project, selectionKey);
    return { id, kind: check.kind, path: target.absolute, sha256: check.sha256 };
  }
  return { id, kind: check.kind, process: resolveProcess(check, bound, project, selectionKey, material, privateValues).process };
}

export async function apply(prepared: PreparedHandle, authorization: Authorization, controls: HostControls = {}): Promise<RunResult> {
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
    const assertInputs = () => {
      try {
        if (!state || homedir() !== state.home || digest(clone(state.request)) !== state.requestDigest ||
            digest(clone(state.privateInputs ?? {})) !== state.privateDigest || !pinsMatch(state.bindings)) throw new Error('changed');
      } catch { throw new Error('review-stale'); }
    };
    assertInputs();
    for (const capture of state.captures) if (!await capture.recheck()) throw new Error('review-stale');
    const assertStep = (step: PreparedStep) => {
      if (!step.path || !step.root) return;
      const live = transaction(step.root).inspect(step.path);
      let pinsOkay = pinsMatch(step.pins ?? []);
      if (!pinsOkay && isManagedContentRoot(step.root) &&
          step.before === null && live.state === 'absent' &&
          step.pins?.some(pin => pin.path === stateRoot() && pin.identity === 'absent')) {
        protectState(); step.pins = pathPins(join(step.root, ...step.path.split('/'))); pinsOkay = true;
      }
      if (!pinsOkay || live.state === 'unreadable' ||
          (live.state === 'absent' ? null : sha256(live.bytes)) !== (step.before ? sha256(step.before) : null))
        throw new Error('review-stale');
    };
    for (const step of state.steps) assertStep(step);
    for (const [root, ownership] of state.ownership)
      if (readOwnership(root).digest !== ownership.digest) throw new Error('review-stale');
    const unresolved = state.steps.some(step => step.review.effects === 'conflict' || step.review.effects === 'unavailable');
    if (unresolved && !allowPartial) throw new Error('partial-approval-required');
    const mutatingRoots = [...new Set(state.steps.filter(step => step.path &&
      (['create-file', 'replace-file', 'remove-file'].includes(step.review.effects) || step.resolution === 'adopt')).map(step => step.root!))].sort();
    if (mutatingRoots.length) protectState();
    for (const root of mutatingRoots) {
      unlocks.push(lockTarget(root));
      for (const step of state.steps.filter(item => item.root === root)) assertStep(step);
      if (readOwnership(root).digest !== state.ownership.get(root)?.digest) throw new Error('review-stale');
      const current = state.ownership.get(root)!.value;
      const next: Ownership = { ...current, members: { ...current.members } };
      for (const step of state.steps.filter(item => item.root === root &&
        (['create-file', 'replace-file', 'remove-file'].includes(item.review.effects) || item.resolution === 'adopt'))) {
        if (step.after === null) delete next.members[step.ownerKey!];
        else if (step.after) next.members[step.ownerKey!] = { managementId: step.managementId,
          recipeIdentity: step.recipeIdentity, sha256: sha256(step.after), mode: step.mode ?? 0o600 };
      }
      releases.push(stageOwnership(root, runId, next));
    }
    handles.delete(prepared);
    if (mutatingRoots.length) {
      try { result.recovery = stageRecovery(runId, state.steps, state.project); }
      catch { throw new Error('recovery-unavailable'); }
    }
    const outcomes = new Map<string, boolean>(); let stop = false;
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
        started = true;
        const processResult = await executeProcess(step.process, runId, controls.signal);
        operation.application = processResult.status === 'passed' ? 'applied' : 'failed';
        if (processResult.status !== 'passed') {
          operation.reason = processResult.reason; operation.effectsUncertain = processResult.effectsUncertain;
          if (processResult.terminationUnconfirmed) stop = true;
        }
        if (processResult.status === 'cancelled' || controls.signal?.aborted) throw new Error('cancelled');
      } else if (step.path && step.root) {
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
        if (step.root && step.path && (operation.application === 'applied' || step.resolution === 'adopt')) {
          try {
            const tracked = state.ownership.get(step.root)!;
            const next: Ownership = { ...tracked.value, members: { ...tracked.value.members } };
            if (step.after === null) delete next.members[step.ownerKey!];
            else if (operation.application === 'applied' || step.resolution === 'adopt') next.members[step.ownerKey!] = {
              managementId: step.managementId, recipeIdentity: step.recipeIdentity,
              sha256: sha256(step.after!), mode: step.mode ?? 0o600 };
            protectState([ownershipPath(step.root)]);
            const receipt = Buffer.from(JSON.stringify(next)); stateFiles().writeAtomic(ownershipPath(step.root), receipt, 0o600);
            state.ownership.set(step.root, { value: next, digest: sha256(receipt) });
          } catch { throw new Error('state-unwritable'); }
        }
        if (step.checks.length) {
          let checkFailed = false;
          for (const check of step.checks) {
            if (controls.signal?.aborted) throw new Error('cancelled');
            const checkResult = await executeCheck(check, step.review.id, runId, controls.signal);
            const checkIndex = result.checks.findIndex(item => item.operationId === step.review.id && item.id === check.id);
            result.checks[checkIndex] = checkResult;
            if (checkResult.status !== 'passed') checkFailed = true;
            if (checkResult.terminationUnconfirmed) stop = true;
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
      if (!okay && !allowPartial) stop = true;
    }
    result.completion = result.operations.every(op => ['applied', 'already-satisfied'].includes(op.application) &&
      ['unverified', 'passed'].includes(op.verification.status)) ? 'complete' : 'incomplete';
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'execution-failed';
    const safeReason = /^[a-z-]{1,64}$/.test(reason) ? reason : 'execution-failed';
    result.completion = reason === 'cancelled' ? 'cancelled' : started ? 'incomplete' : 'rejected';
    if (reason === 'cancelled') for (const check of result.checks)
      if (check.status === 'skipped' && check.reason === 'not-attempted') check.reason = 'cancelled';
    const code = reason === 'cancelled' ? 'CANCELLED' : reason === 'review-stale' || reason === 'handle-unavailable' ? 'REVIEW_STALE' :
      reason === 'approval-required' || reason === 'partial-approval-required' || reason === 'request-object' || reason === 'request-field' ? 'APPROVAL_REQUIRED' :
      reason === 'state-unwritable' || reason === 'state-protection' || reason === 'recovery-unavailable' ? 'PREREQUISITE_UNAVAILABLE' :
      started ? 'EXECUTION_FAILED' : 'PREREQUISITE_UNAVAILABLE';
    result.diagnostics.push(diagnostic(code, safeReason, 'The run could not complete the requested work.'));
    result.followUp.push('Inspect the reported outcomes, prepare again and approve the new review before further changes.');
  } finally {
    for (const release of releases.reverse()) try { release(); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'work-cleanup', 'Inspect remaining temporary work before deliberate cleanup.')); }
    for (const unlock of unlocks.reverse()) try { unlock(); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'lock-release', 'Inspect the remaining state lock before another run.')); }
  }
  result.record = writeHistory(runId, historySafe(result, state?.project), result.effectiveOptions.logging.value);
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
