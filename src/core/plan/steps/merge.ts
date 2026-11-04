// `merge` (Catalog 9, D84, D93; contract 8.1): adds one entry to a file the person may already have, and never replaces
// the file. `json` sets one JSON Pointer, `toml` one table, `markdown` one block between `<!-- aih:begin <id> -->` and
// `<!-- aih:end <id> -->`. The engine's bounded editors keep every other byte; an existing entry Core didn't write is a
// reviewed conflict (section 7). Input bindings (`inputs`, D121) are filled before lowering (`../inputs.ts`): a JSON or
// TOML entry takes them at a pointer, an argv slot or an environment name, a Markdown block at a declared placeholder.
// Secret-bound slots are presented redacted in a conflict.
import { basename } from 'node:path/posix';
import { clis, owners, problem, target } from './common.js';
import { bindEntry, bindText, parseBindings, type BoundInputs } from '../inputs.js';
import type { Json } from '../../types.js';
import type { StepHandler } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOML_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const plain = (value: Json | undefined): value is { [key: string]: Json } => !!value && typeof value === 'object' && !Array.isArray(value);

/** A JSON Pointer's segments (RFC 6901); `undefined` for the whole document or a malformed pointer. */
export function pointerSegments(pointer: string): string[] | undefined {
  if (!pointer.startsWith('/') || pointer.length > 4096) return undefined;
  const segments = pointer.slice(1).split('/');
  if (segments.length > 32 || segments.some(segment => segment === '' || /~(?![01])/.test(segment))) return undefined;
  return segments.map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** A TOML table's leaves: scalars and scalar arrays at their table-relative paths; a nested table adds a segment. */
function leaves(entry: { [key: string]: Json }, prefix: string[] = []): { path: string[]; value: Json }[] | undefined {
  const out: { path: string[]; value: Json }[] = [];
  for (const [name, value] of Object.entries(entry)) {
    if (!TOML_KEY.test(name)) return undefined;
    const path = [...prefix, name];
    if (plain(value)) {
      const nested = leaves(value, path);
      if (!nested || !nested.length) return undefined;
      out.push(...nested);
    } else if (value === null || Array.isArray(value) && value.some(item => item === null || typeof item === 'object')) return undefined;
    else out.push({ path, value });
  }
  return out;
}

export const merge: StepHandler = {
  op: 'merge',
  prepare(step, context) {
    const { index } = context;
    const owner = owners(step, index); if ('problem' in owner) return owner;
    const placed = target(step, index, 'file'); if (!('root' in placed)) return placed;
    const served = clis(step, index); if (!('clis' in served)) return served;
    const { format, key } = step;
    let entry = step.entry;
    if (format !== 'json' && format !== 'toml' && format !== 'markdown')
      return problem(index, 'format', 'format', "A merge step's `format` is `json`, `toml` or `markdown`.");
    if (typeof key !== 'string') return problem(index, 'key', 'key', 'A merge step names its `key`.');
    const parsed = parseBindings(step.inputs, index, format === 'markdown' ? ['placeholder'] : ['pointer', 'argv', 'env']);
    if ('problem' in parsed) return parsed;
    const inputs = context.inputs(served.clis);
    let segments: string[] | undefined;
    let tableLeaves: { path: string[]; value: Json }[] | undefined;
    let secrets: string[][] = [], redact: string[][] = [];
    let bound: BoundInputs | undefined;
    const fill = () => {
      if (!parsed.bindings.length) return undefined;
      const done = bindEntry(entry as Json, segments!, parsed.bindings, inputs, placed.path);
      if (!('entry' in done)) return done;
      ({ entry, secrets, redact, bound } = done);
      return undefined;
    };
    if (format === 'json') {
      segments = pointerSegments(key);
      if (!segments) return problem(index, 'key', 'key', 'A JSON merge `key` is a JSON Pointer below the document root.');
      if (entry === undefined) return problem(index, 'entry', 'entry', 'A merge step names its `entry`.');
      const failed = fill(); if (failed) return failed;
    } else if (format === 'toml') {
      segments = key.split('.');
      if (segments.length > 16 || !segments.every(segment => TOML_KEY.test(segment)))
        return problem(index, 'key', 'key', 'A TOML merge `key` is one table of bare keys, such as `mcp_servers.github`.');
      if (!plain(entry)) return problem(index, 'entry', 'entry', 'A TOML merge `entry` is a non-empty table of scalar or scalar-array values.');
      const failed = fill(); if (failed) return failed;
      tableLeaves = plain(entry) ? leaves(entry) : undefined;
      if (!tableLeaves || !tableLeaves.length)
        return problem(index, 'entry', 'entry', 'A TOML merge `entry` is a non-empty table of scalar or scalar-array values.');
    } else {
      if (!ID.test(key)) return problem(index, 'key', 'key', 'A Markdown merge `key` is the item id that names its block.');
      if (typeof entry !== 'string' || entry.length > 1_048_576)
        return problem(index, 'entry', 'entry', "A Markdown merge `entry` is the block's text.");
      segments = [key];
      if (parsed.bindings.length) {
        const done = bindText(entry, placed.path, parsed.bindings, inputs);
        if (!('text' in done)) return done;
        entry = done.text; bound = done.bound;
      }
    }
    const name = basename(placed.path);
    const codexGuidance = format === 'markdown' && name === 'AGENTS.md' &&
      (served.clis.includes('codex') || !served.clis.length && context.request.profiles.some(profile => profile.id === 'codex'));
    const sentence = format === 'markdown' ? `Adds the \`${key}\` block to \`${placed.path}\`` : `Adds \`${key}\` to \`${placed.path}\``;
    return { lowered: { kind: 'merge', managementIds: owner.ids, root: placed.root, path: placed.path, format, key, segments,
      entry: entry as Json, ...(tableLeaves ? { leaves: tableLeaves } : {}), secrets, redact, ...(bound ? { bound } : {}), codexGuidance, sentence,
      cantPromise: null, review: { ...owner.review, clis: served.clis, format, key, ...(bound ? { inputs: bound.review } : {}) } } };
  }
};
