// Switching off one item inside a plugin (contract 12 "One item inside a plugin", C45, C69). The plugin stays one
// indivisible install; where its CLI supports it (Codex, by the plugin-qualified `plugin:skill` name), the one item is
// turned off by a reviewed change member owned by that item's own claim: one marked text block in `~/.codex/config.toml`
// holding one `[[skills.config]]` table. Removing that claim removes the block and turns the item back on. Other CLIs
// get no invented toggle.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepare as prepareEngine, type ObservedStep } from '../recipe-engine.js';
import { blockMemberBytes, renderTextBlock } from '../internal/recipe-editors.js';
import { tomlArrayTableEntries } from '../internal/toml-editor.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { readOwnership } from '../internal/state.js';
import { register, type StepRef, type SwitchOffReadback } from './handles.js';
import { FAILURE_RULE, digestOf, engineControls, problemsOf } from './prepare.js';
import type { PlanItemFacts, PluginFacts } from '../internal/custody-items.js';
import type { ExecutionPolicy, Json, Recipe } from '../types.js';
import { REVIEW, type PlanControls, type RemovalResult, type Review, type ReviewConflict, type ReviewStep, type Run } from './types.js';

const FILE = ['.codex', 'config.toml'];
const TABLE = ['skills', 'config'];
const OPERATION = 'switch-off';
const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

/** The marked block that switches `name` off: its markers, its block id and its one `[[skills.config]]` table. */
export function switchOffBlock(framework: string, item: string, name: string, eol = '\n') {
  return { blockId: item, startMarker: `# aih:begin ${framework}/${item}`, endMarker: `# aih:end ${framework}/${item}`,
    content: ['[[skills.config]]', `name = "${name}"`, 'enabled = false', ''].join(eol) };
}

/**
 * Prepares the switch-off of `item` inside the plugin `framework`: refused `switch-off-unsupported` unless a Codex plugin
 * step of that install names the item's skill. Before anything is written, the config file is parsed read-only: your own
 * unmarked `[[skills.config]]` entry for the same skill, two marked blocks for it, or a file Core can't read is an
 * `existing-content` conflict offered as skip only (no handle).
 */
export async function prepareSwitchOff(framework: string, item: string, plugin: PluginFacts | undefined, plan: PlanItemFacts,
    controls: PlanControls): Promise<RemovalResult> {
  if (!plugin) return { status: 'refused', code: 'switch-off-unsupported',
    reason: `\`${item}\` can't be switched off on its own: the CLI \`${framework}\` is installed for has no supported switch-off for it. Remove the whole plugin instead.` };
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  const name = `${plugin.plugin}:${plugin.skills![item]}`;
  // The block keeps the file's own line endings; the engine pins the bytes it reads, so a later change makes Apply stale.
  let eol = '\n';
  try { if (readFileSync(join(home, ...FILE)).includes('\r\n')) eol = '\r\n'; } catch { /* absent: Core creates it */ }
  const block = switchOffBlock(framework, item, name, eol);
  const path = FILE.join('/');
  const recipe: Recipe = { schema: 'urn:aihq:core:recipe:1.0.0', id: 'switch-off', description: 'Switches one plugin item off', inputs: {},
    materials: [], targets: ['user'], prerequisites: [], checks: [], operations: [{ id: OPERATION,
      purpose: `Switches off \`${name}\``, kind: 'text.block', scope: 'user', target: { root: 'userHome', segments: FILE.map(literal => ({ literal })) },
      blockId: block.blockId, startMarker: block.startMarker, endMarker: block.endMarker, action: 'set', content: { literal: block.content },
      requires: [], checks: [] }] };
  const selections: ExecutionPolicy['selections'] = [{ id: 's0', managementId: item, scope: 'user', configuration: {}, requires: [],
    recipe: { inline: recipe } }];
  const facts: PlanItemFacts = { items: [item], clis: [plugin.cli], data: plan.data ? { ...plan.data } : null, origin: 'chosen', catalog: plan.catalog,
    profiles: plan.profiles.filter(profile => profile.id === plugin.cli).map(profile => ({ ...profile })), steps: [0],
    switchOff: { framework, item, cli: plugin.cli, name } };
  let observed: ObservedStep | undefined;
  const engine = await prepareEngine({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections },
    target: { project: home } }, engineControls(controls), undefined, undefined, undefined, undefined, undefined,
    { supplied: new Map([['s0', Object.freeze({ materials: Object.freeze([]), readMaterial: () => undefined, recheck: async () => true })]]),
      plans: new Map([['s0', facts]]), observe: step => { observed = step; } });
  if (engine.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Removal preparation was cancelled.' };
  if (!engine.review) return { status: 'invalid', problems: problemsOf(engine) };
  const operation = engine.review.operations.find(entry => entry.id.endsWith(`/${OPERATION}`)) ?? engine.review.operations[0];
  const before = observed?.before ?? null;
  // The read-only parse: an unmarked entry for the same skill is yours, and Core never edits or replaces it.
  let detail: string | undefined;
  if (!operation || operation.effects === 'conflict' || operation.effects === 'unavailable') detail = observed?.reason ?? 'existing-content';
  else try {
    const outside = renderTextBlock(before, { blockId: block.blockId, startMarker: block.startMarker, endMarker: block.endMarker, action: 'remove' });
    if (tomlArrayTableEntries(outside, TABLE).some(entry => entry.values.name === name)) detail = 'unmarked-entry';
  } catch (error) { detail = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'unsupported-toml-syntax'; }
  const effect: ReviewStep['effect'] = detail ? 'conflict' : operation!.effects === 'create-file' || operation!.effects === 'replace-file' ||
    operation!.effects === 'already-satisfied' ? operation!.effects as ReviewStep['effect'] : 'unchanged';
  const step: ReviewStep = { step: 0, op: OPERATION, managementId: item, framework, item, cli: plugin.cli, clis: [plugin.cli], plugin: plugin.plugin,
    sentence: `Switches off \`${name}\` with a marked \`[[skills.config]]\` block in \`${path}\`; the \`${framework}\` plugin stays installed`,
    cantPromise: 'Core checks the block it wrote, not that the CLI honours it.', effect, root: 'user', path, format: 'toml', key: block.blockId,
    entry: block.content };
  const conflicts: ReviewConflict[] = detail ? [{ code: 'STATE_CONFLICT', reason: 'existing-content', managementId: item, step: 0, target: path,
    key: block.blockId, observedSha256: before === null ? null : sha256(before), existing: existingText(before, block, name), redacted: [],
    choices: ['skip'], detail }] : [];
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'removal', scope: 'user', target: { project: null }, steps: [step],
    conflicts, failureRule: FAILURE_RULE, warnings: [] };
  const reviewDigest = digestOf(body, engine.review.reviewDigest);
  const review = deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review;
  const blocked = conflicts.length > 0 || !engine.prepared || !['ready', 'partial'].includes(engine.status);
  const entry = { managementId: framework, item, disposition: 'prepared' as const, status: blocked ? 'blocked' as const : 'ready' as const,
    members: [{ kind: 'block', path, action: 'switch-off' }] };
  if (blocked) return { status: 'ok', entries: [entry], review };
  const operations = new Map<string, StepRef>([[operation!.id, { step: 0, managementId: item }]]);
  const readback: SwitchOffReadback = { file: join(home, ...FILE), ...block, name, step: 0, managementId: item };
  const handle = register({ engine: engine.prepared!, engineDigest: engine.review.reviewDigest, enginePartial: false, reviewDigest, partial: false,
    operations, readback });
  return { status: 'ok', entries: [entry], review, handle };
}

/** The bytes a conflict is about: the marked block if one is there, else your own `[[skills.config]]` entry for the skill. */
function existingText(before: Buffer | null, block: ReturnType<typeof switchOffBlock>, name: string): string | null {
  if (before === null) return null;
  try {
    const marked = blockMemberBytes(before, { ...block, action: 'remove', content: undefined });
    if (marked) return marked.toString('utf8');
    const text = before.toString('utf8');
    const found = tomlArrayTableEntries(before, TABLE).find(entry => entry.values.name === name);
    return found ? text.slice(found.start, found.end) : null;
  } catch { return before.length <= 1_048_576 ? before.toString('utf8') : null; }
}

/**
 * After Apply: reads the file back and checks the marked block parses as TOML and holds exactly one `[[skills.config]]`
 * table naming the skill with `enabled = false`. A mismatch fails the step and makes the run `incomplete`.
 */
export function checkSwitchOff(run: Run, readback: SwitchOffReadback): void {
  const step = run.steps.find(entry => entry.step === readback.step && entry.managementId === readback.managementId);
  if (!step || !['applied', 'already-satisfied'].includes(step.application)) return;
  let ok = false;
  try {
    const bytes = readFileSync(readback.file);
    const marked = blockMemberBytes(bytes, { blockId: readback.blockId, startMarker: readback.startMarker, endMarker: readback.endMarker, action: 'remove' });
    const entries = marked ? tomlArrayTableEntries(marked, TABLE) : [];
    ok = entries.length === 1 && entries[0]!.values.name === readback.name && entries[0]!.values.enabled === false;
  } catch { ok = false; }
  step.verification = ok ? { status: 'passed', reason: 'readback-matched' } : { status: 'failed', reason: 'readback-mismatch' };
  if (!ok && run.completion === 'complete') run.completion = 'incomplete';
}

/** The recorded switch-off claims of a framework in a receipt root, by item id. */
export function switchOffClaims(root: string, framework: string): string[] {
  return Object.values(readOwnership(root).value.items ?? {}).filter(item => item.scope === 'user' && item.plan?.switchOff?.framework === framework)
    .map(item => item.managementId).sort();
}
