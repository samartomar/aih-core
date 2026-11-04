// Prepare for a plan request (contract 7, 8.1): admit the request, lower its steps into the one existing engine, and
// present the engine's review as a frozen 0.1.0 review whose digest the person approves.
import { reviewVersions } from '../inspect.js';
import { knownCli } from './tools.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { prepare as prepareEngine, type EngineExtension, type ObservedStep } from '../recipe-engine.js';
import { blockMemberBytes, configMemberBytes, tomlEntryPaths, tomlEntryText } from '../internal/recipe-editors.js';
import { canonicalJson, codeUnitCompare } from '../internal/canonical.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState, ownershipInventory, readOwnership } from '../internal/state.js';
import { checkPlanRequest, type CheckedStep } from './request.js';
import { register, type ProgramCheck, type StepRef } from './handles.js';
import { resolveExecutable } from '../internal/approved-process.js';
import { claimIdentity } from '../internal/recipe-lifecycle.js';
import { claimKey, managementIdOf } from './claims.js';
import { inspectLink, linkRecordBytes, linkRecordPath, missingParents, placeLink } from './links.js';
import type { LinkFacts } from '../internal/custody-items.js';
import type { LoweredPlugin } from './steps/types.js';
import type { PluginFacts } from '../internal/custody-items.js';
import { proveOrigin } from './origin.js';
import { bindPrivateInputs } from './inputs.js';
import { limitValue } from './limits.js';
import { acquisition } from './acquire/effect.js';
import { probe } from './acquire/download.js';
import { discoverInterpreter } from './acquire/interpreter.js';
import { FALLBACK_REASONS, type AcquireFacts, type InstalledInterpreter } from './acquire/types.js';
import type { PlanItemFacts } from '../internal/custody-items.js';
import type { Lowered, LoweredMerge } from './steps/types.js';
import type { ExecutionPolicy, Json, Recipe } from '../types.js';
import type { PreparationResult } from '../host-types.js';
import { REVIEW, type PlanControls, type PlanPreparation, type Problem, type Review, type ReviewConflict, type ReviewStep } from './types.js';

export const FAILURE_RULE = 'A failed step stops the rest of its item and every item that depends on it; unrelated items continue.';
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const RECIPE = 'urn:aihq:core:recipe:1.0.0';
const POLICY = 'urn:aihq:core:execution-policy:1.0.0';

/** Validates plan controls; only cancellation and logging reach the engine. */
export function planControls(controls: unknown): PlanControls | undefined {
  if (controls === undefined) return {};
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) return undefined;
  const value = controls as PlanControls;
  if (Object.keys(value).some(key => !['signal', 'logging', 'privateInputs', 'catalog', 'onProgress'].includes(key))) return undefined;
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) return undefined;
  if (value.logging !== undefined && !['on', 'off'].includes(value.logging)) return undefined;
  if (value.catalog !== undefined) {
    const catalog = value.catalog;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || typeof catalog.version !== 'string' ||
        catalog.version.length === 0 || catalog.version.length > 64 ||
        Object.keys(catalog).some(key => !['version', 'renderStep', 'planRecipe'].includes(key)) ||
        catalog.renderStep !== undefined && typeof catalog.renderStep !== 'function' ||
        catalog.planRecipe !== undefined && typeof catalog.planRecipe !== 'function') return undefined;
  }
  if (value.onProgress !== undefined && typeof value.onProgress !== 'function') return undefined;
  return value;
}
export const engineControls = (controls: PlanControls) => ({ ...(controls.signal ? { signal: controls.signal } : {}),
  ...(controls.logging ? { logging: controls.logging } : {}) });
export const problemsOf = (result: PreparationResult): Problem[] =>
  result.diagnostics.map(item => ({ path: item.path ?? '', reason: item.reason, message: item.message }));
/** The review digest: the presented review together with the engine review it carries out. */
export const digestOf = (review: Omit<Review, 'reviewDigest'>, engineDigest: string): string =>
  sha256(canonicalJson({ review: review as unknown as Json, engineDigest }));

/** The supplied profiles for a group's CLIs and every profile its renders record, by id. */
function profilesOf(supplied: { id: string; version: string | number }[], clis: string[], steps: CheckedStep[]) {
  const ids = new Set([...clis, ...steps.flatMap(step => (step.lowered.kind === 'write' ? step.lowered.profiles ?? [] : []).map(profile => profile.id))]);
  return supplied.filter(profile => ids.has(profile.id)).map(profile => ({ ...profile })).sort((a, b) => codeUnitCompare(a.id, b.id));
}

/** One claim (C28, C48): a management id and scope, made for one CLI (or none recorded) from one project. */
interface Group { selectionId: string; managementId: string; scope: 'project' | 'user'; cli: string | null; key: string; steps: CheckedStep[] }

export async function preparePlan(input: unknown, rawControls?: unknown): Promise<PlanPreparation> {
  forgetProvenState();
  const controls = planControls(rawControls);
  if (!controls) return { status: 'invalid', problems: [{ path: '', reason: 'controls', message: 'The plan controls are not valid.' }] };
  if (controls.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  const admitted = await checkPlanRequest(input, controls);
  if ('status' in admitted) return admitted;
  const { checked } = admitted;
  const request = checked.document;
  const proven = await proveOrigin(request, controls);
  if ('status' in proven) return proven;
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  let project: string | null;
  try { project = typeof request.target.project === 'string' ? projectRoot(request.target.project) : null; }
  catch { return { status: 'invalid', problems: [{ path: '/target/project', reason: 'project', message: 'The project folder is not usable.' }] }; }

  // AI setups (8.1, C36, C46): a download this host's trust rejects is refused now, naming the repair; a Python tool's
  // installed interpreter inside its range is found now, so the review shows both branches.
  const installed = new Map<number, InstalledInterpreter | null>();
  const probed = new Map<string, 'ok' | 'tls-untrusted'>();
  for (const step of checked.steps) {
    const spec = step.lowered.acquire;
    if (!spec || step.skipped) continue;
    for (const item of [spec.artifact, ...spec.closure, ...(spec.interpreter ? [spec.interpreter.fallback] : [])]) {
      const origin = new URL(item.url).origin;
      if (!probed.has(origin)) probed.set(origin, await probe(item.url, controls.signal));
      if (controls.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
      if (probed.get(origin) === 'tls-untrusted') return { status: 'refused', code: 'tls-untrusted', step: step.index, repair: 'node-npm-ca',
        reason: `Step ${step.index} downloads from ${origin}, whose certificate this machine does not trust. Run the \`node-npm-ca\` repair, then Prepare again.` };
    }
    if (spec.interpreter) installed.set(step.index, await discoverInterpreter(spec.interpreter.range, controls.signal));
  }
  const acquired = new Map<number, AcquireFacts>();
  const effects = new Map<string, { run(signal?: AbortSignal): Promise<{ status: 'passed' | 'failed' | 'cancelled'; reason: string; effectsUncertain: boolean; facts?: Json }> }>();
  // Acquisition progress goes to the Apply call's `onProgress` (C38), which Apply sets here.
  const sink: { onProgress?: (event: Json) => void } = {};
  const progress = (event: Json) => { try { sink.onProgress?.(event); } catch { /* a caller's progress handler never stops the run */ } };
  // Interpreter facts an earlier install recorded, kept when the same AI setup is already in place.
  const recorded = new Map<string, NonNullable<PlanItemFacts['aiSetup']>>();
  if (checked.steps.some(step => step.lowered.acquire)) for (const item of Object.values(readOwnership(home).value.items ?? {}))
    if (item.scope === 'user' && item.plan?.aiSetup) recorded.set(item.plan.managementId ?? item.managementId, item.plan.aiSetup);
  // Items that depend on another planned item (Catalog `dependencies`, or the MCP item that starts an AI setup's
  // executable) are not attempted when it fails (C60).
  const dependencies = new Map<string, Set<string>>();
  const needs = (id: string, on: string) => { const set = dependencies.get(id) ?? new Set<string>(); set.add(on); dependencies.set(id, set); };
  for (const content of request.contents as unknown as { items?: { id?: unknown; dependencies?: unknown; aiSetup?: { mcpItem?: unknown } }[] }[])
    for (const item of Array.isArray(content.items) ? content.items : []) {
      if (!item || typeof item.id !== 'string') continue;
      for (const dependency of Array.isArray(item.dependencies) ? item.dependencies : []) if (typeof dependency === 'string') needs(item.id, dependency);
      if (typeof item.aiSetup?.mcpItem === 'string') needs(item.aiSetup.mcpItem, item.id);
    }

  // One selection per claim: management id and scope (C48), for each CLI the step records (C28; none recorded is its
  // own unattributed claim, C55), from this project. A place several CLIs share is one member with a claim per CLI.
  const groups = new Map<string, Group>();
  for (const step of checked.steps) if (!step.skipped) for (const managementId of step.lowered.managementIds) {
    const scope = step.lowered.root === 'project' ? 'project' : 'user';
    if (scope === 'project' && project === null) return { status: 'invalid', problems: [{ path: `/plan/plan/${step.index}/root`,
      reason: 'project', message: 'A project-rooted step needs the request to name its project.' }] };
    const served: (string | null)[] = step.lowered.kind === 'plugin' ? [step.lowered.cli] :
      step.lowered.review.clis?.length ? step.lowered.review.clis : [null];
    for (const cli of served) {
      const key = claimKey(managementId, scope, cli, project);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { selectionId: `s${groups.size}`, managementId, scope, cli, key, steps: [] });
      group.steps.push(step);
    }
  }
  const claims = new Map([...groups.values()].map(group => [group.key, group.managementId]));
  // Links (C29): the parent folders Core creates for each, as the first claim recorded them, so whichever claim goes
  // last can remove them; a copy holds the files the plan writes into the linked folder.
  const linkPlans = new Map<number, { facts: LinkFacts; place: 'absent' | 'ours' | 'other'; files: { path: string; bytes: Buffer; executable: boolean }[] }>();
  const recordedLinks = new Map<string, string[]>();
  if (checked.steps.some(step => step.lowered.kind === 'link')) for (const root of [home, ...ownershipInventory().targets])
    for (const item of Object.values(readOwnership(root).value.items ?? {}))
      for (const link of item.plan?.links ?? []) if (!recordedLinks.has(link.path)) recordedLinks.set(link.path, link.created);
  for (const step of checked.steps) {
    const lowered = step.lowered;
    if (lowered.kind !== 'link' || step.skipped) continue;
    const files = lowered.linkType !== 'copy' ? [] : checked.steps.flatMap(other => other.lowered.kind === 'write' && !other.skipped &&
      other.lowered.root === 'user' && other.lowered.path.startsWith(`${lowered.to}/`) ?
      [{ path: `${lowered.path}/${other.lowered.path.slice(lowered.to.length + 1)}`, bytes: other.lowered.bytes, executable: other.lowered.executable }] : []);
    if (lowered.linkType === 'copy' && !files.length) return { status: 'invalid', problems: [{ path: `/plan/plan/${step.index}/to`, reason: 'link-target-unplanned',
      message: `Step ${step.index} copies \`${lowered.to}\`, but the plan writes nothing there.` }] };
    linkPlans.set(step.index, { files, place: lowered.linkType === 'copy' ? 'absent' : inspectLink(home, lowered.path, lowered.to),
      facts: { step: step.index, path: lowered.path, to: lowered.to, linkType: lowered.linkType,
        created: lowered.linkType === 'copy' ? [] : recordedLinks.get(lowered.path) ?? missingParents(home, lowered.path) } });
  }
  /** The last engine operation a step lowers to, which the next step of its claim waits for (C60). */
  const lastOp = (step: CheckedStep): string => step.lowered.kind === 'plugin' ? `step-${step.index}-${step.lowered.commands.length - 1}` :
    step.lowered.kind === 'link' && step.lowered.linkType === 'copy' ? `step-${step.index}-${linkPlans.get(step.index)!.files.length - 1}` : `step-${step.index}`;
  const planClis = [...new Set(checked.profiles.map(profile => profile.id))].sort(codeUnitCompare);
  const supplied = new Map<string, NonNullable<EngineExtension['supplied']> extends ReadonlyMap<string, infer V> ? V : never>();
  const plans = new Map<string, PlanItemFacts>();
  const operations = new Map<string, StepRef>();
  const merges = new Map<string, { format: 'json' | 'toml' | 'markdown'; segments: string[] }>();
  const selections: ExecutionPolicy['selections'] = [];
  // Secret values the plan writes into files: the engine holds them as its own private inputs, so its review details
  // and history redact them (C59); Apply re-checks the caller's private inputs by digest.
  const enginePrivate: Record<string, Record<string, string>> = {};
  const privateValues = [...new Set(checked.steps.flatMap(step => step.lowered.bound?.secretValues ?? []))];
  for (const group of groups.values()) {
    const materials: { id: string; path: string; sha256: string; byteLength: number; bytes: Buffer }[] = [];
    const ops: Recipe['operations'] = group.steps.flatMap((step, at): Recipe['operations'] => {
      const lowered = step.lowered;
      if (lowered.kind === 'plugin') return programOperations(lowered, step.index, group, operations);
      const id = `step-${step.index}`;
      operations.set(`${group.selectionId}/${id}`, { step: step.index, managementId: group.managementId });
      const target = { root: group.scope === 'project' ? 'project' as const : 'userHome' as const, segments: lowered.path.split('/').map(literal => ({ literal })) };
      const prior = group.steps[at - 1];
      // A failed step makes the rest of its item's steps not attempted (C60).
      const requires = !prior ? [] : [lastOp(prior)];
      const base = { id, purpose: lowered.sentence, scope: group.scope, target, requires, checks: [] };
      if (lowered.kind === 'link') {
        const planned = linkPlans.get(step.index)!;
        const write = (path: string, bytes: Buffer, executable: boolean, opId: string, needs: string[], root: 'userHome' | 'userState' = 'userHome') => {
          const material = { id: `m${String(materials.length).padStart(6, '0')}`, path: `plan/${materials.length}`, sha256: sha256(bytes), byteLength: bytes.length, bytes };
          materials.push(material);
          return { ...base, id: opId, requires: needs, kind: 'file.write' as const, material: material.id,
            target: { root, segments: path.split('/').map(literal => ({ literal })) }, ...(executable ? { mode: 0o755 } : {}) };
        };
        if (lowered.linkType !== 'copy') {
          // The link is placed just before its record is written; each claim's record lives in Core's private state (contract 5).
          effects.set(`${group.selectionId}/${id}`, { async run() { return placeLink(home, planned.facts); } });
          return [write(linkRecordPath(lowered.path), linkRecordBytes(lowered.path, lowered.to, lowered.linkType), false, id, requires, 'userState')];
        }
        operations.delete(`${group.selectionId}/${id}`);
        return planned.files.map((file, k) => {
          operations.set(`${group.selectionId}/step-${step.index}-${k}`, { step: step.index, managementId: group.managementId });
          return write(file.path, file.bytes, file.executable, `step-${step.index}-${k}`, k ? [`step-${step.index}-${k - 1}`] : requires);
        });
      }
      if (lowered.kind === 'merge') {
        merges.set(`${group.selectionId}/${id}`, { format: lowered.format, segments: lowered.segments });
        if (lowered.format === 'markdown') return [{ ...base, kind: 'text.block' as const, blockId: lowered.key, ...markers(lowered.key),
          action: 'set' as const, content: { literal: lowered.entry } }];
        return [{ ...base, kind: 'config.entries' as const, format: lowered.format === 'json' ? 'jsonc' as const : 'toml' as const,
          entries: lowered.format === 'json' ? [{ path: lowered.segments, action: 'set' as const, value: { literal: lowered.entry } }] :
            lowered.leaves!.map(leaf => ({ path: [...lowered.segments, ...leaf.path], action: 'set' as const, value: { literal: leaf.value } })) }];
      }
      const material = { id: `m${String(materials.length).padStart(6, '0')}`, path: `plan/${materials.length}`, sha256: sha256(lowered.bytes),
        byteLength: lowered.bytes.length, bytes: lowered.bytes };
      materials.push(material);
      return [{ ...base, kind: 'file.write' as const, material: material.id, ...(lowered.executable ? { mode: 0o755 } : {}) }];
    });
    for (const step of group.steps) if (step.lowered.kind === 'write' && step.lowered.acquire) {
      const run = acquisition(step.lowered.acquire, home, installed.get(step.index) ?? null, progress);
      effects.set(`${group.selectionId}/step-${step.index}`, { async run(signal) {
        const outcome = await run.run(signal);
        if (outcome.status === 'passed' && outcome.facts) acquired.set(step.index, outcome.facts as unknown as AcquireFacts);
        return outcome;
      } });
    }
    const secretValues = [...new Set(group.steps.flatMap(step => step.lowered.bound?.secretValues ?? []))];
    const secretInputs: Recipe['inputs'] = Object.fromEntries(secretValues.map((_value, at) => [`secret-${at}`,
      { type: 'string' as const, required: false, sensitive: true }]));
    if (secretValues.length) enginePrivate[group.selectionId] = Object.fromEntries(secretValues.map((value, at) => [`secret-${at}`, value]));
    const recipe: Recipe = { schema: RECIPE, id: 'plan', description: 'Content from a plan request', inputs: secretInputs,
      materials: materials.map(({ id, path, sha256: digest, byteLength }) => ({ id, path, sha256: digest, byteLength, source: { kind: 'local', input: 'plan' } })),
      targets: [group.scope], prerequisites: [], operations: ops, checks: [] };
    const owned = materials.map(({ id, path, sha256: digest, byteLength }) => Object.freeze({ id, path, sha256: digest, byteLength }));
    const bytes = new Map(materials.map(material => [material.id, material.bytes]));
    supplied.set(group.selectionId, Object.freeze({ materials: Object.freeze(owned),
      readMaterial: (id: string) => { const found = bytes.get(id); return found ? Buffer.from(found) : undefined; },
      recheck: async () => true }));
    // An unattributed claim is held for every CLI the plan was made for (contract 5).
    const clis = group.cli !== null ? [group.cli] : planClis;
    plans.set(group.selectionId, { items: [group.managementId], managementId: group.managementId, cli: group.cli, project, clis, data: request.plan.data === null ? null : { ...request.plan.data },
      origin: proven.origin === 'chosen' ? 'chosen' : structuredClone(proven.origin), catalog: controls.catalog?.version ?? null,
      profiles: profilesOf(checked.profiles, clis, group.steps),
      steps: [...new Set(group.steps.map(step => step.index))].sort((a, b) => a - b),
      ...(group.scope === 'user' && recorded.has(group.managementId) && group.steps.some(step => step.lowered.acquire) ?
        { aiSetup: { ...recorded.get(group.managementId)! } } : {}),
      ...pluginFacts(group.steps), ...localPluginFacts(group.steps),
      ...inputFacts(group.managementId, group.steps), ...slotFacts(group.steps),
      ...linkFacts(group.steps, linkPlans) });
    const requires = [...groups.values()].filter(other => other.managementId !== group.managementId &&
      dependencies.get(group.managementId)?.has(other.managementId)).map(other => other.selectionId);
    selections.push({ id: group.selectionId, managementId: group.key, scope: group.scope, configuration: {}, requires,
      recipe: { inline: recipe } });
  }
  const resolutions = (request.resolutions ?? []).filter(item => item.choice !== 'skip').flatMap(item => {
    // The first claim carrying the step resolves it; the others then share what it wrote.
    const group = [...groups.values()].find(entry => entry.managementId === item.managementId && entry.steps.some(step => step.index === item.step));
    return group ? [{ selectionId: group.selectionId, operationId: `step-${item.step}`, choice: item.choice as 'replace' | 'adopt',
      observedSha256: item.observedSha256 }] : [];
  });
  const observed = new Map<string, ObservedStep>();
  const engine = await prepareEngine({ useCase: 'policy', policy: { schema: POLICY, mode: 'vibe', selections },
    target: { project: project ?? home }, ...(resolutions.length ? { resolutions } : {}) },
    { ...engineControls(controls), ...(Object.keys(enginePrivate).length ? { privateInputs: enginePrivate } : {}) },
    undefined, undefined, undefined, undefined, undefined,
    { supplied, plans, ...(effects.size ? { effects } : {}), merges, observe: facts => { observed.set(`${facts.selectionId}/${facts.operationId}`, facts); } });
  if (engine.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  if (!engine.review) {
    if (engine.diagnostics.some(item => item.reason === 'custody-record-limit'))
      return { status: 'refused', code: 'limit-exceeded', reason: 'The receipts this install needs would pass their limit.',
        limit: 'receipt-bytes', value: limitValue('receipt-bytes') };
    return { status: 'invalid', problems: problemsOf(engine) };
  }

  const hints = new Map((engine.resolutionInputs ?? []).map(item => [`${item.selectionId}/${item.operationId}`, item]));
  const chosen = new Map(resolutions.map(item => [`${item.selectionId}/${item.operationId}`, item.choice]));
  const conflicts: ReviewConflict[] = [];
  const steps: ReviewStep[] = [];
  const programCommands = new Map<number, { executable: string; executableSha256: string }[]>();
  const byStep = new Map<number, CheckedStep>(checked.steps.map(step => [step.index, step]));
  // Codex reads at most 32 KiB of AGENTS.md: the resulting file, your bytes plus every planned block, is checked before any write (C72).
  const guidance = new Map<string, { step: number; path: string; size: number }>();
  // A step carried out for several claims (CLIs) is presented once, as its first claim's operation.
  const presented = new Set<string>();
  for (const operation of engine.review.operations) {
    const ref = operations.get(operation.id);
    if (!ref) continue;
    const step = byStep.get(ref.step as number)!;
    if (step.lowered.kind === 'plugin') {
      if (operation.effects === 'unavailable' || typeof operation.details.executableSha256 !== 'string')
        return { status: 'refused', code: 'program-unavailable', reason: `Step ${ref.step} runs \`${step.lowered.cli}\`, which this host cannot run.`, step: ref.step as number };
      const commands = programCommands.get(ref.step as number) ?? []; programCommands.set(ref.step as number, commands);
      commands.push({ executable: String(operation.details.executable), executableSha256: operation.details.executableSha256 });
      continue;
    }
    const lowered = step.lowered;
    if (presented.has(`${ref.step}\0${ref.managementId}`)) continue;
    presented.add(`${ref.step}\0${ref.managementId}`);
    const facts = observed.get(operation.id);
    const hint = hints.get(operation.id);
    // Identical bytes Core didn't write are still yours until you choose to adopt them.
    const unresolvedAdopt = operation.effects === 'already-satisfied' && !!hint?.availableChoices.includes('adopt') && !chosen.has(operation.id);
    const conflict = operation.effects === 'conflict' || operation.effects === 'unavailable' || unresolvedAdopt;
    const effect: ReviewStep['effect'] = conflict ? 'conflict' :
      ['create-file', 'replace-file', 'already-satisfied'].includes(operation.effects) ? operation.effects as ReviewStep['effect'] : 'unchanged';
    const replacing = !conflict && chosen.get(operation.id) === 'replace' && effect === 'replace-file';
    // A reviewed replace of a value other plans hold displaces them (C61): named in the conflict and in the step.
    const stepRoot = lowered.root === 'project' ? project! : home;
    const displaces = facts?.displacing?.offered ? planIds(stepRoot, request.scope, facts.displacing.holders) : undefined;
    const sentence = replacing && displaces ? `${lowered.sentence}, displacing ${named(displaces)}; removing this install gives their value back` :
      !replacing ? lowered.sentence : lowered.kind === 'merge' ?
      `${lowered.sentence}, replacing your ${lowered.format === 'markdown' ? 'block' : 'entry'}; your original is kept for restore` :
      `${lowered.sentence}, replacing your file; your original is kept for restore`;
    steps.push({ step: ref.step, op: step.op, managementId: ref.managementId, sentence, cantPromise: lowered.cantPromise, effect,
      root: lowered.root, path: lowered.path, ...lowered.review, ...(lowered.kind === 'merge' ? { entry: presentedEntry(lowered) } : acquireReview(step, installed)),
      ...(replacing && displaces ? { displaces } : {}) });
    if (lowered.kind === 'merge' && lowered.codexGuidance && !conflict && facts?.after)
      guidance.set(`${lowered.root}\0${lowered.path}`, { step: ref.step as number, path: lowered.path, size: facts.after.length });
    if (!conflict) continue;
    const before = facts?.before ?? null;
    const reason = facts?.reason;
    // Another plan's value you edited is yours now: never displaced (C58).
    const kept = reason === 'managed-content-changed' || reason === 'shared-member-changed';
    const shown = presentExisting(lowered, before, privateValues);
    if (reason === 'second-displacement') {
      // One live restoration level (C75): a different value over an install that already displaces others is blocked.
      const holders = planIds(stepRoot, request.scope, facts!.displacing!.holders);
      const displaced = planIds(stepRoot, request.scope, facts!.displacing!.displaced);
      conflicts.push({ code: 'STATE_CONFLICT', reason: 'second-displacement', managementId: ref.managementId, step: ref.step, target: lowered.path,
        ...(lowered.kind === 'merge' ? { key: lowered.key } : {}), observedSha256: before === null ? null : sha256(before), existing: shown.text,
        redacted: shown.redacted, choices: [], displacedBy: holders, displaced,
        fix: `${named(holders)} already displaces ${named(displaced)} here, and Core keeps one level of restore. Remove ${named(holders)} through a reviewed removal first, which gives ${named(displaced)} their value back, then prepare this install again.` });
      continue;
    }
    const editor = !!reason && !['existing-content', 'managed-content-changed', 'shared-member-changed', 'shared-member', 'overlapping-member'].includes(reason);
    const choices: ReviewConflict['choices'] = kept ? [] : unresolvedAdopt ? ['adopt', 'skip'] :
      editor ? ['skip'] : [...(hint?.availableChoices ?? []), 'skip'];
    conflicts.push({ code: 'STATE_CONFLICT', reason: kept ? 'managed-content-changed' : 'existing-content', managementId: ref.managementId,
      step: ref.step, target: lowered.path, ...(lowered.kind === 'merge' ? { key: lowered.key } : {}),
      observedSha256: before === null ? null : sha256(before), existing: shown.text, redacted: shown.redacted, choices,
      ...(facts?.stale ? { detail: 'resolution-stale' } : editor ? { detail: reason! } : {}), ...(displaces ? { displaces } : {}) });
  }
  // Something already at a link's place that isn't Core's link is yours: never replaced, offered as skip only.
  for (const step of steps) {
    const planned = step.op === 'link' && step.effect !== 'conflict' ? linkPlans.get(step.step as number) : undefined;
    if (planned?.place !== 'other') continue;
    step.effect = 'conflict';
    conflicts.push({ code: 'STATE_CONFLICT', reason: 'existing-content', managementId: step.managementId, step: step.step, target: planned.facts.path,
      observedSha256: null, existing: null, redacted: [], choices: ['skip'] });
  }
  for (const found of guidance.values()) if (found.size > CODEX_GUIDANCE_BYTES)
    return { status: 'refused', code: 'file-too-large-for-client', step: found.step, file: found.path, size: found.size, value: CODEX_GUIDANCE_BYTES,
      reason: `\`${found.path}\` would be ${found.size} bytes with your bytes and the planned blocks; Codex reads at most ${CODEX_GUIDANCE_BYTES}.` };
  // One review step per plugin step: every exact command with its pinned executable, the undo facts and the check.
  const programs = new Map<number, ProgramCheck>();
  for (const step of checked.steps) {
    const lowered = step.lowered;
    if (lowered.kind !== 'plugin' || step.skipped) continue;
    const pinned = programCommands.get(step.index) ?? [];
    let presence: ReviewStep['presenceCheck'] = 'none';
    if (lowered.presenceCheck !== 'none') {
      const executable = resolveExecutable(lowered.presenceCheck.argv[0]!);
      if (!executable) return { status: 'refused', code: 'program-unavailable',
        reason: `Step ${step.index}'s presence check runs \`${lowered.presenceCheck.argv[0]}\`, which this host cannot run.`, step: step.index };
      presence = { ...lowered.presenceCheck, executable: executable.launchPath, executableSha256: executable.sha256 };
      programs.set(step.index, { executable, argv: lowered.presenceCheck.argv, expect: lowered.presenceCheck.expect,
        cwd: lowered.root === 'project' ? project! : home });
    }
    const interrupted = readOwnership(lowered.root === 'project' ? project! : home).value.items?.[
      claimIdentity(lowered.root, claimKey(lowered.framework, lowered.root, lowered.cli, project), project ?? home)]?.installState === 'interrupted';
    steps.push({ step: step.index, op: step.op, managementId: lowered.framework, sentence: lowered.sentence,
      cantPromise: interrupted ? `${lowered.cantPromise} An earlier run of this install was interrupted, so its effects are uncertain; approving runs it again.` : lowered.cantPromise,
      effect: 'run-program', framework: lowered.framework, cli: lowered.cli, clis: [lowered.cli], plugin: lowered.plugin, commit: lowered.commit,
      contains: lowered.contains, commands: lowered.commands.map((argv, at) => ({ argv, ...pinned[at]! })), undo: lowered.undo,
      presenceCheck: presence, ...(interrupted ? { previous: 'interrupted' as const } : {}) });
  }
  for (const step of checked.steps) if (step.skipped && step.lowered.kind !== 'plugin') for (const managementId of step.lowered.managementIds)
    steps.push({ step: step.index, op: step.op, managementId, sentence: step.lowered.sentence, cantPromise: step.lowered.cantPromise,
      effect: 'skipped', root: step.lowered.root, path: step.lowered.path, ...step.lowered.review,
      ...(step.lowered.kind === 'merge' ? { entry: presentedEntry(step.lowered) } : acquireReview(step, installed)) });
  steps.sort((a, b) => (a.step as number) - (b.step as number) || codeUnitCompare(a.managementId, b.managementId));
  const { plan: _steps, ...reports } = request.plan;
  // D110: a CLI older than its served profile's `checkedWith` is a warning in the review, never a stop.
  const served = (request.profiles as unknown as { id?: unknown }[]).map(item => item?.id).filter((id): id is string => typeof id === 'string' && knownCli(id));
  const compared = await reviewVersions(request.profiles as unknown[], served, controls.signal);
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'plan', scope: request.scope, target: { project },
    plan: reports, origin: proven.origin, originNote: proven.note, steps, conflicts,
    ignoredFiles: checked.ignoredFiles, failureRule: FAILURE_RULE, warnings: [...secretWarnings(checked.steps), ...(compared?.warnings ?? [])],
    ...(compared ? { versions: compared.versions as unknown as Json[] } : {}) };
  const reviewDigest = digestOf(body, engine.review.reviewDigest);
  const review = deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review;
  // Unowned content needs the person's choice and a new Prepare: no handle (section 7).
  if (conflicts.some(conflict => conflict.reason === 'existing-content' || conflict.reason === 'second-displacement')) return { status: 'blocked', review };
  if (!engine.prepared) return { status: 'blocked', review };
  const partial = engine.status === 'partial' || checked.steps.some(step => step.skipped);
  const handle = register({ engine: engine.prepared, engineDigest: engine.review.reviewDigest, enginePartial: engine.status === 'partial',
    reviewDigest, partial, operations, claims, acquired, progress: sink, ...(programs.size ? { programs } : {}),
    privateInputs: bindPrivateInputs(controls.privateInputs),
    request: { value: input, documentDigest: checked.documentDigest, bytesDigest: checked.bytesDigest } });
  return { status: partial ? 'partial' : 'ready', review, handle };
}

/**
 * A plugin step's commands as engine `process.run` operations, run in order in the request scope's root (the project
 * folder or home). Each command needs the one before it; the engine pins each executable by sha256 at Prepare.
 */
function programOperations(lowered: LoweredPlugin, index: number, group: { selectionId: string; managementId: string; scope: 'project' | 'user' },
    operations: Map<string, StepRef>): Recipe['operations'] {
  return lowered.commands.map((argv, at) => {
    const id = `step-${index}-${at}`;
    operations.set(`${group.selectionId}/${id}`, { step: index, managementId: group.managementId, program: true });
    return { id, purpose: `Runs \`${argv.join(' ')}\``, kind: 'process.run', scope: group.scope,
      executable: { name: argv[0]! }, args: argv.slice(1).map(literal => ({ literal })),
      cwd: { root: group.scope === 'project' ? 'project' : 'userHome', segments: [] }, env: {}, acceptedExitCodes: [0],
      effects: [`The ${lowered.cli} CLI's own plugin command; Core can't show its effects`], requires: at ? [`step-${index}-${at - 1}`] : [], checks: [] };
  });
}
/** The receipt's plugin undo facts for one management id's steps (C54). */
function pluginFacts(steps: CheckedStep[]): { plugins?: PluginFacts[] } {
  const plugins = steps.flatMap(step => step.lowered.kind === 'plugin' && !step.skipped ? [{ step: step.index, cli: step.lowered.cli,
    plugin: step.lowered.plugin, commit: step.lowered.commit, contains: [...step.lowered.contains], undo: step.lowered.undo,
    presenceCheck: step.lowered.presenceCheck, ...(step.lowered.skills ? { skills: { ...step.lowered.skills } } : {}) }] : []);
  return plugins.length ? { plugins } : {};
}
/** The receipt's facts of the links one claim's steps place. */
function linkFacts(steps: CheckedStep[], plans: Map<number, { facts: LinkFacts }>): { links?: LinkFacts[] } {
  const links = steps.flatMap(step => step.lowered.kind === 'link' && plans.has(step.index) ? [{ ...plans.get(step.index)!.facts, created: [...plans.get(step.index)!.facts.created] }] : []);
  return links.length ? { links } : {};
}
/**
 * A local-plugin route's receipt facts (C68, Catalog D120): the items its first step says it contains, or `null` when
 * the plan gives no such metadata (then only its files are known; Core never infers membership).
 */
function localPluginFacts(steps: CheckedStep[]): { localPlugin?: { contains: string[] | null } } {
  const route = steps.filter(step => step.lowered.kind !== 'plugin' && step.lowered.review.route === 'local-plugin');
  if (!route.length) return {};
  const named = route.flatMap(step => step.lowered.kind === 'plugin' ? [] : step.lowered.review.contains ? [step.lowered.review.contains] : []);
  return { localPlugin: { contains: named.length ? [...new Set(named.flat())].sort(codeUnitCompare) : null } };
}
/** An AI setup's review facts (C46): what it downloads, and for a Python tool both interpreter branches. */
function acquireReview(step: CheckedStep, installed: Map<number, InstalledInterpreter | null>): Pick<ReviewStep, 'acquire' | 'interpreter'> {
  const spec = step.lowered.acquire;
  if (!spec) return {};
  const found = installed.get(step.index) ?? null;
  return { acquire: { aiSetup: spec.aiSetup, version: spec.version, cell: spec.cell, kind: spec.kind, qualification: `sha256:${spec.qualification}`,
    artifact: { file: spec.artifact.file, sha256: spec.artifact.sha256 }, into: `${spec.into}/`, members: spec.members.length, closure: spec.closure.length },
  ...(spec.interpreter ? { interpreter: {
    installed: found ? { path: found.path, version: found.version, note: 'in range, not qualified' as const } : null,
    range: spec.interpreter.range,
    fallback: { version: spec.interpreter.fallback.version, file: spec.interpreter.fallback.file, sha256: spec.interpreter.fallback.sha256 },
    switchesOn: found ? FALLBACK_REASONS.filter(reason => reason !== 'none-found') : ['none-found'] } } : {}) };
}

const CODEX_GUIDANCE_BYTES = 32 * 1024;
const REDACTED = '[REDACTED]';
const markers = (key: string) => ({ startMarker: `<!-- aih:begin ${key} -->`, endMarker: `<!-- aih:end ${key} -->` });
const pointerOf = (segments: string[]): string => segments.map(segment => '/' + segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('');
const under = (path: string[], prefix: string[]): boolean => path.length > prefix.length && prefix.every((part, at) => part === path[at]);

/** The receipt's input facts for one management id (C59): where each binding landed, and only ordinary values. */
function inputFacts(managementId: string, steps: CheckedStep[]): { inputs?: NonNullable<PlanItemFacts['inputs']> } {
  const rows = new Map<string, NonNullable<PlanItemFacts['inputs']>[number]>();
  for (const step of steps) for (const row of step.lowered.bound?.review ?? []) if (row.item === managementId && !rows.has(row.input))
    rows.set(row.input, { input: row.input, secret: row.secret, written: row.written, from: row.from, ...(row.value !== undefined ? { value: row.value } : {}) });
  const inputs = [...rows.values()].sort((a, b) => codeUnitCompare(a.input, b.input));
  return inputs.length ? { inputs } : {};
}
/** The receipt's secret slots of one claim's merge steps (C64): where a secret value was written, never the value. */
function slotFacts(steps: CheckedStep[]): { secretSlots?: NonNullable<PlanItemFacts['secretSlots']> } {
  const slots = steps.flatMap(({ lowered, skipped }) => lowered.kind === 'merge' && !skipped ?
    (lowered.slots ?? []).map(slot => ({ file: lowered.path, path: [...slot.path], item: slot.item, input: slot.input, template: slot.template })) : []);
  return slots.length ? { secretSlots: slots } : {};
}
/** The management ids of recorded engine claims in one root's receipts, unique, in code-unit order. */
function planIds(root: string, scope: 'project' | 'user', engineIds: string[]): string[] {
  const items = readOwnership(root).value.items ?? {};
  return [...new Set(engineIds.map(id => managementIdOf(id, items[claimIdentity(scope, id, root)]?.plan)))].sort(codeUnitCompare);
}
/** Management ids as a review sentence names them. */
const named = (ids: string[]): string => ids.map(id => `\`${id}\``).join(', ');
/** "this file will hold a secret", once per file a secret value is written into (C59). */
function secretWarnings(steps: CheckedStep[]): string[] {
  const files = [...new Set(steps.flatMap(step => step.lowered.bound?.secretFiles ?? []))].sort(codeUnitCompare);
  return files.map(file => `\`${file}\`: this file will hold a secret, written as its value because the client's profile declares no environment reference there.`);
}

/** The planned entry as the review shows it: slots that hold a secret value read `[REDACTED]`. */
function presentedEntry(lowered: LoweredMerge): Json {
  if (lowered.format === 'markdown') return lowered.entry;
  const entry = structuredClone(lowered.entry);
  for (const secret of lowered.redact) {
    const relative = secret.slice(lowered.segments.length);
    let node: Json = entry;
    for (const [at, segment] of relative.entries()) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, segment)) break;
      if (at === relative.length - 1) node[segment] = REDACTED; else node = node[segment]!;
    }
  }
  return entry;
}

/**
 * A conflict's existing bytes, exactly as they are on disk: the entry at the pointer, the table's text or the marked
 * block for a merge, the whole file for a write. Known secret slots read `[REDACTED]`; the observed digest still binds
 * the real bytes. Bytes that are not text, or a file over 1 MiB, are not presented (`null`).
 */
function presentExisting(lowered: Lowered, before: Buffer | null, privateValues: string[]): { text: string | null; redacted: string[] } {
  const shown = existingText(lowered, before);
  let text = shown.text;
  if (text !== null) for (const value of privateValues) if (value) text = text.split(value).join(REDACTED);
  return { text, redacted: shown.redacted };
}
function existingText(lowered: Lowered, before: Buffer | null): { text: string | null; redacted: string[] } {
  if (before === null || lowered.kind === 'plugin' || lowered.kind === 'link') return { text: null, redacted: [] };
  try {
    if (lowered.kind === 'write') return { text: before.length <= 1_048_576 ? new TextDecoder('utf-8', { fatal: true }).decode(before) : null, redacted: [] };
    if (lowered.format === 'markdown') {
      const block = blockMemberBytes(before, { blockId: lowered.key, ...markers(lowered.key), action: 'remove' });
      return { text: block?.toString('utf8') ?? null, redacted: [] };
    }
    if (lowered.format === 'toml') {
      const present = new Set(tomlEntryPaths(before, lowered.segments).assignments.map(path => JSON.stringify(path)));
      const hidden = lowered.secrets.filter(path => present.has(JSON.stringify(path)));
      return { text: tomlEntryText(before, lowered.segments, hidden), redacted: hidden.map(pointerOf) };
    }
    const member = configMemberBytes('jsonc', before, lowered.segments);
    if (member === null) return { text: null, redacted: [] };
    let text = member.toString('utf8');
    const tree = parseTree(text);
    const spans = lowered.secrets.filter(path => under(path, lowered.segments)).flatMap(path => {
      const node = tree && findNodeAtLocation(tree, path.slice(lowered.segments.length));
      return node ? [{ path, offset: node.offset, length: node.length }] : [];
    }).sort((a, b) => b.offset - a.offset);
    for (const span of spans) text = text.slice(0, span.offset) + JSON.stringify(REDACTED) + text.slice(span.offset + span.length);
    return { text, redacted: spans.map(span => pointerOf(span.path)).sort(codeUnitCompare) };
  } catch { return { text: null, redacted: [] }; }
}
