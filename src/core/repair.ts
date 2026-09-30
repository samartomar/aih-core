import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contractSupport as harnessSupport, repairIndex } from '../harness/contracts.mjs';
import { assessRepairCandidate, assessRepairObservations, getRepairRecipe, prepareRepairDefinition, repairObservationRequests } from '../harness/runtime.mjs';
import { distributionManifest, installedDistribution } from './internal/installed-distribution.js';
import { validateRecipe } from './contracts.js';
import { prepare as preparePolicy, apply as applyPolicy, dataObject, validateControls } from './recipe-engine.js';
import { canonicalJson } from './internal/canonical.js';
import { readRegularFile, readRegularFileWithStats } from './internal/fsxn.js';
import { pathPins, pinsMatch, projectRoot, sha256, validSegment } from './internal/host-files.js';
import { resolveExecutable, executablePinsMatch } from './internal/approved-process.js';
import { stateRoot, writeHistory } from './internal/state.js';
import { cloneJsonValueStructureV1 } from './internal/strict-json.js';
import type { Diagnostic, Recipe } from './types.js';
import type { Authorization, HostControls, PreparationResult, PreparedHandle, PreparedReview, RunResult } from './host-types.js';

export interface RepairRequest {
  useCase: 'repair';
  repairs: [{ id: string; targets: string[]; inputs: Record<string, string | boolean | number> }];
  network?: 'declared' | 'off';
  resolutions?: { selectionId: string; operationId: string; choice: 'replace' | 'adopt'; observedSha256: string | null }[];
}

interface RepairState {
  policyHandle: PreparedHandle; policyReviewDigest: string; publicReviewDigest: string;
  id: string; variantRef: string;
  sources: Record<string, { path: string; pins: ReturnType<typeof pathPins>; sha256: string; maxBytes: number }>;
  configs: Record<string, { path: string; maxBytes: number; pins: ReturnType<typeof pathPins>; sha256: string | null }>;
  executables: Record<string, { name: string; path: string | null; pins: ReturnType<typeof pathPins>; sha256: string | null }>;
  helperSha256: string; targets: string[]; fingerprints: string[]; offlineVerification: readonly { target: string; operationId: string; checkId: string }[];
  offline: boolean; observations: { id: string; operationId: string; raw: string; expectedRaw: string }[]; managedPath: string;
  ordinaryInputs: Record<string, string | boolean | number>;
  candidate?: Awaited<ReturnType<typeof assessRepairCandidate>>;
  inputs: NonNullable<RunResult['inputs']>;
}
const handles = new WeakMap<PreparedHandle, RepairState>();
const disabled = { status: 'disabled', reason: 'logging-off' } as const;
const diagnostic = (code: string, reason: string, message: string): Diagnostic => ({ code, reason, message });
const hash = (value: unknown) => sha256(canonicalJson(value));
function historySafe(value: unknown): unknown {
  let text = JSON.stringify(value);
  const home = homedir();
  for (const path of [home, home.replaceAll('\\', '/')]) text = text.split(JSON.stringify(path).slice(1, -1)).join('<home>');
  return JSON.parse(text);
}
function recordPreparation(result: PreparationResult, controls: HostControls): PreparationResult {
  const logging = controls.logging ?? 'on';
  const record = { ...result, prepared: undefined };
  result.record = writeHistory(result.runId, historySafe(record), logging);
  if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason,
    'Routine history could not be saved; the returned review remains available.'));
  return result;
}
function recordRun(result: RunResult, controls: HostControls): RunResult {
  result.effectiveOptions.logging = { value: controls.logging ?? 'on', origin: controls.logging === undefined ? 'default' : 'explicit' };
  result.record = writeHistory(result.runId, historySafe(result), result.effectiveOptions.logging.value);
  if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason,
    'Routine history could not be saved; the returned outcomes remain available.'));
  return result;
}

function installedHelperSha256(id: string): string {
  const packageFile = distributionManifest;
  const root = dirname(packageFile);
  const actual = installedDistribution();
  if (actual.name !== harnessSupport.package.name || actual.version !== harnessSupport.package.version ||
      !harnessSupport.contracts.includes('urn:aihq:harness:repair:1.0.0') ||
      !repairIndex.some(item => item.id === id)) throw new Error('harness-unsupported');
  const digest = createHash('sha256');
  for (const name of ['package.json', 'dist/distribution.mjs', 'dist/harness/contracts.mjs',
    'dist/harness/runtime.mjs', 'dist/harness/ca.mjs', 'dist/harness/candidate.mjs',
    'dist/harness/user-trust-definitions.mjs', 'dist/harness/user-trust.mjs']) {
    const bytes = readRegularFile(join(root, name), { maxBytes: 2_000_000 });
    if (!bytes) throw new Error('harness-unavailable');
    digest.update(name).update('\0').update(bytes).update('\0');
  }
  return digest.digest('hex');
}

function capturedSource(path: string, maxBytes: number) {
  const pins = pathPins(path);
  const first = readRegularFileWithStats(path, { maxBytes });
  if (!first || !pinsMatch(pins)) {
    try { if (lstatSync(path).size > maxBytes) throw new Error('source-byte-limit'); }
    catch (error) { if (error instanceof Error && error.message === 'source-byte-limit') throw error; }
    throw new Error('source-unavailable');
  }
  const second = readRegularFileWithStats(path, { maxBytes });
  if (!second || !pinsMatch(pins) || !first.contents.equals(second.contents) ||
      first.identity.dev !== second.identity.dev || first.identity.ino !== second.identity.ino)
    throw new Error('source-changed');
  return { bytes: first.contents, pins, sha256: sha256(first.contents) };
}

interface VariantMetadata {
  configFiles?: readonly { operationId: string; target: { root: 'userHome'; segments: readonly { literal: string }[] }; maxBytes: number }[];
  executableBindings?: readonly { name: string; pathInput: string }[];
}

/** Portable variant metadata declares scoped user configuration inputs; Core captures their exact bytes. */
function captureConfigFiles(variant: VariantMetadata) {
  const list = variant.configFiles ?? [];
  if (!Array.isArray(list) || list.length > 16) throw new Error('repair-definition');
  const captures: RepairState['configs'] = {};
  const snapshots: Record<string, Uint8Array> = {};
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof entry.operationId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.operationId) || Object.hasOwn(captures, entry.operationId))
      throw new Error('repair-definition');
    const target = entry.target;
    if (!target || typeof target !== 'object' || target.root !== 'userHome' ||
        !Array.isArray(target.segments) || !target.segments.length || target.segments.length > 8 ||
        target.segments.some((slot: { literal: string }) => !slot || typeof slot !== 'object' ||
          Reflect.ownKeys(slot).length !== 1 || typeof slot.literal !== 'string' || !validSegment(slot.literal)))
      throw new Error('repair-definition');
    if (!Number.isSafeInteger(entry.maxBytes) || entry.maxBytes < 1 || entry.maxBytes > 16 * 1024 * 1024)
      throw new Error('repair-definition');
    const path = join(homedir(), ...target.segments.map((slot: { literal: string }) => slot.literal));
    const pins = pathPins(path);
    if (pins.at(-1)?.identity === 'absent') {
      captures[entry.operationId] = { path, maxBytes: entry.maxBytes, pins, sha256: null };
      continue;
    }
    const first = readRegularFileWithStats(path, { maxBytes: entry.maxBytes });
    if (!first || !pinsMatch(pins)) throw new Error('config-unavailable');
    const second = readRegularFileWithStats(path, { maxBytes: entry.maxBytes });
    if (!second || !pinsMatch(pins) || !first.contents.equals(second.contents) ||
        first.identity.dev !== second.identity.dev || first.identity.ino !== second.identity.ino)
      throw new Error('config-unavailable');
    captures[entry.operationId] = { path, maxBytes: entry.maxBytes, pins, sha256: sha256(first.contents) };
    snapshots[entry.operationId] = first.contents;
  }
  return { captures, snapshots };
}

/** Portable variant metadata declares reviewed executable prerequisites; Core resolves and pins their bytes. */
function resolveExecutableBindings(variant: VariantMetadata) {
  const list = variant.executableBindings ?? [];
  if (!Array.isArray(list) || list.length > 16) throw new Error('repair-definition');
  const executables: RepairState['executables'] = {};
  const paths: Record<string, string> = {};
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name) ||
        typeof entry.pathInput !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.pathInput) ||
        Object.hasOwn(executables, entry.pathInput)) throw new Error('repair-definition');
    const resolved = resolveExecutable(entry.name);
    executables[entry.pathInput] = { name: entry.name, path: resolved?.path ?? null,
      pins: resolved?.pins ?? [], sha256: resolved?.sha256 ?? null };
    paths[entry.pathInput] = resolved?.path ?? '';
  }
  return { executables, paths };
}

function observeRepair(id: string, targets: string[], variantRef: string) {
  return repairObservationRequests({ id, targets, variantRef }).map(probe => {
    if (!isAbsolute(probe.executable) || probe.timeoutMs < 1 || probe.timeoutMs > 30_000 ||
        probe.maxOutputBytes < 1 || probe.maxOutputBytes > 65_536 || probe.args.some(arg => typeof arg !== 'string'))
      throw new Error('observation-unsupported');
    const output = spawnSync(probe.executable, probe.args,
      { encoding: 'utf8', timeout: probe.timeoutMs, maxBuffer: probe.maxOutputBytes, windowsHide: true, shell: false });
    if (output.error || output.status !== 0 || Buffer.byteLength(output.stdout) > probe.maxOutputBytes)
      throw new Error('observation-unavailable');
    return { id: probe.id, output: output.stdout };
  });
}

function validateRequest(request: RepairRequest) {
  dataObject(request, ['useCase', 'repairs', 'network', 'resolutions']);
  if (request.useCase !== 'repair' || !Array.isArray(request.repairs) || request.repairs.length !== 1 ||
      request.network !== undefined && !['declared', 'off'].includes(request.network)) throw new Error('repair-request');
  const repair = request.repairs[0]!;
  dataObject(repair, ['id', 'targets', 'inputs']);
  const definition = repairIndex.find(item => item.id === repair.id);
  if (!definition) throw new Error('repair-unsupported');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(definition.managementId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(definition.materialName) ||
      !Number.isSafeInteger(definition.limits.sourceBytes) || definition.limits.sourceBytes < 1 ||
      definition.limits.sourceBytes > 16 * 1024 * 1024) throw new Error('repair-definition');
  if (!Array.isArray(repair.targets) || !repair.targets.length ||
      repair.targets.some(id => !definition.targets.includes(id)) || new Set(repair.targets).size !== repair.targets.length)
    throw new Error('repair-request');
  const variants = definition.variants.filter(item => item.os === process.platform && item.architectures.includes(process.arch) &&
    item.network === (request.network ?? 'declared') && item.targets.length === repair.targets.length &&
    item.targets.every(target => repair.targets.includes(target)));
  if (!variants.length || variants.length > 1 && !definition.candidateDiagnostic ||
      definition.candidateDiagnostic && variants.some(item => !item.candidate))
    throw new Error(variants.length ? 'repair-variant-ambiguous' : 'repair-variant-unavailable');
  dataObject(repair.inputs, Object.keys(definition.inputs));
  if (Object.keys(repair.inputs).some(key => !Object.hasOwn(definition.inputs, key)) ||
      Object.entries(definition.inputs).some(([key, declaration]) => declaration.required && !Object.hasOwn(repair.inputs, key)))
    throw new Error('repair-request');
  for (const [key, declaration] of Object.entries(definition.inputs)) {
    const value = repair.inputs[key];
    if (value === undefined && !declaration.required) continue;
    if (declaration.type === 'file' && (typeof value !== 'string' || !isAbsolute(value) ||
        value.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value))) throw new Error('repair-request');
    if (declaration.type === 'string' && (typeof value !== 'string' ||
        value.length > (declaration.maxLength ?? 4096) || /[\p{Cc}\p{Cf}]/u.test(value))) throw new Error('repair-request');
    if (declaration.type === 'boolean' && typeof value !== 'boolean') throw new Error('repair-request');
    if (declaration.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('repair-request');
  }
  if (request.resolutions !== undefined) {
    if (!Array.isArray(request.resolutions)) throw new Error('resolution-invalid');
    for (const item of request.resolutions) dataObject(item, ['selectionId', 'operationId', 'choice', 'observedSha256']);
  }
  return { definition, variants };
}

export async function prepareRepair(request: RepairRequest, controls: HostControls = {}): Promise<PreparationResult> {
  const runId = randomUUID();
  let safeControls: HostControls = { logging: 'off' };
  const fail = (status: PreparationResult['status'], code: string, reason: string): PreparationResult => recordPreparation({
    status, runId, diagnostics: [{ ...diagnostic(code, reason, 'Prepare again after resolving the reported repair input or state.'),
      ...(reason === 'source-byte-limit' ? { assessedBlocks: 0, assessmentLimit: 'source-byte-limit' } : {}) }], record: disabled
  }, safeControls);
  try {
    validateControls(controls);
    request = cloneJsonValueStructureV1(request, 'repair request', 32);
    const { definition, variants } = validateRequest(request);
    safeControls = controls;
    if (controls.signal?.aborted) return fail('cancelled', 'CANCELLED', 'cancelled');
    const selected = request.repairs[0]!;
    const helperSha256 = installedHelperSha256(selected.id);
    const ordinaryInputs = Object.fromEntries(Object.entries(selected.inputs).filter(([key]) =>
      definition.inputs[key]?.type !== 'file'));
    const candidate = definition.candidateDiagnostic ? await assessRepairCandidate({ id: selected.id, inputs: ordinaryInputs },
      { signal: controls.signal, budgetMs: 120000 }) : undefined;
    if (candidate?.kind === 'unresolved') return fail(candidate.reason === 'cancelled' ? 'cancelled' : 'blocked',
      ['deadline', 'root-count', 'root-bytes', 'peer-count', 'candidate-count', 'output-bytes'].includes(candidate.reason) ? 'DIAGNOSTIC_LIMIT' :
      candidate.reason === 'cancelled' ? 'CANCELLED' : 'PREREQUISITE_UNAVAILABLE', candidate.reason);
    const matching = variants.filter(item => item.candidate === candidate?.kind);
    const variant = matching.length === 1 ? matching[0]! : !candidate && variants.length === 1 ? variants[0]! : undefined;
    if (!variant) return fail('invalid', 'SCHEMA_UNSUPPORTED', 'repair-variant-unavailable');
    const sources = Object.fromEntries(Object.entries(selected.inputs).filter(([key]) =>
      definition.inputs[key]?.type === 'file').map(([key, path]) =>
      [key, { path: path as string, maxBytes: definition.limits.sourceBytes,
        ...capturedSource(path as string, definition.limits.sourceBytes) }]));
    const files = Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.bytes]));
    const initial = prepareRepairDefinition({ id: selected.id, variantRef: variant.recipeRef,
      targets: selected.targets, files, ordinaryInputs, candidate, validateOnly: true });
    if (initial.status !== 'completed') return recordPreparation({ status: 'invalid', runId,
      diagnostics: initial.diagnostics.map(item => ({ code: item.code, reason: item.reason,
        message: item.message, ...(item.block === undefined ? {} : { block: item.block, path: `/blocks/${item.block}` }),
        ...(item.offset === undefined ? {} : { offset: item.offset }),
        assessedBlocks: initial.assessedBlocks,
        ...(initial.assessmentLimit === undefined ? {} : { assessmentLimit: initial.assessmentLimit }),
        ...(item.guidance === undefined ? {} : { guidance: item.guidance }) })), record: disabled }, controls);
    const home = projectRoot(homedir());
    const selectionKey = sha256(`${home}\0user\0${definition.managementId}`);
    const managedPath = join(stateRoot(), 'content', selectionKey, definition.materialName);
    const observations = assessRepairObservations({ id: selected.id, managedPath, variantRef: variant.recipeRef,
      observations: observeRepair(selected.id, selected.targets, variant.recipeRef) });
    const resolutions = [...request.resolutions ?? []];
    for (const observation of observations) {
      const choice = resolutions.find(item => item.selectionId === 'trust' && item.operationId === observation.operationId);
      if (choice && !observation.conflict) return fail('invalid', 'INPUT_INVALID', 'resolution-invalid');
      if (observation.conflict) {
        if (!choice) return fail('blocked', 'STATE_CONFLICT', 'existing-target-observation');
        if (choice.choice !== 'replace' || choice.observedSha256 !== sha256(observation.observedValue!))
          return fail('invalid', 'INPUT_INVALID', 'resolution-stale');
      }
    }
    const policyResolutions = resolutions.filter(item => !observations.some(obs =>
      item.selectionId === 'trust' && item.operationId === obs.operationId));
    const existing = readRegularFile(managedPath, { maxBytes: 16 * 1024 * 1024 });
    const { captures: configs, snapshots: configSnapshots } = captureConfigFiles(variant);
    const { executables, paths: executablePaths } = resolveExecutableBindings(variant);
    const rendered = prepareRepairDefinition({ id: selected.id, variantRef: variant.recipeRef,
      targets: selected.targets, files, ordinaryInputs, existing,
      ...(variant.configFiles?.length ? { configSnapshots } : {}),
      ...(variant.executableBindings?.length ? { executablePaths } : {}),
      candidate, managedPath, offline: request.network === 'off' });
    if (rendered.status !== 'completed' || !rendered.bindings)
      return recordPreparation({ status: rendered.status === 'completed' ? 'invalid' : rendered.status, runId, diagnostics: rendered.status === 'completed' ?
        [diagnostic('INPUT_INVALID', 'repair-render', 'The installed repair returned no bindings.')] : rendered.diagnostics,
        record: disabled }, controls);
    const bundle = rendered.bundle;
    const recipe = getRepairRecipe(variant.recipeRef) as Recipe | undefined;
    if (!recipe) return fail('invalid', 'SCHEMA_UNSUPPORTED', 'recipe-unavailable');
    const validation = validateRecipe(recipe);
    if (!validation.valid) return recordPreparation({ status: 'invalid', runId, diagnostics: validation.diagnostics, record: disabled }, controls);
    const publicNames = Object.keys(recipe.inputs).filter(name => !recipe.inputs[name]?.sensitive);
    const sensitiveNames = Object.keys(recipe.inputs).filter(name => recipe.inputs[name]?.sensitive);
    const privateBindings = rendered.privateBindings ?? {};
    if (typeof privateBindings !== 'object' || !privateBindings || Array.isArray(privateBindings))
      return fail('invalid', 'INPUT_INVALID', 'repair-bindings');
    const suppliedPrivate: Record<string, string> = { ...privateBindings };
    if (bundle !== undefined) suppliedPrivate.bundle = bundle;
    if (Object.keys(rendered.bindings).length !== publicNames.length ||
        Object.keys(rendered.bindings).some(name => !publicNames.includes(name)) ||
        Object.keys(privateBindings).some(name => name === 'bundle' || !sensitiveNames.includes(name)) ||
        Object.keys(suppliedPrivate).length !== sensitiveNames.length ||
        sensitiveNames.some(name => typeof suppliedPrivate[name] !== 'string'))
      return fail('invalid', 'INPUT_INVALID', 'repair-bindings');
    const prepared = await preparePolicy({ useCase: 'policy', target: { project: home },
      policy: { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
        id: 'trust', managementId: definition.managementId, scope: 'user', configuration: rendered.bindings,
        requires: [], recipe: { inline: recipe }
      }] }, ...(policyResolutions.length ? { resolutions: policyResolutions } : {}) },
      { ...controls, logging: 'off', ...(sensitiveNames.length ? { privateInputs: { trust: suppliedPrivate } } : {}) });
    if (!prepared.review || !prepared.prepared) return recordPreparation(prepared, controls);
    const sourceBindings = Object.fromEntries(Object.entries(sources).map(([key, source]) =>
      [key, { sha256: source.sha256, pins: source.pins }]));
    const inputs = { sourceSha256: hash(candidate ? { sourceBindings, candidate } : sourceBindings),
      certificates: rendered.fingerprints,
      ...(candidate ? { candidateKind: candidate.kind } : {}),
      helperSha256, package: harnessSupport.package };
    const publicReviewDigest = hash({ policyReviewDigest: prepared.review.reviewDigest,
      variantRef: variant.recipeRef, sourceBindings, ordinaryInputs, helperSha256,
      configBindings: Object.fromEntries(Object.entries(configs).map(([key, item]) =>
        [key, { sha256: item.sha256, pins: item.pins }])),
      executableBindingDigests: Object.fromEntries(Object.entries(executables).map(([key, item]) =>
        [key, { path: item.path, sha256: item.sha256 }])),
      fingerprints: rendered.fingerprints, evaluatedAt: rendered.evaluatedAt,
      observations: observations.map(item => ({ id: item.id, raw: item.raw })) });
    const review: PreparedReview = { ...prepared.review, useCase: 'repair', mode: 'standalone',
      target: { scope: 'user', project: home }, inputs,
      observations: [...prepared.review.observations,
        { id: candidate ? 'os-trust-candidate' : 'supplied-ca', reason: candidate ?
          `${candidate.kind}; ${candidate.origins.join(', ')}; ${candidate.probes} probes` :
          `${rendered.count} certificates; ${rendered.duplicates} duplicates; ${rendered.evaluatedAt}` },
        { id: 'harness-helper', reason: `sha256:${helperSha256}` },
        ...observations.map(item => ({ id: item.id, reason: item.reason })),
        ...(request.network === 'off' ? definition.offlineVerification.filter(item => selected.targets.includes(item.target))
          .map(item => ({ id: item.checkId, reason: 'skipped-offline' })) : [])],
      effectiveOptions: { ...prepared.review.effectiveOptions,
        logging: { value: controls.logging ?? 'on', origin: controls.logging === undefined ? 'default' : 'explicit' } },
      reviewDigest: publicReviewDigest };
    const handle = Object.freeze({}) as PreparedHandle;
    handles.set(handle, { policyHandle: prepared.prepared, policyReviewDigest: prepared.review.reviewDigest,
      publicReviewDigest, id: selected.id, variantRef: variant.recipeRef,
      sources: Object.fromEntries(Object.entries(sources).map(([key, source]) =>
        [key, { path: source.path, pins: source.pins, sha256: source.sha256, maxBytes: source.maxBytes }])),
      configs, executables,
      helperSha256, targets: selected.targets, fingerprints: rendered.fingerprints,
      candidate,
      offlineVerification: definition.offlineVerification, offline: request.network === 'off', inputs,
      observations: observations.map(item => ({ id: item.id, operationId: item.operationId,
        raw: item.raw, expectedRaw: item.expectedRaw })), managedPath, ordinaryInputs });
    return recordPreparation({ ...prepared, runId, review, prepared: handle }, controls);
  } catch (error) {
    const reason = error instanceof Error && /^[a-z-]{1,64}$/.test(error.message) ? error.message : 'repair-input';
    return fail('invalid', 'INPUT_INVALID', reason);
  }
}

export function isRepairHandle(value: PreparedHandle): boolean { return !!value && handles.has(value); }

export async function applyRepair(handle: PreparedHandle, authorization: Authorization, controls: HostControls = {}): Promise<RunResult> {
  let safeControls: HostControls = { logging: 'off' };
  const state = handles.get(handle);
  const rejected = (reason: string, code = 'REVIEW_STALE'): RunResult => recordRun({
    schema: 'urn:aihq:core:run-result:1.0.0', runId: randomUUID(), useCase: 'repair', completion: 'rejected',
    effectiveOptions: { logging: { value: safeControls.logging ?? 'on', origin: safeControls.logging === undefined ? 'default' : 'explicit' } },
    operations: [], checks: [], diagnostics: [diagnostic(code, reason, 'Prepare and approve a fresh repair review.')],
    record: disabled, followUp: ['Inspect current trust and prepare again.']
  }, safeControls);
  try {
    validateControls(controls);
    authorization = cloneJsonValueStructureV1(authorization, 'authorization', 8);
    dataObject(authorization, ['reviewDigest', 'origin', 'approved', 'allowPartial']);
    safeControls = controls;
  } catch { return rejected('request-invalid', 'INPUT_INVALID'); }
  if (!state) return rejected('handle-unavailable');
  if (authorization.reviewDigest !== state.publicReviewDigest || authorization.approved !== true ||
      !['interactive', 'automation'].includes(authorization.origin) ||
      authorization.allowPartial !== undefined && typeof authorization.allowPartial !== 'boolean')
    return rejected('approval-required', 'APPROVAL_REQUIRED');
  if (controls.signal?.aborted) return { ...rejected('cancelled', 'CANCELLED'), completion: 'cancelled' };
  let configsValidated = false;
  const revalidate = async () => {
    if (installedHelperSha256(state.id) !== state.helperSha256) throw new Error('review-stale');
    const candidate = state.candidate ? await assessRepairCandidate({ id: state.id, inputs: state.ordinaryInputs },
      { signal: controls.signal, budgetMs: 120000 }) : undefined;
    if (controls.signal?.aborted || candidate?.kind === 'unresolved' && candidate.reason === 'cancelled')
      throw new Error('cancelled');
    if (installedHelperSha256(state.id) !== state.helperSha256) throw new Error('review-stale');
    const stableCandidate = (value: typeof candidate) => value?.kind === 'extra-ca' ?
      { kind: value.kind, origins: value.origins, certs: value.certs } : value?.kind === 'system-ca' ?
      { kind: value.kind, origins: value.origins } : value;
    if (state.candidate && (candidate?.kind === 'unresolved' || hash(stableCandidate(candidate)) !== hash(stableCandidate(state.candidate))))
      throw new Error('review-stale');
    const observed = assessRepairObservations({ id: state.id, managedPath: state.managedPath, variantRef: state.variantRef,
      observations: observeRepair(state.id, state.targets, state.variantRef) });
    if (observed.length !== state.observations.length || observed.some((item, index) =>
        item.id !== state.observations[index]?.id ||
        ![state.observations[index]?.raw, state.observations[index]?.expectedRaw].includes(item.raw)))
      throw new Error('review-stale');
    const files: Record<string, Uint8Array> = {};
    for (const [key, source] of Object.entries(state.sources)) {
      if (!pinsMatch(source.pins)) throw new Error('review-stale');
      const captured = capturedSource(source.path, source.maxBytes);
      if (captured.sha256 !== source.sha256) throw new Error('review-stale');
      files[key] = captured.bytes;
    }
    // Bind the transform snapshots before any effect. The policy engine checks
    // each destination's reviewed bytes/pins again immediately before writing;
    // later effects must not reject a preceding authorized config rewrite.
    if (!configsValidated) {
      for (const config of Object.values(state.configs)) {
        if (!pinsMatch(config.pins)) throw new Error('review-stale');
        if (config.sha256 === null) continue;
        const captured = readRegularFileWithStats(config.path, { maxBytes: config.maxBytes });
        if (!captured || sha256(captured.contents) !== config.sha256 || !pinsMatch(config.pins)) throw new Error('review-stale');
      }
    }
    for (const executable of Object.values(state.executables)) {
      if (executable.path === null) {
        if (resolveExecutable(executable.name)) throw new Error('review-stale');
        continue;
      }
      const live = executablePinsMatch(executable.pins) ?
        readRegularFileWithStats(executable.path, { maxBytes: 512 * 1024 * 1024 }) : undefined;
      if (!live || sha256(live.contents) !== executable.sha256 || !executablePinsMatch(executable.pins))
        throw new Error('review-stale');
    }
    const accepted = prepareRepairDefinition({ id: state.id, variantRef: state.variantRef, targets: state.targets, files,
      ordinaryInputs: state.ordinaryInputs,
      candidate: candidate?.kind === 'unresolved' ? undefined : candidate, validateOnly: true });
    if (accepted.status !== 'completed') throw new Error('certificate-invalid');
    if (hash(accepted.fingerprints) !== hash(state.fingerprints)) throw new Error('review-stale');
    configsValidated = true;
  };
  const result = await applyPolicy(state.policyHandle, { ...authorization, reviewDigest: state.policyReviewDigest },
    { ...controls, logging: 'off' }, revalidate);
  handles.delete(handle);
  if (state.offline) {
    for (const pending of state.offlineVerification.filter(item => state.targets.includes(item.target))) {
      const operation = result.operations.find(item => item.id === `trust/${pending.operationId}`);
      if (operation && ['applied', 'already-satisfied'].includes(operation.application)) {
        operation.verification = { status: 'unavailable', reason: 'offline' };
        result.checks.push({ id: `trust/${pending.checkId}`, operationId: operation.id, status: 'skipped', reason: 'offline' });
        result.completion = 'incomplete';
        result.diagnostics.push(diagnostic('VERIFICATION_UNAVAILABLE', 'offline',
          `${pending.target} network verification was suppressed by the selected offline mode.`));
      }
    }
  }
  return recordRun({ ...result, useCase: 'repair', inputs: state.inputs,
    followUp: [...result.followUp,
      'The managed copy remains after the original CA file changes; repeat repair to update it.',
      'User processes may require restart or explicit environment inheritance.'] }, controls);
}
