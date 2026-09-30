import { canonicalJson } from './canonical.js';
import type { Diagnostic, ExecutionPolicy, InputSpec, Json, ProcessInvocation, Recipe, Slot, TargetPath } from '../types.js';

export function inputAccepts(spec: InputSpec, value: unknown): value is Json {
  if (spec.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== spec.type) return false;
  if (typeof value === 'string' && ((spec.minLength !== undefined && [...value].length < spec.minLength) ||
      (spec.maxLength !== undefined && [...value].length > spec.maxLength))) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0) ||
      (spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum))) return false;
  return !spec.enum || spec.enum.some(item => canonicalJson(item) === canonicalJson(value));
}

// A stable dependency order. No recursive walk or execution callbacks.
export function dependencyOrder<T extends { id: string; requires: string[] }>(items: T[]): T[] {
  const byId = new Map(items.map(item => [item.id, item]));
  if (byId.size !== items.length) throw new Error('duplicate-id');
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const item of items) {
    if (new Set(item.requires).size !== item.requires.length) throw new Error('duplicate-dependency');
    indegree.set(item.id, item.requires.length);
    for (const id of item.requires) {
      if (!byId.has(id)) throw new Error('missing-dependency');
      const children = dependents.get(id) ?? []; children.push(item.id); dependents.set(id, children);
    }
  }
  const ready = items.filter(item => !item.requires.length);
  const ordered: T[] = [];
  for (let index = 0; index < ready.length; index++) {
    const item = ready[index]!; ordered.push(item);
    for (const id of dependents.get(item.id) ?? []) {
      const count = indegree.get(id)! - 1; indegree.set(id, count);
      if (!count) ready.push(byId.get(id)!);
    }
  }
  if (ordered.length !== items.length) throw new Error('dependency-cycle');
  return ordered;
}

export function recipeSemantics(recipe: Recipe): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalid = (reason: string, path: string) => diagnostics.push({ code: 'INPUT_INVALID', reason, path,
    message: 'The recipe has an invalid dependency, input definition or binding.' });
  try { dependencyOrder(recipe.operations); } catch (error) { invalid((error as Error).message, '/operations'); }
  const checkIds = new Set<string>();
  for (const [index, check] of recipe.checks.entries()) {
    if (checkIds.has(check.id)) invalid('duplicate-check', `/checks/${index}/id`);
    checkIds.add(check.id);
  }
  const materialIds = new Set<string>();
  for (const [index, material] of recipe.materials.entries()) {
    if (materialIds.has(material.id)) invalid('duplicate-material', `/materials/${index}/id`);
    materialIds.add(material.id);
  }
  for (const [name, spec] of Object.entries(recipe.inputs)) {
    const path = `/inputs/${name}`;
    if ((spec.type !== 'string' && (spec.minLength !== undefined || spec.maxLength !== undefined)) ||
        ((spec.type === 'string' || spec.type === 'boolean') && (spec.minimum !== undefined || spec.maximum !== undefined)) ||
        (spec.minLength !== undefined && spec.maxLength !== undefined && spec.minLength > spec.maxLength) ||
        (spec.minimum !== undefined && spec.maximum !== undefined && spec.minimum > spec.maximum)) invalid('input-bounds', path);
    if (spec.default !== undefined && (!inputAccepts(spec, spec.default) || spec.sensitive)) invalid('input-default', path);
    if (spec.enum?.some(value => !inputAccepts({ ...spec, enum: undefined }, value))) invalid('input-enum', path);
  }
  const checkSlot = (slot: Slot, path: string, stringOnly: boolean) => {
    if ('input' in slot ? !Object.hasOwn(recipe.inputs, slot.input) ||
        stringOnly && recipe.inputs[slot.input]!.type !== 'string' : stringOnly && typeof slot.literal !== 'string')
      invalid(stringOnly ? 'string-slot' : 'value-slot', path);
  };
  const checkTarget = (target: TargetPath, path: string, scope?: 'project' | 'user') => {
    if (scope && (scope === 'project' ? target.root !== 'project' : target.root === 'project')) invalid('scope-mismatch', path);
    target.segments.forEach((slot, index) => checkSlot(slot, `${path}/segments/${index}`, true));
  };
  const checkInvocation = (invocation: ProcessInvocation, path: string) => {
    if ('material' in invocation.executable && !materialIds.has(invocation.executable.material)) invalid('material-missing', `${path}/executable`);
    checkTarget(invocation.cwd, `${path}/cwd`);
    invocation.args.forEach((slot, index) => checkSlot(slot, `${path}/args/${index}`, true));
    Object.entries(invocation.env).forEach(([key, slot]) => checkSlot(slot, `${path}/env/${key}`, true));
    if (invocation.stdin) checkSlot(invocation.stdin, `${path}/stdin`, true);
  };
  recipe.operations.forEach((op, index) => {
    const path = `/operations/${index}`;
    if (!recipe.targets.includes(op.scope)) invalid('scope-mismatch', `${path}/scope`);
    for (const id of op.checks) if (!checkIds.has(id)) invalid('check-missing', `${path}/checks`);
    if (op.kind === 'process.run') { checkInvocation(op, path); checkTarget(op.cwd, `${path}/cwd`, op.scope); return; }
    if (op.target.segments.length === 0) invalid('target-root', `${path}/target`);
    checkTarget(op.target, `${path}/target`, op.scope);
    if (op.kind === 'file.write') {
      if (op.content) checkSlot(op.content, `${path}/content`, true);
      if (op.material && !materialIds.has(op.material)) invalid('material-missing', `${path}/material`);
    } else if (op.kind === 'config.entries') {
      const paths: string[][] = [];
      for (const [entryIndex, entry] of op.entries.entries()) {
        if (entry.path.some(part => !part || /[\p{Cc}\p{Cf}]/u.test(part))) invalid('entry-path', `${path}/entries/${entryIndex}`);
        if (paths.some(other => entry.path.slice(0, other.length).join('\u0000') === other.join('\u0000') ||
            other.slice(0, entry.path.length).join('\u0000') === entry.path.join('\u0000'))) invalid('entry-overlap', `${path}/entries/${entryIndex}`);
        paths.push(entry.path);
        if (entry.action === 'set') checkSlot(entry.value, `${path}/entries/${entryIndex}/value`, false);
      }
    } else if (op.kind === 'text.block') {
      if (op.startMarker === op.endMarker || /[\r\n]/.test(op.startMarker + op.endMarker)) invalid('block-marker', path);
      if (op.content) checkSlot(op.content, `${path}/content`, true);
    }
  });
  recipe.checks.forEach((check, index) => {
    const path = `/checks/${index}`;
    if (check.kind === 'process.exit') checkInvocation(check, path);
    else {
      if (check.target.segments.length === 0) invalid('target-root', `${path}/target`);
      checkTarget(check.target, `${path}/target`);
    }
  });
  return diagnostics;
}

export function policySemantics(policy: ExecutionPolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalid = (reason: string, path: string) => diagnostics.push({ code: 'INPUT_INVALID', reason, path,
    message: 'The policy has an invalid dependency, scope or input value.' });
  try { dependencyOrder(policy.selections); } catch (error) { invalid((error as Error).message, '/selections'); }
  const managers = new Set<string>();
  policy.selections.forEach((selection, index) => {
    const base = `/selections/${index}`;
    const manager = `${selection.scope}:${selection.managementId}`;
    if (managers.has(manager)) invalid('duplicate-management-id', base);
    managers.add(manager);
    if (!('inline' in selection.recipe)) return; // Bounded acquisition precedes resolved validation.
    const recipe = selection.recipe.inline;
    diagnostics.push(...recipeSemantics(recipe).map(d => ({ ...d, path: `${base}/recipe/inline${d.path}` })));
    if (!recipe.targets.includes(selection.scope) || recipe.operations.some(op => op.scope !== selection.scope)) invalid('scope-mismatch', base);
    for (const [name, value] of Object.entries(selection.configuration)) {
      if (!Object.hasOwn(recipe.inputs, name) || recipe.inputs[name]!.sensitive || !inputAccepts(recipe.inputs[name]!, value)) {
        invalid('input-value', `${base}/configuration/${name}`);
      }
    }
    for (const [name, spec] of Object.entries(recipe.inputs)) {
      if (spec.required && !spec.sensitive && !Object.hasOwn(selection.configuration, name) && spec.default === undefined) {
        invalid('input-required', `${base}/configuration/${name}`);
      }
    }
  });
  const sets = new Set<string>(); const removals = new Set<string>();
  for (const [index, set] of (policy.managedSelections ?? []).entries()) {
    const key = `${set.scope}:${set.id}`;
    if (sets.has(key) || new Set(set.members).size !== set.members.length) invalid('duplicate-management-set', `/managedSelections/${index}`);
    sets.add(key);
    for (const id of set.members) if (!managers.has(`${set.scope}:${id}`)) invalid('management-member-missing', `/managedSelections/${index}`);
  }
  for (const [index, removal] of (policy.removals ?? []).entries()) {
    const key = `${removal.scope}:${removal.managementId}`;
    if (removals.has(key) || managers.has(key)) invalid('removal-conflict', `/removals/${index}`);
    removals.add(key);
  }
  return diagnostics;
}
