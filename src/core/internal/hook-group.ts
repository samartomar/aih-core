// Bounded edits of one object inside a shared JSON/JSONC array. Every function
// reads the exact bytes, changes at most one element span (plus the single
// comma that element needs) and refuses rather than reassigning a comment or
// formatting a neighbor. Nothing here executes a hook or interprets its fields.
import { applyEdits, createScanner, findNodeAtLocation, getNodeValue, modify, type Node } from 'jsonc-parser';
import { canonicalJson } from './canonical.js';
import { sha256 } from './host-files.js';
import { decode, fail, parsedObject } from './recipe-editors.js';
import type { JsonObject } from '../types.js';

export interface HookSelectorDigest { path: (string | number)[]; valueSha256: string }
export interface HookElement { index: number; offset: number; length: number; canonicalSha256: string; rawSha256: string }
export interface HookLocation {
  /** `missing` when the file, an object on the container path or the array itself is absent. */
  container: 'missing' | 'array';
  elements: HookElement[];
  /** Elements whose selected scalar hashes to the selector value, in array order. */
  candidates: HookElement[];
}
type Format = 'json' | 'jsonc';
// jsonc-parser's SyntaxKind is an ambient const enum; these are its published token numbers.
const COMMA = 5, LINE_COMMENT = 12, BLOCK_COMMENT = 13, EOF = 17;
const unsafe = (): never => fail('hook-edit-unsafe');

function containerNode(root: Node, container: string[]): Node | undefined {
  let node: Node = root;
  for (const key of container) {
    if (node.type !== 'object') unsafe();
    const property = node.children?.find(item => item.children?.[0]?.value === key);
    if (!property) return undefined;
    node = property.children![1]!;
  }
  if (node.type !== 'array') unsafe();
  return node;
}
/**
 * A neighbor holding a number canonical JSON cannot represent (for example `-0` or `1e999`) is still a
 * neighbor: it gets a digest no other element can share. A selected element must be representable.
 */
function describe(text: string, node: Node, index: number, selected: boolean): HookElement {
  let canonical: string;
  try { canonical = canonicalJson(getNodeValue(node)); }
  catch { if (selected) fail('unsupported-json-value'); canonical = `unrepresentable:${index}`; }
  return { index, offset: node.offset, length: node.length, canonicalSha256: sha256(canonical),
    rawSha256: sha256(Buffer.from(text.slice(node.offset, node.offset + node.length), 'utf8')) };
}
const selects = (node: Node, selector: HookSelectorDigest): boolean => {
  if (node.type !== 'object') return false;
  const target = findNodeAtLocation(node, selector.path);
  return target?.type === 'string' && sha256(target.value as string) === selector.valueSha256;
};

export function locateHookGroups(format: Format, before: Buffer | null, container: string[], selector: HookSelectorDigest): HookLocation {
  if (before === null) return { container: 'missing', elements: [], candidates: [] };
  const text = decode(before);
  const array = containerNode(parsedObject(text, format), container);
  if (!array) return { container: 'missing', elements: [], candidates: [] };
  const children = array.children ?? [];
  const chosen = children.map(child => selects(child, selector));
  const elements = children.map((child, index) => describe(text, child, index, chosen[index]!));
  return { container: 'array', elements, candidates: elements.filter((_, index) => chosen[index]) };
}

interface Trivia { comma?: { start: number; end: number }; comment: boolean; text: string }
function gap(text: string, from: number, to: number): Trivia {
  const scanner = createScanner(text, false);
  scanner.setPosition(from);
  const result: Trivia = { comment: false, text: text.slice(from, to) };
  for (let kind = scanner.scan(); kind !== EOF && scanner.getTokenOffset() < to; kind = scanner.scan()) {
    if (kind === LINE_COMMENT || kind === BLOCK_COMMENT) result.comment = true;
    else if (kind === COMMA) result.comma = { start: scanner.getTokenOffset(), end: scanner.getTokenOffset() + scanner.getTokenLength() };
  }
  return result;
}
const splice = (text: string, start: number, end: number, insert: string): Buffer =>
  Buffer.from(text.slice(0, start) + insert + text.slice(end), 'utf8');
const render = (group: JsonObject): string => canonicalJson(group);

function target(format: Format, before: Buffer | null, container: string[]): { text: string; array?: Node } {
  const text = before === null ? '' : decode(before);
  if (before === null) return { text };
  return { text, array: containerNode(parsedObject(text, format), container) };
}

/** Appends one group, creating only the missing object path and array. */
export function appendHookGroup(format: Format, before: Buffer | null, container: string[], group: JsonObject): Buffer {
  const { text, array } = target(format, before, container);
  if (!array) {
    const base = before === null ? '{}\n' : text;
    if (before === null) parsedObject(base, format);
    const eol = base.includes('\r\n') ? '\r\n' : '\n';
    let edited: string;
    try { edited = applyEdits(base, modify(base, container, [JSON.parse(render(group))], { formattingOptions: { insertSpaces: true, tabSize: 2, eol } })); }
    catch { return unsafe(); }
    parsedObject(edited, format);
    return Buffer.from(edited, 'utf8');
  }
  const children = array.children ?? [];
  const close = array.offset + array.length - 1;
  if (!children.length) {
    if (gap(text, array.offset + 1, close).comment) unsafe();
    return splice(text, array.offset + 1, array.offset + 1, render(group));
  }
  const last = children[children.length - 1]!;
  const end = last.offset + last.length;
  const rest = gap(text, end, close);
  if (rest.comment) unsafe();
  // The whitespace run before the final element supplies indentation and newline style.
  let start = last.offset;
  while (start > array.offset + 1 && /[ \t\r\n]/.test(text[start - 1]!)) start -= 1;
  const leading = text.slice(start, last.offset);
  return rest.comma ? splice(text, rest.comma.end, rest.comma.end, `${leading}${render(group)},`) :
    splice(text, end, end, `,${leading}${render(group)}`);
}

function element(format: Format, before: Buffer, container: string[], index: number): { text: string; array: Node; children: Node[]; node: Node } {
  const text = decode(before);
  const array = containerNode(parsedObject(text, format), container);
  const children = array?.children ?? [];
  const node = children[index];
  if (!array || !node) return unsafe();
  return { text, array, children, node };
}

/** Replaces only the located element's value span. */
export function replaceHookGroup(format: Format, before: Buffer, container: string[], index: number, group: JsonObject): Buffer {
  const { text, node } = element(format, before, container, index);
  return splice(text, node.offset, node.offset + node.length, render(group));
}

/** Deletes the element and the one comma that separated it; comments in adjacent trivia refuse the edit. */
export function removeHookGroup(format: Format, before: Buffer, container: string[], index: number): Buffer {
  const { text, array, children, node } = element(format, before, container, index);
  const end = node.offset + node.length;
  const close = array.offset + array.length - 1;
  const first = index === 0; const last = index === children.length - 1;
  const leading = gap(text, first ? array.offset + 1 : children[index - 1]!.offset + children[index - 1]!.length, node.offset);
  const trailing = gap(text, end, last ? close : children[index + 1]!.offset);
  if (leading.comment || trailing.comment) unsafe();
  if (children.length === 1) return splice(text, node.offset, trailing.comma?.end ?? end, '');
  if (!last) return trailing.comma ? splice(text, node.offset, trailing.comma.end, '') : unsafe();
  if (!leading.comma) unsafe();
  return splice(text, leading.comma!.start, trailing.comma?.end ?? end, '');
}
