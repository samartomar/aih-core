import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isProxy } from 'node:util/types';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { contractSupport, validatePolicy } from './contracts.js';
import { canonicalJson } from './internal/canonical.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, deepFreezeStrictJsonV1 } from './internal/strict-json.js';
import { dependencyOrder, inputAccepts } from './internal/policy-validation.js';
import { fileTransaction, pathPins, pinsMatch, projectRoot, sha256, validSegment, type PathPin } from './internal/host-files.js';
import { lockTarget, ownershipPath, protectState, readOwnership, stageOwnership, stateFiles, stateRoot, writeHistory, type Ownership } from './internal/state.js';
import type { Diagnostic, Json, Slot } from './types.js';
import type { Authorization, Effective, HostControls, PolicyRequest, PreparationResult, PreparedHandle, PreparedReview, ReviewOperation, RunResult } from './host-types.js';
export type * from './types.js';
export type * from './host-types.js';

interface CapturedFile {
  review: ReviewOperation; path: string; contents: Buffer; digest: string;
  before: string | null; pins: PathPin[]; managementId: string; recipeIdentity: string;
}
interface PreparedState {
  request: PolicyRequest; requestDigest: string; privateInputs: HostControls['privateInputs']; privateDigest: string;
  review: PreparedReview; files: CapturedFile[]; project: string; home: string;
  ownership: Ownership; ownershipDigest: string | null; bindings: PathPin[];
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
  dataObject(controls, ['signal', 'logging', 'privateInputs']);
  if (controls.logging !== undefined && !['on', 'off'].includes(controls.logging)) throw new Error('logging');
  if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) throw new Error('signal');
  if (controls.privateInputs !== undefined) assertStrictJsonValueV1(clone(controls.privateInputs), 'private inputs');
}
function safeText(text: string, privateValues: string[]): string {
  let result = text;
  for (const secret of privateValues) if (secret) result = result.split(secret).join('[REDACTED]');
  return result.replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 4096);
}
function historySafe(result: unknown, project?: string): unknown {
  let text = JSON.stringify(result);
  for (const [path, label] of [[project, '<project>'], [homedir(), '<home>']]) {
    if (path) for (const variant of [path, path.replaceAll('\\', '/')]) text = text.split(JSON.stringify(variant).slice(1, -1)).join(label!);
  }
  return JSON.parse(text);
}

export async function prepare(request: PolicyRequest, controls: HostControls = {}): Promise<PreparationResult> {
  const runId = randomUUID();
  let result: PreparationResult = { status: 'invalid', runId, diagnostics: [], record: disabled };
  let logging: 'on' | 'off' = 'off'; let project: string | undefined;
  try {
    validateControls(controls); logging = loggingOption(controls).value;
    if (controls.signal?.aborted) { result.status = 'cancelled'; throw new Error('cancelled'); }
    if (Number(process.versions.node.split('.')[0]) !== 24 || Number(process.versions.node.split('.')[1]) < 6) throw new Error('node-runtime');
    dataObject(request, ['useCase', 'policy', 'target']);
    dataObject(request.target, ['project']);
    if (request.useCase !== 'policy') throw new Error('use-case-unsupported');
    const validation = validatePolicy(request.policy);
    if (!validation.valid) { result.diagnostics = validation.diagnostics; return finish(); }
    const policy = clone(request.policy);
    project = projectRoot(request.target.project);
    const tx = fileTransaction(project, stateRoot());
    const ownership = readOwnership(project);
    const privateInputs = clone(controls.privateInputs ?? {});
    for (const [selectionId, values] of Object.entries(privateInputs)) {
      const selection = policy.selections.find(item => item.id === selectionId);
      if (!selection || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error('private-input-unknown');
      for (const name of Object.keys(values)) {
        if (!Object.hasOwn(selection.recipe.inline.inputs, name) || !selection.recipe.inline.inputs[name]?.sensitive) throw new Error('private-input-unknown');
      }
    }
    const privateValues = Object.values(privateInputs).flatMap(inputs => Object.values(inputs)).map(String);
    const files: CapturedFile[] = []; const destinations = new Set<string>();
    const inputs: PreparedReview['effectiveOptions']['inputs'] = {};
    const conflicts: Diagnostic[] = [];
    for (const selection of dependencyOrder(policy.selections)) {
      const recipe = selection.recipe.inline;
      if (selection.scope !== 'project') throw new Error('scope-unavailable');
      const bound: Record<string, Json> = Object.create(null);
      for (const [name, spec] of Object.entries(recipe.inputs)) {
        const value = spec.sensitive ? privateInputs[selection.id]?.[name] :
          Object.hasOwn(selection.configuration, name) ? selection.configuration[name] : spec.default;
        if (value === undefined && !spec.required) continue;
        if (!inputAccepts(spec, value)) throw new Error('input-value');
        bound[name] = value;
        inputs[`${selection.id}/${name}`] = { origin: spec.sensitive ? 'private' : Object.hasOwn(selection.configuration, name) ? 'explicit' : 'default' };
      }
      const resolveSlot = (slot: Slot): string => {
        const value = 'literal' in slot ? slot.literal : bound[slot.input];
        if (typeof value !== 'string') throw new Error('string-slot');
        return value;
      };
      const recipeIdentity = `sha256:${digest({ schema: 'urn:aihq:core:recipe-identity:1.0.0', recipeSha256: digest(recipe), materials: [] })}`;
      for (const op of dependencyOrder(recipe.operations)) {
        if (op.target.root !== 'project') throw new Error('scope-unavailable');
        const segments = op.target.segments.map(resolveSlot);
        if (segments.some(segment => !validSegment(segment))) throw new Error('invalid-path');
        const path = segments.join('/');
        const key = process.platform === 'win32' ? path.toLowerCase() : path;
        if (destinations.has(key)) throw new Error('duplicate-destination'); destinations.add(key);
        const content = resolveSlot(op.content); const contents = Buffer.from(content);
        if (contents.length > 16 * 1024 * 1024) throw new Error('file-limit');
        const id = `${selection.id}/${op.id}`;
        const live = tx.inspect(path); const contentDigest = sha256(contents);
        const owner = Object.hasOwn(ownership.value.members, path) ? ownership.value.members[path] : undefined;
        const managed = owner?.managementId === selection.managementId && live.state === 'present' && owner.sha256 === sha256(live.bytes);
        const satisfied = live.state === 'present' && live.bytes.equals(contents);
        const conflict = live.state === 'unreadable' || live.state === 'present' && !satisfied || owner !== undefined && !managed;
        if (conflict) conflicts.push({ ...diagnostic('STATE_CONFLICT', 'existing-content', 'Existing or unsafe content requires a separate supported resolution.'), path: safeText(path, privateValues) });
        const review: ReviewOperation = {
          id, purpose: safeText(op.purpose, privateValues), kind: 'file.write', scope: 'project',
          effects: conflict ? 'conflict' : satisfied ? 'already-satisfied' : 'create-file', ownership: managed ? 'managed' : 'unowned',
          requires: op.requires.map(required => `${selection.id}/${required}`), checks: [],
          details: { target: safeText(join(project, ...segments), privateValues),
            content: 'input' in op.content && recipe.inputs[op.content.input]?.sensitive ? '[REDACTED]' : content,
            mode: live.state === 'present' ? live.mode : 0o600 }
        };
        files.push({ review, path, contents, digest: contentDigest, before: live.state === 'present' ? sha256(live.bytes) : null,
          pins: pathPins(join(project, ...segments)), managementId: selection.managementId, recipeIdentity });
      }
    }
    const bindings = pathPins(project);
    const base = {
      schema: 'urn:aihq:core:prepared-work:1.0.0' as const, useCase: 'policy' as const, mode: 'vibe' as const,
      target: { scope: 'project' as const, project }, inputs: { policySha256: digest(policy), package: contractSupport.package },
      operations: files.map(file => file.review), observations: [], conflicts, omissions: [],
      effectiveOptions: { logging: loggingOption(controls), inputs }
    };
    const review: PreparedReview = deepFreezeStrictJsonV1({ ...base,
      reviewDigest: digest({ review: base, bindings, files: files.map(file => ({ path: file.path, before: file.before, digest: file.digest })), nonce: randomBytes(32).toString('hex') }) });
    result = { status: conflicts.length ? 'blocked' : 'ready', runId, review, diagnostics: [...conflicts], record: disabled };
    if (!conflicts.length) {
      const prepared = Object.freeze({}) as PreparedHandle;
      handles.set(prepared, { request, requestDigest: digest(clone(request)), privateInputs: controls.privateInputs,
        privateDigest: digest(privateInputs), review, files, project, home: homedir(),
        ownership: ownership.value, ownershipDigest: ownership.digest, bindings });
      result.prepared = prepared;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'preparation-failed';
    result.diagnostics = [diagnostic(reason === 'cancelled' ? 'CANCELLED' : 'INPUT_INVALID',
      /^[a-z-]{1,64}$/.test(reason) ? reason : 'preparation-failed', 'Preparation could not admit the requested work.')];
  }
  return finish();
  function finish(): PreparationResult {
    // History excludes file contents and the executable handle. The caller's live
    // review can show effects; routine history is not a policy/secret dump.
    const record = { ...result, prepared: undefined,
      review: result.review ? { ...result.review, operations: result.review.operations.map(op => ({ ...op, details: { ...op.details, content: '[OMITTED]' } })) } : undefined };
    result.record = writeHistory(runId, historySafe(record, project), logging);
    if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason, 'Routine history could not be saved; the returned outcomes remain available.'));
    return result;
  }
}

export async function apply(prepared: PreparedHandle, authorization: Authorization, controls: HostControls = {}): Promise<RunResult> {
  const runId = randomUUID(); let state: PreparedState | undefined;
  const result: RunResult = { schema: 'urn:aihq:core:run-result:1.0.0', runId, useCase: 'policy', completion: 'rejected',
    effectiveOptions: { logging: { value: 'off', origin: 'default' } }, operations: [], checks: [], diagnostics: [], record: disabled, followUp: [] };
  let unlock: (() => void) | undefined; let releaseWork: (() => void) | undefined; let started = false;
  try {
    validateControls(controls); result.effectiveOptions.logging = loggingOption(controls);
    await yieldToHost();
    state = prepared && typeof prepared === 'object' ? handles.get(prepared) : undefined;
    if (!state) throw new Error('handle-unavailable');
    result.inputs = state.review.inputs;
    result.operations = state.files.map(file => ({ id: file.review.id, application: 'not-attempted', verification: { status: 'unverified', reason: 'no-supplied-check' } }));
    dataObject(authorization, ['reviewDigest', 'origin', 'approved', 'allowPartial']);
    if (authorization.approved !== true || !['interactive', 'automation'].includes(authorization.origin) ||
        authorization.allowPartial !== undefined && typeof authorization.allowPartial !== 'boolean') throw new Error('approval-required');
    if (authorization.reviewDigest !== state.review.reviewDigest) throw new Error('review-stale');
    result.authorization = { origin: authorization.origin, allowPartial: { value: authorization.allowPartial ?? false, origin: authorization.allowPartial === undefined ? 'default' : 'explicit' } };
    if (controls.signal?.aborted) throw new Error('cancelled');
    const assertInputs = () => {
      try {
        if (!state || homedir() !== state.home || digest(clone(state.request)) !== state.requestDigest ||
            digest(clone(state.privateInputs ?? {})) !== state.privateDigest || !pinsMatch(state.bindings)) throw new Error('changed');
      } catch { throw new Error('review-stale'); }
    };
    assertInputs();
    const tx = fileTransaction(state.project, stateRoot());
    const assertFiles = () => {
      if (!state) throw new Error('handle-unavailable');
      for (const file of state.files) {
        const current = tx.inspect(file.path);
        if (!pinsMatch(file.pins) || current.state === 'unreadable' ||
            (current.state === 'absent' ? null : sha256(current.bytes)) !== file.before) throw new Error('review-stale');
      }
      if (readOwnership(state.project).digest !== state.ownershipDigest) throw new Error('review-stale');
    };
    assertFiles();
    const mutating = state.files.some(file => file.review.effects === 'create-file');
    if (mutating) { protectState(); unlock = lockTarget(state.project); assertFiles(); }
    const nextOwnership: Ownership = { ...state.ownership, members: { ...state.ownership.members } };
    for (const file of state.files) {
      if (file.review.effects !== 'create-file') continue;
      Object.defineProperty(nextOwnership.members, file.path, { enumerable: true, configurable: true, writable: true, value: {
        managementId: file.managementId, recipeIdentity: file.recipeIdentity, sha256: file.digest, mode: 0o600
      } });
    }
    if (mutating) releaseWork = stageOwnership(state.project, runId, nextOwnership);
    let ownership = state.ownership; let ownershipDigest = state.ownershipDigest;
    handles.delete(prepared);
    if (mutating) {
      result.recovery = `recovery/${runId}/manifest.json`;
      try {
        stateFiles().writeAtomic(result.recovery, Buffer.from(JSON.stringify({ target: state.project,
          operations: state.files.map(file => ({ path: file.path, before: file.before, intendedSha256: file.digest })),
          instruction: 'Inspect current state before manual recovery; this is not execution authority.' })), 0o600);
      } catch { throw new Error('recovery-unavailable'); }
    }
    for (let index = 0; index < state.files.length; index++) {
      await yieldToHost();
      if (controls.signal?.aborted) throw new Error('cancelled');
      assertInputs();
      // The host may run caller code during the yield. Recheck custody before
      // any effect and compare against only the receipts this invocation wrote.
      if (readOwnership(state.project).digest !== ownershipDigest) throw new Error('review-stale');
      const file = state.files[index]!; const operation = result.operations[index]!;
      const current = tx.inspect(file.path);
      if (!pinsMatch(file.pins) || current.state === 'unreadable' ||
          (current.state === 'absent' ? null : sha256(current.bytes)) !== file.before) throw new Error('review-stale');
      if (file.review.effects === 'already-satisfied') { operation.application = 'already-satisfied'; continue; }
      started = true;
      try {
        tx.commit([{ action: 'write', path: file.path, mode: 0o600, contents: file.contents, expect: { absent: true } }]);
        operation.application = 'applied';
      } catch {
        operation.application = 'failed'; operation.effectsUncertain = true;
        throw new Error('file-write');
      }
      try {
        protectState([ownershipPath(state.project)]);
        ownership = { ...ownership, members: { ...ownership.members, [file.path]: nextOwnership.members[file.path]! } };
        const receipt = Buffer.from(JSON.stringify(ownership));
        stateFiles().writeAtomic(ownershipPath(state.project), receipt, 0o600);
        ownershipDigest = sha256(receipt);
      } catch { throw new Error('state-unwritable'); }
      // Later files may share directories that this approved write just created.
      // Only replace previously absent parent pins with those observed here.
      const createdParents = pathPins(join(state.project, ...file.path.split('/'))).slice(0, -1);
      for (const remaining of state.files.slice(index + 1)) {
        if (remaining.pins.some(pin => pin.identity === 'absent' && createdParents.some(parent => parent.path === pin.path))) {
          remaining.pins = pathPins(join(state.project, ...remaining.path.split('/')));
        }
      }
    }
    result.completion = 'complete';
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'execution-failed';
    const safeReason = /^[a-z-]{1,64}$/.test(reason) ? reason : 'execution-failed';
    result.completion = reason === 'cancelled' ? 'cancelled' : started ? 'incomplete' : 'rejected';
    const code = reason === 'cancelled' ? 'CANCELLED' : reason === 'review-stale' || reason === 'handle-unavailable' ? 'REVIEW_STALE' :
      reason === 'approval-required' || reason === 'request-object' || reason === 'request-field' ? 'APPROVAL_REQUIRED' :
      reason === 'state-unwritable' || reason === 'state-protection' || reason === 'recovery-unavailable' ? 'PREREQUISITE_UNAVAILABLE' : started ? 'EXECUTION_FAILED' : 'PREREQUISITE_UNAVAILABLE';
    result.diagnostics.push(diagnostic(code, safeReason, 'The run could not complete the requested work.'));
    result.followUp.push('Inspect the reported outcomes, prepare again and approve the new review before further changes.');
  } finally {
    try { releaseWork?.(); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'work-cleanup', 'Inspect remaining temporary work before deliberate cleanup.')); }
    try { unlock?.(); } catch { result.diagnostics.push(diagnostic('EXECUTION_FAILED', 'lock-release', 'Inspect the remaining state lock before another run.')); }
  }
  result.record = writeHistory(runId, historySafe(result, state?.project), result.effectiveOptions.logging.value);
  if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason, 'Routine history could not be saved; the returned outcomes remain available.'));
  return result;
}
