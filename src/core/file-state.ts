import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { validatePolicy, validateRecipe } from './contracts.js';
import { installedDistribution } from './internal/installed-distribution.js';
import { canonicalJson, codeUnitCompare } from './internal/canonical.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1, parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { dependencyOrder, inputAccepts } from './internal/policy-validation.js';
import { pathPins, pinsMatch, projectRoot, userHomeRoot, sha256, validSegment } from './internal/host-files.js';
import { captureRecipeReference, captureInlineMaterials, createMaterialCaptureBudget, MaterialCaptureError,
  type InlineMaterialDescriptor, type MaterialRecipeReference } from './internal/material.js';
import { renderConfigEntries, renderTextBlock, RecipeEditError, type ConfigEntry } from './internal/recipe-editors.js';
import { foldHookGroup } from './internal/hook-prepare.js';
import { dataObject, resolvePath, resolveSlot, resolveString, transaction } from './recipe-engine.js';
import type { Diagnostic, Json, ProcessInvocation, Recipe, Selection, Slot, TargetPath } from './types.js';
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
  /** Capture or recheck failure: the target row and its digest checks are unavailable. */
  error?: string;
  /** Fold failure: only the target row is unavailable. */
  rowError?: string;
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
type Bound = Record<string, Json>;
// An omitted private value is missing (its comparison is unavailable); an unbound
// non-sensitive slot is an authoring error exactly as in Prepare.
const missingInput = (recipe: Recipe, bound: Bound, slot: Slot): boolean =>
  'input' in slot && !Object.hasOwn(bound, slot.input) && recipe.inputs[slot.input]?.sensitive === true;
const unboundInput = (recipe: Recipe, bound: Bound, slot: Slot): boolean =>
  'input' in slot && !Object.hasOwn(bound, slot.input) && recipe.inputs[slot.input]?.sensitive !== true;

/** Binds declared inputs with Prepare's rules, leaving an omitted private value unbound. */
function bindInputs(selection: Selection, recipe: Recipe, supplied: Record<string, Json> | undefined): Bound {
  for (const name of Object.keys(supplied ?? {}))
    if (!Object.hasOwn(recipe.inputs, name) || !recipe.inputs[name]?.sensitive) throw new Error('private-input-unknown');
  for (const [name, value] of Object.entries(selection.configuration))
    if (!Object.hasOwn(recipe.inputs, name) || recipe.inputs[name]!.sensitive || !inputAccepts(recipe.inputs[name]!, value))
      throw new Error('input-value');
  const bound: Bound = Object.create(null);
  for (const [name, spec] of Object.entries(recipe.inputs)) {
    const value = spec.sensitive ? supplied?.[name] :
      Object.hasOwn(selection.configuration, name) ? selection.configuration[name] : spec.default;
    if (value === undefined) {
      if (spec.sensitive || !spec.required) continue;
      throw new Error('input-value');
    }
    if (!inputAccepts(spec, value)) throw new Error('input-value');
    bound[name] = value;
  }
  return bound;
}

/**
 * Rejects what Prepare would reject before any target read: unsafe resolved path
 * segments and unbound non-sensitive slots in operations and referenced checks.
 * Paths that need an omitted private value are left for unavailable rows.
 */
function admitAuthoredSlots(recipe: Recipe, bound: Bound): void {
  const referenced = new Set(recipe.operations.flatMap(op => op.checks));
  const slots = (items: (Slot | undefined)[]) => {
    for (const slot of items) if (slot && unboundInput(recipe, bound, slot)) throw new Error('input-unbound');
  };
  const path = (target: TargetPath, required: boolean) => {
    if (target.segments.some(slot => missingInput(recipe, bound, slot))) return;
    if (target.segments.some(slot => unboundInput(recipe, bound, slot))) { if (required) throw new Error('input-unbound'); return; }
    if (target.segments.some(slot => !validSegment(resolveString(slot, bound)))) throw new Error('invalid-path');
  };
  const invocation = (item: ProcessInvocation) => {
    path(item.cwd, true);
    slots([...item.args, ...Object.values(item.env), item.stdin]);
  };
  for (const op of recipe.operations) {
    if (op.kind === 'process.run') { invocation(op); continue; }
    path(op.target, true);
    if (op.kind === 'file.write' || op.kind === 'text.block') slots([op.content]);
    else if (op.kind === 'config.entries') slots(op.entries.map(entry => entry.action === 'set' ? entry.value : undefined));
  }
  for (const check of recipe.checks) {
    if (check.kind === 'process.exit') { if (referenced.has(check.id)) invocation(check); }
    else path(check.target, referenced.has(check.id));
  }
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
    // Diagnostic pointers are relative to the request, whose policy is one member.
    if (!validation.valid) return failWith('validation', validation.diagnostics.map(item =>
      item.path === undefined ? item : { ...item, path: `/policy${item.path}` }));
    const policy = cloneJsonValueStructureV1(request.policy, 'request', 32);
    for (const selectionId of Object.keys(privateInputs))
      if (!policy.selections.some(item => item.id === selectionId)) throw new Error('private-input-unknown');
    // Every check that needs no I/O precedes cancellation: strict material
    // descriptors (including archive sources), input binding and authored paths.
    const inlineBindings = new Map<string, Bound>();
    for (const selection of policy.selections) {
      try {
        const declared = createMaterialCaptureBudget();
        if ('reference' in selection.recipe) declared.declareReference(selection.recipe.reference);
        else declared.declareInline(selection.recipe.inline.materials);
      } catch (error) {
        // The byte total is checked after every descriptor rule, so an oversized but
        // otherwise valid declaration is reported as limit-exceeded during admission.
        if (!(error instanceof MaterialCaptureError && error.reason === 'captured-byte-limit'))
          throw new Error(error instanceof MaterialCaptureError && SAFE_REASON.test(error.reason) ? error.reason : 'material-invalid');
      }
      if (!('inline' in selection.recipe)) continue;
      const bound = bindInputs(selection, selection.recipe.inline, privateInputs[selection.id]);
      admitAuthoredSlots(selection.recipe.inline, bound);
      inlineBindings.set(selection.id, bound);
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
    // Acquisition shares the caller's absolute budget, checked between bounded reads.
    const captureOptions = { ...(controls.signal === undefined ? {} : { signal: controls.signal }), deadline: start + budgetMs };
    // An item larger than the whole total can never fit and is unavailable by itself;
    // once captured material plus target bytes would pass the total, remaining work is unavailable.
    let bytesExhausted = false;
    const fitsTotal = (bytes: number): boolean => {
      if (bytes > MAX_TOTAL_BYTES) return false;
      if (!bytesExhausted && targetBytes + materialBytes + bytes > MAX_TOTAL_BYTES) bytesExhausted = true;
      return !bytesExhausted;
    };
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
        if (!fitsTotal(referenceDeclaredBytes(reference))) { unread('limit-exceeded'); continue; }
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
          if (!fitsTotal(membersDeclaredBytes(members))) {
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
      // Inline recipes were bound and checked before cancellation; a captured reference is checked now.
      const bound = inlineBindings.get(selection.id) ?? bindInputs(selection, recipe, privateInputs[selection.id]);
      if (!inlineBindings.has(selection.id)) admitAuthoredSlots(recipe, bound);
      const selectionKey = sha256(`${selection.scope === 'user' ? userHomeRoot() : project}\u0000${selection.scope}\u0000${selection.managementId}`);
      // One retained copy per captured source file and pin, however many operations or alias IDs use it.
      const members: { id: string; path: string; sha256: string; source?: InlineMaterialDescriptor['source'] }[] =
        'reference' in selection.recipe ? selection.recipe.reference.materials : recipe.materials as InlineMaterialDescriptor[];
      const identities = new Map(members.map(item => [item.id,
        `${item.source === undefined ? '' : item.source.kind === 'archive' ? item.source.url : item.source.input}\u0000${item.path}\u0000${item.sha256}`]));
      const materialBuffers = new Map<string, Buffer | undefined>();
      const material = (id: string): Buffer | undefined => {
        const identity = identities.get(id) ?? id;
        if (!materialBuffers.has(identity)) materialBuffers.set(identity, readMaterial(id));
        return materialBuffers.get(identity);
      };
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
        // Process dependency is transitive through file operations and required selections.
        const taint = () => { if (deps.some(dep => taintedOps.has(dep))) taintedOps.add(id); };
        if (op.kind === 'process.run') {
          taintedOps.add(id);
          omissions.push({ kind: 'process', id, reason: 'process-not-checked' });
          continue;
        }
        if (op.target.segments.some(slot => missingInput(recipe, bound, slot))) {
          taint();
          rows.push({ kind: 'null', id, reason: 'input-unavailable' });
          continue;
        }
        const resolved = resolvePath(op.target, op.scope, bound, project, selectionKey);
        const key = `${resolved.root}:${process.platform === 'win32' ? resolved.path.toLowerCase() : resolved.path}`;
        // As in Prepare, a later operation on the same target is ordered after the earlier one.
        const prior = groups.get(key)?.contributions.at(-1);
        if (prior !== undefined) deps.push(prior.id);
        taint();
        const depsTainted = taintedOps.has(id);
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
                const bytes = material(op.material);
                // Renderers never mutate their input, so the retained buffer is shared.
                if (bytes === undefined) reason = 'material-unavailable';
                else fold = () => bytes;
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
          } else if (op.kind === 'hook.group') {
            const authored = { format: op.format, container: op.container, groupId: op.groupId, selector: op.selector, action: op.action,
              ...(op.group ? { group: op.group.literal } : {}) };
            fold = before => foldHookGroup(authored, before);
          } else fold = () => null;
        }
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
        // A referenced check with an unbound authored input was already rejected; an
        // unreferenced one (which Prepare never resolves) is reported, not guessed.
        if (check.target.segments.some(slot => missingInput(recipe, bound, slot) || unboundInput(recipe, bound, slot))) {
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
      if (bytesExhausted) return { error: 'limit-exceeded' };
      let pins: ReturnType<typeof pathPins>;
      try { pins = pathPins(target.absolute); } catch { return { error: 'target-unreadable' }; }
      try {
        const leaf = lstatSync(target.absolute);
        if (leaf.size > MAX_TARGET_BYTES || !fitsTotal(leaf.size)) return { error: 'limit-exceeded' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { error: 'target-unreadable' };
      }
      const live = transaction(target.root).inspect(target.path);
      if (live.state === 'unreadable') return { error: 'target-unreadable' };
      if (live.state === 'present') targetBytes += live.bytes.length;
      const outcome: KeyOutcome = { live: live.state === 'present' ? { present: true, bytes: live.bytes } : { present: false } };
      const group = groups.get(key);
      // A fold failure affects only the target row; digest checks still use the live capture.
      const fold = (): Buffer | null | undefined => {
        let desired: Buffer | null = live.state === 'present' ? live.bytes : null;
        try {
          for (const contribution of group!.contributions) {
            desired = contribution.fold!(desired);
            if (desired !== null && desired.byteLength > MAX_TARGET_BYTES) { outcome.rowError = 'limit-exceeded'; return undefined; }
          }
        } catch (error) {
          if (error instanceof RecipeEditError) { outcome.rowError = error.reason; return undefined; }
          throw error;
        }
        return desired;
      };
      const desired = group !== undefined && group.contributions.every(contribution => contribution.reason === undefined) ?
        fold() : undefined;
      if (desired !== undefined) {
        const expectedMode = group!.contributions.at(-1)!.mode;
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
      // Cancellation supersedes an earlier budget stop for every later unfinished item.
      if (terminated !== 'cancelled' && controls.signal?.aborted) terminated = 'cancelled';
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
      if (outcome === undefined || outcome.error !== undefined || outcome.rowError !== undefined)
        return { id: group.id, operationIds: [...group.operationIds], target: targetPath,
          outcome: 'unavailable' as const, reason: outcome?.error ?? outcome?.rowError ?? 'file-state-internal' };
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
    // Cancellation takes precedence even when it arrives during the last observation
    // or after the budget ran out; completed rows are retained either way.
    const cancelled = terminated === 'cancelled' || controls.signal?.aborted === true;
    const status = cancelled ? 'cancelled' as const :
      comparisons >= 1 && unavailableTargets === 0 && unavailableChecks === 0 && notCheckedCount === 0 ? 'complete' as const : 'incomplete' as const;
    return { schema: SCHEMA, package: identity, status, fileState, authority: 'not-evaluated',
      targets, checks, notChecked: omissions,
      coverage: { comparedTargets, unavailableTargets, comparedChecks, unavailableChecks, notChecked: notCheckedCount },
      diagnostics: cancelled ? [diagnostic('CANCELLED', 'cancelled', 'The file-state check was cancelled.')] : [],
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
