import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { validatePolicy, validateRecipe } from './contracts.js';
import { installedDistribution } from './internal/installed-distribution.js';
import { canonicalJson, codeUnitCompare } from './internal/canonical.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { dependencyOrder, inputAccepts } from './internal/policy-validation.js';
import { pathPins, pinsMatch, projectRoot, userHomeRoot, sha256 } from './internal/host-files.js';
import { captureRecipeReference, captureInlineMaterials, MaterialCaptureError,
  type InlineMaterialDescriptor, type MaterialRecipeReference } from './internal/material.js';
import { renderConfigEntries, renderTextBlock, RecipeEditError, type ConfigEntry } from './internal/recipe-editors.js';
import { dataObject, resolvePath, resolveSlot, resolveString, transaction } from './recipe-engine.js';
import type { Diagnostic, Json, Recipe, Slot } from './types.js';
import type { FileStateCheck, FileStateControls, FileStateOmission, FileStateRequest, FileStateResult,
  FileStateTarget } from './file-state-types.js';

const SCHEMA = 'urn:aihq:core:file-state-result:1.0.0' as const;
const DEFAULT_BUDGET_MS = 60000;
const MAX_TARGET_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_TARGETS = 4096;
const SAFE_REASON = /^[a-z][a-z0-9-]{0,63}$/;

const diagnostic = (code: string, reason: string, message: string): Diagnostic => ({ code, reason, message });

const EMPTY_COVERAGE = { comparedTargets: 0, unavailableTargets: 0, comparedChecks: 0, unavailableChecks: 0, notChecked: 0 };

function identityFailure(): FileStateResult {
  return { schema: SCHEMA, package: { name: '@aihq/core', version: 'unavailable' }, status: 'incomplete',
    fileState: 'unverified', authority: 'not-evaluated', targets: [], checks: [], notChecked: [],
    coverage: { ...EMPTY_COVERAGE },
    diagnostics: [diagnostic('PREREQUISITE_UNAVAILABLE', 'core-distribution-identity',
      'The installed Core distribution identity could not be verified.')],
    limits: { budgetMs: DEFAULT_BUDGET_MS, elapsedMs: 0, targetBytes: 0, materialBytes: 0 } };
}

/** CLI support for a syntactically unreadable policy file; not a public export. */
export function invalidFileStateResult(diagnostics: Diagnostic[]): FileStateResult {
  let identity: { name: string; version: string };
  try { identity = installedDistribution(); } catch { return { ...identityFailure(), status: 'invalid', diagnostics }; }
  return { schema: SCHEMA, package: identity, status: 'invalid', fileState: 'unverified', authority: 'not-evaluated',
    targets: [], checks: [], notChecked: [], coverage: { ...EMPTY_COVERAGE }, diagnostics,
    limits: { budgetMs: DEFAULT_BUDGET_MS, elapsedMs: 0, targetBytes: 0, materialBytes: 0 } };
}

interface Contribution { id: string; reason?: string; fold?: (before: Buffer | null) => Buffer | null; mode?: number }
interface Group {
  key: string; id: string; operationIds: string[]; label: 'project' | 'userHome' | 'userState';
  root: string; path: string; absolute: string; contributions: Contribution[];
}
type Row = { kind: 'null'; id: string; reason: string } | { kind: 'group'; group: Group };
interface CheckMeta {
  id: string; preset?: { outcome: 'unavailable' | 'not-checked'; reason: string };
  key?: string; sha256?: string;
}
interface KeyOutcome {
  error?: string;
  live?: { present: boolean; bytes?: Buffer };
  rowOutcome?: 'match' | 'changed' | 'absent';
  rowReason?: string;
}

function referenceDeclaredBytes(reference: MaterialRecipeReference): number {
  const paths = new Set([reference.path]);
  let total = reference.byteLength;
  for (const member of reference.materials) if (!paths.has(member.path)) {
    paths.add(member.path);
    total += member.byteLength;
  }
  return total;
}
function membersDeclaredBytes(members: InlineMaterialDescriptor[]): number {
  const paths = new Set<string>();
  let total = 0;
  for (const member of members) if (!paths.has(member.path)) {
    paths.add(member.path);
    total += member.byteLength;
  }
  return total;
}
const UNAVAILABLE_MATERIAL: Record<string, string> = {
  'local-root-unavailable': 'material-unavailable', 'local-file-unavailable': 'material-unavailable',
  'unsafe-local-root': 'material-unavailable', 'unsafe-local-path': 'material-unavailable',
  'unsafe-local-file': 'material-unavailable', 'invalid-local-root': 'material-unavailable',
  'member-identity-mismatch': 'material-identity-mismatch', 'recipe-identity-mismatch': 'material-identity-mismatch',
  'local-file-changed': 'material-identity-mismatch', 'material-closure-mismatch': 'material-identity-mismatch',
  'acquisition-deadline': 'budget-exhausted'
};

export async function checkFileState(request: FileStateRequest, controls: FileStateControls = {}): Promise<FileStateResult> {
  const start = performance.now();
  let identity: { name: string; version: string };
  try { identity = installedDistribution(); } catch { return identityFailure(); }
  let budgetMs = DEFAULT_BUDGET_MS;
  const elapsed = () => Math.round(performance.now() - start);
  const failWith = (reason: string, diagnostics?: Diagnostic[]): FileStateResult => ({
    schema: SCHEMA, package: identity, status: 'invalid', fileState: 'unverified', authority: 'not-evaluated',
    targets: [], checks: [], notChecked: [], coverage: { ...EMPTY_COVERAGE },
    diagnostics: diagnostics ?? [diagnostic('INPUT_INVALID', reason,
      reason === 'request-field' ? 'Use published file-state options.' : 'The file-state request could not be admitted.')],
    limits: { budgetMs, elapsedMs: elapsed(), targetBytes: 0, materialBytes: 0 } });
  try {
    try { dataObject(controls, ['signal', 'budgetMs', 'privateInputs', 'materialRoots']); }
    catch { throw new Error('request-field'); }
    if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) throw new Error('signal');
    if (controls.budgetMs !== undefined) {
      if (typeof controls.budgetMs !== 'number' || !Number.isInteger(controls.budgetMs) ||
          controls.budgetMs < 1 || controls.budgetMs > DEFAULT_BUDGET_MS) throw new Error('budget-ms');
      budgetMs = controls.budgetMs;
    }
    if (controls.materialRoots !== undefined) {
      try { dataObject(controls.materialRoots, Object.keys(controls.materialRoots)); } catch { throw new Error('material-root'); }
      for (const [id, root] of Object.entries(controls.materialRoots))
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || typeof root !== 'string' || !isAbsolute(root)) throw new Error('material-root');
    }
    let privateInputs: Record<string, Record<string, Json>> = {};
    if (controls.privateInputs !== undefined) {
      try {
        privateInputs = cloneJsonValueStructureV1(controls.privateInputs, 'private inputs', 32);
        assertStrictJsonValueV1(privateInputs, 'private inputs');
      } catch { throw new Error('private-input'); }
      for (const values of Object.values(privateInputs))
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('private-input');
    }
    try { dataObject(request, ['policy', 'target']); } catch { throw new Error('request-field'); }
    if (request.policy === undefined || request.target === undefined) throw new Error('request-field');
    try { dataObject(request.target, ['project']); } catch { throw new Error('request-field'); }
    if (typeof request.target.project !== 'string') throw new Error('project-absolute');
    let project: string;
    try { project = projectRoot(request.target.project); }
    catch (error) {
      throw new Error(error instanceof Error && SAFE_REASON.test(error.message) ? error.message : 'project-directory');
    }
    const validation = validatePolicy(request.policy);
    if (!validation.valid) return failWith('validation', validation.diagnostics);
    const policy = cloneJsonValueStructureV1(request.policy, 'request', 32);
    for (const [selectionId, values] of Object.entries(privateInputs)) {
      const selection = policy.selections.find(item => item.id === selectionId);
      if (!selection) throw new Error('private-input-unknown');
      if ('inline' in selection.recipe) for (const [name, value] of Object.entries(values)) {
        const spec = selection.recipe.inline.inputs[name];
        if (!Object.hasOwn(selection.recipe.inline.inputs, name) || !spec?.sensitive) throw new Error('private-input-unknown');
        // Validation precedes cancellation, so a supplied value is type-checked here too.
        if (!inputAccepts(spec, value)) throw new Error('input-value');
      }
    }
    const privateValues = Object.values(privateInputs).flatMap(values => Object.values(values)).map(String);
    const redact = (text: string): string => {
      let result = text;
      for (const value of privateValues) if (value) result = result.split(value).join('[REDACTED]');
      return result;
    };
    if (controls.signal?.aborted) {
      return { schema: SCHEMA, package: identity, status: 'cancelled', fileState: 'unverified', authority: 'not-evaluated',
        targets: [], checks: [], notChecked: [], coverage: { ...EMPTY_COVERAGE },
        diagnostics: [diagnostic('CANCELLED', 'cancelled', 'The file-state check was cancelled.')],
        limits: { budgetMs, elapsedMs: elapsed(), targetBytes: 0, materialBytes: 0 } };
    }

    const omissions: FileStateOmission[] = [];
    const rows: Row[] = [];
    const checkMetas: CheckMeta[] = [];
    const groups = new Map<string, Group>();
    const checkOnlyTargets = new Map<string, { root: string; path: string; absolute: string }>();
    const limitedKeys = new Set<string>();
    const taintedOps = new Set<string>();
    const selectionUnavailable = new Map<string, string>();
    const selectionOpIds = new Map<string, string[]>();
    let materialBytes = 0;
    let targetBytes = 0;
    let terminated: 'cancelled' | 'budget-exhausted' | null = null;
    const overBudget = () => performance.now() - start > budgetMs;
    const slotJson = (recipe: Recipe, bound: Record<string, Json>, slot: Slot): { missing: boolean; value?: Json } => {
      if ('input' in slot && !Object.hasOwn(bound, slot.input) && recipe.inputs[slot.input]?.sensitive) return { missing: true };
      return { missing: false, value: resolveSlot(slot, bound) };
    };
    const slotText = (recipe: Recipe, bound: Record<string, Json>, slot: Slot): { missing: boolean; value?: string } => {
      if ('input' in slot && !Object.hasOwn(bound, slot.input) && recipe.inputs[slot.input]?.sensitive) return { missing: true };
      return { missing: false, value: resolveString(slot, bound) };
    };
    const materialRoots = controls.materialRoots ?? {};
    const captureOptions = controls.signal === undefined ? {} : { signal: controls.signal };
    // Selections whose admission finished, including unread ones that already carry an omission.
    const admitted = new Set<string>();
    const ordered = dependencyOrder(policy.selections);

    admission:
    for (const [selectionIndex, selection] of ordered.entries()) {
      if (selectionIndex > 0) {
        if (controls.signal?.aborted) { terminated = 'cancelled'; break; }
        if (overBudget()) { terminated = 'budget-exhausted'; break; }
      }
      let recipe: Recipe;
      let readMaterial: (id: string) => Buffer | undefined;
      const materialReasons = new Map<string, string>();
      const unread = (reason: string) => {
        omissions.push({ kind: 'recipe', id: selection.id, reason });
        selectionUnavailable.set(selection.id, reason);
        selectionOpIds.set(selection.id, []);
        admitted.add(selection.id);
      };
      if ('reference' in selection.recipe) {
        const reference = selection.recipe.reference;
        if (reference.source.kind === 'archive') { unread('remote-material-not-admitted'); continue; }
        if (materialBytes + referenceDeclaredBytes(reference) > MAX_TOTAL_BYTES) { unread('limit-exceeded'); continue; }
        let captured: Awaited<ReturnType<typeof captureRecipeReference>>;
        try { captured = await captureRecipeReference(reference, materialRoots, captureOptions); }
        catch (error) {
          if (!(error instanceof MaterialCaptureError)) throw error;
          if (error.reason === 'cancelled') { terminated = 'cancelled'; break admission; }
          const mapped = UNAVAILABLE_MATERIAL[error.reason];
          if (mapped === undefined) throw new Error(SAFE_REASON.test(error.reason) ? error.reason : 'material-invalid');
          unread(mapped);
          continue;
        }
        materialBytes += referenceDeclaredBytes(reference);
        try {
          recipe = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(captured.readRecipe()), 'recipe') as unknown as Recipe;
        } catch { throw new Error('recipe-invalid'); }
        const recipeValidation = validateRecipe(recipe);
        if (!recipeValidation.valid) return failWith('validation', recipeValidation.diagnostics);
        const declared = [...recipe.materials].map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength }))
          .sort((a, b) => codeUnitCompare(a.id, b.id));
        const acquired = [...captured.materials].map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength }))
          .sort((a, b) => codeUnitCompare(a.id, b.id));
        if (canonicalJson(declared) !== canonicalJson(acquired)) throw new Error('material-closure');
        readMaterial = id => captured.readMaterial(id);
      } else {
        recipe = selection.recipe.inline;
        if (recipe.materials.some(item => !('source' in item))) throw new Error('material-source-missing');
        const sourceGroups = new Map<string, InlineMaterialDescriptor[]>();
        for (const member of recipe.materials as InlineMaterialDescriptor[]) {
          if (member.source.kind === 'archive') {
            materialReasons.set(member.id, 'remote-material-not-admitted');
            continue;
          }
          const list = sourceGroups.get(member.source.input) ?? [];
          list.push(member);
          sourceGroups.set(member.source.input, list);
        }
        const captures: { readMaterial(id: string): Buffer | undefined }[] = [];
        for (const members of sourceGroups.values()) {
          if (controls.signal?.aborted) { terminated = 'cancelled'; break admission; }
          if (overBudget()) { terminated = 'budget-exhausted'; break admission; }
          if (materialBytes + membersDeclaredBytes(members) > MAX_TOTAL_BYTES) {
            for (const member of members) materialReasons.set(member.id, 'limit-exceeded');
            continue;
          }
          try {
            captures.push(await captureInlineMaterials(members, materialRoots, captureOptions));
            materialBytes += membersDeclaredBytes(members);
          } catch (error) {
            if (!(error instanceof MaterialCaptureError)) throw error;
            if (error.reason === 'cancelled') { terminated = 'cancelled'; break admission; }
            const mapped = UNAVAILABLE_MATERIAL[error.reason];
            if (mapped === undefined) throw new Error(SAFE_REASON.test(error.reason) ? error.reason : 'material-invalid');
            for (const member of members) materialReasons.set(member.id, mapped);
          }
        }
        readMaterial = id => {
          for (const captured of captures) {
            const bytes = captured.readMaterial(id);
            if (bytes !== undefined) return bytes;
          }
          return undefined;
        };
      }
      if (!recipe.targets.includes(selection.scope) || recipe.operations.some(op => op.scope !== selection.scope))
        throw new Error('scope-mismatch');
      for (const name of Object.keys(privateInputs[selection.id] ?? {}))
        if (!Object.hasOwn(recipe.inputs, name) || !recipe.inputs[name]?.sensitive) throw new Error('private-input-unknown');
      const selectionKey = sha256(`${selection.scope === 'user' ? userHomeRoot() : project}\u0000${selection.scope}\u0000${selection.managementId}`);
      const bound: Record<string, Json> = Object.create(null);
      for (const [name, value] of Object.entries(selection.configuration))
        if (!Object.hasOwn(recipe.inputs, name) || recipe.inputs[name]!.sensitive || !inputAccepts(recipe.inputs[name]!, value))
          throw new Error('input-value');
      for (const [name, spec] of Object.entries(recipe.inputs)) {
        const value = spec.sensitive ? privateInputs[selection.id]?.[name] :
          Object.hasOwn(selection.configuration, name) ? selection.configuration[name] : spec.default;
        if (value === undefined) {
          if (spec.sensitive || !spec.required) continue;
          throw new Error('input-value');
        }
        if (!inputAccepts(spec, value)) throw new Error('input-value');
        bound[name] = value;
      }
      let platformUnsupported = false;
      for (const [index, requirement] of recipe.prerequisites.entries()) {
        if (requirement.kind === 'platform') {
          if (!(requirement.os === process.platform && requirement.architectures.includes(process.arch))) platformUnsupported = true;
        } else {
          omissions.push({ kind: 'prerequisite', id: `${selection.id}/prerequisite-${index}`, reason: 'process-not-checked' });
        }
      }
      // An unread requirement is inherited transitively by every dependent selection.
      const inherited = selection.requires.map(id => selectionUnavailable.get(id)).find(reason => reason !== undefined);
      if (inherited !== undefined) selectionUnavailable.set(selection.id, inherited);
      const priorSelections = selection.requires.flatMap(id => selectionOpIds.get(id) ?? []);
      const opIds: string[] = [];
      for (const op of dependencyOrder(recipe.operations)) {
        const id = `${selection.id}/${op.id}`;
        opIds.push(id);
        const deps = [...priorSelections, ...op.requires.map(required => `${selection.id}/${required}`)];
        const depsTainted = deps.some(dep => taintedOps.has(dep));
        // Process dependency is transitive through file operations and required selections.
        if (depsTainted) taintedOps.add(id);
        if (op.kind === 'process.run') {
          taintedOps.add(id);
          omissions.push({ kind: 'process', id, reason: 'process-not-checked' });
          continue;
        }
        const missingPathInput = op.target.segments.some(slot =>
          'input' in slot && !Object.hasOwn(bound, slot.input) && recipe.inputs[slot.input]?.sensitive);
        if (missingPathInput) {
          rows.push({ kind: 'null', id, reason: 'input-unavailable' });
          continue;
        }
        const resolved = resolvePath(op.target, op.scope, bound, project, selectionKey);
        let reason: string | undefined = platformUnsupported ? 'platform-unsupported' :
          inherited ?? (depsTainted ? 'process-dependency-not-checked' : undefined);
        let fold: Contribution['fold'];
        let mode: number | undefined;
        if (reason === undefined) {
          if (op.kind === 'file.write') {
            mode = op.mode;
            if (op.material !== undefined) {
              const unavailable = materialReasons.get(op.material);
              if (unavailable !== undefined) reason = unavailable;
              else {
                const bytes = readMaterial(op.material);
                if (bytes === undefined) reason = 'material-unavailable';
                else fold = () => Buffer.from(bytes);
              }
            } else {
              const content = slotText(recipe, bound, op.content!);
              if (content.missing) reason = 'input-unavailable';
              else fold = () => Buffer.from(content.value as string, 'utf8');
            }
          } else if (op.kind === 'config.entries') {
            const entries: ConfigEntry[] = [];
            for (const entry of op.entries) {
              if (entry.action === 'remove') entries.push({ path: entry.path, action: 'remove' });
              else {
                const value = slotJson(recipe, bound, entry.value);
                if (value.missing) { reason = 'input-unavailable'; break; }
                entries.push({ path: entry.path, action: 'set', value: value.value });
              }
            }
            if (reason === undefined) fold = before => renderConfigEntries(op.format, before, entries);
          } else if (op.kind === 'text.block') {
            let content: string | undefined;
            if (op.content !== undefined) {
              const resolvedContent = slotText(recipe, bound, op.content);
              if (resolvedContent.missing) reason = 'input-unavailable';
              else content = resolvedContent.value;
            }
            if (reason === undefined) fold = before => renderTextBlock(before, { blockId: op.blockId,
              startMarker: op.startMarker, endMarker: op.endMarker, action: op.action,
              ...(content === undefined ? {} : { content }) });
          } else fold = () => null;
        }
        const key = `${resolved.root}:${process.platform === 'win32' ? resolved.path.toLowerCase() : resolved.path}`;
        let group = groups.get(key);
        if (group === undefined) {
          group = { key, id, operationIds: [], label: op.target.root, root: resolved.root, path: resolved.path,
            absolute: resolved.absolute, contributions: [] };
          groups.set(key, group);
          rows.push({ kind: 'group', group });
          if (groups.size + checkOnlyTargets.size > MAX_TARGETS) {
            limitedKeys.add(key);
            reason = reason ?? 'limit-exceeded';
          }
        }
        group.operationIds.push(id);
        const contribution: Contribution = { id };
        if (reason !== undefined) contribution.reason = reason;
        else {
          contribution.fold = fold;
          if (mode !== undefined) contribution.mode = mode;
        }
        group.contributions.push(contribution);
      }
      selectionOpIds.set(selection.id, opIds);
      for (const check of recipe.checks) {
        const id = `${selection.id}/${check.id}`;
        if (check.kind === 'process.exit') {
          checkMetas.push({ id, preset: { outcome: 'not-checked', reason: 'process-not-checked' } });
          continue;
        }
        // A digest check observes live bytes, so only the platform gate makes it unavailable.
        if (platformUnsupported) {
          checkMetas.push({ id, preset: { outcome: 'unavailable', reason: 'platform-unsupported' } });
          continue;
        }
        const missingPathInput = check.target.segments.some(slot =>
          'input' in slot && !Object.hasOwn(bound, slot.input) && recipe.inputs[slot.input]?.sensitive);
        if (missingPathInput) {
          checkMetas.push({ id, preset: { outcome: 'unavailable', reason: 'input-unavailable' } });
          continue;
        }
        const resolved = resolvePath(check.target, check.target.root === 'project' ? 'project' : 'user', bound, project, selectionKey);
        const key = `${resolved.root}:${process.platform === 'win32' ? resolved.path.toLowerCase() : resolved.path}`;
        if (limitedKeys.has(key)) {
          checkMetas.push({ id, preset: { outcome: 'unavailable', reason: 'limit-exceeded' } });
          continue;
        }
        if (!groups.has(key) && !checkOnlyTargets.has(key)) {
          if (groups.size + checkOnlyTargets.size >= MAX_TARGETS) {
            checkMetas.push({ id, preset: { outcome: 'unavailable', reason: 'limit-exceeded' } });
            continue;
          }
          checkOnlyTargets.set(key, { root: resolved.root, path: resolved.path, absolute: resolved.absolute });
        }
        checkMetas.push({ id, key, sha256: check.sha256 });
      }
      admitted.add(selection.id);
    }
    // A recipe whose admission did not finish has no known operation IDs.
    if (terminated !== null)
      for (const selection of ordered)
        if (!admitted.has(selection.id)) omissions.push({ kind: 'recipe', id: selection.id, reason: terminated });
    for (const set of policy.managedSelections ?? [])
      omissions.push({ kind: 'managed-set', id: `${set.scope}/${set.id}`, reason: 'custody-not-evaluated' });
    for (const removal of policy.removals ?? [])
      omissions.push({ kind: 'removal', id: `${removal.scope}/${removal.managementId}`, reason: 'custody-not-evaluated' });
    for (const association of policy.evidence ?? [])
      omissions.push({ kind: 'evidence', id: association.scanId, reason: 'evidence-not-evaluated' });

    const observe = (key: string): KeyOutcome => {
      const target = groups.get(key) ?? checkOnlyTargets.get(key)!;
      let pins: ReturnType<typeof pathPins>;
      try { pins = pathPins(target.absolute); } catch { return { error: 'target-unreadable' }; }
      try {
        const leaf = lstatSync(target.absolute);
        if (leaf.size > MAX_TARGET_BYTES || targetBytes + materialBytes + leaf.size > MAX_TOTAL_BYTES)
          return { error: 'limit-exceeded' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { error: 'target-unreadable' };
      }
      const live = transaction(target.root).inspect(target.path);
      if (live.state === 'unreadable') return { error: 'target-unreadable' };
      if (live.state === 'present') targetBytes += live.bytes.length;
      const outcome: KeyOutcome = { live: live.state === 'present' ? { present: true, bytes: live.bytes } : { present: false } };
      const group = groups.get(key);
      if (group !== undefined && group.contributions.every(contribution => contribution.reason === undefined)) {
        let desired: Buffer | null = live.state === 'present' ? live.bytes : null;
        try {
          for (const contribution of group.contributions) {
            desired = contribution.fold!(desired);
            if (desired !== null && desired.byteLength > MAX_TARGET_BYTES) return { error: 'limit-exceeded' };
          }
        } catch (error) {
          if (error instanceof RecipeEditError) return { error: error.reason };
          throw error;
        }
        const expectedMode = group.contributions.at(-1)!.mode;
        const liveBytes = live.state === 'present' ? live.bytes : null;
        if (desired === null && liveBytes === null) {
          outcome.rowOutcome = 'match'; outcome.rowReason = 'content-match';
        } else if (desired !== null && liveBytes === null) {
          outcome.rowOutcome = 'absent'; outcome.rowReason = 'target-absent';
        } else if (desired === null || liveBytes === null) {
          outcome.rowOutcome = 'changed'; outcome.rowReason = 'content-changed';
        } else {
          const same = desired.equals(liveBytes) && (expectedMode === undefined || process.platform === 'win32' ||
            (live.state === 'present' && live.mode === expectedMode));
          outcome.rowOutcome = same ? 'match' : 'changed';
          outcome.rowReason = same ? 'content-match' : 'content-changed';
        }
      }
      const again = transaction(target.root).inspect(target.path);
      const unchanged = pinsMatch(pins) && (live.state === again.state &&
        (live.state !== 'present' || again.state === 'present' && live.mode === again.mode && live.bytes.equals(again.bytes)));
      if (!unchanged) return { error: 'target-changed-during-check' };
      return outcome;
    };

    const workQueue: string[] = [];
    const queued = new Set<string>();
    for (const row of rows)
      if (row.kind === 'group' && row.group.contributions.every(contribution => contribution.reason === undefined) &&
          !queued.has(row.group.key)) {
        queued.add(row.group.key);
        workQueue.push(row.group.key);
      }
    for (const meta of checkMetas)
      if (meta.key !== undefined && !queued.has(meta.key)) {
        queued.add(meta.key);
        workQueue.push(meta.key);
      }
    const outcomes = new Map<string, KeyOutcome>();
    for (const key of workQueue) {
      await yieldToHost();
      if (terminated === null && controls.signal?.aborted) terminated = 'cancelled';
      if (terminated === null && overBudget()) terminated = 'budget-exhausted';
      if (terminated !== null) {
        outcomes.set(key, { error: terminated });
        continue;
      }
      // An unexpected host error affects only this observation, never earlier rows.
      try { outcomes.set(key, observe(key)); }
      catch { outcomes.set(key, { error: 'target-unreadable' }); }
    }

    const targets: FileStateTarget[] = rows.map(row => {
      if (row.kind === 'null')
        return { id: row.id, operationIds: [row.id], target: null, outcome: 'unavailable', reason: row.reason };
      const group = row.group;
      const targetPath = { root: group.label, path: redact(group.path) };
      const unavailable = group.contributions.find(contribution => contribution.reason !== undefined);
      if (unavailable !== undefined)
        return { id: group.id, operationIds: [...group.operationIds], target: targetPath,
          outcome: 'unavailable' as const, reason: unavailable.reason! };
      const outcome = outcomes.get(group.key);
      if (outcome === undefined || outcome.error !== undefined)
        return { id: group.id, operationIds: [...group.operationIds], target: targetPath,
          outcome: 'unavailable' as const, reason: outcome?.error ?? 'file-state-internal' };
      return { id: group.id, operationIds: [...group.operationIds], target: targetPath,
        outcome: outcome.rowOutcome!, reason: outcome.rowReason! };
    });
    const checks: FileStateCheck[] = checkMetas.map(meta => {
      if (meta.preset !== undefined) return { id: meta.id, outcome: meta.preset.outcome, reason: meta.preset.reason };
      const outcome = outcomes.get(meta.key!);
      if (outcome === undefined || outcome.error !== undefined)
        return { id: meta.id, outcome: 'unavailable' as const, reason: outcome?.error ?? 'file-state-internal' };
      if (!outcome.live!.present) return { id: meta.id, outcome: 'failed' as const, reason: 'target-absent' };
      const same = sha256(outcome.live!.bytes!) === meta.sha256;
      return { id: meta.id, outcome: same ? 'passed' as const : 'failed' as const,
        reason: same ? 'content-match' : 'content-changed' };
    });
    const comparedTargets = targets.filter(target => target.outcome !== 'unavailable').length;
    const unavailableTargets = targets.length - comparedTargets;
    const comparedChecks = checks.filter(check => check.outcome === 'passed' || check.outcome === 'failed').length;
    const unavailableChecks = checks.filter(check => check.outcome === 'unavailable').length;
    const notCheckedCount = omissions.length + checks.filter(check => check.outcome === 'not-checked').length;
    const mismatch = targets.some(target => target.outcome === 'changed' || target.outcome === 'absent') ||
      checks.some(check => check.outcome === 'failed');
    const unreadRecipe = omissions.some(omission => omission.kind === 'recipe');
    const comparisons = comparedTargets + comparedChecks;
    const fileState = mismatch ? 'changed' as const :
      comparisons >= 1 && unavailableTargets === 0 && unavailableChecks === 0 && !unreadRecipe ? 'match' as const : 'unverified' as const;
    const status = terminated === 'cancelled' ? 'cancelled' as const :
      comparisons >= 1 && unavailableTargets === 0 && unavailableChecks === 0 && notCheckedCount === 0 ? 'complete' as const : 'incomplete' as const;
    return { schema: SCHEMA, package: identity, status, fileState, authority: 'not-evaluated',
      targets, checks, notChecked: omissions,
      coverage: { comparedTargets, unavailableTargets, comparedChecks, unavailableChecks, notChecked: notCheckedCount },
      diagnostics: terminated === 'cancelled' ? [diagnostic('CANCELLED', 'cancelled', 'The file-state check was cancelled.')] : [],
      limits: { budgetMs, elapsedMs: elapsed(), targetBytes, materialBytes } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (reason === 'cancelled')
      return { schema: SCHEMA, package: identity, status: 'cancelled', fileState: 'unverified', authority: 'not-evaluated',
        targets: [], checks: [], notChecked: [], coverage: { ...EMPTY_COVERAGE },
        diagnostics: [diagnostic('CANCELLED', 'cancelled', 'The file-state check was cancelled.')],
        limits: { budgetMs, elapsedMs: elapsed(), targetBytes: 0, materialBytes: 0 } };
    if (SAFE_REASON.test(reason)) return failWith(reason);
    return { schema: SCHEMA, package: identity, status: 'incomplete', fileState: 'unverified', authority: 'not-evaluated',
      targets: [], checks: [], notChecked: [], coverage: { ...EMPTY_COVERAGE },
      diagnostics: [diagnostic('INTERNAL_ERROR', 'file-state-internal', 'The file-state check could not safely complete.')],
      limits: { budgetMs, elapsedMs: elapsed(), targetBytes: 0, materialBytes: 0 } };
  }
}
