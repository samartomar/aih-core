// Harness facts a policy review names for one rendered selection. Portable data functions: no host effects and no
// Core engine import. Core's engine calls them with the bytes it actually prepared, so the review describes what will
// be delivered rather than what a consumer claims.
import { toolBindings } from './tool-binding-data.mjs';
import { selectTool } from './tool-registry.mjs';
import { deriveCellSupport } from './tool-binding.mjs';

const decoder = new TextDecoder('utf-8');
/** Catalog's measure: UTF-8 bytes and UTF-16 code units of the lossily decoded text. */
const measure = bytes => ({ bytes: bytes.byteLength, chars: decoder.decode(bytes).length });
const encoder = new TextEncoder();
const textSize = text => ({ bytes: encoder.encode(text).byteLength, chars: text.length });
const add = (total, part) => ({ bytes: total.bytes + part.bytes, chars: total.chars + part.chars });
const zero = { bytes: 0, chars: 0 };

/** The `name` and `description` values of a Markdown file's leading YAML frontmatter, as the tool reads them every session. */
function frontmatterSummary(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return zero;
  const lines = match[1].split(/\r?\n/);
  let total = zero;
  for (let index = 0; index < lines.length; index++) {
    const field = /^(name|description):[ \t]*(.*)$/.exec(lines[index]);
    if (!field) continue;
    let value = field[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      // A block scalar: its indented continuation lines are the value.
      const block = [];
      while (index + 1 < lines.length && /^([ \t]+.*|)$/.test(lines[index + 1])) block.push(lines[++index].trim());
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    total = add(total, textSize(value));
  }
  return total;
}

/**
 * Delivered and always-loaded size for one selection's delivered content: written files and marker-block text.
 * `alwaysLoaded` follows checkCompatibility's kind rules, measured from the delivered bytes: the frontmatter `name`
 * and `description` of skills, agents and commands; the whole text of a rule delivered as an entry-file block; nothing
 * for hooks, MCP servers and documents. It is omitted where nothing delivered says what the tool loads: without a
 * kind, and for a rule written as a file, whose inclusion the rendered recipe does not carry.
 */
export function selectionDeliveredSize(kind, delivered) {
  const size = delivered.reduce((total, entry) => add(total, measure(entry.bytes)), zero);
  if (kind === undefined || kind === 'rule' && delivered.some(entry => !entry.block)) return size;
  let alwaysLoaded = zero;
  if (kind === 'rule') alwaysLoaded = size;
  else if (['skill', 'agent', 'command'].includes(kind)) for (const entry of delivered) {
    const name = entry.path.split('/').at(-1);
    if (entry.block || !/\.md$/i.test(name) || kind === 'skill' && name !== 'SKILL.md') continue;
    alwaysLoaded = add(alwaysLoaded, frontmatterSummary(decoder.decode(entry.bytes)));
  }
  return { ...size, alwaysLoaded };
}

/** The commands a hook group runs: each `hooks[].command`, as the hook protocols Harness renders shape them. */
export function hookGroupCommands(group) {
  const hooks = group && typeof group === 'object' && !Array.isArray(group) ? group.hooks : undefined;
  return Array.isArray(hooks) ? hooks.flatMap(hook => hook && typeof hook === 'object' && typeof hook.command === 'string' ? [hook.command] : []) : [];
}

/**
 * Prepared work 1.7.0: the shipped binding's digest for the tool and the cell's support and proof level for the kind,
 * derived from its observations. Undefined for a tool the binding table does not have.
 */
export function bindingLayout(tool, kind) {
  const binding = toolBindings.find(item => item.tool === tool);
  const layout = binding?.layouts[kind];
  if (!layout) return undefined;
  const { support, observed } = deriveCellSupport({ kind, observations: layout.observations });
  return { bindingDigest: binding.digest, support, observed };
}

/** The step the user still takes in the tool before an item of this kind is usable, from the shipped binding. */
export function bindingPermissionStep(tool, kind) {
  const step = toolBindings.find(binding => binding.tool === tool)?.layouts[kind]?.register?.permissionStep;
  return typeof step === 'string' ? step : undefined;
}

/** What a preview and compatibility say while the person's OK in the tool is still needed. */
export function permissionNotice(label, step) {
  return `Still needs your OK in ${label}. ${step}`;
}
/** The shipped binding's permission step for tool and kind, worded as still needing the person's OK in that tool. */
export function bindingPermissionNotice(tool, kind) {
  const step = bindingPermissionStep(tool, kind), selected = selectTool(tool);
  return step === undefined || selected.status !== 'selected' ? undefined : permissionNotice(selected.tool.label, step);
}

/** The shipped binding's MCP registration and approval location for tool and kind, when it names one Core can read. */
export function bindingApprovalLocation(tool, kind) {
  const register = toolBindings.find(binding => binding.tool === tool)?.layouts[kind]?.register;
  const location = register?.approvalLocation;
  return location && location.shape !== 'other' ? { register, location } : undefined;
}
/** Whether the parsed approval file already holds the person's OK for one server key at the binding's location. */
export function approvalGiven(location, document, key) {
  let node = document;
  for (const segment of location.container) node = node && typeof node === 'object' && !Array.isArray(node) ? node[segment] : undefined;
  if (location.shape === 'array') return Array.isArray(node) && node.includes(key);
  return !!node && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, key) && node[key] === location.approved;
}
