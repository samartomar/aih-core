import { createHash } from 'node:crypto';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { canonicalJson } from './canonical.js';
import type { Json } from '../types.js';
import { editScalarLines, scalarLineMember } from './scalar-line-editor.js';
import { editIni, iniMember } from './ini-editor.js';
import { editToml, tomlMember, type TomlTableCustody } from './toml-editor.js';
export { removeCreatedTomlTable, tomlTableCustody, tomlTableOf, type TomlTableCustody } from './toml-editor.js';

export class RecipeEditError extends Error {
  constructor(readonly reason: string) {
    super(`Recipe edit failed: ${reason}`);
    this.name = 'RecipeEditError';
  }
}
export function fail(reason: string): never { throw new RecipeEditError(reason); }
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function decode(before: Buffer | null): string {
  try { return before === null ? '' : utf8.decode(before); }
  catch { fail('invalid-utf8'); }
}
function validJson(value: unknown, depth = 0): value is Json {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100_000 && value.every(item => validJson(item, depth + 1));
  if (typeof value !== 'object' || !value ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    'value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}) &&
    validJson((value as Record<string, unknown>)[key], depth + 1));
}
export interface ConfigEntry { path: string[]; action: 'set' | 'remove'; value?: Json }
function validateEntries(entries: ConfigEntry[]): void {
  if (!Array.isArray(entries) || !entries.length || entries.length > 4096) fail('invalid-entries');
  const paths: string[][] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.path) || !entry.path.length ||
        entry.path.length > 32 || entry.path.some(segment => typeof segment !== 'string' || !segment ||
          segment.length > 256 || /[\u0000-\u001f\u007f]/u.test(segment)) ||
        !['set', 'remove'].includes(entry.action) || (entry.action === 'set' && !validJson(entry.value)) ||
        (entry.action === 'remove' && entry.value !== undefined)) fail('invalid-entry');
    if (paths.some(path => path.length <= entry.path.length && path.every((part, i) => part === entry.path[i]) ||
        entry.path.length <= path.length && entry.path.every((part, i) => part === path[i]))) fail('overlapping-entry-paths');
    paths.push(entry.path);
  }
}
export function parsedObject(text: string, format: 'json' | 'jsonc'): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: format === 'json', allowTrailingComma: format === 'jsonc' });
  if (errors.length || root?.type !== 'object') fail('unsupported-json-syntax');
  const walk = (node: Node): void => {
    if (node.type === 'object') {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (typeof key !== 'string' || names.has(key)) fail('duplicate-json-key');
        names.add(key);
        if (property.children?.[1]) walk(property.children[1]);
      }
    } else if (node.type === 'array') for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return root;
}
function jsonEdit(format: 'json' | 'jsonc', before: Buffer | null, entries: ConfigEntry[]): Buffer {
  let text = decode(before);
  if (before === null) text = '{}\n';
  parsedObject(text, format);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const entry of entries) {
    const root = parsedObject(text, format);
    for (let length = 1; length < entry.path.length; length += 1) {
      const parent = findNodeAtLocation(root, entry.path.slice(0, length));
      if (parent && parent.type !== 'object') fail('unsupported-json-path');
    }
    try {
      text = applyEdits(text, modify(text, entry.path, entry.action === 'set' ? entry.value : undefined,
        { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }));
    } catch { fail('unsupported-json-edit'); }
    parsedObject(text, format);
  }
  return Buffer.from(text, 'utf8');
}

/**
 * Applies narrowly selected object-key edits without replacing unrelated configuration text.
 * For TOML, `created` collects the table headers the edit appends (see `editToml`).
 */
export function renderConfigEntries(format: 'json' | 'jsonc' | 'toml' | 'ini' | 'yaml' | 'properties', before: Buffer | null, entries: ConfigEntry[],
    created?: Map<string, TomlTableCustody>): Buffer {
  validateEntries(entries);
  if (format === 'json' || format === 'jsonc') return jsonEdit(format, before, entries);
  if (format === 'toml') return editToml(before, entries, created);
  if (format === 'ini') return editIni(before, entries);
  if (format === 'yaml' || format === 'properties') return editScalarLines(format, before, entries);
  fail('unsupported-config-format');
}

export interface TextBlockEdit { blockId: string; startMarker: string; endMarker: string; action: 'set' | 'remove'; content?: string }
/** Replaces exactly one bounded marker pair, preserving every byte outside that pair. */
export function renderTextBlock(before: Buffer | null, edit: TextBlockEdit): Buffer | null {
  if (!edit || typeof edit.blockId !== 'string' || !edit.blockId || edit.blockId.length > 256 ||
      typeof edit.startMarker !== 'string' || !edit.startMarker || edit.startMarker.length > 256 ||
      typeof edit.endMarker !== 'string' || !edit.endMarker || edit.endMarker.length > 256 ||
      edit.startMarker === edit.endMarker || edit.startMarker.includes(edit.endMarker) ||
      edit.endMarker.includes(edit.startMarker) || /[\r\n\u0000]/u.test(edit.startMarker + edit.endMarker) ||
      !['set', 'remove'].includes(edit.action) ||
      (edit.action === 'set' ? typeof edit.content !== 'string' : edit.content !== undefined)) fail('invalid-text-block');
  const text = decode(before);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = [...text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)].filter(match => match[0] !== '');
  const starts: { start: number; end: number }[] = [];
  const ends: { start: number; end: number }[] = [];
  let offset = 0;
  for (const line of lines) {
    if (line[1] === edit.startMarker) starts.push({ start: offset, end: offset + line[0].length });
    if (line[1] === edit.endMarker) ends.push({ start: offset, end: offset + line[0].length });
    offset += line[0].length;
  }
  const occurrences = (marker: string): number => text.split(marker).length - 1;
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length ||
      starts.length === 1 && starts[0]!.start >= ends[0]!.start ||
      occurrences(edit.startMarker) !== starts.length ||
      occurrences(edit.endMarker) !== ends.length) fail('ambiguous-text-block');
  if (edit.action === 'remove') {
    if (!starts.length) return before === null ? null : Buffer.from(before);
    const output = text.slice(0, starts[0]!.start) + text.slice(ends[0]!.end);
    return output ? Buffer.from(output, 'utf8') : null;
  }
  const content = edit.content!;
  if (content.includes(edit.startMarker) || content.includes(edit.endMarker)) fail('ambiguous-text-block');
  const body = `${edit.startMarker}${eol}${content}${content.endsWith(eol) || !content ? '' : eol}${edit.endMarker}`;
  if (starts.length) return Buffer.from(text.slice(0, starts[0]!.start) + body + text.slice(ends[0]!.start + edit.endMarker.length), 'utf8');
  const separator = text && !/[\r\n]$/u.test(text) ? eol : '';
  return Buffer.from(`${text}${separator}${body}${eol}`, 'utf8');
}

/** Exact selected bytes, with the same ambiguity checks as the editor. */
export function configMemberBytes(format: 'json' | 'jsonc' | 'toml' | 'ini' | 'yaml' | 'properties', before: Buffer | null, path: string[]): Buffer | null {
  if (format === 'ini') return iniMember(before, path);
  if (format === 'yaml' || format === 'properties') return scalarLineMember(format, before, path);
  if (format === 'toml') return tomlMember(before, path);
  const text = decode(before);
  if (before === null) return null;
  const member = findNodeAtLocation(parsedObject(text, format), path);
  return member ? Buffer.from(text.slice(member.offset, member.offset + member.length)) : null;
}
export function blockMemberBytes(before: Buffer | null, edit: TextBlockEdit): Buffer | null {
  const removed = renderTextBlock(before, { ...edit, action: 'remove', content: undefined });
  if (before === null || removed?.equals(before)) return null;
  const text = decode(before);
  const start = text.indexOf(edit.startMarker);
  const end = text.indexOf(edit.endMarker, start) + edit.endMarker.length;
  const closingNewline = /^(?:\r\n|\n|\r)/u.exec(text.slice(end))?.[0] ?? '';
  return Buffer.from(text.slice(start, end + closingNewline.length));
}

/** Recipe 1.4.0 `config.member`: one scalar member of a JSON/JSONC array, identified by its canonical value. */
export interface MemberEdit { container: string[]; action: 'add' | 'remove'; value: string | boolean | number; exclusiveWith?: string[][] }
/** The identity of an array member: the SHA-256 of its canonical JSON value. */
export const memberDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** The array at `container`, or undefined when absent; every parent is an object and the node is an array. */
function memberArray(root: Node, container: string[]): Node | undefined {
  for (let length = 1; length < container.length; length += 1) {
    const parent = findNodeAtLocation(root, container.slice(0, length));
    if (parent && parent.type !== 'object') fail('unsupported-json-path');
  }
  const node = findNodeAtLocation(root, container);
  if (node && node.type !== 'array') fail('member-container-invalid');
  return node;
}
/** Indexes of members equal to the value (by canonical-JSON digest). */
function memberIndexes(node: Node | undefined, valueSha256: string): number[] {
  return (node?.children ?? []).flatMap((child, index) => memberDigest(getNodeValue(child)) === valueSha256 ? [index] : []);
}
/** The canonical bytes of the one member with this digest; null when absent. Two equal members are ambiguous. */
export function configArrayMemberBytes(format: 'json' | 'jsonc', before: Buffer | null, container: string[], valueSha256: string): Buffer | null {
  if (before === null) return null;
  const root = parsedObject(decode(before), format);
  const node = memberArray(root, container);
  const found = memberIndexes(node, valueSha256);
  if (found.length > 1) fail('member-ambiguous');
  return found.length ? Buffer.from(canonicalJson(getNodeValue(node!.children![found[0]!]!)), 'utf8') : null;
}
/**
 * Adds or removes one array member, keeping every other member and all text outside that member. Adding a value
 * already present changes nothing; a value found in an `exclusiveWith` array is `member-excluded`. With `dropEmpty`,
 * removing the last member also removes the array itself (Core created it).
 */
export function renderConfigMember(format: 'json' | 'jsonc', before: Buffer | null, edit: MemberEdit, { dropEmpty = false }: { dropEmpty?: boolean } = {}): Buffer {
  if (!edit || !Array.isArray(edit.container) || !edit.container.length || edit.container.length > 32 ||
      edit.container.some(segment => typeof segment !== 'string' || !segment || segment.length > 256 || /[\u0000-\u001f\u007f]/u.test(segment)) ||
      !['add', 'remove'].includes(edit.action) || !['string', 'boolean', 'number'].includes(typeof edit.value) ||
      typeof edit.value === 'number' && !Number.isFinite(edit.value)) fail('invalid-member');
  let text = before === null ? '{}\n' : decode(before);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol } };
  const root = parsedObject(text, format);
  const valueSha256 = memberDigest(edit.value);
  for (const other of edit.exclusiveWith ?? []) if (memberIndexes(memberArray(root, other), valueSha256).length) fail('member-excluded');
  const node = memberArray(root, edit.container);
  const found = memberIndexes(node, valueSha256);
  if (found.length > 1) fail('member-ambiguous');
  // Inside an existing array only the member and one separating comma change, so adding then removing a member gives
  // back the earlier bytes exactly; every other member, comment and line keeps its text.
  const encoded = JSON.stringify(edit.value);
  try {
    if (edit.action === 'add') {
      if (found.length) return Buffer.from(text, 'utf8');
      const children = node?.children ?? [];
      if (!node) text = applyEdits(text, modify(text, edit.container, [edit.value], options));
      else if (children.length) { const last = children.at(-1)!; const end = last.offset + last.length; text = `${text.slice(0, end)}, ${encoded}${text.slice(end)}`; }
      else text = `${text.slice(0, node.offset + 1)}${encoded}${text.slice(node.offset + 1)}`;
    } else if (found.length) {
      const children = node!.children!, index = found[0]!, child = children[index]!;
      const [start, end] = index > 0 ? [children[index - 1]!.offset + children[index - 1]!.length, child.offset + child.length] :
        children.length > 1 ? [child.offset, children[1]!.offset] : [child.offset, child.offset + child.length];
      const between = text.slice(start, end).replace(text.slice(child.offset, child.offset + child.length), '');
      text = /^[\s,]*$/u.test(between) ? `${text.slice(0, start)}${text.slice(end)}` : applyEdits(text, modify(text, [...edit.container, index], undefined, options));
      if (dropEmpty && children.length === 1) text = applyEdits(text, modify(text, edit.container, undefined, options));
    }
  } catch (error) { if (error instanceof RecipeEditError) throw error; fail('unsupported-json-edit'); }
  parsedObject(text, format);
  return Buffer.from(text, 'utf8');
}
