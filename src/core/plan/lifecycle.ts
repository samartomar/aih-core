// `list` and `prepareRemoval` 0.1.0 (contract 12): the inventory and removal forms over the retained custody,
// claim and removal rules (14.2). The place is always named; Core never guesses it from the working folder.
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';
import { listManagedSelections } from '../managed-inventory.js';
import { prepareManagedRemoval } from '../managed-removal.js';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState, readOwnership } from '../internal/state.js';
import { register, type ProgramCheck, type StepRef } from './handles.js';
import { prepare as prepareEngine } from '../recipe-engine.js';
import { resolveExecutable } from '../internal/approved-process.js';
import type { PreparedHandle } from '../host-types.js';
import type { ExecutionPolicy, Recipe } from '../types.js';
import { FAILURE_RULE, digestOf, engineControls, planControls, problemsOf } from './prepare.js';
import type { PlanItemFacts, PluginFacts } from '../internal/custody-items.js';
import { managementIdOf, sameProject } from './claims.js';
import { linkRecordPath, linkState } from './links.js';
import type { Json } from '../types.js';
import { INVENTORY, REVIEW, type Inventory, type PlanControls, type Refusal, type InventoryEntry, type InventoryMember, type ListResult, type Problem, type RemovalEntry, type RemovalResult,
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
/** The recorded claims of one management id in one scope's receipts: engine id and plan facts (C28). */
function claimsOf(facts: Map<string, PlanItemFacts>, scope: string, managementId: string): { engineId: string; plan: PlanItemFacts }[] {
  const found: { engineId: string; plan: PlanItemFacts }[] = [];
  for (const [key, plan] of facts) {
    const at = key.indexOf('\0'); const recorded = key.slice(0, at); const engineId = key.slice(at + 1);
    if (recorded === scope && managementIdOf(engineId, plan) === managementId) found.push({ engineId, plan });
  }
  return found;
}
const order = (a: string | null, b: string | null) => (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0;
const normal = (path: string) => path.replaceAll('\\', '/');

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
  // One entry per management id and scope, over every claim that holds it: each CLI and project (C28, C38).
  const entries: InventoryEntry[] = [];
  const byId = new Map<string, InventoryEntry>();
  const memberIndex = new Map<InventoryEntry, Map<string, InventoryMember>>();
  for (const row of listed.selections) {
    const plan = facts.get(`${row.scope}\0${row.managementId}`);
    const managementId = managementIdOf(row.managementId, plan);
    let entry = byId.get(`${row.scope}\0${managementId}`);
    if (!entry) {
      entry = { managementId, scope: row.scope, items: plan ? [...plan.items] : [], origin: plan ? plan.origin : null,
        data: plan?.data ? { ...plan.data } : null, clis: [], ...(plan ? { claims: [] } : {}),
        ...(plan ? { catalog: plan.catalog, profiles: plan.profiles.map(profile => ({ ...profile })) } : {}), installState: row.installState,
        ...(plan?.aiSetup ? { aiSetup: { ...plan.aiSetup, interpreter: plan.aiSetup.interpreter ? { ...plan.aiSetup.interpreter } : null } } : {}),
        members: [] };
      byId.set(`${row.scope}\0${managementId}`, entry); entries.push(entry); memberIndex.set(entry, new Map());
    }
    const current = entry;
    if (row.installState === 'interrupted') current.installState = 'interrupted';
    // An unattributed claim is held for every CLI its plan was made for (contract 5).
    const claimClis = plan ? plan.cli !== undefined && plan.cli !== null ? [plan.cli] : plan.clis : [];
    current.clis = [...new Set([...current.clis, ...claimClis])].sort();
    if (plan) current.claims!.push({ cli: plan.cli ?? null, project: plan.project ?? null });
    if (plan?.plugins) current.plugins = [...current.plugins ?? [], ...plan.plugins
      .filter(item => !current.plugins?.some(known => known.step === item.step && known.cli === item.cli))
      .map(item => JSON.parse(JSON.stringify(item)) as PluginFacts)];
    const index = memberIndex.get(current)!;
    for (const member of row.members) {
      const path = normal(member.path);
      // A placed link is shown as the link itself; its record in `.aihq/links/` is how the receipt claims it.
      const link = plan?.links?.find(item => item.linkType !== 'copy' && path.endsWith(linkRecordPath(item.path)));
      const copy = !link ? plan?.links?.find(item => item.linkType === 'copy' && path.includes(`${item.path}/`)) : undefined;
      const shown: InventoryMember = link ? { kind: 'link', path: link.path, linkType: link.linkType, state: linkState(home, link) } :
        { kind: member.kind, path: member.path, ...(member.pointer === undefined ? {} : { pointer: member.pointer }),
          ...(member.blockId === undefined ? {} : { blockId: member.blockId }), ...(copy ? { linkType: 'copy' as const } : {}),
          state: member.fileState === 'matches' ? 'matching' : member.fileState === 'changed' || member.fileState === 'block-changed' ? 'changed-by-you' :
            member.fileState === 'missing' || member.fileState === 'block-missing' ? 'missing' : 'unchecked' };
      const key = JSON.stringify([shown.kind, shown.path, shown.pointer ?? null, shown.blockId ?? null]);
      let known = index.get(key);
      if (!known) { known = shown; index.set(key, known); current.members.push(known); }
      if (plan) known.clis = [...new Set([...known.clis ?? [], ...claimClis])].sort();
    }
  }
  for (const entry of entries) entry.claims?.sort((a, b) => order(a.project, b.project) || order(a.cli, b.cli));
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
  const scope = located.scope as 'project' | 'user';
  const home = projectRoot(homedir());
  const facts = planFacts([scope === 'project' ? located.anchor : home]);
  // Each removal names the engine claims it releases (C28): this place's claims of the management id from this project,
  // and with `clis` only those CLIs' claims. A claim whose steps recorded no CLI can't be split by CLI (C55).
  const selectors: { index: number; managementId: string; engineIds: string[] }[] = [];
  const absentEntries = new Map<number, RemovalEntry>();
  // One item inside an indivisible plugin (C45, C68): never split; the entry offers the whole plugin instead.
  const itemEntries = new Map<number, RemovalEntry>();
  for (const [index, entry] of removals.entries()) {
    if (!plain(entry, ['managementId', 'item', 'origin', 'clis']) || typeof entry.managementId !== 'string' || !ID.test(entry.managementId))
      return invalid(`/removals/${index}`, 'removal', 'A removal names a `managementId`.');
    if (entry.clis !== undefined && !(Array.isArray(entry.clis) && entry.clis.length > 0 && entry.clis.length <= 64 &&
        entry.clis.every(cli => typeof cli === 'string' && ID.test(cli)) && new Set(entry.clis).size === entry.clis.length))
      return invalid(`/removals/${index}/clis`, 'clis', 'Name one or more CLI ids.');
    if (entry.origin !== undefined && entry.origin !== 'chosen') return invalid(`/removals/${index}/origin`, 'origin', 'Only the `chosen` origin can be recorded by this Core.');
    if (entry.item !== undefined) {
      if (typeof entry.item !== 'string' || !ID.test(entry.item)) return invalid(`/removals/${index}/item`, 'item', 'An item is named by its id.');
      const found = itemInPlugin(entry.managementId, entry.item, located.scope as 'project' | 'user', located.anchor);
      if (!found) return invalid(`/removals/${index}/item`, 'item-removal-unavailable', 'Only an item inside a plugin is removed by item.');
      itemEntries.set(index, found); continue;
    }
    const recorded = claimsOf(facts, scope, entry.managementId).filter(claim => sameProject(claim.plan, located.project));
    const clis = entry.clis as string[] | undefined;
    if (clis && recorded.some(claim => (claim.plan.cli ?? null) === null)) return { status: 'refused', code: 'client-attribution-missing',
      reason: `Removal by CLI is refused: the plan that installed \`${entry.managementId}\` recorded no CLIs for its members, so Core can't tell which CLI claims them. Remove it for every CLI, or install it again from a plan that records \`clis\`.` };
    const chosen = clis ? recorded.filter(claim => clis.includes(claim.plan.cli!)) : recorded;
    if (recorded.length && !chosen.length) { absentEntries.set(index, { managementId: entry.managementId, disposition: 'absent', members: [] }); continue; }
    // A receipt without plan facts (a change, an older install) keeps its own management id.
    selectors.push({ index, managementId: entry.managementId, engineIds: chosen.length ? chosen.map(claim => claim.engineId) : [entry.managementId] });
  }
  const engineOwner = new Map(selectors.flatMap(selector => selector.engineIds.map(id => [id, selector.managementId] as const)));
  const merged = (engineEntries: RemovalEntry[]): RemovalEntry[] => {
    const byEngine = new Map(engineEntries.map(entry => [entry.managementId, entry]));
    return removals.flatMap((_entry, index): RemovalEntry[] => {
      const fixed = itemEntries.get(index) ?? absentEntries.get(index);
      if (fixed) return [fixed];
      const selector = selectors.find(item => item.index === index);
      const parts = (selector?.engineIds ?? []).flatMap(id => byEngine.has(id) ? [byEngine.get(id)!] : []);
      if (!selector || !parts.length) return [];
      // One shared member several of these claims hold is listed once.
      const seen = new Set<string>();
      const members = parts.flatMap(part => part.members).filter(member => { const key = JSON.stringify(member); if (seen.has(key)) return false; seen.add(key); return true; });
      const first = parts.find(part => part.disposition === 'prepared') ?? parts[0]!;
      return [{ ...first, managementId: selector.managementId, members }];
    });
  };
  if (!selectors.length) return { status: 'ok', entries: merged([]) };
  // `origin: chosen` removes the whole management id here: a plan install records exactly that one origin.
  const prepared = await prepareManagedRemoval({ target: { project: located.anchor }, scope,
    removals: selectors.flatMap(({ engineIds }) => engineIds.map(managementId => ({ managementId }))) }, engineControls(options));
  if (prepared.disposition === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Removal preparation was cancelled.' };
  if (prepared.disposition === 'invalid') return { status: 'invalid', problems: prepared.diagnostics.map(item => ({ path: item.path ?? '', reason: item.reason, message: item.message })) };
  const engine = prepared.preparation;
  const entries: RemovalEntry[] = merged((prepared.removals ?? []).map(entry => ({ managementId: entry.managementId, disposition: entry.disposition,
    ...(entry.disposition === 'prepared' && engine && ['ready', 'partial', 'blocked'].includes(engine.status) ?
      { status: engine.status as 'ready' | 'partial' | 'blocked' } : {}),
    members: entry.members.map(member => ({ kind: member.kind, path: member.path, ...(member.pointer === undefined ? {} : { pointer: member.pointer }),
      action: member.action, ...(member.reason === undefined ? {} : { reason: member.reason }) })) })));
  if (prepared.disposition === 'unavailable' && !entries.length)
    return { status: 'refused', code: 'home-unavailable', reason: prepared.diagnostics[0]?.message ?? 'Removal could not be prepared here.' };
  if (!engine?.review || !engine.prepared || !['ready', 'partial'].includes(engine.status)) return { status: 'ok', entries };
  // Native plugins in the prepared entries: their removal commands and presence checks come from the receipt (C54).
  const releasing = (prepared.removals ?? []).filter(entry => entry.disposition === 'prepared' && engineOwner.has(entry.managementId));
  const plugins = releasing.flatMap(entry => (facts.get(`${scope}\0${entry.managementId}`)?.plugins ?? [])
    .map(plugin => ({ managementId: engineOwner.get(entry.managementId)!, plugin })));
  // Folder links these claims placed: removed with their record once no other claim holds it (C28, Apply).
  const links = releasing.flatMap(entry => facts.get(`${scope}\0${entry.managementId}`)?.links ?? []);
  const program = plugins.length ? await prepareProgramRemoval(plugins, scope, located.anchor, options) : undefined;
  if (program && 'status' in program) return program;
  // Each review operation carries one listed member's action; its management id is that member's entry.
  const owners = new Map<string, string>();
  for (const entry of prepared.removals ?? []) for (const member of entry.members) if (member.operationId)
    owners.set(member.operationId, engineOwner.get(entry.managementId) ?? entry.managementId);
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
  const handle = register({ engine: engine.prepared, engineDigest: engine.review.reviewDigest, enginePartial: partial, reviewDigest, partial, operations,
    claims: engineOwner, ...(links.length ? { links } : {}),
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
  const plan = planFacts([root]).get(`${scope}\0${managementId}`);
  if (!plan) return { managementId, item, disposition: 'absent', members: [] };
  if (!plan.plugins) return undefined;
  const holding = plan.plugins.filter(plugin => plugin.contains.includes(item));
  if (!holding.length) return { managementId, item, disposition: 'absent', members: [] };
  return { managementId, item, disposition: 'unavailable', reason: 'plugin-indivisible', members: [],
    contains: [...new Set(holding.flatMap(plugin => plugin.contains))].sort(), offers: [{ managementId }] };
}

/**
 * The reviewed removal commands of native plugins, as their own engine preparation: one `process.run` per saved
 * removal command, run before the receipt is released, then the saved presence check. Nothing here writes custody.
 */
async function prepareProgramRemoval(plugins: { managementId: string; plugin: PluginFacts }[], scope: 'project' | 'user', anchor: string,
    controls: PlanControls): Promise<ProgramRemoval | Refusal | { status: 'invalid'; problems: Problem[] }> {
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
      return { status: 'refused', code: 'program-unavailable', reason: `Removing \`${ref.managementId}\` runs a CLI this host cannot run.` };
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
  return { steps, engine: engine?.prepared, engineDigest: engine?.review?.reviewDigest ?? '', operations, programs, unremovable };
}
interface ProgramRemoval {
  steps: ReviewStep[]; engine: PreparedHandle | undefined; engineDigest: string; operations: Map<string, StepRef>;
  programs: Map<number, ProgramCheck>; unremovable: StepRef[];
}
