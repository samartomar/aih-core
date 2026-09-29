import { canonicalJson } from './canonical.js';
import type { Diagnostic, ExecutionPolicy, InputSpec, Json, Recipe, Slot } from '../types.js';

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
  for (const [name, spec] of Object.entries(recipe.inputs)) {
    const path = `/inputs/${name}`;
    if ((spec.type !== 'string' && (spec.minLength !== undefined || spec.maxLength !== undefined)) ||
        ((spec.type === 'string' || spec.type === 'boolean') && (spec.minimum !== undefined || spec.maximum !== undefined)) ||
        (spec.minLength !== undefined && spec.maxLength !== undefined && spec.minLength > spec.maxLength) ||
        (spec.minimum !== undefined && spec.maximum !== undefined && spec.minimum > spec.maximum)) invalid('input-bounds', path);
    if (spec.default !== undefined && (!inputAccepts(spec, spec.default) || spec.sensitive)) invalid('input-default', path);
    if (spec.enum?.some(value => !inputAccepts({ ...spec, enum: undefined }, value))) invalid('input-enum', path);
  }
  const checkSlot = (slot: Slot, path: string) => {
    if ('input' in slot ? !Object.hasOwn(recipe.inputs, slot.input) || recipe.inputs[slot.input]!.type !== 'string' : typeof slot.literal !== 'string') {
      invalid('string-slot', path);
    }
  };
  recipe.operations.forEach((op, index) => {
    if (!recipe.targets.includes(op.scope) || (op.scope === 'project' && op.target.root !== 'project') ||
        (op.scope === 'user' && op.target.root === 'project')) invalid('scope-mismatch', `/operations/${index}/scope`);
    checkSlot(op.content, `/operations/${index}/content`);
    op.target.segments.forEach((slot, part) => checkSlot(slot, `/operations/${index}/target/segments/${part}`));
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
  return diagnostics;
}
