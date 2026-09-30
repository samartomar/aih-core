import { applyEdits, findNodeAtLocation, modify, parseTree, type Node, type ParseError } from 'jsonc-parser';
import type { Json } from '../types.js';

export class RecipeEditError extends Error {
  constructor(readonly reason: string) {
    super(`Recipe edit failed: ${reason}`);
    this.name = 'RecipeEditError';
  }
}
function fail(reason: string): never { throw new RecipeEditError(reason); }
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decode(before: Buffer | null): string {
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
function parsedObject(text: string, format: 'json' | 'jsonc'): Node {
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

interface TomlLine { text: string; start: number; end: number; newline: string; table: string; key?: string; valueStart?: number; valueEnd?: number }
const bare = /^[A-Za-z0-9_-]+$/u;
const tableName = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;
function scalar(value: Json): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return String(value);
  fail('unsupported-toml-value');
}
function tomlScalarSyntax(value: string): boolean {
  return /^(?:"(?:[^"\\\r\n]|\\["\\btnfr]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})*"|'[^'\r\n]*'|true|false|[+-]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)$/u.test(value);
}
function tomlLines(text: string): { lines: TomlLine[]; tables: Map<string, { first: number; last: number }>; assignments: Map<string, TomlLine> } {
  const lines: TomlLine[] = [];
  const tables = new Map<string, { first: number; last: number }>([['', { first: 0, last: text.length }]]);
  const assignments = new Map<string, TomlLine>();
  let table = '';
  let offset = 0;
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)) {
    const raw = match[1]!; const newline = match[2]!;
    if (!raw && !newline && offset === text.length) break;
    const line: TomlLine = { text: raw, start: offset, end: offset + raw.length + newline.length, newline, table };
    offset = line.end;
    const trim = raw.trim();
    if (!trim || trim.startsWith('#')) { lines.push(line); continue; }
    if (trim.startsWith('[[')) fail('unsupported-toml-array-table');
    if (trim.startsWith('[')) {
      const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(raw);
      if (!header || !tableName.test(header[1]!) || tables.has(header[1]!)) fail('unsupported-toml-table');
      table = header[1]!;
      line.table = table;
      tables.set(table, { first: line.start, last: text.length });
      lines.push(line);
      continue;
    }
    const assignment = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.*)$/u.exec(raw);
    if (!assignment || !bare.test(assignment[2]!)) fail('unsupported-toml-syntax');
    const key = assignment[2]!;
    const full = table ? `${table}.${key}` : key;
    if (assignments.has(full)) fail('duplicate-toml-key');
    const tail = assignment[4]!;
    const valueMatch = /^("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^#]*?)(\s*(?:#.*)?)$/u.exec(tail);
    if (!valueMatch || !valueMatch[1]!.trim()) fail('unsupported-toml-syntax');
    line.key = key;
    line.valueStart = assignment[1]!.length + key.length + assignment[3]!.length;
    line.valueEnd = line.valueStart + valueMatch[1]!.trimEnd().length;
    assignments.set(full, line);
    lines.push(line);
  }
  for (const [name, region] of tables) {
    if (!name) {
      region.last = lines.find(line => line.text.trim().startsWith('['))?.start ?? text.length;
      continue;
    }
    const following = lines.find(line => line.start > region.first && line.text.trim().startsWith('['));
    region.last = following?.start ?? text.length;
  }
  for (const assignment of assignments.keys())
    if ([...tables.keys()].some(tableName => tableName &&
      (tableName === assignment || tableName.startsWith(`${assignment}.`)))) fail('unsupported-toml-path');
  return { lines, tables, assignments };
}
function tomlEdit(before: Buffer | null, entries: ConfigEntry[]): Buffer {
  let text = decode(before);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const entry of entries) {
    if (entry.path.some(segment => !bare.test(segment))) fail('unsupported-toml-path');
    const key = entry.path.at(-1)!;
    const table = entry.path.slice(0, -1).join('.');
    const full = table ? `${table}.${key}` : key;
    const parsed = tomlLines(text);
    if ([...parsed.tables.keys()].some(name => name && (name === full || name.startsWith(`${full}.`))))
      fail('unsupported-toml-path');
    const current = parsed.assignments.get(full);
    if (entry.action === 'remove') {
      if (current) {
        if (!tomlScalarSyntax(current.text.slice(current.valueStart, current.valueEnd).trim())) fail('unsupported-toml-value');
        text = text.slice(0, current.start) + text.slice(current.end);
      }
      continue;
    }
    const rendered = scalar(entry.value!);
    if (current) {
      if (!tomlScalarSyntax(current.text.slice(current.valueStart, current.valueEnd).trim())) fail('unsupported-toml-value');
      const from = current.start + current.valueStart!;
      const to = current.start + current.valueEnd!;
      text = text.slice(0, from) + rendered + text.slice(to);
      continue;
    }
    const tableParts = entry.path.slice(0, -1);
    const tableAncestors = tableParts.map((_, i) => tableParts.slice(0, i + 1).join('.'));
    if (tableAncestors.some(name => parsed.assignments.has(name)) ||
        [...parsed.assignments.keys()].some(name => name.startsWith(`${full}.`)))
      fail('unsupported-toml-path');
    const region = parsed.tables.get(table);
    if (region) {
      const prefix = region.last > 0 && !/[\r\n]$/u.test(text.slice(0, region.last)) ? eol : '';
      text = text.slice(0, region.last) + `${prefix}${key} = ${rendered}${eol}` + text.slice(region.last);
    } else {
      if ([...parsed.tables.keys()].some(name => name === full || name.startsWith(`${full}.`))) fail('unsupported-toml-path');
      const separator = text && !/[\r\n]$/u.test(text) ? eol : '';
      text += `${separator}[${table}]${eol}${key} = ${rendered}${eol}`;
    }
  }
  tomlLines(text);
  return Buffer.from(text, 'utf8');
}

/** Applies narrowly selected object-key edits without replacing unrelated configuration text. */
export function renderConfigEntries(format: 'json' | 'jsonc' | 'toml', before: Buffer | null, entries: ConfigEntry[]): Buffer {
  validateEntries(entries);
  if (format === 'json' || format === 'jsonc') return jsonEdit(format, before, entries);
  if (format === 'toml') return tomlEdit(before, entries);
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
export function configMemberBytes(format: 'json' | 'jsonc' | 'toml', before: Buffer | null, path: string[]): Buffer | null {
  const text = decode(before);
  if (before === null) return null;
  if (format === 'toml') {
    const member = tomlLines(text).assignments.get(path.join('.'));
    if (!member) return null;
    const value = member.text.slice(member.valueStart, member.valueEnd).trim();
    if (!tomlScalarSyntax(value)) fail('unsupported-toml-value');
    return Buffer.from(value);
  }
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
