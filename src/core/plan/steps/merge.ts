// `merge` (Catalog 9, D84, D93; contract 8.1): adds one entry to a file the person may already have, and never replaces
// the file. `json` sets one JSON Pointer, `toml` one table, `markdown` one block between `<!-- aih:begin <id> -->` and
// `<!-- aih:end <id> -->`. The engine's bounded editors keep every other byte; an existing entry Core didn't write is a
// reviewed conflict (section 7). Input bindings (`inputs`, D121) are filled before lowering (`../inputs.ts`): a JSON or
// TOML entry takes them at a pointer, an argv slot or an environment name, a Markdown block at a declared placeholder.
// Secret-bound slots are presented redacted in a conflict.
import { guidanceLimit } from '../../../harness/cli-facts.mjs';
import { basename } from 'node:path/posix';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { projectRoot } from '../../internal/host-files.js';
import { aiSetupReserved, clis, owners, problem, refusal, target } from './common.js';
import { renderWrite } from './render.js';
import { holdsCoreMarker } from '../../internal/recipe-editors.js';
import { bindEntry, bindText, parseBindings, unfilledPlaceholder, type BoundInputs, type SlotTemplate } from '../inputs.js';
import type { Json } from '../../types.js';
import type { PlanStep } from '../types.js';
import type { StepContext, StepHandler, StepOutcome } from './types.js';

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

/**
 * Catalog `rootPaths`: entry values that name a path under a plan root (an acquired executable). The entry holds the path
 * from that root; Core writes it as the absolute path under the real root, which only Core knows. Each value at its
 * pointer must be exactly the recorded path.
 */
function rootPathsFilled(step: PlanStep & Record<string, Json>, index: number, entry: Json): { entry: Json } | Exclude<StepOutcome, { lowered: unknown }> {
  const list = step.rootPaths;
  if (list === undefined) return { entry };
  if (!Array.isArray(list) || list.length > 64) return problem(index, 'rootPaths', 'rootPaths', 'A merge step\'s `rootPaths` is a list of `{ pointer, root, path }`.');
  let home: string;
  try { home = projectRoot(homedir()); } catch { return refusal('home-unavailable', 'The home folder is not usable.', index); }
  const filled = structuredClone(entry);
  for (const [at, rootPath] of list.entries()) {
    const bad = problem(index, `rootPaths/${at}`, 'rootPaths', 'A root path names a JSON Pointer into the entry, the `user` root and the path the entry holds there.');
    if (!plain(rootPath) || typeof rootPath.pointer !== 'string' || rootPath.root !== 'user') return bad;
    const placed = target(rootPath as PlanStep, index); if (!('root' in placed)) return placed;
    const segments = pointerSegments(rootPath.pointer); if (!segments) return bad;
    let parent: Json = filled;
    for (const segment of segments.slice(0, -1)) parent = plain(parent) ? parent[segment] as Json : Array.isArray(parent) ? parent[Number(segment)] as Json : null;
    const last = segments[segments.length - 1]!;
    const holder = plain(parent) ? parent : Array.isArray(parent) && /^(0|[1-9][0-9]*)$/.test(last) ? parent : undefined;
    const current = holder === undefined ? undefined : Array.isArray(holder) ? holder[Number(last)] : holder[last];
    if (current !== placed.path) return bad;
    const absolute = join(home, ...placed.path.split('/'));
    if (Array.isArray(holder)) holder[Number(last)] = absolute; else (holder as { [key: string]: Json })[last] = absolute;
  }
  return { entry: filled };
}

/** The registries whose packages Catalog starts, by their runner (Catalog's `server.json` lowering). */
const RUNNERS: Record<string, { command: string; spec: (identifier: string, version: string) => string }> = {
  npm: { command: 'npx', spec: (identifier, version) => `${identifier}@${version}` },
  pypi: { command: 'uvx', spec: (identifier, version) => `${identifier}==${version}` },
};
const argumentsOf = (entries: Json | undefined): string[] => (Array.isArray(entries) ? entries : []).flatMap(entry => !plain(entry) ? [] :
  entry.type === 'named' ? [String(entry.name), ...(typeof entry.value === 'string' ? [entry.value] : [])] : typeof entry.value === 'string' ? [entry.value] : []);
/**
 * An MCP item's merge entry is bound to the item's scanned `server.json` when the plan supplies that file's bytes: the
 * command and arguments the entry starts, or the URL it names, must be exactly what that file declares, lowered the way
 * Catalog lowers it (the registry's runner, its flags, `identifier@version` or `identifier==version`, the package's
 * arguments). An AI setup's MCP item is not: its entry starts the acquired, qualified program instead.
 */
function serverMismatch(step: PlanStep & Record<string, Json>, context: StepContext, owners: string[], entry: Json): Exclude<StepOutcome, { lowered: unknown }> | undefined {
  if (owners.length !== 1 || !plain(entry)) return undefined;
  const id = owners[0]!;
  const items = (context.request.contents as unknown as { items?: Record<string, Json>[] }[]).flatMap(content => Array.isArray(content.items) ? content.items : []);
  const item = items.find(candidate => candidate.id === id);
  if (!item || item.kind !== 'mcp' || items.some(other => plain(other.aiSetup) && other.aiSetup.mcpItem === id)) return undefined;
  const file = (Array.isArray(item.files) ? item.files : []).find(entry => plain(entry) && typeof entry.sourcePath === 'string' &&
    /(^|\/)server\.json$/.test(entry.sourcePath)) as Record<string, Json> | undefined;
  if (!file) return undefined;
  const facts = context.itemFile(id, file.sourcePath as string, { ...(typeof file.sourceId === 'string' ? { sourceId: file.sourceId } : {}),
    ...(typeof file.sha256 === 'string' ? { sha256: file.sha256 } : {}) });
  if (!facts) return undefined;
  const supplied = context.bytesFor(facts);
  // Without the file's bytes nothing was scanned to bind to.
  if ('refusal' in supplied) return supplied.refusal.code === 'source-missing' ? undefined : supplied;
  const mismatch = (what: string) => refusal('source-mismatch', `Step ${context.index}'s MCP entry ${what} differs from what \`${facts.sourcePath}\` declares.`, context.index);
  let server: Json;
  try { server = JSON.parse(supplied.bytes.toString('utf8')) as Json; } catch { return mismatch('(an unreadable server.json)'); }
  if (!plain(server)) return mismatch('(an unreadable server.json)');
  const pkg = (Array.isArray(server.packages) ? server.packages : []).find(candidate => plain(candidate) && typeof candidate.registryType === 'string' &&
    Object.hasOwn(RUNNERS, candidate.registryType) && (!plain(candidate.transport) || (candidate.transport.type ?? 'stdio') === 'stdio')) as Record<string, Json> | undefined;
  const fields = mcpFieldNames(context, step, plain(server) && Array.isArray(server.remotes) && plain(server.remotes[0]) ? String(server.remotes[0].type) : undefined);
  if (pkg) {
    const runner = RUNNERS[pkg.registryType as string]!;
    const declared = [runner.command, ...argumentsOf(pkg.runtimeArguments), runner.spec(String(pkg.identifier), String(pkg.version)), ...argumentsOf(pkg.packageArguments)];
    const started = fields.argv !== undefined ? entry[fields.argv] : Array.isArray(entry[fields.command]) ? entry[fields.command] :
      [entry[fields.command], ...(Array.isArray(entry[fields.args]) ? entry[fields.args] as Json[] : entry[fields.args] === undefined ? [] : [entry[fields.args]!])];
    return JSON.stringify(started) === JSON.stringify(declared) ? undefined : mismatch('command or arguments');
  }
  const remote = (Array.isArray(server.remotes) ? server.remotes : [])[0];
  if (!plain(remote) || typeof remote.url !== 'string') return undefined;
  return entry[fields.url] === remote.url ? undefined : mismatch('URL');
}
/** The MCP entry field names the profile of the step's CLI gives (`mcpFile`), or the common ones. */
function mcpFieldNames(context: StepContext, step: PlanStep & Record<string, Json>, remoteType: string | undefined): { command: string; args: string; argv?: string; url: string } {
  const served = Array.isArray(step.clis) ? step.clis : [];
  const named = (context.request.profiles as unknown as { id?: unknown; mcpFile?: Json }[])
    .filter(profile => !served.length || served.includes(profile.id as Json)).map(profile => profile.mcpFile).find(plain);
  const stdio = named && plain(named.stdio) ? named.stdio : {};
  const forms = named && plain(named.remote) ? named.remote : {};
  const remote = remoteType !== undefined && plain(forms[remoteType]) ? forms[remoteType] : Object.values(forms).find(plain);
  return { command: typeof stdio.command === 'string' ? stdio.command : 'command', args: typeof stdio.args === 'string' ? stdio.args : 'args',
    ...(typeof stdio.argv === 'string' ? { argv: stdio.argv } : {}), url: remote && typeof remote.url === 'string' ? remote.url : 'url' };
}

/** A Markdown block's text from its `render` (through the caller's Catalog) or its copied `from` file, UTF-8 only. */
async function blockText(step: PlanStep & Record<string, Json>, context: StepContext, path: string, owners: string[]):
    Promise<{ text: string } | Exclude<StepOutcome, { lowered: unknown }>> {
  const { index } = context;
  let bytes: Buffer;
  if (step.render !== undefined) {
    const done = await renderWrite(step, context, path, owners);
    if (!('rendered' in done)) return done;
    bytes = done.rendered.bytes;
  } else {
    const from = step.from;
    const item = from && typeof from === 'object' && !Array.isArray(from) && typeof from.item === 'string' ? from.item : owners.length === 1 ? owners[0] : undefined;
    if (!from || typeof from !== 'object' || Array.isArray(from) || typeof from.sourcePath !== 'string' || item === undefined)
      return problem(index, 'from', 'from', 'A Markdown merge names `from` as the file of the item whose block it is.');
    const facts = context.itemFile(item, from.sourcePath, { ...(typeof from.sourceId === 'string' ? { sourceId: from.sourceId } : {}),
      ...(typeof from.sha256 === 'string' ? { sha256: from.sha256 } : {}) });
    if (!facts) return refusal('source-missing', `Step ${index} names \`${from.sourcePath}\`, which no supplied content document lists.`, index);
    if (from.sourceId !== undefined && from.sourceId !== facts.sourceId || from.sha256 !== undefined && from.sha256 !== facts.sha256)
      return refusal('source-mismatch', `Step ${index}'s source facts for \`${from.sourcePath}\` differ from the content document's.`, index);
    const supplied = context.bytesFor(facts); if ('refusal' in supplied) return supplied;
    bytes = supplied.bytes;
  }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
  catch { return problem(index, 'from', 'entry', `The block for \`${path}\` is not UTF-8 text.`); }
}

export const merge: StepHandler = {
  op: 'merge',
  async prepare(step, context) {
    const { index } = context;
    const owner = owners(step, index); if ('problem' in owner) return owner;
    const placed = target(step, index, 'file'); if (!('root' in placed)) return placed;
    const reserved = aiSetupReserved(placed.root, placed.path, index); if (reserved) return reserved;
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
    let slots: SlotTemplate[] = [];
    let bound: BoundInputs | undefined;
    const fill = () => {
      if (!parsed.bindings.length) return undefined;
      const done = bindEntry(entry as Json, segments!, parsed.bindings, inputs, placed.path);
      if (!('entry' in done)) return done;
      ({ entry, secrets, redact, bound, slots } = done);
      return undefined;
    };
    if (format === 'json') {
      segments = pointerSegments(key);
      if (!segments) return problem(index, 'key', 'key', 'A JSON merge `key` is a JSON Pointer below the document root.');
      if (entry === undefined) return problem(index, 'entry', 'entry', 'A merge step names its `entry`.');
      const unbound = serverMismatch(step, context, owner.ids, entry as Json); if (unbound) return unbound;
      const rooted = rootPathsFilled(step, index, entry as Json); if (!('entry' in rooted)) return rooted;
      entry = rooted.entry;
      const failed = fill(); if (failed) return failed;
    } else if (format === 'toml') {
      segments = key.split('.');
      if (segments.length > 16 || !segments.every(segment => TOML_KEY.test(segment)))
        return problem(index, 'key', 'key', 'A TOML merge `key` is one table of bare keys, such as `mcp_servers.github`.');
      if (!plain(entry)) return problem(index, 'entry', 'entry', 'A TOML merge `entry` is a non-empty table of scalar or scalar-array values.');
      const unbound = serverMismatch(step, context, owner.ids, entry as Json); if (unbound) return unbound;
      const rooted = rootPathsFilled(step, index, entry as Json); if (!('entry' in rooted)) return rooted;
      entry = rooted.entry;
      const failed = fill(); if (failed) return failed;
      tableLeaves = plain(entry) ? leaves(entry) : undefined;
      if (!tableLeaves || !tableLeaves.length)
        return problem(index, 'entry', 'entry', 'A TOML merge `entry` is a non-empty table of scalar or scalar-array values.');
    } else {
      if (!ID.test(key)) return problem(index, 'key', 'key', 'A Markdown merge `key` is the item id that names its block.');
      if (step.rootPaths !== undefined) return problem(index, 'rootPaths', 'rootPaths', 'Only a JSON or TOML entry names `rootPaths`.');
      // Catalog gives a block's text by its source file (`from`), rendered by the caller's Catalog when it has a `render`
      // (a rule as `rule-block`, the generated `bundle-root` rule); an explicit `entry` is the text itself.
      if (entry === undefined && (step.render !== undefined || step.from !== undefined)) {
        const block = await blockText(step, context, placed.path, owner.ids);
        if (!('text' in block)) return block;
        entry = block.text;
      }
      if (typeof entry !== 'string' || entry.length > 1_048_576)
        return problem(index, 'entry', 'entry', "A Markdown merge `entry` is the block's text.");
      segments = [key];
      if (parsed.bindings.length) {
        const from = plain(step.from) && typeof step.from.sourcePath === 'string' ? step.from.sourcePath : undefined;
        const done = bindText(entry, placed.path, parsed.bindings, inputs, from);
        if (!('text' in done)) return done;
        entry = done.text; bound = done.bound;
      }
      if (holdsCoreMarker(entry as string))
        return problem(index, 'entry', 'entry', "A Markdown merge `entry` never holds a Core block marker, its own or another block's.");
      const unfilled = unfilledPlaceholder(step, index, entry, owner.ids, inputs); if (unfilled) return unfilled;
    }
    const name = basename(placed.path);
    // A guidance file a served CLI reads only up to a size (C72); a step naming no CLIs serves every profile's.
    const guidance = format === 'markdown' ? guidanceLimit(served.clis.length ? served.clis : context.request.profiles.map(profile => String(profile.id)), name) : undefined;
    const sentence = format === 'markdown' ? `Adds the \`${key}\` block to \`${placed.path}\`` : `Adds \`${key}\` to \`${placed.path}\``;
    return { lowered: { kind: 'merge', managementIds: owner.ids, root: placed.root, path: placed.path, format, key, segments,
      entry: entry as Json, ...(tableLeaves ? { leaves: tableLeaves } : {}), secrets, redact, ...(slots.length ? { slots } : {}), ...(bound ? { bound } : {}), ...(guidance ? { guidance: { label: guidance.label, maxBytes: guidance.maxBytes } } : {}), sentence,
      cantPromise: null, review: { ...owner.review, clis: served.clis, format, key, ...(bound ? { inputs: bound.review } : {}) } } };
  }
};
