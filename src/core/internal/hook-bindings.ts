// Portable, bounded replacement of existing scalar leaves. This never evaluates
// a command or expands a shell expression; the caller supplies ordinary inputs.
import { canonicalJson } from './canonical.js';
import type { HookGroupOperation, InputSpec, Json, JsonObject, Slot } from '../types.js';

type Path = (string | number)[];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const samePath = (a: Path, b: Path): boolean => canonicalJson(a) === canonicalJson(b);
const scalar = (value: unknown): value is null | string | number | boolean =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);
const valueType = (value: Json): string => value === null ? 'null' : typeof value;
function leaf(root: Json, path: Path): { parent: Record<string | number, Json>; key: string | number; value: Json } | undefined {
  let node = root;
  for (const [index, part] of path.entries()) {
    if (typeof part === 'string' && (forbidden.has(part) || !part || /[\p{Cc}\p{Cf}]/u.test(part))) return;
    if (Array.isArray(node) ? typeof part !== 'number' || !Number.isInteger(part) || part < 0 || part >= node.length :
        !node || typeof node !== 'object' || typeof part !== 'string' || !Object.hasOwn(node, part)) return;
    const parent = node as unknown as Record<string | number, Json>;
    if (index === path.length - 1) return { parent, key: part, value: parent[part]! };
    node = parent[part]!;
  }
}
const depth = (value: Json): number => value && typeof value === 'object' ?
  1 + Math.max(0, ...(Array.isArray(value) ? value : Object.values(value)).map(depth)) : 0;
function bounded(group: JsonObject): boolean {
  return new TextEncoder().encode(canonicalJson(group)).length <= 65_536 && depth(group) <= 16;
}

export function hookBindingIssues(op: HookGroupOperation, inputs: Record<string, InputSpec>): { reason: string; path: string }[] {
  const issues: { reason: string; path: string }[] = [];
  const invalid = (reason: string, path: string) => issues.push({ reason, path });
  if ('input' in op.selector && (!Object.hasOwn(inputs, op.selector.input) || inputs[op.selector.input]!.type !== 'string'))
    invalid('string-slot', '/selector/input');
  if (op.action !== 'set') return issues;
  const group = op.group!.literal;
  if (!bounded(group)) invalid('hook-group-bounds', '/group');
  const paths: Path[] = [];
  for (const [index, binding] of (op.groupBindings ?? []).entries()) {
    const path = '/groupBindings/' + index;
    const at = leaf(group, binding.path);
    if (!at || !scalar(at.value)) invalid('hook-binding-path', path + '/path');
    if (paths.some(other => other.slice(0, binding.path.length).every((part, i) => part === binding.path[i]) && other.length >= binding.path.length ||
        binding.path.slice(0, other.length).every((part, i) => part === other[i]) && binding.path.length >= other.length)) invalid('hook-binding-overlap', path + '/path');
    paths.push(binding.path);
    const slot = binding.value;
    const spec = 'input' in slot && Object.hasOwn(inputs, slot.input) ? inputs[slot.input] : undefined;
    if ('input' in slot ? !spec : !scalar(slot.literal)) invalid('value-slot', path + '/value');
    else if (at && scalar(at.value)) {
      const nextType = 'input' in slot ? spec!.type === 'integer' ? 'number' : spec!.type : valueType(slot.literal);
      if (valueType(at.value) !== nextType) invalid('hook-binding-type', path + '/value');
    }
  }
  const selected = leaf(group, op.selector.path);
  const binding = op.groupBindings?.find(item => samePath(item.path, op.selector.path));
  if ('input' in op.selector) {
    if (!binding || !('input' in binding.value) || binding.value.input !== op.selector.input) invalid('hook-selector-value', '/selector');
  } else {
    const value = binding ? 'literal' in binding.value ? binding.value.literal : undefined : selected?.value;
    if (value !== op.selector.value) invalid('hook-selector-value', '/selector');
  }
  return issues;
}

export interface BoundHookGroup {
  format: 'json' | 'jsonc'; container: string[]; groupId: string;
  selector: { path: Path; value: string }; action: 'set' | 'remove'; group?: JsonObject;
}
/** Review copy only: private bound leaves are hidden regardless of scalar type. */
export function redactHookBindings(group: JsonObject, op: HookGroupOperation, inputs: Record<string, InputSpec>): JsonObject {
  const review = structuredClone(group);
  for (const binding of op.groupBindings ?? []) {
    if (!('input' in binding.value) || !inputs[binding.value.input]?.sensitive) continue;
    const at = leaf(review, binding.path);
    if (at) at.parent[at.key] = '[REDACTED]';
  }
  return review;
}
export function bindHookGroup(op: HookGroupOperation, inputs: Record<string, Json>): BoundHookGroup {
  const resolve = (slot: Slot): Json => {
    if ('literal' in slot) return slot.literal;
    if (!Object.hasOwn(inputs, slot.input)) throw new Error('hook-input-unavailable');
    return inputs[slot.input]!;
  };
  const selected = 'input' in op.selector ? resolve({ input: op.selector.input }) : op.selector.value;
  if (typeof selected !== 'string' || !selected || [...selected].length > 4096) throw new Error('hook-selector-value');
  const group = op.group ? structuredClone(op.group.literal) : undefined;
  if (group) {
    for (const binding of op.groupBindings ?? []) {
      const at = leaf(group, binding.path); const value = resolve(binding.value);
      if (!at || !scalar(at.value) || !scalar(value) || valueType(at.value) !== valueType(value)) throw new Error('hook-binding-type');
      at.parent[at.key] = value;
    }
    if (!bounded(group)) throw new Error('hook-group-bounds');
    if (leaf(group, op.selector.path)?.value !== selected) throw new Error('hook-selector-value');
  }
  return { format: op.format, container: op.container, groupId: op.groupId, selector: { path: op.selector.path, value: selected }, action: op.action,
    ...(group ? { group } : {}) };
}
