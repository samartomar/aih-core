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
import { readOwnership } from '../../internal/state.js';
import { acquiredByCore, aiSetupReserved, clis, owners, problem, refusal, target } from './common.js';
import { renderWrite } from './render.js';
import { holdsCoreMarker } from '../../internal/recipe-editors.js';
import { bindEntry, bindText, isLoaderVariable, parseBindings, unfilledPlaceholder, type BoundInputs, type SlotTemplate } from '../inputs.js';
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
/** The keys a client's MCP container goes by: a merge inside one writes MCP servers. */
const CONTAINERS = /^(mcpservers|mcp_servers|servers|mcp|context_servers)$/i;
type McpProfile = { stdio: Record<string, Json>; remote: Record<string, Record<string, Json>>; tools: Record<string, Json>; place?: string[] };
/** The MCP file descriptions (`mcpFile`) and MCP places (`places.mcp`) of the profiles a step serves. */
function mcpProfiles(context: StepContext, step: PlanStep & Record<string, Json>, file: string, format: string): McpProfile[] {
  const served = Array.isArray(step.clis) ? step.clis : [];
  return (context.request.profiles as unknown as Record<string, Json>[]).filter(profile => !served.length || served.includes(profile.id as Json))
    .flatMap(profile => {
      const mcpFile = plain(profile.mcpFile) ? profile.mcpFile : undefined;
      const places = plain(profile.places) && plain(profile.places.mcp) ? Object.values(profile.places.mcp).filter(plain) : [];
      const place = places.find(entry => entry.file === file && typeof entry.key === 'string');
      if (!mcpFile && !place) return [];
      const key = place ? String(place.key) : undefined;
      return [{ stdio: mcpFile && plain(mcpFile.stdio) ? mcpFile.stdio : {}, tools: mcpFile && plain(mcpFile.tools) ? mcpFile.tools : {},
        remote: mcpFile && plain(mcpFile.remote) ? Object.fromEntries(Object.entries(mcpFile.remote).filter(([, form]) => plain(form))) as Record<string, Record<string, Json>> : {},
        ...(key ? { place: (format === 'toml' ? key.split('.') : pointerSegments(key) ?? []).slice(0, -1) } : {}) }];
    });
}
/**
 * Where a merge writes in a client's MCP container: `{ name }` for exactly one whole server entry (`/mcpServers/<name>`,
 * `mcp_servers.<name>` or the profile's MCP place), `shape` for the container itself, a field inside a server or any
 * deeper key, and `undefined` for a key outside any MCP container.
 */
function mcpPlace(segments: string[], profiles: McpProfile[]): { name: string } | 'shape' | undefined {
  const fold = (value: string) => value.toLowerCase();
  for (const container of profiles.flatMap(profile => profile.place ? [profile.place] : [])) {
    if (!container.length || segments.length < container.length || !container.every((part, at) => fold(part) === fold(segments[at]!))) continue;
    return segments.length === container.length + 1 ? { name: segments.at(-1)! } : 'shape';
  }
  let at = -1;
  segments.forEach((segment, index) => { if (CONTAINERS.test(segment)) at = index; });
  if (at < 0) return undefined;
  return segments.length === at + 2 ? { name: segments[at + 1]! } : 'shape';
}
/** Every environment object in an entry, at any depth: the keys a client sets for the program it starts. */
function environments(value: Json, names: Set<string>, found: Record<string, Json>[] = [], depth = 0): Record<string, Json>[] {
  if (depth > 32) return found;
  if (Array.isArray(value)) for (const item of value) environments(item, names, found, depth + 1);
  else if (plain(value)) for (const [key, child] of Object.entries(value)) {
    if (names.has(key.toLowerCase()) && plain(child)) found.push(child);
    environments(child, names, found, depth + 1);
  }
  return found;
}
const sameJson = (a: Json | undefined, b: Json | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);
const stringList = (value: Json | undefined): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * Binds a merge that writes in a client's MCP container to one MCP item, whole (contract 8.1). The write must be exactly
 * one server entry (`mcp-entry-shape` otherwise), named by exactly one MCP item of the step's own framework, with keys
 * only from the fixed allowlist (`command`, `args`, `env`, `type`, `url`, `headers` and the profile's names for them and
 * its tool lists), and no environment, at any depth, that sets a loader or search variable. The entry must then equal the
 * one derived for that item, with only its declared input slots differing:
 * - an AI setup's own MCP item, while that setup is acquired in this plan or on a receipt: the acquired program (a
 *   `rootPaths` path inside that setup's folder) and the setup's launch arguments;
 * - otherwise from the item's scanned `server.json` (required whenever its content document lists one): the package Core
 *   can start (its registry's runner, flags, exact package and arguments, with the profile's fixed fields) or the remote
 *   (its URL, the profile's fixed fields and declared headers). A remote entry never starts a program, and a package entry
 *   never names a URL.
 * An MCP item whose content gives no `server.json` at all has nothing to derive from: its entry is checked for shape,
 * keys and environment only, and the review labels the program it starts.
 */
function bindMcpEntry(step: PlanStep & Record<string, Json>, context: StepContext, owners: string[], entry: Json, segments: string[], file: string,
    format: string): Exclude<StepOutcome, { lowered: unknown }> | undefined {
  const profiles = mcpProfiles(context, step, file, format);
  const place = mcpPlace(segments, profiles);
  if (place === undefined) return undefined;
  const { index } = context;
  const shape = (message: string) => refusal('mcp-entry-shape', `Step ${index} ${message}`, index);
  if (place === 'shape' || !plain(entry)) return shape('writes in an MCP container other than one whole server entry (`/mcpServers/<name>`, `mcp_servers.<name>`).');
  const documents = context.request.contents as unknown as { framework?: { id?: unknown }; items?: Record<string, Json>[] }[];
  const items = documents.flatMap(content => Array.isArray(content.items) ? content.items.map(item => ({ item, framework: String(content.framework?.id) })) : []);
  // The step's own framework: the one its owners belong to (a framework id, or the content document of an owning item).
  const frameworks = new Set(owners.flatMap(owner => [...items.filter(entry => entry.item.id === owner).map(entry => entry.framework),
    ...documents.filter(content => content.framework?.id === owner).map(() => owner)]));
  // The MCP item the entry is for: the step's own MCP item owner, or else the MCP item of the server's name in its content.
  const owning = items.filter(({ item }) => item.kind === 'mcp' && owners.includes(String(item.id)));
  const named = owning.length ? owning : items.filter(({ item, framework }) => item.kind === 'mcp' && item.name === place.name && frameworks.has(framework));
  if (named.length !== 1) return refusal('source-mismatch', `Step ${index} writes the MCP server \`${place.name}\`, which is not exactly one MCP item of its own content.`, index);
  const [{ item, framework }] = named as [{ item: Record<string, Json>; framework: string }];
  const id = String(item.id);
  // The allowlisted keys: the fixed names and each served profile's names for the same fields and its tool lists.
  const fields = (form: 'stdio' | 'remote') => new Set([...(form === 'stdio' ? ['command', 'args', 'env', 'type'] : ['url', 'headers', 'type']),
    ...profiles.flatMap(profile => form === 'stdio' ? Object.entries(profile.stdio).filter(([key]) => key !== 'set').map(([, name]) => String(name)) :
      Object.values(profile.remote).flatMap(remote => Object.entries(remote).filter(([key]) => key !== 'set').map(([, name]) => String(name)))),
    ...profiles.flatMap(profile => Object.values(form === 'stdio' ? { set: profile.stdio.set } : {}).flatMap(set => plain(set) ? Object.keys(set) : [])),
    ...profiles.flatMap(profile => form === 'remote' ? Object.values(profile.remote).flatMap(remote => plain(remote.set) ? Object.keys(remote.set) : []) : []),
    ...profiles.flatMap(profile => Object.values(profile.tools).map(String))]);
  const stdioKeys = fields('stdio'), remoteKeys = fields('remote');
  const unknown = Object.keys(entry).find(key => !stdioKeys.has(key) && !remoteKeys.has(key));
  if (unknown !== undefined) return shape(`writes the MCP entry key \`${unknown}\`, which no client's MCP entry takes from a plan.`);
  const envNames = new Set(['env', 'environment', ...profiles.map(profile => profile.stdio.env).filter((name): name is string => typeof name === 'string').map(name => name.toLowerCase())]);
  for (const env of environments(entry, envNames)) {
    const loader = Object.keys(env).find(isLoaderVariable);
    if (loader !== undefined) return problem(index, 'entry', 'loader-variable', `An MCP entry's environment never sets \`${loader}\`: it changes which program or code runs.`);
  }
  const stdio = profiles.find(profile => Object.keys(profile.stdio).length)?.stdio ?? {};
  const names = { command: typeof stdio.command === 'string' ? stdio.command : 'command', args: typeof stdio.args === 'string' ? stdio.args : 'args',
    argv: typeof stdio.argv === 'string' ? stdio.argv : undefined, env: typeof stdio.env === 'string' ? stdio.env : 'env' };
  const started = (): Json[] | undefined => {
    const argv = names.argv !== undefined ? entry[names.argv] : Array.isArray(entry[names.command]) ? entry[names.command] : undefined;
    if (argv !== undefined) return Array.isArray(argv) ? argv : undefined;
    if (entry[names.command] === undefined) return undefined;
    return [entry[names.command]!, ...(entry[names.args] === undefined ? [] : Array.isArray(entry[names.args]) ? entry[names.args] as Json[] : [entry[names.args]!])];
  };
  const mismatch = (what: string, source = 'its MCP item') => refusal('source-mismatch', `Step ${index}'s MCP entry ${what} differs from what ${source} declares.`, index);
  const fixedFieldsHold = (set: Json | undefined) => !plain(set) || Object.entries(set).every(([key, value]) => entry[key] === undefined || sameJson(entry[key], value));
  // An AI setup's own MCP item: its entry starts the acquired program with the setup's launch arguments.
  const setups = items.filter(other => other.framework === framework && other.item.kind === 'ai-setup' && plain(other.item.aiSetup) && other.item.aiSetup.mcpItem === id);
  const setup = setups.find(other => acquiredSetup(context, String(other.item.id)));
  if (setup) {
    const argv = started();
    const rootPaths = (Array.isArray(step.rootPaths) ? step.rootPaths : []).filter(plain);
    const acquire = context.request.plan.plan.find(other => other.op === 'acquire' && other.aiSetup === setup.item.id);
    const inside = (path: string) => acquire && typeof acquire.into === 'string' ? path.startsWith(acquire.into.replace(/\/$/, '') + '/') : acquiredByCore(path, String(setup.item.id));
    if (!argv || typeof argv[0] !== 'string' || !rootPaths.some(rootPath => rootPath.path === argv[0] && inside(String(rootPath.path))))
      return mismatch('program (not the acquired program of its AI setup)', `AI setup \`${setup.item.id}\``);
    const launch = plain(setup.item.aiSetup) && plain(setup.item.aiSetup.launch) ? setup.item.aiSetup.launch : undefined;
    const cli = Array.isArray(step.clis) && typeof step.clis[0] === 'string' ? step.clis[0] : undefined;
    const declared = launch ? (cli !== undefined && plain(launch.clis) && stringList(launch.clis[cli]) ? launch.clis[cli] : stringList(launch.args) ? launch.args : undefined) : undefined;
    if (declared !== undefined && !sameJson(argv.slice(1), declared)) return mismatch('arguments', `AI setup \`${setup.item.id}\``);
    if ([...remoteKeys].some(key => !stdioKeys.has(key) && entry[key] !== undefined)) return mismatch('(a remote field beside its program)', `AI setup \`${setup.item.id}\``);
    return undefined;
  }
  const listed = (Array.isArray(item.files) ? item.files : []).find(entry => plain(entry) && typeof entry.sourcePath === 'string' &&
    entry.sourcePath.split('/').at(-1)!.toLowerCase() === 'server.json') as Record<string, Json> | undefined;
  if (!listed) return undefined;
  const sourcePath = listed.sourcePath as string;
  const facts = context.itemFile(id, sourcePath, { ...(typeof listed.sourceId === 'string' ? { sourceId: listed.sourceId } : {}),
    ...(typeof listed.sha256 === 'string' ? { sha256: listed.sha256 } : {}) });
  if (!facts) return refusal('source-missing', `Step ${index} writes \`${id}\`'s MCP entry, whose \`${sourcePath}\` no supplied content document lists.`, index);
  const declares = `\`${facts.sourcePath}\``;
  if (sourcePath.split('/').at(-1) !== 'server.json') return mismatch('(a server file not named exactly `server.json`)', declares);
  const supplied = context.bytesFor(facts);
  if ('refusal' in supplied) return supplied;
  let server: Json;
  try { server = JSON.parse(supplied.bytes.toString('utf8')) as Json; } catch { return mismatch('(an unreadable server.json)', declares); }
  if (!plain(server)) return mismatch('(an unreadable server.json)', declares);
  const pkg = (Array.isArray(server.packages) ? server.packages : []).filter(plain).find(candidate => typeof candidate.registryType === 'string' &&
    Object.hasOwn(RUNNERS, candidate.registryType) && (!plain(candidate.transport) || (candidate.transport.type ?? 'stdio') === 'stdio'));
  const remote = (Array.isArray(server.remotes) ? server.remotes : []).filter(plain)[0];
  const argv = started();
  // The entry's own shape names the form: a program to start, or a remote to connect to.
  if (argv !== undefined) {
    if (!pkg) return mismatch('(a program, where it declares no package Core can start)', declares);
    if ([...remoteKeys].some(key => !stdioKeys.has(key) && entry[key] !== undefined)) return mismatch('(a remote field beside the package)', declares);
    if (!fixedFieldsHold(stdio.set)) return mismatch('fixed fields', declares);
    if (entry.type !== undefined && !plain(stdio.set) && entry.type !== 'stdio') return mismatch('type', declares);
    const runner = RUNNERS[pkg.registryType as string]!;
    const expected = [runner.command, ...argumentsOf(pkg.runtimeArguments), runner.spec(String(pkg.identifier), String(pkg.version)), ...argumentsOf(pkg.packageArguments)];
    if (!sameJson(argv, expected)) return mismatch('command or arguments', declares);
    const allowed = new Set((Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []).flatMap(variable => plain(variable) && typeof variable.name === 'string' ? [variable.name] : []));
    const env = entry[names.env];
    if (env !== undefined && !(plain(env) && Object.keys(env).every(key => allowed.has(key)))) return mismatch('environment', declares);
    return undefined;
  }
  if (!remote || typeof remote.url !== 'string') return mismatch('(a remote, where it declares none)', declares);
  if ([...stdioKeys].some(key => !remoteKeys.has(key) && entry[key] !== undefined)) return mismatch('(a program beside the remote)', declares);
  const form = profiles.map(profile => profile.remote[String(remote.type)]).find(plain);
  const urlKey = form && typeof form.url === 'string' ? form.url : 'url';
  const headersKey = form && typeof form.headers === 'string' ? form.headers : 'headers';
  if (entry[urlKey] !== remote.url) return mismatch('URL', declares);
  if (form && !fixedFieldsHold(form.set)) return mismatch('fixed fields', declares);
  if (entry.type !== undefined && !form && entry.type === 'stdio') return mismatch('type', declares);
  const declaredHeaders = new Set((Array.isArray(remote.headers) ? remote.headers : []).flatMap(header => plain(header) && typeof header.name === 'string' ? [header.name] : []));
  const headers = entry[headersKey];
  if (headers !== undefined && !(plain(headers) && Object.keys(headers).every(key => declaredHeaders.has(key)))) return mismatch('headers', declares);
  return undefined;
}
/** Whether an AI setup is acquired by this plan (an acquire step names it) or recorded on a user-scope receipt. */
function acquiredSetup(context: StepContext, setup: string): boolean {
  if (context.request.plan.plan.some(step => step.op === 'acquire' && step.aiSetup === setup)) return true;
  try {
    return Object.values(readOwnership(projectRoot(homedir())).value.items ?? {}).some(item => item.scope === 'user' && !!item.plan?.aiSetup &&
      (item.plan.managementId ?? item.managementId) === setup);
  } catch { return false; }
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
      const unbound = bindMcpEntry(step, context, owner.ids, entry as Json, segments!, placed.path, format); if (unbound) return unbound;
      const rooted = rootPathsFilled(step, index, entry as Json); if (!('entry' in rooted)) return rooted;
      entry = rooted.entry;
      const failed = fill(); if (failed) return failed;
    } else if (format === 'toml') {
      segments = key.split('.');
      if (segments.length > 16 || !segments.every(segment => TOML_KEY.test(segment)))
        return problem(index, 'key', 'key', 'A TOML merge `key` is one table of bare keys, such as `mcp_servers.github`.');
      if (!plain(entry)) return problem(index, 'entry', 'entry', 'A TOML merge `entry` is a non-empty table of scalar or scalar-array values.');
      const unbound = bindMcpEntry(step, context, owner.ids, entry as Json, segments!, placed.path, format); if (unbound) return unbound;
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
