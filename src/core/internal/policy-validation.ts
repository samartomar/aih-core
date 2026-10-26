import { hookBindingIssues } from './hook-bindings.js';
import { canonicalJson } from './canonical.js';
import { nativeClients } from './native-clients.js';
import { findTool } from '../../harness/tool-registry.mjs';
import type { Diagnostic, ExecutionPolicy, InputSpec, Json, OrganizationPolicy, OrganizationPolicy11, OrganizationSelection11, ProcessInvocation, Recipe, Slot, TargetPath } from '../types.js';

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

export function inputDefinitionSemantics(inputs: Record<string, InputSpec>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalid = (reason: string, path: string) => diagnostics.push({ code: 'INPUT_INVALID', reason, path,
    message: 'The recipe has an invalid dependency, input definition or binding.' });
  for (const [name, spec] of Object.entries(inputs)) {
    const path = `/inputs/${name}`;
    if ((spec.type !== 'string' && (spec.minLength !== undefined || spec.maxLength !== undefined)) ||
        ((spec.type === 'string' || spec.type === 'boolean') && (spec.minimum !== undefined || spec.maximum !== undefined)) ||
        (spec.minLength !== undefined && spec.maxLength !== undefined && spec.minLength > spec.maxLength) ||
        (spec.minimum !== undefined && spec.maximum !== undefined && spec.minimum > spec.maximum)) invalid('input-bounds', path);
    if (spec.default !== undefined && (!inputAccepts(spec, spec.default) || spec.sensitive)) invalid('input-default', path);
    if (spec.enum?.some(value => !inputAccepts({ ...spec, enum: undefined }, value))) invalid('input-enum', path);
  }
  return diagnostics;
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
  diagnostics.push(...inputDefinitionSemantics(recipe.inputs));
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
  const hookIdentities = new Set<string>();
  // Recipe 1.4.0: an approval is one person's OK for one server this recipe registers, never a switch for all of them.
  const approvals = recipe.operations.flatMap((op, index) => (op.kind === 'config.entries' || op.kind === 'config.member') && op.approval ? [{ op, index }] : []);
  for (const [position, { op, index }] of approvals.entries()) {
    if (position > 0) { invalid('approval-one-server', `/operations/${index}/approval`); continue; }
    const server = op.kind === 'config.member' ? op.value.literal : op.entries[0]?.path.at(-1);
    const registered = typeof server === 'string' && recipe.operations.some(other => other.kind === 'config.entries' && !other.approval &&
      op.requires.includes(other.id) && other.entries.some(entry => entry.action === 'set' && entry.path.includes(server)));
    if (!registered) invalid('approval-server-unregistered', `/operations/${index}/approval`);
  }
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
      // An approval is exactly one literal JSON entry the person can recognise as their tool's own choice.
      if (op.approval && (op.entries.length !== 1 || op.entries[0]!.action !== 'set' || !('literal' in op.entries[0]!.value) ||
          (op.format !== 'json' && op.format !== 'jsonc'))) invalid('approval-entry', `${path}/approval`);
    } else if (op.kind === 'config.member') {
      const prefix = (a: string[], b: string[]) => a.slice(0, b.length).join('\u0000') === b.slice(0, a.length).join('\u0000');
      if (op.container.some(part => /[\p{Cc}\p{Cf}]/u.test(part))) invalid('member-container', `${path}/container`);
      (op.exclusiveWith ?? []).forEach((other, otherIndex) => {
        if (other.some(part => /[\p{Cc}\p{Cf}]/u.test(part)) || prefix(other, op.container) ||
            (op.exclusiveWith ?? []).some((another, anotherIndex) => anotherIndex !== otherIndex && prefix(another, other)))
          invalid('member-exclusive', `${path}/exclusiveWith/${otherIndex}`);
      });
      if (op.approval && op.action !== 'add') invalid('approval-member', `${path}/approval`);
    } else if (op.kind === 'text.block') {
      if (op.startMarker === op.endMarker || /[\r\n]/.test(op.startMarker + op.endMarker)) invalid('block-marker', path);
      if (op.content) checkSlot(op.content, `${path}/content`, true);
    } else if (op.kind === 'hook.group') {
      if (op.container.some(part => /[\p{Cc}\p{Cf}]/u.test(part))) invalid('hook-container', `${path}/container`);
      if (op.selector.path.some(part => typeof part === 'string' && /[\p{Cc}\p{Cf}]/u.test(part))) invalid('hook-selector', `${path}/selector/path`);
      const identity = canonicalJson({ target: op.target, format: op.format, container: op.container, groupId: op.groupId });
      if (hookIdentities.has(identity)) invalid('hook-duplicate-group', path);
      hookIdentities.add(identity);
      for (const issue of hookBindingIssues(op, recipe.inputs)) invalid(issue.reason, path + issue.path);
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

const hostLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const repositoryPattern = new RegExp(`^${hostLabel}(?:\\.${hostLabel})+/[a-z0-9._-]{1,100}/[a-z0-9._-]{1,100}$`);
/** `<host>/<owner>/<name>`, lowercase, compared by exact equality and never inferred from a checkout. */
export const isRepositoryIdentity = (value: string): boolean =>
  repositoryPattern.test(value) && value.split('/').slice(1).every(part => part !== '.' && part !== '..');
export const isOrganizationPolicy11 = (policy: OrganizationPolicy): policy is OrganizationPolicy11 =>
  policy.schema === 'urn:aihq:core:organization-policy:1.1.0';
export const isNativeClient = (value: string): boolean => (nativeClients as readonly string[]).includes(value);

/** Rechecks the client against Core's list and requires a well-formed declared repository identity. */
export function organizationTargetSemantics(target: { client?: string; tool?: { id: string; surface: string }; repository?: string }): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (target.tool !== undefined) {
    // 1.1.0 names a Harness registry tool by its canonical id; the 1.0.0 client roster stays closed.
    const { id, surface } = target.tool;
    const found = findTool(id);
    if (found?.via !== 'id') diagnostics.push(found ?
      { code: 'INPUT_INVALID', reason: 'tool-alias', path: '/tool/id', message: 'The organization target names a tool alias; use its registry id.' } :
      { code: 'INPUT_INVALID', reason: 'unknown-tool', path: '/tool/id', message: 'The organization target names a tool the registry does not know.' });
    else if (found.tool.surface !== surface) diagnostics.push({ code: 'INPUT_INVALID', reason: 'tool-surface-mismatch', path: '/tool/surface',
      message: 'The organization target names a surface the registry tool does not have.' });
  } else if (!isNativeClient(target.client!)) diagnostics.push({ code: 'INPUT_INVALID', reason: 'unknown-client', path: '/client',
    message: 'The organization target names a client that Core does not know.' });
  if (target.repository !== undefined && !isRepositoryIdentity(target.repository)) diagnostics.push({ code: 'INPUT_INVALID',
    reason: 'repository-identity', path: '/repository', message: 'The organization target names a malformed repository identity.' });
  return diagnostics;
}

const intersects = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  left === undefined || right === undefined || left.some(value => right.includes(value));
const overlaps = (left: OrganizationSelection11, right: OrganizationSelection11): boolean =>
  left.scopes.some(scope => right.scopes.includes(scope)) && intersects(left.clients, right.clients) &&
  intersects(left.repositories, right.repositories);

export function organizationSemantics(policy: OrganizationPolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalid = (reason: string, path: string, message: string) => diagnostics.push({ code: 'INPUT_INVALID', reason, path, message });
  const seen = new Set<string>();
  const current = isOrganizationPolicy11(policy) ? policy : undefined;
  const groups = new Map<string, { entry: OrganizationSelection11; index: number }[]>();
  policy.selections.forEach((selection, index) => {
    if (seen.has(selection.selectionId)) invalid('duplicate-selection-id', `/selections/${index}/selectionId`,
      'The organization document has a duplicate selection identity.');
    seen.add(selection.selectionId);
    const entry = current?.selections[index];
    if (entry === undefined) return;
    entry.clients?.forEach((client, position) => {
      if (!isNativeClient(client)) invalid('unknown-client', `/selections/${index}/clients/${position}`,
        'The organization entry names a client that Core does not know.');
    });
    entry.repositories?.forEach((repository, position) => {
      if (!isRepositoryIdentity(repository)) invalid('repository-identity', `/selections/${index}/repositories/${position}`,
        'The organization entry names a malformed repository identity.');
    });
    const group = groups.get(entry.recipeIdentity) ?? [];
    if (entry.obligation === 'required' || entry.obligation === 'prohibited') {
      const opposite = entry.obligation === 'required' ? 'prohibited' : 'required';
      if (group.some(other => other.entry.obligation === opposite && overlaps(other.entry, entry)))
        invalid('obligation-contradiction', `/selections/${index}/obligation`,
          'The organization document both requires and prohibits this recipe for an overlapping target.');
    }
    group.push({ entry, index });
    groups.set(entry.recipeIdentity, group);
  });
  return diagnostics;
}

export function policySemantics(policy: ExecutionPolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalid = (reason: string, path: string) => diagnostics.push({ code: 'INPUT_INVALID', reason, path,
    message: 'The policy has an invalid dependency, scope or input value.' });
  try { dependencyOrder(policy.selections); } catch (error) { invalid((error as Error).message, '/selections'); }
  const managers = new Set<string>();
  const current = policy.schema === 'urn:aihq:core:execution-policy:1.4.0';
  // Execution policy 1.4.0 names one selection per management id; older policies keep per-scope ids.
  const managementIds = new Set<string>();
  const excluded = new Set<string>();
  for (const [index, item] of (policy.excludedItems ?? []).entries()) {
    const key = canonicalJson([item.framework, item.itemId]);
    if (excluded.has(key)) invalid('duplicate-excluded-item', `/excludedItems/${index}`);
    excluded.add(key);
  }
  policy.selections.forEach((selection, index) => {
    const base = `/selections/${index}`;
    const manager = `${selection.scope}:${selection.managementId}`;
    if (managers.has(manager) || current && managementIds.has(selection.managementId)) invalid('duplicate-management-id', base);
    managers.add(manager); managementIds.add(selection.managementId);
    if (selection.item !== undefined) {
      // Descriptive only: an excluded item is never selected again, whatever its content identities or origin.
      if (excluded.has(canonicalJson([selection.item.framework, selection.item.itemId]))) invalid('excluded-item-selected', `${base}/item`);
      if (findTool(selection.tool!)?.via !== 'id') invalid('unknown-tool', `${base}/tool`);
      if (new Set(selection.origins!.map(origin => canonicalJson(origin))).size !== selection.origins!.length) invalid('duplicate-origin', `${base}/origins`);
    }
    if (policy.mode === 'enterprise') {
      if (selection.organizationSelectionId === undefined) invalid('organization-selection-required', `${base}/organizationSelectionId`);
    } else if (selection.organizationSelectionId !== undefined) {
      invalid('organization-selection-vibe', `${base}/organizationSelectionId`);
    }
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
