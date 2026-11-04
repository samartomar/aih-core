// `checkFiles` (contract 3, 10, 14.1, 15): the read-only comparison of what a plan or change request would write
// with what is on disk. No effects at all: no state, history, network or processes. A plan's write steps are
// compared with their checked bytes (supplied or rendered by the caller's Catalog); a change is compared by the
// retained file-state comparison of its lowered recipe. Steps that are not files (programs, acquisitions) are
// listed as not checked; a comparison is never inferred from them.
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isProxy } from 'node:util/types';
import { checkFileState } from './file-state.js';
import { installedDistribution } from './internal/installed-distribution.js';
import { projectRoot } from './internal/host-files.js';
import { readRegularFile } from './internal/fsxn.js';
import { cloneJsonValueStructureV1 } from './internal/strict-json.js';
import { checkPlanRequest } from './plan/request.js';
import { planControls } from './plan/prepare.js';
import { schemaProblems, schemas } from './plan/formats.js';
import { limitValue } from './plan/limits.js';
import { PLAN_REQUEST, type Invalid, type PlanControls, type Problem, type Refusal, type UnsupportedVersion } from './plan/types.js';
import { CHANGE, CHANGE_REQUEST, engineRecipe, validateChange } from './change/validate.js';
import type { ChangeRequest } from './change/prepare.js';
import type { ExecutionPolicy, Json } from './types.js';

export const FILE_CHECK = 'urn:aihq:core:file-check:0.1.0' as const;
export interface FileCheckTarget {
  id: string;
  /** The plan steps (indexes) or change operation ids that write this target, in order. */
  steps: (number | string)[];
  managementIds: string[];
  target: { root: 'project' | 'user'; path: string } | null;
  outcome: 'match' | 'changed' | 'absent' | 'unavailable';
  reason: string;
}
export interface FileCheck {
  schema: typeof FILE_CHECK; status: 'ok'; request: 'plan' | 'change';
  package: { name: string; version: string };
  /** `complete` only when every planned file was compared and nothing was left unchecked. */
  observation: 'complete' | 'incomplete' | 'cancelled';
  fileState: 'match' | 'changed' | 'unverified';
  authority: 'not-evaluated';
  targets: FileCheckTarget[];
  checks: { id: string; outcome: 'passed' | 'failed' | 'unavailable' | 'not-checked'; reason: string }[];
  notChecked: { kind: string; id: string; reason: string }[];
  coverage: { comparedTargets: number; unavailableTargets: number; comparedChecks: number; unavailableChecks: number; notChecked: number };
  diagnostics: { code: string; reason: string; message: string }[];
  limits: { budgetMs: number; elapsedMs: number; targetBytes: number; materialBytes: number };
}
export type FileCheckResult = FileCheck | Refusal | Invalid | UnsupportedVersion;
export interface FileCheckControls {
  signal?: AbortSignal;
  /** Plan requests: the caller's Catalog, for render steps. */
  catalog?: PlanControls['catalog'];
  /** Change requests: secret values by management id, and local material folders by id. */
  privateInputs?: Record<string, Record<string, Json>>;
  materialRoots?: Record<string, string>;
  budgetMs?: number;
}

const BUDGET_MS = 60000;
const invalid = (problems: Problem[]): Invalid => ({ status: 'invalid', problems });
const schemaOf = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value) ?
  Object.getOwnPropertyDescriptor(value, 'schema')?.value : undefined;

export async function checkFiles(request: unknown, rawControls: unknown = {}): Promise<FileCheckResult> {
  if (!rawControls || typeof rawControls !== 'object' || Array.isArray(rawControls) || isProxy(rawControls) ||
      Object.keys(rawControls).some(key => !['signal', 'catalog', 'privateInputs', 'materialRoots', 'budgetMs'].includes(key)))
    return invalid([{ path: '', reason: 'controls', message: 'Use { signal?, catalog?, privateInputs?, materialRoots?, budgetMs? }.' }]);
  const controls = rawControls as FileCheckControls;
  if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) return invalid([{ path: '/signal', reason: 'controls', message: 'The signal is an AbortSignal.' }]);
  if (controls.budgetMs !== undefined && (!Number.isInteger(controls.budgetMs) || controls.budgetMs < 1 || controls.budgetMs > BUDGET_MS))
    return invalid([{ path: '/budgetMs', reason: 'budget-ms', message: `The budget is a whole number of milliseconds up to ${BUDGET_MS}.` }]);
  let identity: { name: string; version: string };
  try { identity = installedDistribution(); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The installed Core distribution could not be identified.' }; }
  if (controls.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'The file check was cancelled.' };
  const schema = schemaOf(request);
  if (schema === PLAN_REQUEST || typeof schema === 'string' && schema.startsWith('urn:aihq:core:plan-request:')) return checkPlan(request, controls, identity);
  if (typeof schema === 'string' && schema.startsWith('urn:aihq:core:change-request:')) return checkChange(request, controls, identity);
  return invalid([{ path: '/schema', reason: 'request-kind', message: 'checkFiles compares a plan request or a change request.' }]);
}

type Read = { outcome: 'absent' } | { outcome: 'present'; bytes: Buffer } | { outcome: 'unavailable'; reason: string };
/** Reads one target without following a link anywhere on its path. */
function readTarget(root: string, path: string, maxBytes: number): Read {
  const segments = path.split('/');
  let at = root;
  for (const [index, segment] of segments.entries()) {
    at = join(at, segment);
    let stat;
    try { stat = lstatSync(at); } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ?
        { outcome: 'absent' } : { outcome: 'unavailable', reason: 'target-unreadable' };
    }
    if (stat.isSymbolicLink()) return { outcome: 'unavailable', reason: 'target-link' };
    if (index < segments.length - 1) { if (!stat.isDirectory()) return { outcome: 'absent' }; continue; }
    if (!stat.isFile()) return { outcome: 'unavailable', reason: 'target-not-regular' };
    if (stat.size > maxBytes) return { outcome: 'unavailable', reason: 'limit-exceeded' };
  }
  const bytes = readRegularFile(at, { maxBytes });
  return bytes ? { outcome: 'present', bytes } : { outcome: 'unavailable', reason: 'target-unreadable' };
}

function conclude(base: Omit<FileCheck, 'observation' | 'fileState' | 'coverage'>, cancelled: boolean): FileCheck {
  const comparedTargets = base.targets.filter(target => target.outcome !== 'unavailable').length;
  const unavailableTargets = base.targets.length - comparedTargets;
  const comparedChecks = base.checks.filter(check => check.outcome === 'passed' || check.outcome === 'failed').length;
  const unavailableChecks = base.checks.filter(check => check.outcome === 'unavailable').length;
  const notChecked = base.notChecked.length + base.checks.filter(check => check.outcome === 'not-checked').length;
  const mismatch = base.targets.some(target => target.outcome === 'changed' || target.outcome === 'absent') || base.checks.some(check => check.outcome === 'failed');
  const unread = base.notChecked.some(item => item.kind === 'recipe');
  const compared = comparedTargets + comparedChecks;
  const fileState = mismatch ? 'changed' : compared >= 1 && unavailableTargets === 0 && unavailableChecks === 0 && !unread ? 'match' : 'unverified';
  const observation = cancelled ? 'cancelled' : compared >= 1 && unavailableTargets === 0 && unavailableChecks === 0 && notChecked === 0 ? 'complete' : 'incomplete';
  return { ...base, observation, fileState, coverage: { comparedTargets, unavailableTargets, comparedChecks, unavailableChecks, notChecked } };
}

async function checkPlan(request: unknown, controls: FileCheckControls, identity: { name: string; version: string }): Promise<FileCheckResult> {
  const started = performance.now();
  const plan = planControls({ ...(controls.signal ? { signal: controls.signal } : {}), ...(controls.catalog ? { catalog: controls.catalog } : {}) });
  if (!plan) return invalid([{ path: '/catalog', reason: 'controls', message: 'The Catalog control is not valid.' }]);
  const admitted = await checkPlanRequest(request, plan);
  if ('status' in admitted) return admitted;
  const { checked } = admitted;
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  const project = checked.document.target.project;
  let projectFolder: string | null = null;
  if (typeof project === 'string') {
    if (!isAbsolute(project)) return invalid([{ path: '/target/project', reason: 'absolute', message: 'The project folder is an absolute path.' }]);
    try { projectFolder = projectRoot(project); } catch { return invalid([{ path: '/target/project', reason: 'project', message: 'The project folder is not usable.' }]); }
  }
  const budgetMs = controls.budgetMs ?? BUDGET_MS;
  const notChecked: FileCheck['notChecked'] = [];
  // One row per target file; a later write to the same file is what the comparison expects.
  const rows = new Map<string, { root: 'project' | 'user'; path: string; steps: number[]; managementIds: Set<string>; bytes: Buffer }>();
  for (const step of checked.steps) {
    const lowered = step.lowered as { kind: string; root?: 'project' | 'user'; path?: string; bytes?: Buffer; acquire?: unknown; managementIds: string[] };
    if (step.skipped) { notChecked.push({ kind: 'step', id: `step-${step.index}`, reason: 'skipped' }); continue; }
    if (lowered.kind === 'plugin') { notChecked.push({ kind: 'process', id: `step-${step.index}`, reason: 'program-not-run' }); continue; }
    if (lowered.kind !== 'write' || !lowered.bytes || !lowered.path || !lowered.root) {
      notChecked.push({ kind: 'step', id: `step-${step.index}`, reason: 'step-not-compared' }); continue;
    }
    if (lowered.acquire) { notChecked.push({ kind: 'acquisition', id: `step-${step.index}`, reason: 'acquisition-not-run' }); continue; }
    if (lowered.root === 'project' && projectFolder === null)
      return invalid([{ path: `/plan/plan/${step.index}/root`, reason: 'project', message: 'A project-rooted step needs the request to name its project.' }]);
    const key = `${lowered.root}\0${lowered.path}`;
    const row = rows.get(key) ?? { root: lowered.root, path: lowered.path, steps: [], managementIds: new Set<string>(), bytes: lowered.bytes };
    row.steps.push(step.index); row.bytes = lowered.bytes;
    for (const id of lowered.managementIds) row.managementIds.add(id);
    rows.set(key, row);
  }
  if (rows.size > limitValue('check-files-targets'))
    return { status: 'refused', code: 'limit-exceeded', reason: 'The request names more files than one check compares.', limit: 'check-files-targets', value: limitValue('check-files-targets') };
  const targets: FileCheckTarget[] = [];
  let targetBytes = 0, materialBytes = 0, cancelled = false, stopped: string | undefined;
  for (const row of rows.values()) {
    const base = { id: `step-${row.steps.at(-1)}`, steps: row.steps, managementIds: [...row.managementIds].sort(), target: { root: row.root, path: row.path } };
    if (!stopped && controls.signal?.aborted) { cancelled = true; stopped = 'cancelled'; }
    if (!stopped && performance.now() - started > budgetMs) stopped = 'budget-exhausted';
    if (stopped) { targets.push({ ...base, outcome: 'unavailable', reason: stopped }); continue; }
    materialBytes += row.bytes.length;
    const read = readTarget(row.root === 'project' ? projectFolder! : home, row.path, limitValue('file-bytes'));
    if (read.outcome === 'unavailable') targets.push({ ...base, outcome: 'unavailable', reason: read.reason });
    else if (read.outcome === 'absent') targets.push({ ...base, outcome: 'absent', reason: 'target-absent' });
    else {
      targetBytes += read.bytes.length;
      const same = read.bytes.equals(row.bytes);
      targets.push({ ...base, outcome: same ? 'match' : 'changed', reason: same ? 'content-match' : 'content-changed' });
    }
  }
  return conclude({ schema: FILE_CHECK, status: 'ok', request: 'plan', package: identity, authority: 'not-evaluated', targets, checks: [], notChecked,
    diagnostics: cancelled ? [{ code: 'CANCELLED', reason: 'cancelled', message: 'The file check was cancelled.' }] : [],
    limits: { budgetMs, elapsedMs: Math.round(performance.now() - started), targetBytes, materialBytes } }, cancelled);
}

async function checkChange(input: unknown, controls: FileCheckControls, identity: { name: string; version: string }): Promise<FileCheckResult> {
  const declared = schemaOf(input);
  if (declared !== CHANGE_REQUEST) return { status: 'unsupported-version', encountered: String(declared), supported: [CHANGE_REQUEST] };
  let request: ChangeRequest;
  try { request = cloneJsonValueStructureV1(input, 'change request', 32) as unknown as ChangeRequest; }
  catch { return invalid([{ path: '', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }]); }
  const shallow = { ...request, changes: request.changes?.map?.(entry => entry && typeof entry === 'object' && 'change' in entry ?
    { ...entry, change: schemas[CHANGE]!.fixtures.valid } : entry) };
  const problems = schemaProblems(CHANGE_REQUEST, Array.isArray(request.changes) ? shallow : request);
  if (problems) return invalid(problems);
  const changeProblems = request.changes.flatMap((entry, index) => {
    if (!entry.change) return [];
    const read = validateChange(entry.change);
    if (read.status === 'ok') return [];
    if (read.status === 'unsupported-version') return [{ path: `/changes/${index}/change/schema`, reason: 'unsupported-version',
      message: `\`${read.encountered}\` is not a change format this Core reads.` }];
    return read.problems.map(problem => ({ ...problem, path: `/changes/${index}/change${problem.path}` }));
  });
  if (changeProblems.length) return invalid(changeProblems);
  if (request.scope === 'project' && typeof request.target.project !== 'string')
    return invalid([{ path: '/target/project', reason: 'required', message: 'A project-scope request names its project folder.' }]);
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  const policy: ExecutionPolicy = { schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe',
    selections: request.changes.map(entry => ({ id: entry.managementId, managementId: entry.managementId, scope: request.scope,
      configuration: entry.inputs, requires: entry.requires,
      recipe: entry.change ? { inline: engineRecipe(entry.change) } : { reference: entry.reference! } })) } as ExecutionPolicy;
  const result = await checkFileState({ policy, target: { project: typeof request.target.project === 'string' ? request.target.project : home } }, {
    ...(controls.signal ? { signal: controls.signal } : {}), ...(controls.budgetMs ? { budgetMs: controls.budgetMs } : {}),
    ...(controls.privateInputs ? { privateInputs: controls.privateInputs } : {}), ...(controls.materialRoots ? { materialRoots: controls.materialRoots } : {}) });
  if (result.status === 'invalid') {
    const reason = result.diagnostics[0]?.reason;
    if (reason === 'project-absolute' || reason === 'project-directory')
      return invalid([{ path: '/target/project', reason: 'project', message: 'The project folder is not usable.' }]);
    return invalid(result.diagnostics.map(item => ({ path: (item.path ?? '').replace(/^\/policy\/selections\/(\d+)\/recipe\/inline/, '/changes/$1/change'),
      reason: item.reason, message: item.message })));
  }
  const op = (id: string) => id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  return conclude({ schema: FILE_CHECK, status: 'ok', request: 'change', package: identity, authority: 'not-evaluated',
    targets: result.targets.map(target => ({ id: target.id, steps: target.operationIds.map(op), managementIds: [...new Set(target.selectionIds)],
      target: target.target === null ? null : { root: target.target.root === 'project' ? 'project' : 'user', path: target.target.path },
      outcome: target.outcome, reason: target.reason })),
    checks: result.checks, notChecked: result.notChecked, diagnostics: result.diagnostics.map(({ code, reason, message }) => ({ code, reason, message })),
    limits: result.limits }, result.status === 'cancelled');
}
