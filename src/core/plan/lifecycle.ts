// `list` and `prepareRemoval` 0.1.0 (contract 12): the inventory and removal forms over the retained custody,
// claim and removal rules (14.2). The place is always named; Core never guesses it from the working folder.
import { bindPrivateInputs } from './inputs.js';
import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { isProxy } from 'node:util/types';
import { listManagedSelections } from '../managed-inventory.js';
import { prepareManagedRemoval } from '../managed-removal.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState, readOwnership } from '../internal/state.js';
import { register, type ProgramCheck, type StepRef } from './handles.js';
import { claimIdentity } from '../internal/recipe-lifecycle.js';
import { prepareSwitchOff, switchOffClaims } from './switch-off.js';
import { prepare as prepareEngine } from '../recipe-engine.js';
import { resolveExecutable } from '../internal/approved-process.js';
import type { PreparedHandle } from '../host-types.js';
import type { ExecutionPolicy, Recipe } from '../types.js';
import { FAILURE_RULE, digestOf, engineControls, planControls, problemsOf } from './prepare.js';
import type { PlanItemFacts, PluginFacts, ProgramFacts } from '../internal/custody-items.js';
import { join } from 'node:path';
import type { Json } from '../types.js';
import { INVENTORY, REVIEW, type Inventory, type PlanControls, type Refusal, type InventoryEntry, type ListResult, type Problem, type RemovalEntry, type RemovalResult,
  type Review, type ReviewStep } from './types.js';

const invalid = (path: string, reason: string, message: string): { status: 'invalid'; problems: Problem[] } =>
  ({ status: 'invalid', problems: [{ path, reason, message }] });
const plain = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value) && Object.keys(value).every(key => keys.includes(key));
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The project and the folder the engine anchors a request on: the project, or home for a user-only place. */
function place(request: Record<string, unknown>, scopes: string[]): { project: string | null; anchor: string; scope: string } | { status: 'invalid'; problems: Problem[] } {
  if (!scopes.includes(request.scope as string)) return invalid('/scope', 'scope', `The scope is one of ${scopes.join(', ')}.`);
  if (!plain(request.target, ['project'])) return invalid('/target', 'target', 'The target is `{ project? }`.');
  const named = request.target.project;
  if (named !== undefined && named !== null && (typeof named !== 'string' || !isAbsolute(named)))
    return invalid('/target/project', 'absolute', 'The project folder is an absolute path.');
  if (request.scope !== 'user' && typeof named !== 'string') return invalid('/target/project', 'required', 'This scope needs the project folder.');
  try {
    const project = typeof named === 'string' ? projectRoot(named) : null;
    return { project, anchor: project ?? projectRoot(homedir()), scope: request.scope as string };
  } catch { return invalid('/target/project', 'project', 'The project folder is not usable.'); }
}

/** Plan facts recorded for each management id and scope in the receipts of these roots. */
function planFacts(roots: string[]): Map<string, PlanItemFacts> {
  const facts = new Map<string, PlanItemFacts>();
  for (const root of new Set(roots)) for (const item of Object.values(readOwnership(root).value.items ?? {}))
    if (item.plan) facts.set(`${item.scope}\0${item.managementId}`, item.plan);
  return facts;
}

/** A local plugin's files: its whole-file members, by path relative to their root, in code-unit order. */
function pluginFiles(members: readonly { kind: string; path: string }[], root: string): string[] {
  return [...new Set(members.filter(member => member.kind === 'file').map(member =>
    (isAbsolute(member.path) ? relative(root, member.path) : member.path).replaceAll('\\', '/')))]
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export async function list(request: unknown, controls: unknown = {}): Promise<ListResult> {
  forgetProvenState();
  if (!plain(request, ['target', 'scope'])) return invalid('', 'request', 'A list request is `{ target, scope }`.');
  const located = place(request, ['project', 'user', 'both']);
  if ('status' in located) return located;
  const options = planControls(controls);
  if (!options) return invalid('', 'controls', 'The controls are not valid.');
  const scope = located.scope as 'project' | 'user' | 'both';
  let home: string;
  try { home = projectRoot(homedir()); } catch { return { status: 'refused', code: 'home-unavailable', reason: 'The home folder is not usable.' }; }
  const listed = await listManagedSelections({ target: { project: located.anchor }, scope, format: 'urn:aihq:core:managed-inventory-result:1.1.0' },
    options.signal ? { signal: options.signal } : {});
  if (listed.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Listing was cancelled.' };
  if (listed.status === 'invalid') return { status: 'invalid', problems: listed.diagnostics.map(item => ({ path: item.path ?? '', reason: item.reason, message: item.message })) };
  const facts = planFacts([...(scope !== 'user' && located.project ? [located.project] : []), ...(scope !== 'project' ? [home] : [])]);
  const entries: InventoryEntry[] = listed.selections.map(row => {
    const plan = facts.get(`${row.scope}\0${row.managementId}`);
    return { managementId: row.managementId, scope: row.scope, items: plan ? [...plan.items] : [], origin: plan ? plan.origin : null,
      data: plan?.data ? { ...plan.data } : null, clis: plan ? [...plan.clis] : [],
      ...(plan ? { catalog: plan.catalog, profiles: plan.profiles.map(profile => ({ ...profile })) } : {}), installState: row.installState,
      ...(plan?.aiSetup ? { aiSetup: { ...plan.aiSetup, interpreter: plan.aiSetup.interpreter ? { ...plan.aiSetup.interpreter } : null } } : {}),
      members: row.members.map(member => ({ kind: member.kind, path: member.path, ...(member.pointer === undefined ? {} : { pointer: member.pointer }),
        ...(member.blockId === undefined ? {} : { blockId: member.blockId }),
        state: member.fileState === 'matches' ? 'matching' : member.fileState === 'changed' || member.fileState === 'block-changed' ? 'changed-by-you' :
          member.fileState === 'missing' || member.fileState === 'block-missing' ? 'missing' : 'unchecked' })),
      ...(plan?.plugins ? { plugins: plan.plugins.map(facts => JSON.parse(JSON.stringify(facts)) as PluginFacts) } : {}),
      ...(plan?.programs ? { programs: plan.programs.map(facts => JSON.parse(JSON.stringify(facts)) as ProgramFacts) } : {}),
      ...(plan?.localPlugin ? { localPlugin: { contains: plan.localPlugin.contains ? [...plan.localPlugin.contains] : null,
        files: pluginFiles(row.members, row.scope === 'project' ? located.anchor : home) } } : {}),
      ...(plan?.switchOff ? { switchOff: { ...plan.switchOff } } : {}) };
  });
  const inventory: Inventory = { schema: INVENTORY, status: 'ok', target: { project: located.project }, scope,
    observation: listed.status === 'complete' ? 'complete' : 'incomplete', entries };
  return deepFreezeStrictJsonV1(inventory as unknown as Json) as unknown as Inventory;
}

export async function prepareRemoval(request: unknown, controls: unknown = {}): Promise<RemovalResult> {
  forgetProvenState();
  if (!plain(request, ['target', 'scope', 'removals'])) return invalid('', 'request', 'A removal request is `{ target, scope, removals }`.');
  const located = place(request, ['project', 'user']);
  if ('status' in located) return located;
  const options = planControls(controls);
  if (!options) return invalid('', 'controls', 'The controls are not valid.');
  if (options.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Removal preparation was cancelled.' };
  const removals = request.removals;
  if (!Array.isArray(removals) || removals.length === 0 || removals.length > 4096) return invalid('/removals', 'removals', 'Name one or more removals.');
  const selectors: { managementId: string; origin?: { reasonIncluded: 'chosen' } }[] = [];
  // One item inside an indivisible plugin (C45, C68): never split; the entry offers the whole plugin instead.
  const itemEntries = new Map<number, RemovalEntry>();
  for (const [index, entry] of removals.entries()) {
    if (!plain(entry, ['managementId', 'item', 'origin', 'clis', 'switchOff']) || typeof entry.managementId !== 'string' || !ID.test(entry.managementId))
      return invalid(`/removals/${index}`, 'removal', 'A removal names a `managementId`.');
    if (entry.switchOff !== undefined) {
      if (entry.switchOff !== true || typeof entry.item !== 'string' || !ID.test(entry.item) || entry.origin !== undefined || entry.clis !== undefined)
        return invalid(`/removals/${index}/switchOff`, 'switch-off', 'A switch-off is `{ managementId, item, switchOff: true }`.');
      if (removals.length !== 1) return invalid('/removals', 'switch-off-alone', 'A switch-off is prepared on its own.');
      return switchOff(entry.managementId, entry.item, located.scope as 'project' | 'user', located.anchor, options);
    }
    if (entry.clis !== undefined) return { status: 'refused', code: 'client-attribution-missing',
      reason: `Removal by CLI is refused: this Core does not yet record which CLI claims each member of \`${entry.managementId}\`.` };
    if (entry.origin !== undefined && entry.origin !== 'chosen') return invalid(`/removals/${index}/origin`, 'origin', 'Only the `chosen` origin can be recorded by this Core.');
    if (entry.item !== undefined) {
      if (typeof entry.item !== 'string' || !ID.test(entry.item)) return invalid(`/removals/${index}/item`, 'item', 'An item is named by its id.');
      const found = itemInPlugin(entry.managementId, entry.item, located.scope as 'project' | 'user', located.anchor);
      if (!found) return invalid(`/removals/${index}/item`, 'item-removal-unavailable', 'Only an item inside a plugin is removed by item.');
      itemEntries.set(index, found); continue;
    }
    selectors.push({ managementId: entry.managementId, ...(entry.origin === 'chosen' ? { origin: { reasonIncluded: 'chosen' as const } } : {}) });
  }
  const scope = located.scope as 'project' | 'user';
  // Removing a whole plugin also removes the switch-offs of its items: nothing is left to switch off (C45).
  if (scope === 'user') for (const selector of [...selectors])
    for (const item of switchOffClaims(located.anchor, selector.managementId))
      if (!selectors.some(other => other.managementId === item)) selectors.push({ managementId: item });
  const inOrder = (engineEntries: RemovalEntry[]): RemovalEntry[] => {
    const queue = [...engineEntries];
    const ordered = removals.map((_entry, index) => itemEntries.get(index) ?? queue.shift()!).filter(Boolean);
    return [...ordered, ...queue];
  };
  if (!selectors.length) return { status: 'ok', entries: inOrder([]) };
  // `origin: chosen` removes the whole management id here: a plan install records exactly that one origin.
  const prepared = await prepareManagedRemoval({ target: { project: located.anchor }, scope,
    removals: selectors.map(({ managementId }) => ({ managementId })) }, engineControls(options));
  if (prepared.disposition === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Removal preparation was cancelled.' };
  if (prepared.disposition === 'invalid') return { status: 'invalid', problems: prepared.diagnostics.map(item => ({ path: item.path ?? '', reason: item.reason, message: item.message })) };
  const engine = prepared.preparation;
  const entries: RemovalEntry[] = inOrder((prepared.removals ?? []).map(entry => ({ managementId: entry.managementId, disposition: entry.disposition,
    ...(entry.disposition === 'prepared' && engine && ['ready', 'partial', 'blocked'].includes(engine.status) ?
      { status: engine.status as 'ready' | 'partial' | 'blocked' } : {}),
    members: entry.members.map(member => ({ kind: member.kind, path: member.path, ...(member.pointer === undefined ? {} : { pointer: member.pointer }),
      action: member.action, ...(member.reason === undefined ? {} : { reason: member.reason }) })) })));
  if (prepared.disposition === 'unavailable' && !entries.length)
    return { status: 'refused', code: 'home-unavailable', reason: prepared.diagnostics[0]?.message ?? 'Removal could not be prepared here.' };
  if (!engine?.review || !engine.prepared || !['ready', 'partial'].includes(engine.status)) return { status: 'ok', entries };
  // Native plugins in the prepared entries: their removal commands and presence checks come from the receipt (C54).
  const home = projectRoot(homedir());
  const facts = planFacts([scope === 'project' ? located.anchor : home]);
  const plugins = entries.filter(entry => entry.disposition === 'prepared' && entry.item === undefined).flatMap(entry =>
    (facts.get(`${scope}\0${entry.managementId}`)?.plugins ?? []).map(plugin => ({ managementId: entry.managementId, plugin })));
  // Program steps (C30): a tool-command's saved reverse command and readback run here; the rest can't be undone, and say so.
  const commands = entries.filter(entry => entry.disposition === 'prepared' && entry.item === undefined).flatMap(entry =>
    (facts.get(`${scope}\0${entry.managementId}`)?.programs ?? []).map(program => ({ managementId: entry.managementId, program })));
  const program = plugins.length || commands.length ? await prepareProgramRemoval(plugins, scope, located.anchor, options, commands) : undefined;
  if (program && 'status' in program) return program;
  // Each review operation carries one listed member's action; its management id is that member's entry.
  const owners = new Map<string, string>();
  for (const entry of prepared.removals ?? []) for (const member of entry.members) if (member.operationId) owners.set(member.operationId, entry.managementId);
  const operations = new Map<string, StepRef>();
  const offset = program?.steps.length ?? 0;
  const steps: ReviewStep[] = [...program?.steps ?? [], ...engine.review.operations.map((operation, at) => {
    const index = offset + at;
    const managementId = owners.get(operation.id) ?? '';
    operations.set(operation.id, { step: index, managementId });
    const target = operation.details.target ?? '';
    const effect: ReviewStep['effect'] = ['create-file', 'replace-file', 'remove-file', 'already-satisfied'].includes(operation.effects) ?
      operation.effects as ReviewStep['effect'] : operation.effects === 'conflict' ? 'conflict' : 'unchanged';
    const sentence = effect === 'remove-file' ? `Removes \`${target}\`` : effect === 'replace-file' ? `Restores \`${target}\`` :
      effect === 'already-satisfied' ? `Releases \`${target}\`, already as it should be` : `Leaves \`${target}\` as it is`;
    return { step: index, op: 'remove', managementId, sentence, cantPromise: null, effect, path: target };
  })];
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'removal', scope, target: { project: located.project }, steps,
    conflicts: [], failureRule: FAILURE_RULE, warnings: [] };
  const reviewDigest = digestOf(body, engine.review.reviewDigest + (program ? '\0' + program.engineDigest : ''));
  const review = deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review;
  const partial = engine.status === 'partial';
  // Private inputs passed for a removal (such as a secret a restored value needs again, C64) bind its review.
  const handle = register({ engine: engine.prepared, engineDigest: engine.review.reviewDigest, enginePartial: partial, reviewDigest, partial, operations,
    privateInputs: bindPrivateInputs(options.privateInputs),
    ...(program ? { before: { engine: program.engine, engineDigest: program.engineDigest, operations: program.operations, programs: program.programs,
      unremovable: program.unremovable } } : {}) });
  return { status: 'ok', entries, review, handle };
}

/**
 * A removal of one item by `{ managementId, item }`: `absent` when no install of that management id records it, and
 * `unavailable` with `plugin-indivisible` when a native plugin holds it, listing what the plugin holds and offering the
 * whole plugin's removal. `undefined` when the management id records no plugin (no item route applies).
 */
function itemInPlugin(managementId: string, item: string, scope: 'project' | 'user', anchor: string): RemovalEntry | undefined {
  const root = scope === 'project' ? anchor : projectRoot(homedir());
  const facts = planFacts([root]);
  const plan = facts.get(`${scope}\0${managementId}`);
  if (!plan) return { managementId, item, disposition: 'absent', members: [] };
  const whole = { managementId, item, disposition: 'unavailable' as const, reason: 'plugin-indivisible', members: [] };
  if (plan.localPlugin) {
    // Without the route's contained-item metadata Core can't say what the plugin holds; it lists its files (C68).
    if (plan.localPlugin.contains === null) {
      const row = readOwnership(root).value.items?.[claimIdentity(scope, managementId, anchor)];
      return { ...whole, files: pluginFiles((row?.members ?? []).map(member => ({ kind: member.kind, path: 'path' in member ? member.path : '' })), root), offers: [{ managementId }] };
    }
    if (!plan.localPlugin.contains.includes(item)) return { managementId, item, disposition: 'absent', members: [] };
    return { ...whole, contains: [...plan.localPlugin.contains], offers: [{ managementId }] };
  }
  if (!plan.plugins) return undefined;
  const holding = plan.plugins.filter(plugin => plugin.contains.includes(item));
  if (!holding.length) return { managementId, item, disposition: 'absent', members: [] };
  const offers: NonNullable<RemovalEntry['offers']> = [{ managementId }];
  if (switchable(holding, item)) offers.push(switchedOff(facts, scope, managementId, item) ? { managementId: item } : { managementId, item, switchOff: true });
  return { ...whole, contains: [...new Set(holding.flatMap(plugin => plugin.contains))].sort(), offers };
}
/** `{ managementId, item, switchOff: true }`: `absent` when the install doesn't record the item, else its reviewed switch-off. */
async function switchOff(framework: string, item: string, scope: 'project' | 'user', anchor: string, controls: PlanControls): Promise<RemovalResult> {
  const root = scope === 'project' ? anchor : projectRoot(homedir());
  const plan = planFacts([root]).get(`${scope}\0${framework}`);
  const absent: RemovalResult = { status: 'ok', entries: [{ managementId: framework, item, disposition: 'absent', members: [] }] };
  if (!plan) return absent;
  const holding = [...(plan.plugins ?? []).filter(plugin => plugin.contains.includes(item)), ...(plan.localPlugin?.contains?.includes(item) ? [null] : [])];
  if (!holding.length && plan.localPlugin?.contains !== null) return absent;
  return prepareSwitchOff(framework, item, switchable(plan.plugins ?? [], item), plan, controls);
}
/** The plugin step that lets this one item be switched off: a Codex plugin naming the item's skill (C45, C69). */
export function switchable(plugins: PluginFacts[], item: string): PluginFacts | undefined {
  return plugins.find(plugin => plugin.cli === 'codex' && plugin.contains.includes(item) && typeof plugin.skills?.[item] === 'string');
}
/** Whether a switch-off claim for this item of this framework is recorded here. */
const switchedOff = (facts: Map<string, PlanItemFacts>, scope: string, framework: string, item: string): boolean =>
  facts.get(`${scope}\0${item}`)?.switchOff?.framework === framework;

/**
 * The reviewed removal commands of native plugins, as their own engine preparation: one `process.run` per saved
 * removal command, run before the receipt is released, then the saved presence check. Nothing here writes custody.
 */
async function prepareProgramRemoval(plugins: { managementId: string; plugin: PluginFacts }[], scope: 'project' | 'user', anchor: string,
    controls: PlanControls, commands: { managementId: string; program: ProgramFacts }[] = []): Promise<ProgramRemoval | Refusal | { status: 'invalid'; problems: Problem[] }> {
  const operations = new Map<string, StepRef>();
  const programs = new Map<number, ProgramCheck>();
  const unremovable: StepRef[] = [];
  const selections: ExecutionPolicy['selections'] = [];
  const cwd = { root: scope === 'project' ? 'project' as const : 'userHome' as const, segments: [] };
  plugins.forEach(({ managementId, plugin }, index) => {
    if (!plugin.undo) { unremovable.push({ step: index, managementId, program: true }); return; }
    const selectionId = `p${index}`;
    const ops: Recipe['operations'] = plugin.undo.map((argv, at) => {
      const id = `remove-${at}`;
      operations.set(`${selectionId}/${id}`, { step: index, managementId, program: true });
      return { id, purpose: `Runs \`${argv.join(' ')}\``, kind: 'process.run', scope, executable: { name: argv[0]! },
        args: argv.slice(1).map(literal => ({ literal })), cwd, env: {}, acceptedExitCodes: [0],
        effects: [`The ${plugin.cli} CLI's own plugin removal; Core can't show its effects`], requires: at ? [`remove-${at - 1}`] : [], checks: [] };
    });
    selections.push({ id: selectionId, managementId, scope, configuration: {}, requires: [], recipe: { inline: {
      schema: 'urn:aihq:core:recipe:1.0.0', id: 'plugin-removal', description: 'Removes a native plugin', inputs: {}, materials: [],
      targets: [scope], prerequisites: [], operations: ops, checks: [] } } });
  });
  // A tool-command's reverse runs the acquired program it was installed with, from home, before the AI setup folder goes.
  const home = projectRoot(homedir());
  const offset = plugins.length;
  commands.forEach(({ managementId, program }, at) => {
    const index = offset + at;
    if (!program.undo || !program.executable) { unremovable.push({ step: index, managementId, command: true }); return; }
    const selectionId = `c${index}`;
    operations.set(`${selectionId}/reverse`, { step: index, managementId, command: true });
    // Its own engine management id: running the reverse must not rewrite the AI setup's claim before its release.
    selections.push({ id: selectionId, managementId: `aih-reverse-${index}`, scope: 'user', configuration: {}, requires: [], recipe: { inline: {
      schema: 'urn:aihq:core:recipe:1.0.0', id: 'command-reverse', description: 'Reverses a tool command', inputs: {}, materials: [],
      targets: ['user'], prerequisites: [], checks: [], operations: [{ id: 'reverse', purpose: `Runs \`${program.undo.argv.join(' ')}\``, kind: 'process.run',
        scope: 'user', executable: { name: join(home, ...program.executable.split('/')) }, args: program.undo.argv.map(literal => ({ literal })),
        cwd: { root: 'userHome', segments: [] }, env: {}, acceptedExitCodes: [0], effects: ['The tool\'s own reverse command; Core can\'t show its effects'],
        requires: [], checks: [] }] } } });
  });
  const steps: ReviewStep[] = [];
  let engine: Awaited<ReturnType<typeof prepareEngine>> | undefined;
  if (selections.length) {
    engine = await prepareEngine({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections },
      target: { project: anchor } }, engineControls(controls));
    if (engine.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Removal preparation was cancelled.' };
    if (!engine.review || !engine.prepared) return { status: 'invalid', problems: problemsOf(engine) };
  }
  const pinned = new Map<number, { executable: string; executableSha256: string }[]>();
  for (const operation of engine?.review?.operations ?? []) {
    const ref = operations.get(operation.id);
    if (!ref) continue;
    if (operation.effects === 'unavailable' || typeof operation.details.executableSha256 !== 'string')
      return { status: 'refused', code: 'program-unavailable', reason: `Removing \`${ref.managementId}\` runs a ${ref.command ? 'program' : 'CLI'} this host cannot run.` };
    const list = pinned.get(ref.step as number) ?? []; pinned.set(ref.step as number, list);
    list.push({ executable: String(operation.details.executable), executableSha256: operation.details.executableSha256 });
  }
  for (const [index, { managementId, plugin }] of plugins.entries()) {
    let presence: ReviewStep['presenceCheck'] = 'none';
    if (plugin.presenceCheck !== 'none' && plugin.undo) {
      const executable = resolveExecutable(plugin.presenceCheck.argv[0]!);
      if (!executable) return { status: 'refused', code: 'program-unavailable',
        reason: `The presence check of \`${managementId}\` runs \`${plugin.presenceCheck.argv[0]}\`, which this host cannot run.` };
      presence = { ...plugin.presenceCheck, executable: executable.launchPath, executableSha256: executable.sha256 };
      programs.set(index, { executable, argv: plugin.presenceCheck.argv, expect: plugin.presenceCheck.expect, cwd: anchor });
    }
    const commands = (plugin.undo ?? []).map((argv, at) => ({ argv, ...pinned.get(index)![at]! }));
    steps.push({ step: index, op: 'plugin', managementId, framework: managementId, cli: plugin.cli, clis: [plugin.cli], plugin: plugin.plugin,
      commit: plugin.commit, contains: [...plugin.contains], effect: plugin.undo ? 'run-program' : 'unchanged', commands, undo: plugin.undo,
      presenceCheck: presence,
      sentence: plugin.undo ? `Runs \`${plugin.undo.map(argv => argv.join(' ')).join('`, then `')}\`` :
        `Releases the receipt of \`${plugin.plugin}\`; Core has no removal command for it`,
      cantPromise: plugin.undo ? 'Core can\'t show or roll back what the CLI\'s own removal changes. ' +
        (presence === 'none' ? 'The receipt has no presence check, so the removal stays unverified.' : 'Core checks only that the plugin is no longer listed.') :
        'The plugin stays installed in the CLI; remove it there yourself.' });
  }
  for (const [at, { managementId, program }] of commands.entries()) {
    const index = offset + at;
    const pinned = pinnedReverse(engine, index, operations);
    const reversible = !!(program.undo && program.executable && pinned);
    if (reversible) programs.set(index, { executable: pinned!.resolved, argv: [pinned!.resolved.launchPath, ...program.undo!.readback.argv],
      expect: program.undo!.readback.expected, cwd: home, readback: true });
    const command = program.argv.join(' ');
    steps.push({ step: index, op: program.op, managementId, item: managementId, effect: reversible ? 'run-program' : 'unchanged',
      sentence: reversible ? `Runs \`${program.undo!.argv.join(' ')}\`, then checks that \`${program.undo!.readback.argv.join(' ')}\` reads \`${program.undo!.readback.expected}\`` :
        program.op === 'upstream-setup' ? `Removes the clone \`${program.clone?.into ?? ''}\` with the install` : `Releases the record of \`${command}\``,
      cantPromise: reversible ? 'Core can\'t show or roll back what the reverse command changes; it checks only the readback.' :
        program.op === 'tool-command' ? `Core can't undo \`${command}\`: the AI setup named no reverse command.` :
        program.op === 'upstream-installer' ? `Core can't remove what \`${command}\` installed: it is not managed by Core. Remove it with the tool's own uninstaller.` :
        `Core removes only its clone; it can't remove what \`${command}\` wrote elsewhere.`,
      program: { kind: program.op, argv: reversible ? program.undo!.argv : program.argv,
        executable: reversible ? pinned!.resolved.launchPath : program.executable ? join(home, ...program.executable.split('/')) : program.argv[0]!,
        executableSha256: reversible ? pinned!.resolved.sha256 : null, from: program.executable ? 'acquired' : 'path', cwd: home, env: [], managed: program.managed,
        readback: reversible ? program.undo!.readback : null, undo: program.undo, cantRemove: reversible ? 'Nothing else the command changed is rolled back.' :
          program.op === 'upstream-setup' ? 'What the setup command wrote outside its clone stays.' : 'What the command changed stays.' } });
  }
  return { steps, engine: engine?.prepared, engineDigest: engine?.review?.reviewDigest ?? '', operations, programs, unremovable };
}
/** The reverse command's executable as the removal's engine pinned it. */
function pinnedReverse(engine: Awaited<ReturnType<typeof prepareEngine>> | undefined, index: number, operations: Map<string, StepRef>):
    { resolved: NonNullable<ReturnType<typeof resolveExecutable>> } | undefined {
  const operation = engine?.review?.operations.find(entry => operations.get(entry.id)?.step === index && operations.get(entry.id)?.command);
  if (!operation || typeof operation.details.executable !== 'string') return undefined;
  const resolved = resolveExecutable(operation.details.executable);
  return resolved && resolved.sha256 === operation.details.executableSha256 ? { resolved } : undefined;
}
interface ProgramRemoval {
  steps: ReviewStep[]; engine: PreparedHandle | undefined; engineDigest: string; operations: Map<string, StepRef>;
  programs: Map<number, ProgramCheck>; unremovable: StepRef[];
}
