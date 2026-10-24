/**
 * Bounded plain-JSON admission shared by the reporting data modules.
 *
 * Internal to the package: not a public export. Every reporting input is
 * admitted through here first so a getter or Proxy can never return different
 * data after validation. Error messages name structural paths only, never a
 * caller value.
 */
import { parseTree } from 'jsonc-parser';
import { pointerMember, unknownFieldPath } from '../native/canonical.mjs';

const encoder = new TextEncoder();

// Bounded plain-JSON guards. Values outside these bounds are rejected rather
// than truncated, so a caller can never smuggle host text past the projection.
export const SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 20000,
  maxStringBytes: 65536,
  maxTotalStringBytes: 1_048_576,
  maxArrayLength: 4096,
  maxObjectKeys: 256,
});

/** Prose omits caller values; optional format details retain encountered schema identifiers. */
export class ReportInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReportInputError';
    this.code = code;
    for (const key of ['path', 'encountered', 'supported']) if (details[key] !== undefined) this[key] = details[key];
  }
}

export function invalid(message, details) {
  throw new ReportInputError('INPUT_INVALID', message, details);
}

export function unsupported(message, encountered, supported, path = '/schema') {
  throw new ReportInputError('SCHEMA_UNSUPPORTED', message, { path, encountered, supported: [...supported] });
}

export function errorDetails(error, includeCode = false) {
  const details = Object.fromEntries(['path', 'encountered', 'supported'].filter(key => error[key] !== undefined).map(key => [key, error[key]]));
  if (includeCode && Object.keys(details).length) details.code = error.code;
  return details;
}

// Reporting's authored structural labels become JSON pointers in machine diagnostics.
const pointer = path => path.replace(/^(?:snapshot|claimSet|input|redaction)(?=\.|\[|$)/, '').split(/[.\[\]]/)
  .filter(Boolean).map(key => '/' + pointerMember(key)).join('');

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasExactKeys(value, keys) {
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return false;
  return own.every((key) => typeof key === 'string' && keys.includes(key));
}

export function requirePlainObject(value, path, keys) {
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) {
    const at = unknownFieldPath(value, keys, pointer(path));
    invalid(`${path}: expected object {${keys.join(',')}}`, at ? { path: at } : undefined);
  }
  return value;
}

/** A closed object whose `required` keys must be present and `optional` keys may be. */
export function requireKeys(value, path, required, optional = []) {
  const shape = `{${required.join(',')}${optional.length ? `,${optional.map((key) => `${key}?`).join(',')}` : ''}}`;
  if (!isPlainObject(value)) invalid(`${path}: expected object ${shape}`);
  const own = Reflect.ownKeys(value);
  for (const key of own) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) {
      invalid(`${path}: expected object ${shape}`, typeof key === 'string' ? { path: pointer(path) + '/' + pointerMember(key) } : undefined);
    }
  }
  for (const key of required) {
    if (!own.includes(key)) invalid(`${path}: expected object ${shape}`);
  }
  return value;
}

export function requireString(value, path, maxLength) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${path}: expected non-empty string`);
  if (maxLength !== undefined && [...value].length > maxLength) invalid(`${path}: exceeds maximum length`);
  return value;
}

export function requireEnum(value, allowed, path) {
  if (!allowed.includes(value)) invalid(`${path}: expected one of ${allowed.join('|')}`);
  return value;
}

export function requireArray(value, path) {
  if (!Array.isArray(value)) invalid(`${path}: expected array`);
  return value;
}

/**
 * Validate and copy a value into bounded plain JSON: accessors, symbol or
 * hidden keys, prototypes, cycles/shared references, non-finite or negative-zero
 * numbers, non-JSON types, and oversized or over-deep values are all rejected.
 * The returned plain copy is what callers validate and project, so a getter or
 * Proxy can never return different data after the check. Error messages name the
 * structural path only, never a caller value.
 */
export function toBoundedJson(root, label = 'input', limits = SNAPSHOT_LIMITS) {
  const state = { seen: new WeakSet(), nodes: 0, stringBytes: 0, label, limits };
  return cloneChecked(root, label, 0, state);
}

function cloneChecked(value, path, depth, state) {
  const { limits } = state;
  if (depth > limits.maxDepth) invalid(`${path}: exceeds maximum depth`);
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) invalid(`${path}: exceeds maximum node count`);
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) invalid(`${path}: expected a finite number`);
    if (Object.is(value, -0)) invalid(`${path}: negative zero is not deterministic JSON`);
    return value;
  }
  if (type === 'string') {
    const bytes = encoder.encode(value).length;
    if (bytes > limits.maxStringBytes) invalid(`${path}: string exceeds ${limits.maxStringBytes} bytes`);
    state.stringBytes += bytes;
    if (state.stringBytes > limits.maxTotalStringBytes) {
      invalid(`${state.label}: total string bytes exceed ${limits.maxTotalStringBytes}`);
    }
    return value;
  }
  if (type !== 'object') invalid(`${path}: not JSON data`);
  if (state.seen.has(value)) invalid(`${path}: cyclic or repeated reference`);
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid(`${path}: expected a plain array`);
    if (value.length > limits.maxArrayLength) invalid(`${path}: array exceeds ${limits.maxArrayLength} items`);
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
        invalid(`${path}: unexpected array property`);
      }
    }
    const copy = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        invalid(`${path}[${index}]: expected an enumerable data property`);
      }
      copy[index] = cloneChecked(descriptor.value, `${path}[${index}]`, depth + 1, state);
    }
    return copy;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(`${path}: expected a plain object`);
  const own = Reflect.ownKeys(value);
  if (own.length > limits.maxObjectKeys) invalid(`${path}: object exceeds ${limits.maxObjectKeys} keys`);
  const copy = {};
  for (let index = 0; index < own.length; index += 1) {
    const key = own[index];
    const memberPath = `${path}.field[${index}]`;
    if (typeof key !== 'string') invalid(`${path}: symbol keys are not JSON`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      invalid(`${memberPath}: expected an enumerable data property`);
    }
    // Define data properties so own __proto__ keys survive admission without invoking a setter.
    Object.defineProperty(copy, key, { value: cloneChecked(descriptor.value, memberPath, depth + 1, state), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

/** Reject a JSON document that repeats an object key or exceeds structural limits. */
export function rejectDuplicateKeys(json, limits = SNAPSHOT_LIMITS) {
  let tree;
  try { tree = parseTree(json); } catch { invalid('input: invalid JSON structure'); }
  let nodes = 0;
  function visit(node, depth) {
    if (++nodes > limits.maxNodes * 4 || depth > limits.maxDepth * 2 + 2) invalid('input: JSON exceeds structural limits');
    if (node.type === 'object') {
      const keys = new Set();
      for (const property of node.children ?? []) {
        const key = property.children[0].value;
        if (keys.has(key)) invalid('input: duplicate JSON key');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  visit(tree, 0);
}
