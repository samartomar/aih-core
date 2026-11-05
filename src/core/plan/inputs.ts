// Typed input bindings (contract 4.1, C59, C63, C64; Catalog D121). A plan step that consumes declared inputs carries
// `inputs: [{ item, input, at }]` with exactly one destination: a JSON Pointer in its structured merge entry
// (`pointer`), a declared placeholder marker in a written file (`placeholder`), an argv slot (`argv`) or an environment
// name (`env`). Core fills values only there, never by free-form substitution:
// - an ordinary value comes from the request's `inputs`, else the declaration's `default`; a required one with neither is
//   `input-missing`, an optional one is left out;
// - a secret comes only from `controls.privateInputs`, and is written as the client's own environment reference where
//   every profile the step serves declares one for that destination surface (`inputReferences`); otherwise its value is
//   written and the review warns that the file will hold a secret;
// - an item input no step binds is `input-binding-missing`, never guessed (C63).
// Marker text inside a string (`{NAME}`) is the only partial replacement, and only for the bound input's own marker.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../internal/canonical.js';
import { cloneJsonValueStructureV1 } from '../internal/strict-json.js';
import { pointerSegments } from './steps/merge.js';
import type { Json } from '../types.js';
import type { PlanRequest, Problem, Refusal } from './types.js';

export type BindingAt = { pointer: string } | { placeholder: string } | { argv: number } | { env: string };
export interface Binding { item: string; input: string; at: BindingAt }
/** A profile `inputReferences` surface (Catalog D121). */
export type Surface = 'file' | 'mcp-argv' | 'mcp-env' | 'mcp-header';
export interface InputDeclaration { isRequired: boolean; isSecret: boolean; default?: Json; placeholder?: { sourcePath: string; marker: string } }
/** One binding as the review and the receipt show it. A secret's value is never shown. */
export interface ReviewInput {
  item: string; input: string; at: BindingAt; secret: boolean;
  /** `value` (the value is in the file), `reference` (the client's own environment reference is), or `omitted`. */
  written: 'value' | 'reference' | 'omitted';
  /** Where the value came from; `null` for a reference or an omission. */
  from: 'inputs' | 'default' | 'privateInputs' | null;
  /** The ordinary value written; never present for a secret. */
  value?: Json;
}
/** What binding one step's inputs did: the review rows, the secret values written (for redaction), and the warning files. */
/** A slot that holds a secret value: its full editor path, the input, and the slot's authored text with the marker. */
export interface SlotTemplate { path: string[]; item: string; input: string; template: string }
export interface BoundInputs { review: ReviewInput[]; secretValues: string[]; secretFiles: string[] }
type Fail = { refusal: Refusal } | { problem: Problem };
type Landing = { written: 'value'; text: Json; secret: boolean; from: 'inputs' | 'default' | 'privateInputs' } |
  { written: 'reference'; text: string } | { written: 'omitted' };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const plain = (value: unknown): value is Record<string, Json> => !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' && value.length <= 65_536 || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
const problemAt = (index: number, field: string, reason: string, message: string): { problem: Problem } =>
  ({ problem: { path: `/plan/plan/${index}/${field}`, reason, message } });
const marker = (input: string) => `{${input}}`;

/** The declared inputs of every item in the request's contents, by item id then input name. */
export function declarations(contents: PlanRequest['contents']): Map<string, Map<string, InputDeclaration>> {
  const out = new Map<string, Map<string, InputDeclaration>>();
  for (const content of contents as unknown as { items?: { id?: unknown; requirements?: { inputs?: unknown } }[] }[])
    for (const item of Array.isArray(content.items) ? content.items : []) {
      if (!item || typeof item.id !== 'string' || !plain(item.requirements?.inputs)) continue;
      const map = out.get(item.id) ?? new Map<string, InputDeclaration>(); out.set(item.id, map);
      for (const [name, spec] of Object.entries(item.requirements.inputs)) {
        if (!plain(spec)) continue;
        const placeholder = plain(spec.placeholder) && typeof spec.placeholder.sourcePath === 'string' && typeof spec.placeholder.marker === 'string' &&
          spec.placeholder.marker.length > 0 ? { sourcePath: spec.placeholder.sourcePath, marker: spec.placeholder.marker } : undefined;
        map.set(name, { isRequired: spec.isRequired === true, isSecret: spec.isSecret === true,
          ...(spec.default !== undefined ? { default: spec.default } : {}), ...(placeholder ? { placeholder } : {}) });
      }
    }
  return out;
}

/**
 * Checks the request's ordinary `inputs` and the controls' `privateInputs` against the declarations: every key names a
 * declared input of a known item; ordinary values are scalars and never secrets; private values are strings for
 * declared secrets. Returns the problems (empty when both are well formed).
 */
export function checkValues(declared: Map<string, Map<string, InputDeclaration>>, inputs: unknown, privateInputs: unknown): Problem[] {
  const problems: Problem[] = [];
  const walk = (values: unknown, base: string, secret: boolean) => {
    if (values === undefined) return;
    if (!plain(values)) { problems.push({ path: base, reason: 'type', message: 'Input values are keyed by item id, then input name.' }); return; }
    for (const [item, named] of Object.entries(values)) {
      const declaredItem = declared.get(item);
      if (!plain(named)) { problems.push({ path: `${base}/${item}`, reason: 'type', message: 'An item\'s input values are an object.' }); continue; }
      for (const [name, value] of Object.entries(named)) {
        const path = `${base}/${item}/${name}`;
        const spec = declaredItem?.get(name);
        if (!spec) problems.push({ path, reason: 'input-unknown', message: `\`${item}\` declares no input \`${name}\`.` });
        else if (!secret && spec.isSecret) problems.push({ path, reason: 'input-secret',
          message: `\`${name}\` of \`${item}\` is a secret: pass it in \`controls.privateInputs\`, never in the request.` });
        else if (secret && !spec.isSecret) problems.push({ path, reason: 'input-not-secret',
          message: `\`${name}\` of \`${item}\` is not a secret: pass it in the request's \`inputs\`.` });
        else if (secret ? typeof value !== 'string' || value.length === 0 || value.length > 65_536 : !scalar(value))
          problems.push({ path, reason: 'input-value', message: `The value of \`${name}\` of \`${item}\` is not a usable ${secret ? 'secret string' : 'scalar'}.` });
      }
    }
  };
  walk(inputs, '/inputs', false);
  walk(privateInputs, '/controls/privateInputs', true);
  return problems;
}

/** A step's `inputs` bindings: each `{ item, input, at }` with exactly one destination form from `allowed`. */
export function parseBindings(raw: Json | undefined, index: number, allowed: (keyof UnionKeys)[]): { bindings: Binding[] } | { problem: Problem } {
  if (raw === undefined) return { bindings: [] };
  if (!Array.isArray(raw) || raw.length > 256) return problemAt(index, 'inputs', 'inputs', 'A step\'s `inputs` is a list of input bindings.');
  const bindings: Binding[] = [];
  const seen = new Set<string>();
  for (const [at, binding] of raw.entries()) {
    const where = plain(binding) && plain(binding.at) && Object.keys(binding.at).length === 1 ? Object.keys(binding.at)[0]! : undefined;
    const value = where ? (binding as { at: Record<string, Json> }).at[where] : undefined;
    const valid = plain(binding) && Object.keys(binding).every(key => ['item', 'input', 'at'].includes(key)) &&
      typeof binding.item === 'string' && ID.test(binding.item) && typeof binding.input === 'string' && NAME.test(binding.input) &&
      where !== undefined && (allowed as string[]).includes(where) &&
      (where === 'pointer' ? typeof value === 'string' && pointerSegments(value) !== undefined :
        where === 'argv' ? Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 4096 :
        where === 'env' ? typeof value === 'string' && NAME.test(value) : typeof value === 'string' && value.length > 0 && value.length <= 256);
    if (!valid) return problemAt(index, `inputs/${at}`, 'input-binding',
      `A binding names its \`item\`, its \`input\` and exactly one destination this step can hold: ${allowed.map(name => `\`${name}\``).join(', ')}.`);
    const parsed = binding as unknown as Binding;
    const destination = JSON.stringify(parsed.at);
    if (seen.has(destination)) return problemAt(index, `inputs/${at}`, 'input-binding', 'Two bindings name the same destination.');
    seen.add(destination);
    bindings.push({ item: parsed.item, input: parsed.input, at: { ...parsed.at } as BindingAt });
  }
  return { bindings };
}
type UnionKeys = { pointer: 1; placeholder: 1; argv: 1; env: 1 };

/** Everything binding needs from the request: declarations, values, and the profiles of the step's CLIs. */
export interface InputContext {
  index: number;
  request: PlanRequest;
  privateInputs: Record<string, Record<string, Json>> | undefined;
  declared: Map<string, Map<string, InputDeclaration>>;
  /** The CLIs the step serves; empty means every profile the request supplies. */
  clis: string[];
}

/** The supplied profiles a step's bindings follow. */
const stepProfiles = (context: InputContext): Record<string, Json>[] =>
  (context.request.profiles as Record<string, Json>[]).filter(profile => !context.clis.length || context.clis.includes(profile.id as string));

/** The native reference every profile the step serves declares for a surface, or `undefined` (then a value is written). */
function referenceFor(context: InputContext, surface: Surface | undefined, input: string): string | undefined {
  if (!surface) return undefined;
  const profiles = stepProfiles(context);
  if (!profiles.length) return undefined;
  const syntaxes = profiles.map(profile => {
    const reference = plain(profile.inputReferences) ? profile.inputReferences[surface] : undefined;
    return plain(reference) && Object.keys(reference).length === 1 && typeof reference.syntax === 'string' &&
      reference.syntax.includes('<name>') && reference.syntax.length <= 64 ? reference.syntax : undefined;
  });
  const [first] = syntaxes;
  return first !== undefined && syntaxes.every(syntax => syntax === first) ? first.replaceAll('<name>', input) : undefined;
}

/** What lands at one binding's destination; `input-missing` for a required value nobody supplied. */
function land(binding: Binding, surface: Surface | undefined, context: InputContext): { landing: Landing; declaration: InputDeclaration } | Fail {
  const declaration = context.declared.get(binding.item)?.get(binding.input);
  if (!declaration) return problemAt(context.index, 'inputs', 'input-binding',
    `Step ${context.index} binds \`${binding.input}\`, which \`${binding.item}\` does not declare.`);
  const missing = (): { refusal: Refusal } => ({ refusal: { status: 'refused', code: 'input-missing', step: context.index,
    item: binding.item, input: binding.input,
    reason: `\`${binding.input}\` of \`${binding.item}\` is required and has no value${declaration.isSecret ? ' in `controls.privateInputs`' : ''}.` } });
  if (declaration.isSecret) {
    const reference = referenceFor(context, surface, binding.input);
    if (reference !== undefined) return { landing: { written: 'reference', text: reference }, declaration };
    const value = context.privateInputs?.[binding.item]?.[binding.input];
    if (typeof value === 'string') return { landing: { written: 'value', text: value, secret: true, from: 'privateInputs' }, declaration };
    return declaration.isRequired ? missing() : { landing: { written: 'omitted' }, declaration };
  }
  const given = context.request.inputs?.[binding.item]?.[binding.input];
  if (given !== undefined) return { landing: { written: 'value', text: given, secret: false, from: 'inputs' }, declaration };
  if (declaration.default !== undefined && scalar(declaration.default))
    return { landing: { written: 'value', text: declaration.default, secret: false, from: 'default' }, declaration };
  return declaration.isRequired ? missing() : { landing: { written: 'omitted' }, declaration };
}

function reviewRow(binding: Binding, landing: Landing, secret: boolean): ReviewInput {
  return { item: binding.item, input: binding.input, at: binding.at, secret, written: landing.written,
    from: landing.written === 'value' ? landing.from : null,
    ...(landing.written === 'value' && !landing.secret ? { value: landing.text } : {}) };
}
const textOf = (landing: Landing): string => landing.written === 'omitted' ? '' : String(landing.text);

/** The MCP field names the step's profiles agree on (`mcpFile`), or `undefined` when they give none or disagree. */
function mcpFields(context: InputContext): { stdio?: Record<string, Json>; headers: string[] } | undefined {
  const profiles = stepProfiles(context);
  const described = profiles.map(profile => plain(profile.mcpFile) ? canonicalJson(profile.mcpFile) : undefined);
  if (!described.length || described.some(item => item === undefined || item !== described[0])) return undefined;
  const file = profiles[0]!.mcpFile as Record<string, Json>;
  const headers = plain(file.remote) ? Object.values(file.remote).flatMap(form => plain(form) && typeof form.headers === 'string' ? [form.headers] : []) : [];
  return { ...(plain(file.stdio) ? { stdio: file.stdio } : {}), headers };
}
function pointerSurface(relative: string[], fields: ReturnType<typeof mcpFields>): Surface | undefined {
  const first = relative[0];
  if (!fields || first === undefined) return undefined;
  const stdio = fields.stdio ?? {};
  if (typeof stdio.env === 'string' && first === stdio.env) return 'mcp-env';
  if (fields.headers.includes(first)) return 'mcp-header';
  if ([stdio.args, stdio.argv, stdio.command].some(field => typeof field === 'string' && field === first)) return 'mcp-argv';
  return undefined;
}

/**
 * Fills the bindings of one structured merge entry (JSON or TOML). `segments` is the entry's own key path, so the
 * returned `secrets` (every secret-bound slot) and `redact` (slots that now hold a secret value) are full editor paths.
 */
export function bindEntry(entry: Json, segments: string[], bindings: Binding[], context: InputContext, file: string):
    { entry: Json; secrets: string[][]; redact: string[][]; bound: BoundInputs; slots: SlotTemplate[] } | Fail {
  const out = cloneJsonValueStructureV1(entry, 'merge entry', 32) as Json;
  const secrets: string[][] = []; const redact: string[][] = []; const slots: SlotTemplate[] = [];
  const bound: BoundInputs = { review: [], secretValues: [], secretFiles: [] };
  const removals: { array: Json[]; at: number }[] = [];
  const conflicting = (message: string) => problemAt(context.index, 'inputs', 'input-binding', message);
  const fields = bindings.some(binding => !('pointer' in binding.at)) ? mcpFields(context) : undefined;
  for (const binding of bindings) {
    let relative: string[];
    let surface: Surface | undefined;
    if ('pointer' in binding.at) {
      relative = pointerSegments(binding.at.pointer)!;
      surface = pointerSurface(relative, mcpFields(context));
    } else if ('env' in binding.at) {
      const field = fields?.stdio?.env;
      if (typeof field !== 'string') return conflicting(`Step ${context.index}'s profiles do not say where its entry's environment is.`);
      relative = [field, binding.at.env]; surface = 'mcp-env';
    } else if ('argv' in binding.at) {
      const stdio = fields?.stdio;
      const slot = binding.at.argv;
      if (typeof stdio?.argv === 'string') relative = [stdio.argv, String(slot)];
      else if (typeof stdio?.command === 'string') relative = slot === 0 ? [stdio.command] : [typeof stdio.args === 'string' ? stdio.args : 'args', String(slot - 1)];
      else return conflicting(`Step ${context.index}'s profiles do not say where its entry's command and arguments are.`);
      surface = 'mcp-argv';
    } else return conflicting('A structured entry binds inputs at a pointer, an argv slot or an environment name.');
    // The slot must be one the entry can take before any value is looked up: absent, or a string holding the marker.
    const fit = slotFits(out, relative, binding);
    if (fit !== true) return conflicting(`Step ${context.index}'s binding of \`${binding.input}\` names a place its entry cannot hold (${fit}).`);
    const landed = land(binding, surface, context);
    if (!('landing' in landed)) return landed;
    const { landing, declaration } = landed;
    // Walk to the slot's parent, creating objects only for a slot the entry does not hold yet.
    let parent: Json | undefined = out;
    for (const [depth, name] of relative.slice(0, -1).entries()) {
      const node: Json = parent!;
      let next: Json | undefined = Array.isArray(node) ? node[Number(name)] : plain(node) ? node[name] : undefined;
      if (next === undefined && plain(node) && !('argv' in binding.at)) {
        if (landing.written === 'omitted') { parent = undefined; break; }
        next = node[name] = {};
      }
      if (!next || typeof next !== 'object')
        return conflicting(`Step ${context.index}'s binding of \`${binding.input}\` names a place its entry cannot hold (${relative.slice(0, depth + 1).join('/')}).`);
      parent = next;
    }
    if (parent !== undefined) {
      const name = relative.at(-1)!;
      const container = parent as Json;
      const current = Array.isArray(container) ? container[Number(name)] : plain(container) ? container[name] : undefined;
      const set = (value: Json) => { if (Array.isArray(container)) container[Number(name)] = value; else (container as Record<string, Json>)[name] = value; };
      if (current === undefined) {
        if (Array.isArray(container) || 'argv' in binding.at) return conflicting(`Step ${context.index}'s entry holds no argv slot for \`${binding.input}\`.`);
        if (landing.written !== 'omitted') set(landing.text);
      } else if (typeof current === 'string' && current.includes(marker(binding.input))) {
        if (landing.written === 'omitted' && current === marker(binding.input)) {
          if (Array.isArray(container)) removals.push({ array: container, at: Number(name) }); else delete (container as Record<string, Json>)[name];
        } else if (current === marker(binding.input) && landing.written === 'value' && !landing.secret && typeof landing.text !== 'string' && !('argv' in binding.at)) set(landing.text);
        else {
          const text = textOf(landing);
          if (('argv' in binding.at || 'env' in binding.at) && text.includes('\0')) return problemAt(context.index, 'inputs', 'input-value', `The value of \`${binding.input}\` cannot be an argument or environment value.`);
          set(current.split(marker(binding.input)).join(text));
        }
      } else return conflicting(`Step ${context.index}'s entry already holds a value where \`${binding.input}\` is bound.`);
    }
    const path = [...segments, ...relative];
    if (declaration.isSecret) secrets.push(path);
    if (landing.written === 'value' && landing.secret) {
      redact.push(path); bound.secretValues.push(landing.text as string); bound.secretFiles.push(file);
      // The slot as the plan wrote it, marker and all: a displaced value keeps this instead of the secret (C64).
      const authored = relative.reduce<Json | undefined>((node, name) => Array.isArray(node) ? node[Number(name)] : plain(node) ? node[name] : undefined, entry);
      slots.push({ path, item: binding.item, input: binding.input, template: typeof authored === 'string' ? authored : marker(binding.input) });
    }
    bound.review.push(reviewRow(binding, landing, declaration.isSecret));
  }
  for (const { array, at } of removals.sort((a, b) => b.at - a.at)) array.splice(at, 1);
  return { entry: out, secrets, redact, bound, slots };
}

/** `true` when a binding's slot is absent (and creatable) or a string holding its marker; otherwise the path that is not. */
function slotFits(entry: Json, relative: string[], binding: Binding): true | string {
  let node: Json = entry;
  for (const [depth, name] of relative.entries()) {
    const here = relative.slice(0, depth + 1).join('/');
    const next: Json | undefined = Array.isArray(node) ? node[Number(name)] : plain(node) ? node[name] : undefined;
    const last = depth === relative.length - 1;
    if (next === undefined) return plain(node) && !('argv' in binding.at) ? true : here;
    if (last) return typeof next === 'string' && next.includes(marker(binding.input)) ? true : here;
    if (!next || typeof next !== 'object') return here;
    node = next;
  }
  return '';
}

/** How a value is written inside a text file, by the file's format: JSON and TOML string escapes, or one plain line. */
function escapeFor(path: string, value: string): string | undefined {
  if (/\.(json|jsonc|toml)$/i.test(path)) return JSON.stringify(value).slice(1, -1);
  return /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? undefined : value;
}

/**
 * Fills the placeholder bindings of one written file or Markdown block. Each placeholder must be the marker the item
 * declares for that source file, and must occur in the text; every occurrence is replaced.
 */
export function bindText(text: string, path: string, bindings: Binding[], context: InputContext, sourcePath?: string):
    { text: string; bound: BoundInputs } | Fail {
  const bound: BoundInputs = { review: [], secretValues: [], secretFiles: [] };
  let out = text;
  for (const binding of bindings) {
    if (!('placeholder' in binding.at)) return problemAt(context.index, 'inputs', 'input-binding', 'A written file binds inputs only at declared placeholders.');
    const declared = context.declared.get(binding.item)?.get(binding.input)?.placeholder;
    if (!declared || declared.marker !== binding.at.placeholder || sourcePath !== undefined && declared.sourcePath !== sourcePath)
      return problemAt(context.index, 'inputs', 'input-binding', `\`${binding.at.placeholder}\` is not the placeholder \`${binding.item}\` declares for \`${binding.input}\` in this file.`);
    if (!out.includes(declared.marker)) return problemAt(context.index, 'inputs', 'input-binding', `\`${path}\` does not hold the declared placeholder \`${declared.marker}\`.`);
    const landed = land(binding, 'file', context);
    if (!('landing' in landed)) return landed;
    const { landing, declaration } = landed;
    const value = escapeFor(path, textOf(landing));
    if (value === undefined) return problemAt(context.index, 'inputs', 'input-value', `The value of \`${binding.input}\` cannot be written into \`${path}\` on one line.`);
    out = out.split(declared.marker).join(value);
    if (landing.written === 'value' && landing.secret) { bound.secretValues.push(landing.text as string); bound.secretFiles.push(path); }
    bound.review.push(reviewRow(binding, landing, declaration.isSecret));
  }
  return { text: out, bound };
}

/**
 * Fills the argv and environment bindings of a process step (argv slots hold `{NAME}` markers; an env binding sets that
 * variable). For the process-backed step kinds; the value never goes through a shell.
 */
export function bindProcess(argv: string[], bindings: Binding[], context: InputContext): { argv: string[]; env: Record<string, string>; bound: BoundInputs } | Fail {
  const out = [...argv]; const env: Record<string, string> = {};
  const bound: BoundInputs = { review: [], secretValues: [], secretFiles: [] };
  const drop: number[] = [];
  for (const binding of bindings) {
    if (!('argv' in binding.at) && !('env' in binding.at)) return problemAt(context.index, 'inputs', 'input-binding', 'A command binds inputs at argv slots or environment names.');
    const landed = land(binding, undefined, context);
    if (!('landing' in landed)) return landed;
    const { landing, declaration } = landed;
    const text = textOf(landing);
    if (text.includes('\0')) return problemAt(context.index, 'inputs', 'input-value', `The value of \`${binding.input}\` cannot be an argument or environment value.`);
    if ('argv' in binding.at) {
      const slot = binding.at.argv;
      const current = out[slot];
      if (current === undefined || !current.includes(marker(binding.input)))
        return problemAt(context.index, 'inputs', 'input-binding', `Argv slot ${slot} does not hold \`${marker(binding.input)}\`.`);
      if (landing.written === 'omitted' && current === marker(binding.input)) drop.push(slot); else out[slot] = current.split(marker(binding.input)).join(text);
    } else if (landing.written !== 'omitted') env[binding.at.env] = text;
    if (landing.written === 'value' && landing.secret) bound.secretValues.push(text);
    bound.review.push(reviewRow(binding, landing, declaration.isSecret));
  }
  for (const slot of drop.sort((a, b) => b - a)) out.splice(slot, 1);
  return { argv: out, env, bound };
}

/**
 * A declared placeholder still in a file a step places from that source file, with no binding of the step filling it:
 * the plan marks no place for the input there, so the step is refused `input-binding-missing` (C63), never written with
 * the marker in it and never guessed.
 */
export function unfilledPlaceholder(step: { [field: string]: unknown }, index: number, text: string, items: string[],
    context: InputContext): { refusal: Refusal } | undefined {
  const from = plain(step.from as Json) && typeof (step.from as { sourcePath?: unknown }).sourcePath === 'string' ?
    (step.from as { sourcePath: string }).sourcePath : undefined;
  if (from === undefined) return undefined;
  const bindings = Array.isArray(step.inputs) ? step.inputs as { item?: unknown; input?: unknown }[] : [];
  for (const item of items) for (const [input, spec] of context.declared.get(item) ?? []) {
    if (spec.placeholder?.sourcePath !== from || bindings.some(binding => binding?.item === item && binding?.input === input)) continue;
    if (text.includes(spec.placeholder.marker)) return { refusal: { status: 'refused', code: 'input-binding-missing', step: index, item, input,
      reason: `Step ${index} places \`${from}\` with the \`${input}\` placeholder of \`${item}\` but marks no binding for it; replan with a Catalog that marks input places.` } };
  }
  return undefined;
}

/** The item inputs no step of the plan binds: the first is refused `input-binding-missing` (C63). */
export function unboundInput(declared: Map<string, Map<string, InputDeclaration>>, items: Set<string>, bound: Set<string>): { item: string; input: string } | undefined {
  for (const item of [...items].sort()) for (const input of [...declared.get(item)?.keys() ?? []].sort())
    if (!bound.has(`${item}\0${input}`)) return { item, input };
  return undefined;
}

/**
 * The reviewed private inputs for a lifecycle handle (plan install, removal, update): a digest of the caller's exact
 * values and the object they passed, so Apply can tell whether they changed (`REVIEW_STALE` `input`).
 */
export interface PrivateInputBinding { value: unknown; digest: string }
const digestOf = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(cloneJsonValueStructureV1(value ?? {}, 'private inputs', 8) as Json)).digest('hex');
export const bindPrivateInputs = (value: unknown): PrivateInputBinding => ({ value, digest: digestOf(value) });
/** Whether Apply's private inputs (or, when it passes none, the object Prepare read) still hold the reviewed values. */
export function privateInputsHold(binding: PrivateInputBinding, now: unknown): boolean {
  try { return digestOf(now === undefined ? binding.value : now) === binding.digest; } catch { return false; }
}
/** A secret supplied for a lifecycle call, such as the value a displaced managed entry needs again (C64). */
export function privateInputValue(privateInputs: unknown, item: string, input: string): string | undefined {
  const value = plain(privateInputs) && plain(privateInputs[item]) ? privateInputs[item]![input] : undefined;
  return typeof value === 'string' ? value : undefined;
}
