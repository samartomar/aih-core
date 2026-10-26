// Portable Harness data functions: render one checked Catalog item as an ordinary Core recipe for one tool, and
// answer from a binding alone whether items work on a platform. Rendered recipes are ordinary execution-policy
// content, never Harness repair. This module never imports the Core engine and performs no host observation.
import { canonicalJson, isRecord, isSafeRelativePath, sha256Hex } from './native/canonical.mjs';
import { deriveCellSupport, toolBindingKinds, validateToolBinding } from './tool-binding.mjs';
import { selectTool } from './tool-registry.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BEHAVIOUR = 'aih-behaviour.json';
const PLACEHOLDER = /\{([^{}]*)\}/g;
const CATALOG_PLACEHOLDERS = new Set(['projectDir', 'homeDir', 'itemDir', 'pluginRoot']);
const INTERPRETERS = new Set(['node', 'bash', 'python', 'pwsh']);
// Kinds a tool must read natively: there are no reference files, so these are never delivered where unread.
const NATIVE_ONLY = new Set(['agent', 'command']);
// How each hook protocol's runtime names the project and home folders inside a hook command.
const HOOK_PROTOCOL_FOLDERS = Object.freeze({
  'claude-code-hooks': Object.freeze({ projectDir: '${CLAUDE_PROJECT_DIR}', homeDir: '${HOME}' })
});
/** The material-root id a consumer maps to the installed Catalog package folder for rendered recipes. */
export const deliveryMaterialRoot = 'catalog';

class Refusal extends Error {
  constructor(code, reason, path, message) { super(message); this.refusal = { status: 'refused', code, reason, path, message }; }
}
const invalid = (reason, path, message) => { throw new Refusal('INPUT_INVALID', reason, path, message); };
const unavailable = (reason, path, message) => { throw new Refusal('PREREQUISITE_UNAVAILABLE', reason, path, message); };
const guarded = body => {
  try { return body(); } catch (error) { if (error instanceof Refusal) return error.refusal; throw error; }
};
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
const segmentsOf = path => path.split('/');
const lines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`)
  .sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join('');

/** The tool, validated binding and registry id; refusals match selectTool. */
function bindingFor(tool, binding, path = '') {
  const selected = selectTool(tool);
  if (selected.status === 'refused') throw Object.assign(new Refusal(selected.code, selected.reason, `${path}/tool`, 'The tool is not offered.'),
    { refusal: { ...selected, path: `${path}/tool` } });
  const checked = validateToolBinding(binding);
  if (!checked.valid) throw Object.assign(new Refusal('INPUT_INVALID', 'binding-invalid', `${path}/binding`, 'The binding is not a valid tool binding.'),
    { refusal: { status: 'refused', code: 'INPUT_INVALID', reason: 'binding-invalid', path: `${path}/binding`,
      message: 'The binding is not a valid tool binding.', diagnostics: checked.diagnostics } });
  if (binding.tool !== selected.tool.id) invalid('binding-tool-mismatch', `${path}/binding/tool`, 'The binding is for another tool.');
  return binding;
}

/** The fields of a checked Catalog release 1.6 item that rendering and compatibility read. */
function readItem(item, path) {
  if (!isRecord(item) || typeof item.id !== 'string' || !ID.test(item.id)) invalid('item-invalid', `${path}/id`, 'Expected a checked Catalog item.');
  if (!toolBindingKinds.includes(item.kind)) invalid('item-invalid', `${path}/kind`, 'Expected a content kind a binding names.');
  if (!Array.isArray(item.materials)) invalid('item-invalid', `${path}/materials`, 'Expected the item materials.');
  const behaviour = [], content = [];
  item.materials.forEach((member, index) => {
    const at = `${path}/materials/${index}`;
    if (!isRecord(member) || Object.hasOwn(member, 'path') || typeof member.id !== 'string' || !ID.test(member.id) ||
        !isSafeRelativePath(member.relPath) || !isSafeRelativePath(member.packagePath) || !SHA256.test(member.sha256) ||
        !Number.isSafeInteger(member.byteLength) || member.byteLength < 0)
      invalid('item-invalid', at, 'Expected a release 1.6 material with an id, paths, SHA-256 and byte length.');
    (member.role === 'behaviour' ? behaviour : content).push(member);
  });
  if (behaviour.length !== 1 || behaviour[0].relPath !== BEHAVIOUR || typeof behaviour[0].sourceId !== 'string' || !ID.test(behaviour[0].sourceId))
    invalid('item-invalid', `${path}/materials`, 'Expected exactly one behaviour file naming the publishing framework.');
  if (new Set(item.materials.map(member => member.id)).size !== item.materials.length)
    invalid('item-invalid', `${path}/materials`, 'Material ids are unique within an item.');
  if (item.contentSha256 !== sha256Hex(lines(content)) || item.behaviourSha256 !== sha256Hex(lines([...content, ...behaviour])))
    invalid('item-identity-mismatch', path, 'The item identities do not match its materials.');
  const payload = isRecord(item.payload) ? item.payload : {};
  const inputs = isRecord(item.requirements) && isRecord(item.requirements.inputs) ? item.requirements.inputs : {};
  return { item, path, ref: { framework: behaviour[0].sourceId, itemId: item.id }, kind: item.kind, payload, content, inputs };
}

const namespaced = (layout, payload, name, path) => {
  if (payload.namespace === undefined || layout.namespace === undefined) return [name];
  if (!text(payload.namespace, 128) || payload.namespace.includes('/') || !isSafeRelativePath(payload.namespace))
    invalid('item-invalid', `${path}/payload/namespace`, 'Expected one safe namespace name.');
  return layout.namespace === 'folder' ? [payload.namespace, name] : [`${payload.namespace}-${name}`];
};
const markdown = info => info.content.filter(member => /\.md$/i.test(member.relPath));
const baseName = relPath => segmentsOf(relPath).at(-1);
const material = (info, id, at) => {
  const found = info.content.find(member => member.id === id);
  if (!found) invalid('item-invalid', at, 'Expected a content material id.');
  return found;
};
const singleName = (value, at) => {
  if (!text(value, 255) || value.includes('/') || !isSafeRelativePath(value)) invalid('item-invalid', at, 'Expected one safe folder name.');
  return value;
};

/**
 * Where an item of this kind lands for a tool: root, delivered files and marker blocks, hook and registration
 * facts. Shared by rendering and the static check so both describe the same delivery.
 */
function deliveryPlan(info, binding, scope, projectFolder) {
  const layout = binding.layouts[info.kind], { payload, path } = info;
  if (NATIVE_ONLY.has(info.kind) && (layout.support === 'none' || (!layout.roots.project && !layout.roots.user)))
    unavailable('native-only-kind', `${path}/kind`, `${binding.tool} does not read ${info.kind} items; they are delivered only where read natively.`);
  const base = scope === 'user' ? 'userHome' : 'project';
  const rootPath = scope === 'user' ? layout.roots.user?.path : layout.roots.project;
  const plan = { kind: info.kind, base, files: [], blocks: [], folder: undefined, layout };
  const needRoot = () => {
    if (!rootPath) unavailable('scope-not-bound', `${path}/kind`, `The binding names no ${scope} location for ${info.kind} items.`);
    return segmentsOf(rootPath);
  };
  const file = (member, segments) => plan.files.push({ member, segments });
  const block = (member, segments) => plan.blocks.push({ member, segments });
  if (info.kind === 'skill') {
    plan.folder = [...needRoot(), ...namespaced(layout, payload, singleName(payload.dirName, `${path}/payload/dirName`), path)];
    for (const member of info.content) file(member, [...plan.folder, ...segmentsOf(member.relPath)]);
  } else if (info.kind === 'agent' || info.kind === 'command') {
    const root = needRoot();
    if (!Array.isArray(payload.files) || payload.files.length === 0) invalid('item-invalid', `${path}/payload/files`, 'Expected the carried files.');
    payload.files.forEach((id, index) => {
      const member = material(info, id, `${path}/payload/files/${index}`);
      file(member, [...root, baseName(member.relPath)]);
    });
  } else if (info.kind === 'rule') {
    const texts = markdown(info);
    if (texts.length === 0) invalid('item-invalid', `${path}/materials`, 'A rule carries its Markdown text.');
    const placement = payload.placement ?? 'file';
    const entryBlock = segments => {
      if (texts.length !== 1) invalid('rule-text-ambiguous', `${path}/materials`, 'A marker block takes exactly one Markdown material.');
      block(texts[0], segments);
    };
    if (placement === 'project-folder') {
      if (scope !== 'project') unavailable('scope-not-bound', `${path}/payload/placement`, 'A project-folder rule is delivered only to a project.');
      const folder = projectFolder ?? 'ai-coding';
      for (const member of texts) file(member, [...segmentsOf(folder), ...segmentsOf(member.relPath)]);
    } else if (placement === 'entry-block') {
      if (scope !== 'project' || binding.entryFiles.length === 0)
        unavailable('scope-not-bound', `${path}/payload/placement`, 'The binding names no entry file for a marker block.');
      for (const entry of binding.entryFiles) entryBlock(segmentsOf(entry));
    } else {
      const root = needRoot();
      if (binding.entryFiles.includes(rootPath) || /\.md$/i.test(rootPath)) entryBlock(root);
      else for (const member of texts) file(member, [...root, ...namespaced(layout, payload, baseName(member.relPath), path)]);
    }
  } else if (info.kind === 'hook') {
    if (!(layout.hookProtocols ?? []).includes(payload.protocol))
      unavailable('protocol-not-spoken', `${path}/payload/protocol`, `${binding.tool} does not speak the ${String(payload.protocol)} hook protocol.`);
    if (!Object.hasOwn(layout.hookEvents ?? {}, payload.event))
      unavailable('protocol-not-spoken', `${path}/payload/event`, `The binding maps no ${String(payload.event)} hook event for ${binding.tool}.`);
    plan.folder = [...needRoot(), info.item.id];
    for (const member of info.content) file(member, [...plan.folder, ...segmentsOf(member.relPath)]);
  } else if (info.kind === 'mcp-server') {
    needRoot();
  } else {
    const root = needRoot();
    for (const member of info.content) file(member, [...root, ...segmentsOf(member.relPath)]);
  }
  for (const entry of [...plan.files, ...plan.blocks]) if (!isSafeRelativePath(entry.segments.join('/')))
    invalid('item-invalid', path, 'A delivered path is not a safe relative path.');
  return plan;
}

const target = (base, segments) => ({ root: base, segments: segments.map(literal => ({ literal })) });
const recipeKey = (info, at) => {
  const key = `${info.ref.framework}.${info.ref.itemId}`;
  if (key.length > 128) invalid('item-invalid', at, 'The framework and item id together exceed 128 characters.');
  return key;
};
const quote = value => `"${value}"`;
const escapeLiteral = value => value.replace(/["\\`$]/g, '\\$&');

/** The hook command: the named interpreter and script, or the named program, with only Catalog's four placeholders. */
function hookCommand(info, plan, scope) {
  const { payload, path } = info, command = payload.command;
  if (!isRecord(command)) invalid('item-invalid', `${path}/payload/command`, 'A hook payload carries its command.');
  const placeholders = (value, at) => {
    for (const [, name] of value.matchAll(PLACEHOLDER)) if (!CATALOG_PLACEHOLDERS.has(name))
      invalid('unknown-placeholder', at, 'Only {projectDir}, {homeDir}, {itemDir} and {pluginRoot} may appear.');
    return escapeLiteral(value);
  };
  const itemPath = member => `{itemDir}/${member.relPath}`;
  const script = material(info, command.script, `${path}/payload/command/script`);
  const parts = [];
  if (command.interpreter !== undefined) {
    if (!INTERPRETERS.has(command.interpreter)) invalid('item-invalid', `${path}/payload/command/interpreter`, 'Expected node, bash, python or pwsh.');
    parts.push(command.interpreter, quote(itemPath(script)));
  } else if (command.program !== undefined) {
    if (!text(command.program)) invalid('item-invalid', `${path}/payload/command/program`, 'Expected a program name.');
    parts.push(quote(placeholders(command.program, `${path}/payload/command/program`)));
  } else {
    // A script run by its shebang never works on Windows, so a rendered hook always names how it runs.
    unavailable('interpreter-required', `${path}/payload/command`, 'A hook names its interpreter or program; a shebang is never relied on.');
  }
  if (command.args !== undefined && !Array.isArray(command.args)) invalid('item-invalid', `${path}/payload/command/args`, 'Expected an argument list.');
  (command.args ?? []).forEach((arg, index) => {
    const at = `${path}/payload/command/args/${index}`;
    if (typeof arg === 'string') parts.push(quote(placeholders(arg, at)));
    else if (isRecord(arg) && typeof arg.material === 'string') parts.push(quote(itemPath(material(info, arg.material, at))));
    else invalid('item-invalid', at, 'Expected a string or material argument.');
  });
  const template = plan.layout.commandTemplate ?? '{command}';
  const tokens = [...template.matchAll(PLACEHOLDER)].map(match => match[1]);
  if (tokens.filter(token => token === 'command').length !== 1 || tokens.some(token => token !== 'command' && !CATALOG_PLACEHOLDERS.has(token)))
    invalid('command-template-invalid', '/binding', 'A commandTemplate holds {command} once and otherwise only Catalog placeholders.');
  const folders = HOOK_PROTOCOL_FOLDERS[payload.protocol];
  const home = scope === 'user' ? folders.homeDir : folders.projectDir;
  const itemDir = `${home}/${plan.folder.join('/')}`;
  const values = { projectDir: folders.projectDir, homeDir: folders.homeDir, itemDir, pluginRoot: itemDir };
  const rendered = template.replace('{command}', () => parts.join(' ')).replace(PLACEHOLDER, (_, name) => values[name]);
  if (rendered.length > 4096) invalid('item-invalid', `${path}/payload/command`, 'The rendered hook command exceeds 4096 characters.');
  return { rendered, executable: command.interpreter };
}

/**
 * Renders one checked Catalog item as an ordinary Core recipe for one tool. The recipe identity, through Core's
 * public deriveRecipeIdentity, binds both item identities and the binding digest. Rendering never grants authority:
 * the recipe is ordinary execution-policy content that Enterprise organization policy governs in full.
 */
export function renderDelivery({ tool, item, binding, scope, projectFolder, grantApproval, contents } = {}) {
  return guarded(() => {
    bindingFor(tool, binding);
    const { digest, ...rest } = binding;
    if (digest !== sha256Hex(canonicalJson(JSON.parse(JSON.stringify(rest)))))
      invalid('binding-digest-mismatch', '/binding/digest', 'The binding digest is not the SHA-256 of its canonical JSON.');
    if (scope !== 'project' && scope !== 'user') invalid('scope', '/scope', 'Expected project or user.');
    if (projectFolder !== undefined && (!text(projectFolder, 255) || !isSafeRelativePath(projectFolder)))
      invalid('project-folder', '/projectFolder', 'Expected a safe relative folder.');
    if (grantApproval !== undefined && !Array.isArray(grantApproval)) invalid('grant-approval', '/grantApproval', 'Expected a list of items.');
    if (grantApproval?.length) unavailable('grant-approval-unsupported', '/grantApproval', 'Granting MCP approval is not rendered by this Core.');
    if (contents !== undefined && !isRecord(contents)) invalid('contents', '/contents', 'Expected material text keyed by material id.');
    const info = readItem(item, '/item');
    const plan = deliveryPlan(info, binding, scope, projectFolder);
    const key = recipeKey(info, '/item');
    const recipeId = `${binding.tool}.${info.ref.itemId}`;
    if (recipeId.length > 128) invalid('item-invalid', '/item/id', 'The rendered recipe id exceeds 128 characters.');
    const materials = new Map(), operations = [], checks = [], inputs = {}, prerequisites = [];
    const writeIds = [];
    plan.files.forEach(({ member, segments }, index) => {
      materials.set(member.id, member);
      const id = `write-${index + 1}`, checkId = `${id}-sha256`, at = target(plan.base, segments);
      writeIds.push(id);
      operations.push({ id, purpose: `Write ${segments.join('/')}`, kind: 'file.write', scope, target: at, material: member.id,
        ...(member.executable === true ? { mode: 493 } : {}), requires: [], checks: [checkId] });
      checks.push({ id: checkId, purpose: `${segments.join('/')} has the pinned bytes`, kind: 'file.sha256', target: at, sha256: member.sha256 });
    });
    plan.blocks.forEach(({ member, segments }, index) => {
      const value = contents?.[member.id];
      if (typeof value !== 'string') unavailable('content-required', `/contents/${member.id}`, 'A marker block needs the material text.');
      if (sha256Hex(value) !== member.sha256 || new TextEncoder().encode(value).length !== member.byteLength)
        invalid('content-mismatch', `/contents/${member.id}`, 'The supplied text does not match the material SHA-256 and length.');
      operations.push({ id: `block-${index + 1}`, purpose: `Set the ${key} block in ${segments.join('/')}`, kind: 'text.block', scope,
        target: target(plan.base, segments), blockId: key, startMarker: `<!-- BEGIN aih:${key} -->`, endMarker: `<!-- END aih:${key} -->`,
        action: 'set', content: { literal: value }, requires: [], checks: [] });
    });
    const register = plan.layout.register;
    if (info.kind === 'hook') {
      if (!register || (register.format !== 'json' && register.format !== 'jsonc'))
        unavailable('registration-not-bound', '/binding', 'The binding names no JSON hook registration for this tool.');
      const { rendered, executable } = hookCommand(info, plan, scope);
      if (executable) prerequisites.push({ kind: 'executable', name: executable });
      const { payload } = info;
      const group = { ...(text(payload.matcher) ? { matcher: payload.matcher } : {}),
        hooks: [{ type: 'command', command: rendered, ...(payload.timeoutSec !== undefined ? { timeout: payload.timeoutSec } : {}) }] };
      operations.push({ id: 'register-hook', purpose: `Register the ${key} hook group in ${register.file}`, kind: 'hook.group', scope,
        target: target(plan.base, segmentsOf(register.file)), format: register.format,
        container: [...register.container.slice(0, -1), plan.layout.hookEvents[payload.event]], groupId: key,
        selector: { path: ['hooks', 0, 'command'], value: rendered }, action: 'set', group: { literal: group },
        requires: writeIds, checks: [] });
    } else if (info.kind === 'mcp-server') {
      if (!register) unavailable('registration-not-bound', '/binding', 'The binding names no MCP registration for this tool.');
      const { payload } = info, at = '/item/payload';
      if (!text(payload.key, 128)) invalid('item-invalid', `${at}/key`, 'Expected the server key.');
      const entry = (suffix, value) => ({ path: [...register.container, payload.key, ...suffix], action: 'set', value });
      const entries = [];
      if (payload.transport === 'stdio') {
        if (!text(payload.command)) invalid('item-invalid', `${at}/command`, 'An MCP stdio transport carries its command.');
        entries.push(entry(['command'], { literal: payload.command }));
        if (payload.args !== undefined) entries.push(entry(['args'], { literal: payload.args }));
      } else if (payload.transport === 'http' || payload.transport === 'sse') {
        if (!text(payload.url)) invalid('item-invalid', `${at}/url`, 'An MCP http or sse transport carries its url.');
        entries.push(entry(['type'], { literal: payload.transport }), entry(['url'], { literal: payload.url }));
      } else invalid('item-invalid', `${at}/transport`, 'Expected stdio, http or sse.');
      for (const field of ['env', 'headers']) for (const [name, value] of Object.entries(isRecord(payload[field]) ? payload[field] : {})) {
        if (isRecord(value) && typeof value.input === 'string' && Object.hasOwn(info.inputs, value.input)) {
          inputs[value.input] = info.inputs[value.input];
          entries.push(entry([field, name], { input: value.input }));
        } else if (isRecord(value) && Object.hasOwn(value, 'value')) entries.push(entry([field, name], { literal: value.value }));
        else invalid('item-invalid', `${at}/${field}/${name}`, 'Expected an input reference or a value.');
      }
      operations.push({ id: 'register-server', purpose: `Register the ${payload.key} MCP server in ${register.file}`, kind: 'config.entries',
        scope, target: target(plan.base, segmentsOf(register.file)), format: register.format, entries, requires: [], checks: [] });
    }
    if (operations.length === 0) unavailable('nothing-to-deliver', '/item', 'The item delivers no content for this tool.');
    const recipe = {
      schema: info.kind === 'hook' ? 'urn:aihq:core:recipe:1.1.0' : 'urn:aihq:core:recipe:1.0.0',
      id: recipeId,
      description: `Deliver ${info.ref.framework}/${info.ref.itemId} (${info.kind}) to ${binding.tool}: ` +
        `content sha256:${item.contentSha256}, behaviour sha256:${item.behaviourSha256}, binding sha256:${digest}.`,
      inputs,
      materials: [...materials.values()].map(member => ({ id: member.id, source: { kind: 'local', input: deliveryMaterialRoot },
        path: member.packagePath, sha256: member.sha256, byteLength: member.byteLength })),
      targets: [scope], prerequisites, operations, checks
    };
    return { status: 'rendered', tool: binding.tool, item: info.ref, bindingDigest: digest, materialRoot: deliveryMaterialRoot, recipe };
  });
}

const OPERATING_SYSTEMS = ['windows', 'macos', 'linux'], ARCHITECTURES = ['x64', 'arm64'];
const zero = () => ({ bytes: 0, chars: 0 });
const add = (total, part) => { total.bytes += part.bytes; total.chars += part.chars; return total; };
const charsOf = member => isRecord(member.size) && member.size.status === 'measured' && Number.isSafeInteger(member.size.chars)
  ? member.size.chars : member.byteLength;
const measure = members => members.reduce((total, member) => add(total, { bytes: member.byteLength, chars: charsOf(member) }), zero());
const parts = (info, names) => (Array.isArray(info.item.size?.parts) ? info.item.size.parts : [])
  .filter(part => names.includes(part.part) && Number.isSafeInteger(part.bytes) && Number.isSafeInteger(part.chars))
  .reduce((total, part) => add(total, part), zero());

/** Delivered and always-loaded sizes for the planned delivery, in bytes and characters. */
function deliveredSize(info, plan) {
  const delivered = measure([...plan.files, ...plan.blocks].map(entry => entry.member));
  let alwaysLoaded = zero();
  if (['skill', 'agent', 'command'].includes(info.kind)) alwaysLoaded = parts(info, ['name', 'description']);
  else if (info.kind === 'rule' && (plan.blocks.length > 0 || (info.payload.inclusion ?? 'always') === 'always'))
    alwaysLoaded = { ...delivered };
  return { ...delivered, alwaysLoaded };
}

/** A cell's support, reason and newest observation on this platform. */
function cellOn(binding, kind, platform) {
  const layout = binding.layouts[kind];
  const derived = deriveCellSupport({ kind, observations: layout.observations, platform });
  const elsewhere = layout.observations.length > 0 &&
    !layout.observations.some(item => item.os === platform.os && item.arch === platform.arch);
  const reason = !elsewhere && derived.support === layout.support ? layout.reason
    : `Not observed on ${platform.os} ${platform.arch}; observations from another platform do not count.`;
  return { support: derived.support, reason, observed: derived.observed, observedOn: derived.observedOn ?? null, layout };
}

const refKey = ref => `${ref.framework}\u0000${ref.itemId}`;
const setKey = set => `${set.framework}\u0000${set.setId}\u0000${set.setSha256}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isSetRef = set => isRecord(set) && Object.keys(set).length === 3 && typeof set.framework === 'string' && ID.test(set.framework) &&
  typeof set.setId === 'string' && ID.test(set.setId) && typeof set.setSha256 === 'string' && SHA256.test(set.setSha256);

/**
 * Answers from the binding alone, for one OS and architecture, whether each Catalog-resolved item works there.
 * Only observations made on that platform count. Items are the members left after Catalog's set expansion and
 * exclusions; entries repeated across overlapping sets merge, so the answer does not depend on their order.
 */
export function checkCompatibility({ tool, platform, items, binding } = {}) {
  return guarded(() => {
    bindingFor(tool, binding);
    if (!isRecord(platform) || !OPERATING_SYSTEMS.includes(platform.os) || !ARCHITECTURES.includes(platform.arch) || Object.keys(platform).length !== 2)
      invalid('platform', '/platform', "Expected { os: 'windows' | 'macos' | 'linux', arch: 'x64' | 'arm64' }.");
    if (!Array.isArray(items) || items.length > 4096) invalid('items', '/items', 'Expected at most 4096 item entries.');
    const merged = new Map();
    items.forEach((entry, index) => {
      const at = `/items/${index}`;
      if (!isRecord(entry) || Object.keys(entry).some(key => !['item', 'fallback', 'excluded', 'required', 'sets'].includes(key)))
        invalid('items', at, 'Expected { item, fallback?, excluded?, required?, sets? }.');
      for (const flag of ['excluded', 'required']) if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean')
        invalid('items', `${at}/${flag}`, 'Expected a boolean.');
      if (entry.sets !== undefined && (!Array.isArray(entry.sets) || !entry.sets.every(isSetRef)))
        invalid('items', `${at}/sets`, 'Expected { framework, setId, setSha256 } set references.');
      const info = readItem(entry.item, `${at}/item`);
      const fallback = entry.fallback === undefined ? undefined : readItem(entry.fallback, `${at}/fallback`);
      const key = refKey(info.ref), prior = merged.get(key);
      if (!prior) { merged.set(key, { info, fallback, excluded: entry.excluded === true, required: entry.required === true,
        sets: new Map((entry.sets ?? []).map(set => [setKey(set), set])) }); return; }
      if (prior.info.item.behaviourSha256 !== info.item.behaviourSha256) invalid('item-conflict', `${at}/item`, 'One item reference names two different items.');
      if (fallback && prior.fallback && prior.fallback.item.behaviourSha256 !== fallback.item.behaviourSha256)
        invalid('fallback-conflict', `${at}/fallback`, 'One item names two different fallbacks.');
      prior.fallback ??= fallback;
      // Exclusion is never undone by the same item arriving through another set.
      prior.excluded ||= entry.excluded === true; prior.required ||= entry.required === true;
      for (const set of entry.sets ?? []) prior.sets.set(setKey(set), set);
    });
    // Membership is Catalog's: an excluded entry never binds, neither as itself nor through its fallback, and an
    // excluded item is never used as another item's fallback.
    const excluded = new Set([...merged.values()].filter(entry => entry.excluded).map(entry => refKey(entry.info.ref)));
    const ordered = [...merged.entries()].sort(([a], [b]) => compare(a, b)).map(([, entry]) => entry);
    const scopeOf = layout => layout.roots.project ? 'project' : 'user';
    const results = ordered.map(entry => {
      const own = cellOn(binding, entry.info.kind, platform);
      const isExcluded = excluded.has(refKey(entry.info.ref));
      let bound = entry.info, cell = own, boundAs;
      if (!isExcluded && own.support !== 'native' && entry.fallback && !NATIVE_ONLY.has(entry.info.kind) &&
          !NATIVE_ONLY.has(entry.fallback.kind) && !excluded.has(refKey(entry.fallback.ref))) {
        const candidate = cellOn(binding, entry.fallback.kind, platform);
        if (candidate.support === 'native') {
          bound = entry.fallback; cell = candidate;
          boundAs = { kind: entry.fallback.kind, item: entry.fallback.ref, viaFallback: true };
        }
      }
      const staticBlockers = [];
      let plan;
      if (!isExcluded) {
        try { plan = deliveryPlan(bound, binding, scopeOf(cell.layout), undefined); }
        catch (error) {
          if (!(error instanceof Refusal)) throw error;
          const { reason, message } = error.refusal;
          if (['native-only-kind', 'protocol-not-spoken'].includes(reason)) staticBlockers.push({ code: reason, detail: message });
          else if (reason !== 'scope-not-bound') throw error;
        }
        if (entry.required && cell.support === 'none') staticBlockers.push({ code: 'required-but-unsupported',
          detail: `A required ${bound.kind} item is not supported by ${binding.tool} on ${platform.os} ${platform.arch}.` });
      }
      return { entry, plan, result: {
        item: entry.info.ref, support: cell.support, reason: cell.reason, observed: cell.observed, observedOn: cell.observedOn,
        ...(boundAs ? { boundAs } : {}), ...(isExcluded ? { excluded: true } : {}),
        ...(cell.layout.register?.permissionStep && !isExcluded ? { permissionStep: cell.layout.register.permissionStep } : {}),
        deliveredSize: plan ? deliveredSize(bound, plan) : { ...zero(), alwaysLoaded: zero() }, staticBlockers } };
    });
    // Two items writing one folder (a skill folder, a hook folder) or one file.
    const writers = new Map();
    for (const { entry, plan } of results) if (plan) {
      const places = plan.folder ? [plan.folder] : plan.files.map(file => file.segments);
      for (const place of places) {
        const where = `${plan.base}/${place.join('/')}`;
        writers.set(where, [...(writers.get(where) ?? []), entry]);
      }
    }
    for (const [where, entries] of writers) if (new Set(entries.map(entry => refKey(entry.info.ref))).size > 1)
      for (const { entry, result } of results) if (entries.includes(entry) &&
          !result.staticBlockers.some(blocker => blocker.code === 'same-folder' && blocker.detail.endsWith(where)))
        result.staticBlockers.push({ code: 'same-folder', detail: `Another item also writes ${where}` });
    const sets = new Map();
    for (const { entry, result } of results) if (!result.excluded) for (const [key, set] of entry.sets) {
      const summary = sets.get(key) ?? { set, fit: 'none', members: { native: 0, unconfirmed: 0, none: 0 },
        deliveredSize: { ...zero(), alwaysLoaded: zero() } };
      const works = result.staticBlockers.length === 0 ? result.support : 'none';
      summary.members[works] += 1;
      add(summary.deliveredSize, result.deliveredSize); add(summary.deliveredSize.alwaysLoaded, result.deliveredSize.alwaysLoaded);
      sets.set(key, summary);
    }
    for (const summary of sets.values()) {
      const total = summary.members.native + summary.members.unconfirmed + summary.members.none;
      summary.fit = summary.members.native === total ? 'full' : summary.members.native === 0 ? 'none' : 'partial';
    }
    return { status: 'checked', tool: binding.tool, platform: { os: platform.os, arch: platform.arch }, bindingDigest: binding.digest,
      items: results.map(({ result }) => result), sets: [...sets.entries()].sort(([a], [b]) => compare(a, b)).map(([, summary]) => summary) };
  });
}
