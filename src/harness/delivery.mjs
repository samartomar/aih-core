// Portable Harness data functions: render one checked Catalog item as an ordinary Core recipe for one tool, and
// answer from a binding alone whether items work on a platform. Rendered recipes are ordinary execution-policy
// content, never Harness repair. This module never imports the Core engine and performs no host observation.
import { SHA256_RE, canonicalJson, compareCodeUnits, isRecord, isSafeRelativePath, sha256Hex } from './native/canonical.mjs';
import { deriveCellSupport, toolBindingKinds, validateToolBinding } from './tool-binding.mjs';
import { selectTool } from './tool-registry.mjs';
import { permissionNotice } from './delivery-review.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BEHAVIOUR = 'aih-behaviour.json';
const PLACEHOLDER = /\{([^{}]*)\}/g;
const CATALOG_PLACEHOLDERS = new Set(['projectDir', 'homeDir', 'itemDir', 'pluginRoot']);
const INTERPRETERS = new Set(['node', 'bash', 'python', 'pwsh']);
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The MCP registration operation id; the one approval a recipe grants depends on it. */
const REGISTER_SERVER = 'register-server';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const OPERATING_SYSTEMS = ['windows', 'macos', 'linux'], ARCHITECTURES = ['x64', 'arm64'];
const VERSION = /^[0-9]{1,9}(?:\.[0-9]{1,9}){0,3}$/;
// Kinds a tool must read natively: there are no reference files, so these are never delivered where unread.
const NATIVE_ONLY = new Set(['agent', 'command']);
// How each hook protocol's runtime names the project and home folders inside a hook command.
const HOOK_PROTOCOL_FOLDERS = Object.freeze({
  'claude-code-hooks': Object.freeze({ projectDir: '${CLAUDE_PROJECT_DIR}', homeDir: '${HOME}' })
});
const REGISTRATION_FORMATS = { hook: ['json', 'jsonc'], 'mcp-server': ['json', 'jsonc', 'toml'] };
/** The material-root id a consumer maps to the installed Catalog package folder for rendered recipes. */
export const deliveryMaterialRoot = 'catalog';

class Refusal extends Error {
  constructor(refusal) { super(refusal.message); this.refusal = { status: 'refused', ...refusal }; }
}
const refuse = (code, reason, path, message, extra = {}) => { throw new Refusal({ code, reason, path, message, ...extra }); };
const invalid = (reason, path, message) => refuse('INPUT_INVALID', reason, path, message);
const unavailable = (reason, path, message) => refuse('PREREQUISITE_UNAVAILABLE', reason, path, message);
const guarded = body => {
  try { return body(); } catch (error) { if (error instanceof Refusal) return error.refusal; throw error; }
};
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
const segmentsOf = path => path.split('/');
const lines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`).sort(compareCodeUnits).join('');

/** Validate the caller-selected observation tuple; a render guard always needs both fields. */
function observationTarget(platform, installedVersion, requireVersion = false) {
  if (!isRecord(platform) || !OPERATING_SYSTEMS.includes(platform.os) || !ARCHITECTURES.includes(platform.arch) || Object.keys(platform).length !== 2)
    invalid('platform', '/platform', "Expected { os: 'windows' | 'macos' | 'linux', arch: 'x64' | 'arm64' }.");
  if ((requireVersion || installedVersion !== undefined) && (typeof installedVersion !== 'string' || !VERSION.test(installedVersion)))
    invalid('installed-version', '/installedVersion', 'Expected a dotted numeric installed version.');
}

/** The validated binding for the named tool; refusals match selectTool. The digest is recomputed. */
function bindingFor(tool, binding) {
  const selected = selectTool(tool);
  if (selected.status === 'refused') throw new Refusal({ ...selected, path: '/tool' });
  const checked = validateToolBinding(binding);
  if (!checked.valid) refuse('INPUT_INVALID', 'binding-invalid', '/binding', 'The binding is not a valid tool binding.',
    { diagnostics: checked.diagnostics });
  if (binding.tool !== selected.tool.id) invalid('binding-tool-mismatch', '/binding/tool', 'The binding is for another tool.');
  const { digest, ...rest } = binding;
  if (digest !== sha256Hex(canonicalJson(JSON.parse(JSON.stringify(rest)))))
    invalid('binding-digest-mismatch', '/binding/digest', 'The binding digest is not the SHA-256 of its canonical JSON.');
  return binding;
}

/**
 * The fields of a checked Catalog release 1.6 or 1.7 item that rendering and compatibility read. Both identities and the
 * behaviour file are recomputed as Catalog's reader does, so the payload rendered is the one the identities name.
 */
function readItem(item, path) {
  if (!isRecord(item) || typeof item.id !== 'string' || !ID.test(item.id)) invalid('item-invalid', `${path}/id`, 'Expected a checked Catalog item.');
  if (!toolBindingKinds.includes(item.kind)) invalid('item-invalid', `${path}/kind`, 'Expected a content kind a binding names.');
  if (!Array.isArray(item.materials)) invalid('item-invalid', `${path}/materials`, 'Expected the item materials.');
  const behaviour = [], content = [];
  item.materials.forEach((member, index) => {
    if (!isRecord(member) || Object.hasOwn(member, 'path') || typeof member.id !== 'string' || !ID.test(member.id) ||
        !isSafeRelativePath(member.relPath) || !isSafeRelativePath(member.packagePath) || !SHA256_RE.test(member.sha256) ||
        !Number.isSafeInteger(member.byteLength) || member.byteLength < 0)
      invalid('item-invalid', `${path}/materials/${index}`, 'Expected a release 1.6 material with an id, paths, SHA-256 and byte length.');
    (member.role === 'behaviour' ? behaviour : content).push(member);
  });
  if (behaviour.length !== 1 || behaviour[0].relPath !== BEHAVIOUR || typeof behaviour[0].sourceId !== 'string' || !ID.test(behaviour[0].sourceId))
    invalid('item-invalid', `${path}/materials`, 'Expected exactly one behaviour file naming the publishing framework.');
  if (new Set(item.materials.map(member => member.id)).size !== item.materials.length)
    invalid('item-invalid', `${path}/materials`, 'Material ids are unique within an item.');
  const inputs = isRecord(item.requirements) && isRecord(item.requirements.inputs) ? item.requirements.inputs : {};
  const dependencies = isRecord(item.dependencies) ? item.dependencies : {};
  let behaviourValue, behaviourText;
  try {
    behaviourValue = JSON.parse(JSON.stringify({ kind: item.kind, payload: item.payload ?? null, requirements: { inputs },
      dependencies: { requires: dependencies.requires ?? [], optional: dependencies.optional ?? [], conflicts: dependencies.conflicts ?? [] },
      executable: Object.fromEntries(content.map(member => [member.relPath, member.executable])) }));
    behaviourText = `${canonicalJson(behaviourValue)}\n`;
  } catch { invalid('item-invalid', path, 'The item behaviour is not plain JSON.'); }
  const contentLines = lines(content);
  // Release 1.7 items (each carries `role`) use the contract's behaviour identity: SHA-256 of the canonical JSON of
  // { kind, payload, requirements, dependencies, materials: <the contentSha256 lines>, executable }. Frozen 1.6 items
  // keep their line hash over the content and behaviour files.
  const behaviourSha256 = Object.hasOwn(item, 'role') ? sha256Hex(canonicalJson({ ...behaviourValue, materials: contentLines }))
    : sha256Hex(lines([...content, ...behaviour]));
  if (item.contentSha256 !== sha256Hex(contentLines) || item.behaviourSha256 !== behaviourSha256)
    invalid('item-identity-mismatch', path, 'The item identities do not match its materials.');
  if (sha256Hex(behaviourText) !== behaviour[0].sha256 || new TextEncoder().encode(behaviourText).length !== behaviour[0].byteLength)
    invalid('item-identity-mismatch', `${path}/payload`, 'The kind, payload, requirements, dependencies or executable state differ from the behaviour file.');
  const payload = isRecord(item.payload) ? item.payload : {};
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

/** How a hook runs: the named interpreter with its script, or the named program given the script as an argument. */
function hookRunner(info) {
  const { payload, path } = info, command = payload.command;
  if (!isRecord(command)) invalid('item-invalid', `${path}/payload/command`, 'A hook payload carries its command.');
  const script = material(info, command.script, `${path}/payload/command/script`);
  if (command.args !== undefined && !Array.isArray(command.args)) invalid('item-invalid', `${path}/payload/command/args`, 'Expected an argument list.');
  const args = command.args ?? [];
  if (command.interpreter !== undefined && command.program !== undefined)
    unavailable('hook-command-ambiguous', `${path}/payload/command`, 'A hook names its interpreter or its program, not both.');
  if (command.interpreter !== undefined) {
    if (!INTERPRETERS.has(command.interpreter)) invalid('item-invalid', `${path}/payload/command/interpreter`, 'Expected node, bash, python or pwsh.');
    return { script, args, interpreter: command.interpreter };
  }
  if (command.program !== undefined) {
    if (!text(command.program)) invalid('item-invalid', `${path}/payload/command/program`, 'Expected a program name.');
    if (!args.some(arg => isRecord(arg) && arg.material === script.id))
      unavailable('hook-command-ambiguous', `${path}/payload/command/args`, 'A program is given the hook script as a material argument.');
    return { script, args, program: command.program };
  }
  // A script run by its shebang never works on Windows, so a rendered hook always names how it runs.
  unavailable('interpreter-required', `${path}/payload/command`, 'A hook names its interpreter or program; a shebang is never relied on.');
}

/** The item's `requires` references, as Catalog states them. */
const requiresOf = info => isRecord(info.item.dependencies) && Array.isArray(info.item.dependencies.requires) ?
  info.item.dependencies.requires.filter(ref => isRecord(ref) && typeof ref.itemId === 'string') : [];
/** Whether `requirer` lists `document` in its `requires` (a reference without a framework names the requirer's own). */
const requiresDocument = (requirer, document) => requiresOf(requirer).some(ref => ref.itemId === document.ref.itemId &&
  (ref.framework ?? requirer.ref.framework) === document.ref.framework);
/** The scope a cell delivers to when compatibility plans it without a request: the project where the binding names one. */
const planScope = (binding, kind) => binding.layouts[kind].roots?.project ? 'project' : 'user';

/**
 * Where an item of this kind lands for a tool: root, delivered files and marker blocks, hook and registration
 * facts. Shared by rendering and the static check so both describe the same delivery. `support` is the cell's
 * support where it is read (the platform's in the static check).
 */
function deliveryPlan(info, binding, scope, { projectFolder, support, requirer } = {}) {
  const layout = binding.layouts[info.kind], { payload, path } = info;
  if (NATIVE_ONLY.has(info.kind) && ((support ?? layout.support) === 'none' || (!layout.roots.project && !layout.roots.user)))
    unavailable('native-only-kind', `${path}/kind`, `${binding.tool} does not read ${info.kind} items; they are delivered only where read natively.`);
  const base = scope === 'user' ? 'userHome' : 'project';
  const rootPath = scope === 'user' ? layout.roots.user?.path : layout.roots.project;
  const plan = { kind: info.kind, base, files: [], blocks: [], folder: undefined, layout };
  const needRoot = () => {
    if (!rootPath) unavailable('scope-not-bound', `${path}/kind`, `The binding names no ${scope} location for ${info.kind} items.`);
    return segmentsOf(rootPath);
  };
  const file = (member, segments) => plan.files.push({ member, segments });
  if (info.kind === 'skill') {
    plan.folder = [...needRoot(), ...namespaced(layout, payload, singleName(payload.dirName, `${path}/payload/dirName`), path)];
    for (const member of info.content) file(member, [...plan.folder, ...segmentsOf(member.relPath)]);
  } else if (NATIVE_ONLY.has(info.kind)) {
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
    const entryBlock = (segments, shared = false) => {
      if (texts.length !== 1) unavailable('rule-text-ambiguous', `${path}/materials`, 'A marker block takes exactly one Markdown material.');
      plan.blocks.push({ member: texts[0], segments, shared });
    };
    if (placement === 'project-folder') {
      if (scope !== 'project') unavailable('scope-not-bound', `${path}/payload/placement`, 'A project-folder rule is delivered only to a project.');
      for (const member of texts) file(member, [...segmentsOf(projectFolder ?? 'ai-coding'), ...segmentsOf(member.relPath)]);
    } else if (placement === 'entry-block') {
      if (scope !== 'project' || binding.entryFiles.length === 0)
        unavailable('scope-not-bound', `${path}/payload/placement`, 'The binding names no entry file for a marker block.');
      // The shared guidance block uses the published aih:shared markers, one block per entry file; the
      // project folder it routes to is a reviewed recipe input, so updates can find the user's notes file.
      plan.entryShared = true;
      for (const entry of binding.entryFiles) entryBlock(segmentsOf(entry), true);
    } else {
      const root = needRoot();
      if (binding.entryFiles.includes(rootPath) || /\.md$/i.test(rootPath)) entryBlock(root);
      else for (const member of texts) file(member, [...root, ...namespaced(layout, payload, baseName(member.relPath), path)]);
    }
  } else if (info.kind === 'hook') {
    if (!(layout.hookProtocols ?? []).includes(payload.protocol) || !Object.hasOwn(HOOK_PROTOCOL_FOLDERS, payload.protocol))
      unavailable('protocol-not-spoken', `${path}/payload/protocol`, `${binding.tool} does not speak the ${String(payload.protocol)} hook protocol.`);
    if (!Object.hasOwn(layout.hookEvents ?? {}, payload.event))
      unavailable('protocol-not-spoken', `${path}/payload/event`, `The binding maps no ${String(payload.event)} hook event for ${binding.tool}.`);
    plan.folder = [...needRoot(), info.item.id];
    plan.runner = hookRunner(info);
    for (const member of info.content) file(member, [...plan.folder, ...segmentsOf(member.relPath)]);
  } else if (info.kind === 'mcp-server') {
    needRoot();
  } else if (info.kind === 'document') {
    const documents = Array.isArray(payload.files) && payload.files.length > 0 ?
      payload.files.map((id, index) => material(info, id, `${path}/payload/files/${index}`)) : info.content;
    if (payload.placement === 'project-folder') {
      if (scope !== 'project') unavailable('scope-not-bound', `${path}/payload/placement`, 'A project-folder document is delivered only to a project.');
      for (const member of documents) file(member, [...segmentsOf(projectFolder ?? 'ai-coding'), ...segmentsOf(member.relPath)]);
    } else {
      // Delivered beside what requires it: inside the requiring item's own folder, under the document's item id, so the
      // tool never reads a notice or reference as a skill, rule, agent or command of its own.
      if (!requirer) unavailable('scope-not-bound', `${path}/kind`,
        'A supporting document is delivered beside the item that requires it; name that item in requiredBy.');
      if (!requiresDocument(requirer, info)) invalid('required-by-mismatch', '/requiredBy', 'requiredBy names an item that does not require this document.');
      const beside = deliveryPlan(requirer, binding, scope, { projectFolder });
      if (!beside.folder) unavailable('scope-not-bound', '/requiredBy',
        `${binding.tool} keeps no folder of its own for a ${requirer.kind} item, so there is no place beside it that the tool would not read as content.`);
      for (const member of documents) file(member, [...beside.folder, info.item.id, ...segmentsOf(member.relPath)]);
    }
  } else {
    const root = needRoot();
    for (const member of info.content) file(member, [...root, ...segmentsOf(member.relPath)]);
  }
  if (REGISTRATION_FORMATS[info.kind] && !REGISTRATION_FORMATS[info.kind].includes(layout.register?.format))
    unavailable('registration-not-bound', '/binding', `The binding names no supported ${info.kind} registration for ${binding.tool}.`);
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
// Double-quoted shell text: literal characters never expand; placeholder values are inserted unescaped.
const escapeLiteral = value => value.replace(/["\\`$]/g, '\\$&');

/** The hook command: how it runs, then its arguments, each quoted, with only Catalog's four placeholders. */
function hookCommand(info, plan, scope) {
  const { payload, path } = info, { runner } = plan;
  const folders = HOOK_PROTOCOL_FOLDERS[payload.protocol];
  const itemDir = `${scope === 'user' ? folders.homeDir : folders.projectDir}/${plan.folder.map(escapeLiteral).join('/')}`;
  const values = { projectDir: folders.projectDir, homeDir: folders.homeDir, itemDir, pluginRoot: itemDir };
  const substitute = (value, at) => escapeLiteral(value).replace(PLACEHOLDER, (match, name) => {
    if (!CATALOG_PLACEHOLDERS.has(name)) invalid('unknown-placeholder', at, 'Only {projectDir}, {homeDir}, {itemDir} and {pluginRoot} may appear.');
    return values[name];
  });
  const quoted = value => `"${value}"`;
  const itemPath = member => quoted(`${itemDir}/${escapeLiteral(member.relPath)}`);
  const parts = runner.interpreter ? [runner.interpreter, itemPath(runner.script)]
    : [quoted(substitute(runner.program, `${path}/payload/command/program`))];
  runner.args.forEach((arg, index) => {
    const at = `${path}/payload/command/args/${index}`;
    if (typeof arg === 'string') parts.push(quoted(substitute(arg, at)));
    else if (isRecord(arg) && typeof arg.material === 'string') parts.push(itemPath(material(info, arg.material, at)));
    else invalid('item-invalid', at, 'Expected a string or material argument.');
  });
  const template = plan.layout.commandTemplate ?? '{command}';
  const pieces = template.split('{command}');
  const tokens = [...template.matchAll(PLACEHOLDER)].map(match => match[1]);
  if (pieces.length !== 2 || tokens.some(token => token !== 'command' && !CATALOG_PLACEHOLDERS.has(token)))
    invalid('command-template-invalid', '/binding', 'A commandTemplate holds {command} once and otherwise only Catalog placeholders.');
  const fill = piece => piece.replace(PLACEHOLDER, (_, name) => values[name]);
  const rendered = `${fill(pieces[0])}${parts.join(' ')}${fill(pieces[1])}`;
  if (rendered.length > 4096) invalid('item-invalid', `${path}/payload/command`, 'The rendered hook command exceeds 4096 characters.');
  const executable = runner.interpreter ?? (PROGRAM_NAME.test(runner.program) ? runner.program : undefined);
  return { rendered, executable };
}

/**
 * The one operation that allows one MCP server where the binding says the tool records approval: one entry at the
 * server's key, or one member of a list. Any other shape is refused, and the person approves in the tool. Core never
 * writes an approve-all switch, and the operation never replaces a choice the person already made (see Core).
 */
function approvalOperation(binding, register, plan, scope, key) {
  const location = register.approvalLocation;
  const label = selectTool(binding.tool).tool.label;
  if (!location || location.shape === 'other')
    refuse('PREREQUISITE_UNAVAILABLE', 'approval-shape-unsupported', '/grantApproval', `Core cannot write ${label}'s approval for one server.`,
      { guidance: register.permissionStep ? permissionNotice(label, register.permissionStep) : `Approve the server in ${label}.` });
  const base = { id: 'approve-server', purpose: `Allow the ${key} MCP server in ${label}`, scope,
    target: target(plan.base, segmentsOf(location.file)), format: location.format };
  const tail = { approval: { tool: binding.tool }, requires: [REGISTER_SERVER], checks: [] };
  if (location.shape === 'object-keyed') return { ...base, kind: 'config.entries',
    entries: [{ path: [...location.container, key], action: 'set', value: { literal: location.approved } }], ...tail };
  return { ...base, kind: 'config.member', container: [...location.container], action: 'add', value: { literal: key },
    ...(location.denied ? { exclusiveWith: [[...location.denied]] } : {}), ...tail };
}

/**
 * Renders one checked Catalog item as an ordinary Core recipe for one tool. The recipe identity, through Core's
 * public deriveRecipeIdentity, binds both item identities and the binding digest. Rendering never grants authority:
 * the recipe is ordinary execution-policy content that Enterprise organization policy governs in full.
 */
export function renderDelivery({ tool, item, binding, scope, projectFolder, grantApproval, contents, projectFacts, platform, installedVersion, requiredBy } = {}) {
  return guarded(() => {
    bindingFor(tool, binding);
    if (scope !== 'project' && scope !== 'user') invalid('scope', '/scope', 'Expected project or user.');
    if (projectFolder !== undefined && (!text(projectFolder, 255) || !isSafeRelativePath(projectFolder)))
      invalid('project-folder', '/projectFolder', 'Expected a safe relative folder.');
    // The consumer-reviewed facts this delivery renders into its Project basics selections: validated
    // here, echoed in the result, and placed on the selection metadata by the caller. Facts never add
    // operations or authority, and never change the pinned material bytes.
    if (projectFacts !== undefined) {
      if (!Array.isArray(projectFacts) || projectFacts.length === 0 || projectFacts.length > 32) invalid('project-facts', '/projectFacts', 'Expected at most 32 project facts.');
      for (const [index, fact] of projectFacts.entries()) {
        if (!isRecord(fact) || Object.keys(fact).some(key => !['field', 'value', 'confidence'].includes(key)) ||
            typeof fact.field !== 'string' || !/^[a-z][A-Za-z0-9]{0,63}$/.test(fact.field) ||
            typeof fact.value !== 'string' || !fact.value || fact.value.length > 256 ||
            !['detected', 'inferred'].includes(fact.confidence))
          invalid('project-facts', `/projectFacts/${index}`, 'Expected { field, value, confidence: detected | inferred }.');
      }
    }
    // One ticked server, named exactly: there is no list, wildcard or approve-all form.
    if (grantApproval !== undefined && !(isRecord(grantApproval) && Object.keys(grantApproval).length === 2 &&
        typeof grantApproval.framework === 'string' && typeof grantApproval.itemId === 'string'))
      invalid('grant-approval', '/grantApproval', 'Name the one MCP server to allow as { framework, itemId }.');
    if (contents !== undefined && !isRecord(contents)) invalid('contents', '/contents', 'Expected material text keyed by material id.');
    const info = readItem(item, '/item');
    if (grantApproval && (grantApproval.framework !== info.ref.framework || grantApproval.itemId !== info.ref.itemId || info.kind !== 'mcp-server'))
      invalid('grant-approval', '/grantApproval', 'grantApproval names the MCP server item being rendered, and only that one.');
    if (platform !== undefined || installedVersion !== undefined) {
      observationTarget(platform, installedVersion, true);
      const cell = cellOn(binding, info.kind, platform, installedVersion);
      if (cell.support !== 'native') unavailable('kind-not-native', '/item/kind', cell.reason);
    }
    const requirer = requiredBy === undefined ? undefined : readItem(requiredBy, '/requiredBy');
    if (requirer && !(info.kind === 'document' && info.payload.placement !== 'project-folder'))
      invalid('required-by-unused', '/requiredBy', 'requiredBy names the item a supporting document is delivered beside; this item is not one.');
    const plan = deliveryPlan(info, binding, scope, { projectFolder, requirer });
    const key = recipeKey(info, '/item');
    // One recipe per placement: a document rendered beside two items is two recipes, never one recipe that moves.
    const recipeId = requirer ? `${binding.tool}.${info.ref.itemId}.beside.${requirer.ref.itemId}` : `${binding.tool}.${info.ref.itemId}`;
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
    const sharedFolder = text(projectFolder, 255) && isSafeRelativePath(projectFolder) ? projectFolder : 'ai-coding';
    plan.blocks.forEach(({ member, segments, shared }, index) => {
      const value = contents?.[member.id];
      if (typeof value !== 'string') unavailable('content-required', `/contents/${member.id}`, 'A marker block needs the material text.');
      if (sha256Hex(value) !== member.sha256 || new TextEncoder().encode(value).length !== member.byteLength)
        invalid('content-mismatch', `/contents/${member.id}`, 'The supplied text does not match the material SHA-256 and length.');
      operations.push({ id: `block-${index + 1}`, purpose: `Set the ${shared ? 'aih:shared' : key} block in ${segments.join('/')}`, kind: 'text.block', scope,
        target: target(plan.base, segments), blockId: key, startMarker: `<!-- BEGIN ${shared ? 'aih:shared' : `aih:${key}`} -->`,
        endMarker: `<!-- END ${shared ? 'aih:shared' : `aih:${key}`} -->`, action: 'set', content: { literal: value }, requires: [], checks: [] });
    });
    // A binding that declares an entry pointer also points the tool at the shared guidance folder: one
    // aih:shared:pointer block in the pointer file, next to the guidance blocks. Nothing is written without it.
    if (plan.entryShared && binding.entryPointer) {
      const pointer = binding.entryPointer;
      if (!text(pointer.file, 255) || !isSafeRelativePath(pointer.file) || typeof pointer.template !== 'string' ||
          !pointer.template || pointer.template.length > 4096) invalid('binding-invalid', '/binding/entryPointer', 'The binding names a malformed entry pointer.');
      const content = pointer.template.replaceAll('{projectFolder}', sharedFolder);
      operations.push({ id: 'entry-pointer', purpose: `Point ${binding.tool} at the shared guidance folder`, kind: 'text.block', scope,
        target: target(plan.base, segmentsOf(pointer.file)), blockId: 'aihq.entry-pointer', startMarker: '<!-- BEGIN aih:shared:pointer -->',
        endMarker: '<!-- END aih:shared:pointer -->', action: 'set', content: { literal: content }, requires: [], checks: [] });
    }
    if (plan.entryShared) inputs.projectFolder = { type: 'string', required: true, default: sharedFolder, minLength: 1, maxLength: 64,
      description: 'Project folder, one name at the project root, that receives the Project basics files.' };
    const register = plan.layout.register;
    if (info.kind === 'hook') {
      const { rendered, executable } = hookCommand(info, plan, scope);
      if (executable) prerequisites.push({ kind: 'executable', name: executable });
      const { payload } = info;
      const group = { ...(text(payload.matcher) ? { matcher: payload.matcher } : {}),
        hooks: [{ type: 'command', command: rendered, ...(payload.timeoutSec !== undefined ? { timeout: payload.timeoutSec } : {}) }] };
      // The registration container names the observed event's array; its last segment becomes this hook's event.
      operations.push({ id: 'register-hook', purpose: `Register the ${key} hook group in ${register.file}`, kind: 'hook.group', scope,
        target: target(plan.base, segmentsOf(register.file)), format: register.format,
        container: [...register.container.slice(0, -1), plan.layout.hookEvents[payload.event]], groupId: key,
        selector: { path: ['hooks', 0, 'command'], value: rendered }, action: 'set', group: { literal: group },
        requires: writeIds, checks: [] });
    } else if (info.kind === 'mcp-server') {
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
          // An input value is never written into a tool's configuration: the entry holds a reference by input name,
          // which the tool resolves from its environment, and the value itself travels only in the live request.
          if (!ENV_NAME.test(value.input)) unavailable('input-reference-invalid', `${at}/${field}/${name}`,
            'An MCP input is written as a ${NAME} reference, so its name must be a valid environment variable name.');
          inputs[value.input] = info.inputs[value.input];
          entries.push(entry([field, name], { literal: `\${${value.input}}` }));
        } else if (isRecord(value) && Object.hasOwn(value, 'value')) entries.push(entry([field, name], { literal: value.value }));
        else invalid('item-invalid', `${at}/${field}/${name}`, 'Expected an input reference or a value.');
      }
      operations.push({ id: REGISTER_SERVER, purpose: `Register the ${payload.key} MCP server in ${register.file}`, kind: 'config.entries',
        scope, target: target(plan.base, segmentsOf(register.file)), format: register.format, entries, requires: [], checks: [] });
      if (grantApproval) operations.push(approvalOperation(binding, register, plan, scope, payload.key));
    }
    if (operations.length === 0) unavailable('nothing-to-deliver', '/item', 'The item delivers no content for this tool.');
    const recipe = {
      schema: grantApproval ? 'urn:aihq:core:recipe:1.4.0' : info.kind === 'hook' ? 'urn:aihq:core:recipe:1.1.0' : 'urn:aihq:core:recipe:1.0.0',
      id: recipeId,
      description: `Deliver ${info.ref.framework}/${info.ref.itemId} (${info.kind}) to ${binding.tool}: ` +
        `content sha256:${item.contentSha256}, behaviour sha256:${item.behaviourSha256}, binding sha256:${binding.digest}.`,
      inputs,
      materials: [...materials.values()].map(member => ({ id: member.id, source: { kind: 'local', input: deliveryMaterialRoot },
        path: member.packagePath, sha256: member.sha256, byteLength: member.byteLength })),
      targets: [scope], prerequisites, operations, checks
    };
    return { status: 'rendered', tool: binding.tool, item: info.ref, bindingDigest: binding.digest, materialRoot: deliveryMaterialRoot,
      ...(projectFacts ? { projectFacts } : {}), recipe };
  });
}

const STATIC_BLOCKERS = new Set(['native-only-kind', 'protocol-not-spoken']);
const zero = () => ({ bytes: 0, chars: 0 });
const emptySize = () => ({ ...zero(), alwaysLoaded: zero() });
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
  if (info.kind === 'skill' || NATIVE_ONLY.has(info.kind)) alwaysLoaded = parts(info, ['name', 'description']);
  else if (info.kind === 'rule' && (plan.blocks.length > 0 || (info.payload.inclusion ?? 'always') === 'always'))
    alwaysLoaded = { ...delivered };
  return { ...delivered, alwaysLoaded };
}

/** A cell's support, reason and newest observation on this platform; the reason rule matches selectBindingCell. */
function cellOn(binding, kind, platform, installedVersion) {
  const layout = binding.layouts[kind];
  const derived = deriveCellSupport({ kind, observations: layout.observations, platform, installedVersion });
  const elsewhere = layout.observations.length > 0 &&
    !layout.observations.some(item => item.os === platform.os && item.arch === platform.arch);
  const reason = derived.stale ? `Not observed for ${installedVersion} on ${platform.os} ${platform.arch}; observations from another version do not count.`
    : installedVersion !== undefined && !elsewhere && derived.support !== layout.support
      ? `No native ${kind} binding for ${installedVersion} on ${platform.os} ${platform.arch}; only exact version observations count.`
      : !elsewhere && derived.support === layout.support ? layout.reason
    : `Not observed on ${platform.os} ${platform.arch}; observations from another platform do not count.`;
  return { support: derived.support, reason, observed: derived.observed, observedOn: derived.observedOn ?? null, layout };
}

/** Where plugin-route guidance comes from: the `nativeRoutes` lines of the caller's checked Catalog releases. */
const PLUGIN_ROUTE_SOURCE = 'catalog-native-routes';
/**
 * Upstream tool names in a framework's published route lines that differ from the registry label, attributed by exact
 * name in that framework only. Superpowers (README at 5bf4e780) heads its `copilot plugin` routes "GitHub Copilot CLI"
 * and its `agy plugin` route "Antigravity"; `copilot` and `agy` are those registry tools' binaries.
 */
const ROUTE_NAMES = Object.freeze({
  superpowers: Object.freeze({ copilot: Object.freeze(['GitHub Copilot CLI']), antigravity: Object.freeze(['Antigravity']) })
});

/** The supplied Catalog `nativeRoutes` lines by framework, bounded as Catalog's release reader bounds them. */
function readNativeRoutes(nativeRoutes) {
  if (!Array.isArray(nativeRoutes) || nativeRoutes.length > 4096)
    invalid('native-routes', '/nativeRoutes', 'Expected at most 4096 { framework, lines } entries.');
  const supplied = new Map();
  nativeRoutes.forEach((entry, index) => {
    const at = `/nativeRoutes/${index}`;
    if (!isRecord(entry) || Object.keys(entry).some(key => !['framework', 'lines'].includes(key)) ||
        typeof entry.framework !== 'string' || !ID.test(entry.framework) ||
        !Array.isArray(entry.lines) || entry.lines.length > 4096 || !entry.lines.every(line => text(line)))
      invalid('native-routes', at, "Expected { framework, lines } holding one Catalog release's nativeRoutes lines.");
    if (supplied.has(entry.framework)) invalid('native-routes', `${at}/framework`, 'Expected one entry per framework.');
    supplied.set(entry.framework, entry.lines);
  });
  return supplied;
}

/**
 * Display-only guidance: the route text of each line naming the tool by its registry label (`<label>: <route>`) or,
 * in that framework, by an attributed upstream name, in published order. A line naming the tool any other way is not
 * attributed to it. Nothing here is run or observed.
 */
function pluginRoutes(supplied, tool, frameworks) {
  return [...new Set([...frameworks, ...supplied.keys()])].sort(compareCodeUnits).map(framework => {
    const suppliedLines = supplied.get(framework);
    const prefixes = [tool.label, ...(Object.hasOwn(ROUTE_NAMES, framework) && Object.hasOwn(ROUTE_NAMES[framework], tool.id)
      ? ROUTE_NAMES[framework][tool.id] : [])].map(name => `${name}: `);
    const listed = (suppliedLines ?? []).flatMap(line => {
      const prefix = prefixes.find(name => line.startsWith(name) && line.length > name.length);
      return prefix ? [line.slice(prefix.length)] : [];
    });
    return { framework, source: PLUGIN_ROUTE_SOURCE,
      state: suppliedLines === undefined ? 'not-supplied' : listed.length > 0 ? 'listed' : 'not-listed', lines: listed };
  });
}

const refKey = ref => `${ref.framework}\u0000${ref.itemId}`;
const setKey = set => `${set.framework}\u0000${set.setId}\u0000${set.setSha256}`;
const isSetRef = set => isRecord(set) && Object.keys(set).length === 3 && typeof set.framework === 'string' && ID.test(set.framework) &&
  typeof set.setId === 'string' && ID.test(set.setId) && typeof set.setSha256 === 'string' && SHA256_RE.test(set.setSha256);

/**
 * Answers from the binding alone, for one OS and architecture, whether each Catalog-resolved item works there.
 * Only observations made on that platform count. Items are the members left after Catalog's set expansion and
 * exclusions; entries repeated across overlapping sets merge, so the answer does not depend on their order.
 */
export function checkCompatibility({ tool, platform, installedVersion, items, binding, nativeRoutes } = {}) {
  return guarded(() => {
    bindingFor(tool, binding);
    observationTarget(platform, installedVersion);
    if (!Array.isArray(items) || items.length > 4096) invalid('items', '/items', 'Expected at most 4096 item entries.');
    const suppliedRoutes = nativeRoutes === undefined ? undefined : readNativeRoutes(nativeRoutes);
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
    const ordered = [...merged.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, entry]) => entry);
    const supportingDocument = item => item.kind === 'document' && item.payload.placement !== 'project-folder';
    /** A delivery refusal, kept for its reason; anything else is not an answer about this item and is rethrown. */
    const refusalOf = error => {
      if (!(error instanceof Refusal) || error.refusal.code !== 'PREREQUISITE_UNAVAILABLE') throw error;
      return error.refusal;
    };
    const assess = entry => {
      const own = cellOn(binding, entry.info.kind, platform, installedVersion);
      const isExcluded = excluded.has(refKey(entry.info.ref));
      let bound = entry.info, cell = own, boundAs;
      if (!isExcluded && own.support !== 'native' && entry.fallback && !NATIVE_ONLY.has(entry.info.kind) &&
          !NATIVE_ONLY.has(entry.fallback.kind) && !excluded.has(refKey(entry.fallback.ref))) {
        const candidate = cellOn(binding, entry.fallback.kind, platform, installedVersion);
        if (candidate.support === 'native') {
          bound = entry.fallback; cell = candidate;
          boundAs = { kind: entry.fallback.kind, item: entry.fallback.ref, viaFallback: true };
        }
      }
      const staticBlockers = [];
      let plan, notRendered;
      if (!isExcluded) {
        try {
          if (installedVersion !== undefined && cell.support !== 'native')
            unavailable('kind-not-native', '/item/kind', cell.reason);
          plan = supportingDocument(bound) ? planBeside(bound, cell.support) :
            deliveryPlan(bound, binding, bound.kind === 'document' ? 'project' : planScope(binding, bound.kind), { support: cell.support });
        } catch (error) {
          const { reason, message } = refusalOf(error);
          if (STATIC_BLOCKERS.has(reason)) staticBlockers.push({ code: reason, detail: message });
          else {
            notRendered = { reason, detail: message };
            // A native cell that rendering refuses is never shown as working. An unconfirmed cell is neither working
            // nor "doesn't work", so it carries only notRendered.
            if (cell.support === 'native') staticBlockers.push({ code: reason, detail: message });
          }
        }
        if (entry.required && cell.support === 'none') staticBlockers.push({ code: 'required-but-unsupported',
          detail: `A required ${bound.kind} item is not supported by ${binding.tool} on ${platform.os} ${platform.arch}.` });
      }
      return { entry, bound, plan, result: {
        item: entry.info.ref, support: cell.support, reason: cell.reason, observed: cell.observed, observedOn: cell.observedOn,
        ...(boundAs ? { boundAs } : {}), ...(isExcluded ? { excluded: true } : {}), ...(notRendered ? { notRendered } : {}),
        ...(cell.layout.register?.permissionStep && !isExcluded ?
          { permissionStep: permissionNotice(selectTool(binding.tool).tool.label, cell.layout.register.permissionStep) } : {}),
        deliveredSize: plan ? deliveredSize(bound, plan) : emptySize(), staticBlockers } };
    };
    // Two different items writing one folder (a skill or hook folder) or one file. Items bound to the same item,
    // such as a fallback that is also a member, write the same place and do not collide.
    const markCollisions = rows => {
      const writers = new Map();
      for (const row of rows) if (row.plan) {
        const places = row.plan.folder ? [[row.plan.base, row.plan.folder]] : row.plan.files.map(file => [file.base ?? row.plan.base, file.segments]);
        for (const [base, place] of places) {
          const where = `${base}/${place.join('/')}`;
          writers.set(where, [...(writers.get(where) ?? []), row]);
        }
      }
      for (const [where, writing] of writers) if (new Set(writing.map(row => refKey(row.bound.ref))).size > 1)
        for (const row of new Set(writing)) {
          const detail = `Another item also writes ${where}`;
          if (!row.result.staticBlockers.some(blocker => blocker.code === 'same-folder' && blocker.detail === detail))
            row.result.staticBlockers.push({ code: 'same-folder', detail });
        }
    };
    // Supporting documents are assessed after the items they sit beside: only an item installed as itself, with no
    // blocker of its own, gives one a place.
    const assessed = new Map(ordered.filter(entry => !supportingDocument(entry.info)).map(entry => [entry, assess(entry)]));
    markCollisions([...assessed.values()]);
    const hosts = [...assessed.values()].filter(row => !row.result.excluded && row.bound === row.entry.info && row.result.staticBlockers.length === 0);
    // A supporting document is planned beside each such requiring item, exactly as renderDelivery places it.
    const planBeside = (document, support) => {
      const files = []; let refusal;
      for (const host of hosts) if (requiresDocument(host.bound, document)) {
        try {
          const plan = deliveryPlan(document, binding, planScope(binding, host.bound.kind), { support, requirer: host.bound });
          files.push(...plan.files.map(file => ({ ...file, base: plan.base })));
        } catch (error) { refusal = refusalOf(error); }
      }
      if (files.length === 0) throw new Refusal(refusal ?? { code: 'PREREQUISITE_UNAVAILABLE', reason: 'scope-not-bound', path: '/items',
        message: 'A supporting document is delivered beside the item that requires it; no requiring item it can sit beside is selected.' });
      return { kind: 'document', base: files[0].base, files, blocks: [], layout: binding.layouts.document };
    };
    const results = ordered.map(entry => assessed.get(entry) ?? assess(entry));
    markCollisions(results);
    // `requires` is installed with the item or the item cannot be installed: a required item that is not selected, is
    // left out, or (a supporting document) has no place beside it blocks the item that requires it.
    const byRef = new Map(results.map(row => [refKey(row.entry.info.ref), row]));
    for (const row of results) {
      if (row.result.excluded) continue;
      const own = row.result.staticBlockers.length > 0;
      for (const ref of requiresOf(row.bound)) {
        const required = byRef.get(refKey({ framework: ref.framework ?? row.bound.ref.framework, itemId: ref.itemId }));
        if (!required) row.result.staticBlockers.push({ code: 'dependency-missing', detail: `It requires ${ref.itemId}, which is not selected.` });
        else if (required.result.excluded)
          row.result.staticBlockers.push({ code: 'excluded-but-required', detail: `It requires ${ref.itemId}, which is left out.` });
        else if (!own && supportingDocument(required.bound)) {
          try { deliveryPlan(required.bound, binding, planScope(binding, row.bound.kind), { requirer: row.bound }); }
          catch (error) {
            row.result.staticBlockers.push({ code: 'dependency-missing',
              detail: `${ref.itemId} cannot be delivered beside it: ${refusalOf(error).message}` });
          }
        }
      }
    }
    const sets = new Map();
    for (const { entry, result } of results) if (!result.excluded) for (const [key, set] of entry.sets) {
      const summary = sets.get(key) ?? { set, fit: 'none', members: { native: 0, unconfirmed: 0, none: 0 }, deliveredSize: emptySize() };
      summary.members[result.staticBlockers.length === 0 && !result.notRendered ? result.support : 'none'] += 1;
      add(summary.deliveredSize, result.deliveredSize); add(summary.deliveredSize.alwaysLoaded, result.deliveredSize.alwaysLoaded);
      sets.set(key, summary);
    }
    for (const summary of sets.values()) {
      const total = summary.members.native + summary.members.unconfirmed + summary.members.none;
      summary.fit = summary.members.native === total ? 'full' : summary.members.native === 0 ? 'none' : 'partial';
    }
    return { status: 'checked', tool: binding.tool, platform: { os: platform.os, arch: platform.arch }, bindingDigest: binding.digest,
      items: results.map(({ result }) => result), sets: [...sets.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, summary]) => summary),
      ...(suppliedRoutes ? { pluginRoutes: pluginRoutes(suppliedRoutes, selectTool(binding.tool).tool,
        ordered.map(entry => entry.info.ref.framework)) } : {}) };
  });
}
