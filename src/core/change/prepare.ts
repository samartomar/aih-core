// Prepare for a change request (contract 4.2, 7, 9): admit the request, hand its changes, `requires` and named groups to
// the one existing engine, and present the engine's review as a frozen 0.1.0 review whose digest the person approves.
// The retained rules carry over unchanged (14.2): editors, materials, inputs and private inputs, checks, exact
// approved commands, one-server approval, owned hook groups, dependency retention and group reconciliation.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { isProxy } from 'node:util/types';
import { prepare as prepareEngine } from '../recipe-engine.js';
import { canonicalJson } from '../internal/canonical.js';
import { cloneJsonValueStructureV1, deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState } from '../internal/state.js';
import { schemaProblems, schemas } from '../plan/formats.js';
import { limitValue } from '../plan/limits.js';
import { register, type StepRef } from '../plan/handles.js';
import { FAILURE_RULE, digestOf, problemsOf } from '../plan/prepare.js';
import { requestDigests } from '../plan/request.js';
import { REVIEW, type PlanPreparation, type Problem, type Review, type ReviewConflict, type ReviewStep } from '../plan/types.js';
import { CHANGE, CHANGE_REQUEST, engineRecipe, leftOut, validateChange, type Change, type ChangeReference } from './validate.js';
import { claimKey } from '../plan/claims.js';
import type { ReviewOperation } from '../host-types.js';
import type { ExecutionPolicy, Json, Recipe } from '../types.js';

const POLICY = 'urn:aihq:core:execution-policy:1.4.0';
const COMMAND_LINE = 'Core can\'t show or undo what this command does; if it fails or is stopped, its effects are reported as uncertain.';

export interface ChangeRequest {
  schema: typeof CHANGE_REQUEST;
  mode: 'vibe' | 'enterprise';
  scope: 'project' | 'user';
  target: { project: string | null };
  changes: ({ managementId: string; inputs: Record<string, Json>; requires: string[] } &
    ({ change: Change; reference?: never } | { reference: ChangeReference; change?: never }))[];
  groups?: { id: string; members: string[] }[];
  /** A second Prepare's conflict choices: `step` is the operation id in that change (section 7). */
  resolutions?: { managementId: string; step: string; choice: 'replace' | 'adopt' | 'skip'; observedSha256: string | null }[];
}
/** Controls for change requests: secret values by management id, and local material folders by id. */
export interface ChangeControls {
  signal?: AbortSignal;
  logging?: 'on' | 'off';
  privateInputs?: Record<string, Record<string, Json>>;
  materialRoots?: Record<string, string>;
  onProgress?: (event: Json) => void;
}

export function changeControls(controls: unknown): ChangeControls | undefined {
  if (controls === undefined) return {};
  if (!controls || typeof controls !== 'object' || Array.isArray(controls) || isProxy(controls)) return undefined;
  const value = controls as ChangeControls;
  if (Object.keys(value).some(key => !['signal', 'logging', 'privateInputs', 'materialRoots', 'onProgress'].includes(key))) return undefined;
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) return undefined;
  if (value.logging !== undefined && !['on', 'off'].includes(value.logging)) return undefined;
  if (value.onProgress !== undefined && typeof value.onProgress !== 'function') return undefined;
  for (const field of ['privateInputs', 'materialRoots'] as const)
    if (value[field] !== undefined && (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field]))) return undefined;
  if (value.materialRoots && Object.values(value.materialRoots).some(root => typeof root !== 'string' || !isAbsolute(root))) return undefined;
  return value;
}

const invalid = (problems: Problem[]) => ({ status: 'invalid' as const, problems });
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** `absolute` under `base` as a `/`-separated relative path, or undefined when it is not inside it. */
function relativePath(base: string, absolute: string): string | undefined {
  const path = relative(base, absolute);
  if (!path) return '';
  if (path.startsWith('..') || isAbsolute(path)) return undefined;
  return path.split(sep).join('/');
}
const quoted = (value: string | undefined): string => `\`${value ?? ''}\``;

/** One sentence per reviewed operation (C38). */
function sentence(operation: ReviewOperation, lifecycle: boolean, place: (absolute?: string) => string | undefined): string {
  const target = quoted(place(operation.details.target));
  if (lifecycle) return operation.details.reason === 'restore-pre-existing' ? `Restores your earlier value in ${target}` :
    operation.effects === 'already-satisfied' ? `Keeps ${target}, ${operation.purpose.toLowerCase()}` : `Removes a member no longer stated from ${target}`;
  switch (operation.kind) {
    case 'file.write': return `Writes ${target}`;
    case 'file.remove': return `Removes ${target}`;
    case 'config.entries': {
      const entries = operation.details.entries ?? [];
      const sets = entries.filter(entry => entry.action === 'set').map(entry => quoted(entry.path.join('.')));
      const removes = entries.filter(entry => entry.action === 'remove').map(entry => quoted(entry.path.join('.')));
      return [sets.length ? `Sets ${sets.join(', ')}` : '', removes.length ? `${sets.length ? 'removes' : 'Removes'} ${removes.join(', ')}` : ''].filter(Boolean).join(' and ') + ` in ${target}`;
    }
    case 'config.member': return `${operation.details.member?.action === 'remove' ? 'Removes' : 'Adds'} ${operation.details.member?.value ?? 'one value'} ` +
      `${operation.details.member?.action === 'remove' ? 'from' : 'to'} ${quoted(operation.details.member?.container.join('.'))} in ${target}`;
    case 'text.block': return `${operation.details.blockAction === 'remove' ? 'Removes' : 'Writes'} block ${quoted(operation.details.blockId)} in ${target}`;
    case 'hook.group': return `${operation.details.hookGroup?.action === 'remove' ? 'Removes' : 'Sets'} hook group ${quoted(operation.details.hookGroup?.groupId)} in ${target}`;
    case 'process.run': return `Runs ${quoted(operation.details.executable)} with ${JSON.stringify((operation.details.args ?? []).map(arg => JSON.parse(arg)))} in ${quoted(place(operation.details.cwd) || '.')}`;
  }
}

export async function prepareChange(input: unknown, rawControls?: unknown): Promise<PlanPreparation> {
  forgetProvenState();
  const controls = changeControls(rawControls);
  if (!controls) return invalid([{ path: '', reason: 'controls', message: 'The change controls are not valid.' }]);
  if (controls.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input))
    return invalid([{ path: '', reason: 'type', message: 'A change request is an object.' }]);
  const declared = (input as { schema?: unknown }).schema;
  if (typeof declared === 'string' && declared !== CHANGE_REQUEST)
    return { status: 'unsupported-version', encountered: declared, supported: [CHANGE_REQUEST] };
  let request: ChangeRequest;
  try { request = cloneJsonValueStructureV1(input, 'change request', 32) as unknown as ChangeRequest; }
  catch { return invalid([{ path: '', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }]); }
  if (Buffer.byteLength(canonicalJson(request as unknown as Json)) > limitValue('request-bytes'))
    return { status: 'refused', code: 'limit-exceeded', reason: 'The change request is larger than one request may be.', limit: 'request-bytes', value: limitValue('request-bytes') };
  // The changes' own schema reports exact problems below; read the request around them first.
  const shallow = { ...request, changes: request.changes?.map?.(entry => entry && typeof entry === 'object' && 'change' in entry ?
    { ...entry, change: schemas[CHANGE]!.fixtures.valid } : entry) };
  const problems = schemaProblems(CHANGE_REQUEST, Array.isArray(request.changes) ? shallow : request);
  if (problems) return invalid(problems);
  const changeProblems = request.changes.flatMap((entry, index) => {
    if (!entry.change) return [];
    const read = validateChange(entry.change);
    if (read.status === 'ok') return [];
    if (read.status === 'unsupported-version') return [{ path: `/changes/${index}/change/schema`, reason: 'unsupported-version',
      message: `\`${read.encountered}\` is not a change format this Core reads; it reads ${read.supported.join(', ')}.` }];
    return read.problems.map(problem => ({ ...problem, path: `/changes/${index}/change${problem.path}` }));
  });
  if (changeProblems.length) return invalid(changeProblems);
  if (request.mode === 'enterprise') return { status: 'refused', code: 'organization-required',
    reason: 'Enterprise admission of a change request is not carried out by this Core yet; nothing was prepared.' };
  if (request.scope === 'project' && typeof request.target.project !== 'string')
    return invalid([{ path: '/target/project', reason: 'required', message: 'A project-scope request names its project folder.' }]);
  if (typeof request.target.project === 'string' && !isAbsolute(request.target.project))
    return invalid([{ path: '/target/project', reason: 'absolute', message: 'The project folder is an absolute path.' }]);
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  let project: string | null;
  try { project = typeof request.target.project === 'string' ? projectRoot(request.target.project) : null; }
  catch { return invalid([{ path: '/target/project', reason: 'project', message: 'The project folder is not usable.' }]); }

  // A skipped operation is left out, with every operation of that change that waits for it; the review is then partial.
  const skips = new Map<string, Set<string>>();
  for (const item of request.resolutions ?? []) if (item.choice === 'skip') {
    const entry = request.changes.find(candidate => candidate.managementId === item.managementId);
    if (!entry || entry.change && !entry.change.operations.some(op => op.id === item.step))
      return invalid([{ path: '/resolutions', reason: 'resolution-unknown', message: `No operation \`${item.step}\` belongs to \`${item.managementId}\`.` }]);
    (skips.get(item.managementId) ?? skips.set(item.managementId, new Set()).get(item.managementId)!).add(item.step);
  }
  const skipped = new Map<string, { change: Change; ids: string[] }>();
  // One engine selection per change, keyed by its management id (C48): `requires` and private inputs name it too.
  const inline = new Map<string, string>();
  // Claim identity includes the project for user-scope members too (contract 5): a user-scope change made for a project
  // is its own claim. Without a project it stays the home-anchored claim of its management id.
  const attributed = request.scope === 'user' && project !== null;
  const engineId = (managementId: string): string => attributed ? claimKey(managementId, 'user', null, project) : managementId;
  const claims = new Map(request.changes.map(entry => [engineId(entry.managementId), entry.managementId]));
  const selections: ExecutionPolicy['selections'] = request.changes.map(entry => {
    if (entry.change) inline.set(entry.managementId, sha256(canonicalJson(entry.change as unknown as Json)));
    return { id: entry.managementId, managementId: engineId(entry.managementId), scope: request.scope, configuration: entry.inputs,
      requires: entry.requires, recipe: entry.change ? { inline: engineRecipe(entry.change, skips.get(entry.managementId)) } : { reference: entry.reference! } };
  });
  const policy: ExecutionPolicy = { schema: POLICY, mode: 'vibe', selections,
    ...(request.groups ? { managedSelections: request.groups.map(group => ({ id: group.id, scope: request.scope, members: group.members.map(engineId) })) } : {}) };
  for (const entry of request.changes) if (entry.change && skips.has(entry.managementId))
    skipped.set(entry.managementId, { change: entry.change, ids: leftOut(entry.change, skips.get(entry.managementId)!) });
  const resolutions = (request.resolutions ?? []).filter(item => item.choice !== 'skip').map(item => ({ selectionId: item.managementId, operationId: item.step,
    choice: item.choice as 'replace' | 'adopt', observedSha256: item.observedSha256 }));
  const owners = new Map<string, string[]>();
  const read = (document: unknown, managementId: string): Recipe | undefined => {
    if (validateChange(document).status !== 'ok') return undefined;
    const change = document as Change; const named = skips.get(managementId);
    if (named && [...named].some(id => !change.operations.some(op => op.id === id))) return undefined;
    if (named) skipped.set(managementId, { change, ids: leftOut(change, named) });
    return engineRecipe(change, named);
  };
  const engine = await prepareEngine({ useCase: 'policy', policy, target: { project: project ?? home }, ...(resolutions.length ? { resolutions } : {}) },
    { ...(controls.signal ? { signal: controls.signal } : {}), ...(controls.logging ? { logging: controls.logging } : {}),
      ...(controls.privateInputs ? { privateInputs: controls.privateInputs } : {}), ...(controls.materialRoots ? { materialRoots: controls.materialRoots } : {}) },
    undefined, undefined, undefined, undefined, undefined, { change: { inline, read }, owners,
      ...(attributed ? { claims: new Map(request.changes.map(entry => [entry.managementId, { managementId: entry.managementId, project }])) } : {}) });
  if (engine.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  if (!engine.review) {
    if (engine.diagnostics.some(item => item.reason === 'custody-record-limit'))
      return { status: 'refused', code: 'limit-exceeded', reason: 'The receipts these changes need would pass their limit.',
        limit: 'receipt-bytes', value: limitValue('receipt-bytes') };
    return invalid(problemsOf(engine));
  }

  // Paths are shown relative to their root, as a plan review shows them; the exact absolute target stays in `details`.
  const roots = [...(project ? [['project', project] as const] : []), ['user', home] as const];
  const located = (absolute?: string): { root?: 'project' | 'user'; path?: string } => {
    if (absolute === undefined) return {};
    for (const [root, base] of roots) {
      const relative = relativePath(base, absolute);
      if (relative !== undefined) return { root, path: relative };
    }
    return { path: absolute };
  };
  const place = (absolute?: string) => located(absolute).path;
  const bySelection = new Map((engine.operationSelections ?? []).map(item => [item.id, item]));
  const hints = new Map((engine.resolutionInputs ?? []).map(item => [`${item.selectionId}/${item.operationId}`, item]));
  const operations = new Map<string, StepRef>();
  const steps: ReviewStep[] = []; const conflicts: ReviewConflict[] = [];
  for (const operation of engine.review.operations) {
    const authored = bySelection.get(operation.id);
    const lifecycle = !authored?.selectionId;
    const owner = owners.get(operation.id)?.[0];
    const managementId = authored?.selectionId ?? (owner === undefined ? '' : claims.get(owner) ?? owner);
    const step = authored?.operationId ?? operation.id;
    operations.set(operation.id, { step, managementId });
    const effect: ReviewStep['effect'] = operation.effects;
    const where = located(operation.details.target);
    steps.push({ step, op: operation.kind, managementId, sentence: sentence(operation, lifecycle, place),
      cantPromise: operation.kind === 'process.run' && !lifecycle ? COMMAND_LINE : null, effect, root: where.root ?? operation.scope,
      ...(where.path === undefined ? {} : { path: where.path }),
      requires: [...operation.requires], details: operation.details as unknown as Json });
    if (operation.effects === 'conflict') {
      const hint = hints.get(operation.id);
      const replaceable = !!hint && hint.availableChoices.length > 0;
      conflicts.push({ code: 'STATE_CONFLICT', reason: replaceable ? 'existing-content' : 'managed-content-changed', managementId, step,
        target: where.path ?? '', observedSha256: hint?.observedSha256 ?? null, existing: null, redacted: [], choices: replaceable ? [...hint!.availableChoices, 'skip'] : [] });
    }
  }
  for (const [managementId, { change, ids }] of skipped) for (const id of ids) {
    const op = change.operations.find(candidate => candidate.id === id)!;
    steps.push({ step: id, op: op.kind, managementId, sentence: `Leaves out \`${id}\` (${op.purpose}), as you chose`, cantPromise: null,
      effect: 'skipped', root: op.scope, requires: [...op.requires] });
  }
  const warnings = engine.diagnostics.filter(item => item.code !== 'STATE_CONFLICT').map(item => `${item.reason}: ${item.message}`);
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'change', scope: request.scope, target: { project }, steps, conflicts,
    groups: (request.groups ?? []).map(group => ({ id: group.id, members: [...group.members] })), failureRule: FAILURE_RULE, warnings };
  const reviewDigest = digestOf(body, engine.review.reviewDigest);
  const review = deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review;
  if (conflicts.some(conflict => conflict.reason === 'existing-content') || !engine.prepared) return { status: 'blocked', review };
  const partial = engine.status === 'partial' || skipped.size > 0;
  const digests = requestDigests(input)!;
  const handle = register({ engine: engine.prepared, engineDigest: engine.review.reviewDigest, enginePartial: partial, reviewDigest, partial,
    operations, claims, request: { value: input, ...digests } });
  return { status: partial ? 'partial' : 'ready', review, handle };
}

