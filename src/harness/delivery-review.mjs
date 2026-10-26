// Harness facts a policy review names for one rendered selection. Portable data functions: no host effects and no
// Core engine import. Core's engine calls them with the bytes it actually prepared, so the review describes what will
// be delivered rather than what a consumer claims.
import { toolBindings } from './tool-binding-data.mjs';

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
 * and `description` of skills, agents and commands; the whole text of a rule; nothing for hooks, MCP servers and
 * documents. Without a kind it is omitted, because nothing says what the tool loads.
 */
export function selectionDeliveredSize(kind, delivered) {
  const size = delivered.reduce((total, entry) => add(total, measure(entry.bytes)), zero);
  if (kind === undefined) return size;
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

/** The step the user still takes in the tool before an item of this kind is usable, from the shipped binding. */
export function bindingPermissionStep(tool, kind) {
  const step = toolBindings.find(binding => binding.tool === tool)?.layouts[kind]?.register?.permissionStep;
  return typeof step === 'string' ? step : undefined;
}
