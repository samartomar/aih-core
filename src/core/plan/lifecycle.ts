// `list` and `prepareRemoval` 0.1.0 (contract 12): the inventory and removal forms over the retained custody,
// claim and removal rules (14.2). The place is always named; Core never guesses it from the working folder.
import { bindPrivateInputs, privateInputValue } from './inputs.js';
import { memberPointer, publicKind } from '../internal/custody-items.js';
import { codeUnitCompare } from '../internal/canonical.js';
import { internalManagementId, publicManagementId } from '../../harness/public-ids.mjs';
import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { isProxy } from 'node:util/types';
import { listManagedSelections } from '../managed-inventory.js';
import { prepareManagedRemovals, prepareRepairRemoval } from '../managed-removal.js';
import type { RemovalMember as EngineRemovalMember } from '../removal-types.js';
import { repairIndex } from '../../harness/contracts.mjs';
import { windowsUserEnvironmentKept } from '../../harness/runtime.mjs';
import { deepFreezeStrictJsonV1 } from '../internal/strict-json.js';
import { projectRoot } from '../internal/host-files.js';
import { forgetProvenState, readOwnership } from '../internal/state.js';
import { register, type ProgramCheck, type StepRef } from './handles.js';
import { claimIdentity } from '../internal/recipe-lifecycle.js';
import { prepareSwitchOff, switchOffClaims, switchOffId } from './switch-off.js';
import { switchOffRoute } from '../../harness/cli-facts.mjs';
import { prepare as prepareEngine } from '../recipe-engine.js';
import { argumentsRunnable, resolveProgram } from '../internal/approved-process.js';
import { operationKey } from '../internal/operation-key.js';
import type { PreparedHandle } from '../host-types.js';
import type { ExecutionPolicy, Recipe } from '../types.js';
import { FAILURE_RULE, digestOf, engineControls, launcherReview, pinnedCommand, planControls, problemsOf, shimRefusal } from './prepare.js';
import { enterpriseContext } from '../enterprise/plan.js';
import { admitRemovals, obligations } from '../enterprise/admission.js';
import { denialReason, organizationReview, placeClaims, projected } from '../enterprise/host.js';
import type { ItemRunOutcome, PlanItemFacts } from '../internal/custody-items.js';
import type { PluginFacts, ProgramFacts } from './types.js';
import { join } from 'node:path';
import { managementIdOf, sameProject } from './claims.js';
import { linkRecordPath, linkState } from './links.js';
import type { Json } from '../types.js';
import { INVENTORY, REMOVAL_CHOICES, REVIEW, type ReviewCommand, type RemovalResolution, type Inventory, type PlanControls, type Refusal, type InventoryEntry, type InventoryMember, type ListResult, type Problem, type RemovalEntry, type RemovalResult,
  type Review, type ReviewStep } from './types.js';

const invalid = (path: string, reason: string, message: string): { status: 'invalid'; problems: Problem[] } =>
  ({ status: 'invalid', problems: [{ path, reason, message }] });
const plain = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value) && Object.keys(value).every(key => keys.includes(key));
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The project and the folder the engine anchors a request on: the project, or home for a user-only place. */
export function place(request: Record<string, unknown>, scopes: string[]): { project: string | null; anchor: string; scope: string } | { status: 'invalid'; problems: Problem[] } {
  if (!scopes.includes(request.scope as string)) return invalid('/scope', 'scope', `The scope is one of ${scopes.join(', ')}.`);
  if (!plain(request.target, ['project', 'client', 'repository'])) return invalid('/target', 'target', 'The target is `{ project?, client?, repository? }`.');
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
/** What the last run that reached its end did to each install it left unfinished, by scope and engine id. */
function lastRuns(roots: string[]): Map<string, ItemRunOutcome> {
  const found = new Map<string, ItemRunOutcome>();
  for (const root of new Set(roots)) for (const item of Object.values(readOwnership(root).value.items ?? {}))
    if (item.lastRun) found.set(`${item.scope}\0${item.managementId}`, item.lastRun);
  return found;
}
/** Claims kept under a claim key without plan facts (user-scope changes made for a project): their management id and project. */
function keyedClaims(roots: string[]): Map<string, { managementId: string; project: string | null }> {
  const found = new Map<string, { managementId: string; project: string | null }>();
  for (const root of new Set(roots)) for (const item of Object.values(readOwnership(root).value.items ?? {}))
    if (item.claim && !item.plan) found.set(`${item.scope}\0${item.managementId}`, item.claim);
  return found;
}
/**
 * The identity each change claim here was installed with (`deriveChangeIdentity`, recorded on its members), by scope and
 * engine id. Enterprise counts a change entry as fulfilled only by that identity (contract 11).
 */
function changeIdentities(roots: { root: string; scope: 'project' | 'user' }[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { root, scope } of roots) for (const owner of Object.values(readOwnership(root).value.members))
    for (const claim of owner.claims ?? [{ managementId: owner.managementId, scope }])
      if (claim.scope === scope && !found.has(`${scope}\0${claim.managementId}`)) found.set(`${scope}\0${claim.managementId}`, owner.recipeIdentity);
  return found;
}
const REPAIR_IDS = new Set(repairIndex.map((repair: { id: string }) => repair.id));
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
  const keyed = keyedClaims(scope !== 'project' ? [home] : []);
  const runs = lastRuns([...(scope !== 'user' && located.project ? [located.project] : []), ...(scope !== 'project' ? [home] : [])]);
  const identities = changeIdentities([...(scope !== 'user' && located.project ? [{ root: located.project, scope: 'project' as const }] : []),
    ...(scope !== 'project' ? [{ root: home, scope: 'user' as const }] : [])]);
  // One entry per management id and scope, over every claim that holds it: each CLI and project (C28, C38).
  const entries: InventoryEntry[] = [];
  const byId = new Map<string, InventoryEntry>();
  const memberIndex = new Map<InventoryEntry, Map<string, InventoryMember>>();
  for (const row of listed.selections) {
    const plan = facts.get(`${row.scope}\0${row.managementId}`);
    const changeClaim = plan ? undefined : keyed.get(`${row.scope}\0${row.managementId}`);
    const managementId = changeClaim?.managementId ?? publicManagementId(managementIdOf(row.managementId, plan));
    let entry = byId.get(`${row.scope}\0${managementId}`);
    if (!entry) {
      // A change (no plan facts, not a repair) is listed with the identity it was installed with.
      const identity = plan || REPAIR_IDS.has(managementId) ? undefined : identities.get(`${row.scope}\0${row.managementId}`);
      entry = { managementId, scope: row.scope, ...(identity ? { change: { identity } } : {}), items: plan ? [...plan.items] : [], origin: plan ? plan.origin : null,
        data: plan?.data ? { ...plan.data } : null, clis: [], ...(plan || changeClaim ? { claims: [] } : {}),
        ...(plan ? { catalog: plan.catalog, profiles: plan.profiles.map(profile => ({ ...profile })) } : {}),
        ...(plan && plan.kind !== undefined ? { kind: plan.kind, framework: plan.framework ?? null } : {}), installState: row.installState,
        ...(plan?.aiSetup ? { aiSetup: { ...plan.aiSetup, interpreter: plan.aiSetup.interpreter ? { ...plan.aiSetup.interpreter } : null } } : {}),
        ...(plan?.localPlugin ? { localPlugin: { contains: plan.localPlugin.contains ? [...plan.localPlugin.contains] : null,
          files: pluginFiles(row.members, row.scope === 'project' ? located.anchor : home) } } : {}),
        ...(plan?.switchOff ? { switchOff: { ...plan.switchOff } } : {}),
        members: [] };
      byId.set(`${row.scope}\0${managementId}`, entry); entries.push(entry); memberIndex.set(entry, new Map());
    }
    const current = entry;
    if (row.installState === 'interrupted') current.installState = 'interrupted';
    // An unfinished install says what the run that left it did; a failure outranks a step never attempted.
    const lastRun = row.installState === 'interrupted' ? runs.get(`${row.scope}\0${row.managementId}`) : undefined;
    if (lastRun && (!current.lastRun || current.lastRun.outcome === 'not-attempted' && lastRun.outcome === 'failed')) current.lastRun = { ...lastRun };
    // An unattributed claim is held for every CLI its plan was made for (contract 5).
    const claimClis = plan ? plan.cli !== undefined && plan.cli !== null ? [plan.cli] : plan.clis : [];
    current.clis = [...new Set([...current.clis, ...claimClis])].sort();
    if (plan) current.claims!.push({ cli: plan.cli ?? null, project: plan.project ?? null });
    else if (changeClaim) (current.claims ??= []).push({ cli: null, project: changeClaim.project });
    if (plan && current.profiles) for (const profile of plan.profiles)
      if (!current.profiles.some(known => known.id === profile.id)) current.profiles.push({ ...profile });
    current.profiles?.sort((a, b) => order(a.id, b.id));
    if (plan?.plugins) current.plugins = [...current.plugins ?? [], ...plan.plugins
      .filter(item => !current.plugins?.some(known => known.step === item.step && known.cli === item.cli))
      .map(item => JSON.parse(JSON.stringify(item)) as PluginFacts)];
    // The last Scan results seen (contract 12, 13): one per key and signer across this install's claims.
    if (plan?.scans) current.scans = [...current.scans ?? [], ...plan.scans
      .filter(item => !current.scans?.some(known => known.scanKey === item.scanKey && known.signer.issuer === item.signer.issuer &&
        known.signer.subject === item.signer.subject))
      .map(item => structuredClone(item))];
    if (plan?.programs) current.programs = [...current.programs ?? [], ...plan.programs
      .filter(item => !current.programs?.some(known => known.step === item.step))
      .map(item => JSON.parse(JSON.stringify(item)) as ProgramFacts)];
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
  // A displaced claim (C61) holds nothing on disk: each member it shares is listed as displaced by the installs there now.
  for (const root of new Set([...(scope !== 'user' && located.project ? [located.project] : []), ...(scope !== 'project' ? [home] : [])])) {
    const recorded = readOwnership(root).value;
    const idOf = (claim: { scope: string; managementId: string }) => managementIdOf(claim.managementId, recorded.items?.[claimIdentity(claim.scope as 'project' | 'user', claim.managementId, root)]?.plan);
    for (const [key, owner] of Object.entries(recorded.members)) for (const claim of owner.displaced?.claims ?? []) {
      const entry = byId.get(`${claim.scope}\0${idOf(claim)}`);
      if (!entry) continue;
      const descriptor = owner.descriptor ?? { kind: 'file' as const, path: key };
      const pointer = memberPointer(descriptor);
      const path = join(root, descriptor.path);
      if (entry.members.some(member => member.state === 'displaced-by' && member.path === path && member.pointer === pointer)) continue;
      const plan = recorded.items?.[claimIdentity(claim.scope as 'project' | 'user', claim.managementId, root)]?.plan;
      entry.members.push({ kind: publicKind(descriptor), path, ...(pointer === undefined ? {} : { pointer }),
        ...(descriptor.kind === 'block' ? { blockId: descriptor.blockId } : {}), ...(plan ? { clis: plan.cli ? [plan.cli] : [...plan.clis] } : {}),
        state: 'displaced-by', displacedBy: [...new Set((owner.claims ?? []).map(idOf))].sort(codeUnitCompare) });
    }
  }
  for (const entry of entries) entry.members.sort((a, b) => (a.state === 'displaced-by' ? 1 : 0) - (b.state === 'displaced-by' ? 1 : 0) ||
    order(a.path, b.path) || order(a.pointer ?? null, b.pointer ?? null));
  for (const entry of entries) entry.claims?.sort((a, b) => order(a.project, b.project) || order(a.cli, b.cli));
  const inventory: Inventory = { schema: INVENTORY, status: 'ok', target: { project: located.project }, scope,
    observation: listed.status === 'complete' ? 'complete' : 'incomplete', entries };
  return deepFreezeStrictJsonV1(inventory as unknown as Json) as unknown as Inventory;
}

export async function prepareRemoval(request: unknown, controls: unknown = {}): Promise<RemovalResult> {
  forgetProvenState();
  if (!plain(request, ['target', 'scope', 'removals', 'mode', 'resolutions'])) return invalid('', 'request', 'A removal request is `{ target, scope, removals, mode?, resolutions? }`.');
  const located = place(request, ['project', 'user']);
  if ('status' in located) return located;
  const options = planControls(controls);
  if (!options) return invalid('', 'controls', 'The controls are not valid.');
  if (options.signal?.aborted) return { status: 'refused', code: 'cancelled', reason: 'Removal preparation was cancelled.' };
  // Enterprise (contract 11): the organization is read fresh now, and again at Apply.
  const enterprise = await enterpriseContext(request.mode, located.scope as 'project' | 'user', request.target as never, options);
  if (enterprise && 'status' in enterprise) return enterprise;
  const removals = request.removals;
  if (!Array.isArray(removals) || removals.length === 0 || removals.length > 4096) return invalid('/removals', 'removals', 'Name one or more removals.');
  // A second preparation's choices for one-item entries (section 7's resolve-and-prepare-again): `{ managementId, item, choice }`.
  const resolutions = request.resolutions ?? [];
  if (!Array.isArray(resolutions) || resolutions.length > 4096 || !resolutions.every(item => plain(item, ['managementId', 'item', 'choice']) &&
      typeof item.managementId === 'string' && ID.test(item.managementId) && typeof item.item === 'string' && ID.test(item.item) &&
      (REMOVAL_CHOICES as readonly unknown[]).includes(item.choice)))
    return invalid('/resolutions', 'resolutions', `Each resolution is \`{ managementId, item, choice }\` with a choice of ${REMOVAL_CHOICES.join(', ')}.`);
  const resolutionFor = (managementId: string, item: string) => (resolutions as RemovalResolution[]).find(entry => entry.managementId === managementId && entry.item === item);
  for (const [index, resolution] of (resolutions as RemovalResolution[]).entries())
    if (!removals.some(entry => plain(entry, ['managementId', 'item', 'origin', 'clis']) && entry.managementId === resolution.managementId && entry.item === resolution.item))
      return invalid(`/resolutions/${index}`, 'resolution-unknown', `No removal entry names \`${resolution.managementId}\` with item \`${resolution.item}\`.`);
  const scope = located.scope as 'project' | 'user';
  const home = projectRoot(homedir());
  const facts = planFacts([scope === 'project' ? located.anchor : home]);
  const keyed = keyedClaims([scope === 'project' ? located.anchor : home]);
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
    const resolution = typeof entry.item === 'string' ? resolutionFor(entry.managementId, entry.item) : undefined;
    if (resolution?.choice === 'switch-off') {
      // The item's switch-off (C45) is reviewed on its own: one entry, one marked block.
      if (entry.origin !== undefined || entry.clis !== undefined) return invalid(`/removals/${index}`, 'switch-off', 'A switch-off names only `{ managementId, item }`.');
      if (removals.length !== 1) return invalid('/removals', 'switch-off-alone', 'A switch-off is prepared on its own.');
      return switchOff(entry.managementId, resolution.item, located.scope as 'project' | 'user', located.anchor, options);
    }
    if (entry.item !== undefined && !resolution) {
      if (typeof entry.item !== 'string' || !ID.test(entry.item)) return invalid(`/removals/${index}/item`, 'item', 'An item is named by its id.');
      const found = itemInPlugin(entry.managementId, entry.item, located.scope as 'project' | 'user', located.anchor);
      if (!found) return invalid(`/removals/${index}/item`, 'item-removal-unavailable', 'Only an item inside a plugin is removed by item.');
      itemEntries.set(index, found); continue;
    }
    // With `remove-plugin` chosen for one item, the entry is the whole plugin's removal.
    // A user-scope change's claim has no CLI: it counts as unattributed for removal by CLI.
    const changeClaims = [...keyed].filter(([key, claim]) => key.startsWith(`${scope}\0`) && claim.managementId === entry.managementId)
      .map(([key, claim]) => ({ engineId: key.slice(scope.length + 1), plan: { managementId: claim.managementId, cli: null, project: claim.project } as PlanItemFacts }));
    const recorded = [...claimsOf(facts, scope, entry.managementId), ...changeClaims].filter(claim => sameProject(claim.plan, located.project));
    const clis = entry.clis as string[] | undefined;
    if (clis && recorded.some(claim => (claim.plan.cli ?? null) === null)) return { status: 'refused', code: 'client-attribution-missing',
      reason: `Removal by CLI is refused: the plan that installed \`${entry.managementId}\` recorded no CLIs for its members, so Core can't tell which CLI claims them. Remove it for every CLI, or install it again from a plan that records \`clis\`.` };
    const chosen = clis ? recorded.filter(claim => clis.includes(claim.plan.cli!)) : recorded;
    if (recorded.length && !chosen.length) { absentEntries.set(index, { managementId: entry.managementId, disposition: 'absent', members: [] }); continue; }
    // A receipt without plan facts (a change, an older install) keeps its own management id.
    selectors.push({ index, managementId: entry.managementId, engineIds: chosen.length ? chosen.map(claim => claim.engineId) : [internalManagementId(entry.managementId)] });
  }
  // Removing a whole plugin also removes the switch-offs of its items: nothing is left to switch off (C45).
  if (scope === 'user') for (const selector of [...selectors])
    for (const item of switchOffClaims(located.anchor, selector.managementId))
      if (!selectors.some(other => other.managementId === item)) selectors.push({ index: -1 - selectors.length, managementId: item, engineIds: [item] });
  const engineOwner = new Map(selectors.flatMap(selector => selector.engineIds.map(id => [id, selector.managementId] as const)));
  const merged = (engineEntries: RemovalEntry[]): RemovalEntry[] => {
    const byEngine = new Map(engineEntries.map(entry => [entry.managementId, entry]));
    return [...removals.keys(), ...selectors.filter(item => item.index < 0).map(item => item.index)].flatMap((index): RemovalEntry[] => {
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
  // Writing a displaced value back needs each secret it held again (C64): receipts never keep one.
  const released = new Set(selectors.flatMap(selector => selector.engineIds));
  const receipt = readOwnership(scope === 'project' ? located.anchor : home).value;
  for (const owner of Object.values(receipt.members)) {
    if (!owner.displaced || !owner.claims?.length || !owner.claims.every(claim => released.has(claim.managementId))) continue;
    if (owner.displaced.claims.every(claim => released.has(claim.managementId))) continue;
    for (const secret of owner.displaced.secrets ?? []) if (privateInputValue(options.privateInputs, secret.item, secret.input) === undefined)
      return { status: 'refused', code: 'input-missing', item: secret.item, input: secret.input,
        reason: `Removing this gives \`${secret.item}\` its value back, which holds the secret \`${secret.input}\`; Core never kept it. Pass it in ` +
          `\`controls.privateInputs\` (\`--private-input\`).` };
  }
  // `origin: chosen` removes the whole management id here: a plan install records exactly that one origin.
  // A repair (trust or session custody, contract 10) is removed on its own, by its repair id, through the retained
  // single-id removal that also releases that custody.
  const repairCustody = selectors.length === 1 && selectors[0]!.engineIds.length === 1 &&
    repairIndex.some(definition => definition.managementId === selectors[0]!.engineIds[0]) ? selectors[0]!.engineIds[0]! : undefined;
  const prepared = repairCustody !== undefined ? await (async () => {
    const one = await prepareRepairRemoval({ target: { project: located.anchor }, managementId: repairCustody, scope, mode: 'vibe' }, engineControls(options));
    return { disposition: one.disposition, preparation: one.preparation, diagnostics: one.diagnostics,
      removals: ['cancelled', 'invalid'].includes(one.disposition) ? [] : [{ managementId: repairCustody,
        disposition: one.disposition as Exclude<typeof one.disposition, 'cancelled' | 'invalid'>,
        members: [] as { kind: EngineRemovalMember['kind']; path: string; pointer?: string; action: EngineRemovalMember['action']; reason?: string; operationId?: string }[] }] };
  })() : await prepareManagedRemovals({ target: { project: located.anchor }, scope,
    removals: selectors.flatMap(({ engineIds }) => engineIds.map(managementId => ({ managementId }))) }, engineControls(options),
    { displacedInput: (item, input) => privateInputValue(options.privateInputs, item, input) });
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
  // Program steps (C30): a tool-command's saved restore command (filled with its prior value) and readback run here; the rest can't be undone, and say so.
  const commands = releasing.flatMap(entry => (facts.get(`${scope}\0${entry.managementId}`)?.programs ?? [])
    .map(program => ({ managementId: engineOwner.get(entry.managementId)!, program })));
  const program = plugins.length || commands.length ? await prepareProgramRemoval(plugins, scope, located.anchor, options, commands) : undefined;
  if (program && 'status' in program) return program;
  // Each review operation carries one listed member's action; its management id is that member's entry.
  const owners = new Map<string, string>();
  for (const entry of prepared.removals ?? []) for (const member of entry.members) if (member.operationId)
    owners.set(member.operationId, engineOwner.get(entry.managementId) ?? entry.managementId);
  const operations = new Map<string, StepRef>();
  const offset = program?.steps.length ?? 0;
  const steps: ReviewStep[] = [...program?.steps ?? [], ...engine.review.operations.map((operation, at) => {
    const index = offset + at;
    const managementId = owners.get(operation.id) ?? (repairCustody !== undefined ? selectors[0]!.managementId : '');
    operations.set(operation.id, { step: index, managementId });
    const target = operation.details.target ?? '';
    const effect: ReviewStep['effect'] = ['create-file', 'replace-file', 'remove-file', 'already-satisfied'].includes(operation.effects) ?
      operation.effects as ReviewStep['effect'] : operation.effects === 'conflict' ? 'conflict' : 'unchanged';
    const sentence = operation.details.reason === 'release-displaced' ? `Releases a displaced claim on \`${target}\`; the value there now stays` :
      effect === 'remove-file' ? `Removes \`${target}\`` : effect === 'replace-file' ? `Restores \`${target}\`` :
      effect === 'already-satisfied' ? `Releases \`${target}\`, already as it should be` : `Leaves \`${target}\` as it is`;
    return { step: index, op: 'remove', managementId, sentence, cantPromise: null, effect, path: target };
  })];
  // A change goes only where its entry permits removal; fulfilment is projected over the claims left (C71).
  const root = scope === 'project' ? located.anchor : home;
  const admission = enterprise ? (() => {
    const recorded = placeClaims(scope, located.project);
    const releasing = new Set(selectors.flatMap(selector => selector.engineIds));
    const denials = admitRemovals(enterprise.state.bound.organization, enterprise.target, recorded.filter(claim => releasing.has(claim.key)));
    const results = obligations(enterprise.state.bound.organization, enterprise.target, [], projected(recorded, releasing, []));
    return { denials, review: organizationReview(enterprise.state.bound, enterprise.target, denials, results) };
  })() : undefined;
  // A Windows repair's setx values stay: Core can't undo them, and the review says which (contract 10).
  const kept = repairCustody !== undefined && process.platform === 'win32' ? windowsUserEnvironmentKept(Object.values(receipt.members).flatMap(owner =>
    owner.descriptor?.kind === 'block' && (owner.managementId === repairCustody || owner.claims?.some(claim => claim.managementId === repairCustody)) ?
      [owner.descriptor.blockId] : [])) : [];
  const warnings = kept.length ? [`user-environment-kept: Core can't undo the Windows user environment values this repair set with setx ` +
    `(${kept.join(', ')}); removal leaves them as they are. Clear them yourself if you no longer want them.`] : [];
  const body: Omit<Review, 'reviewDigest'> = { schema: REVIEW, request: 'removal', scope, target: { project: located.project }, steps,
    conflicts: [], failureRule: FAILURE_RULE, warnings, ...(admission ? { organization: admission.review } : {}) };
  const reviewDigest = digestOf(body, engine.review.reviewDigest + (program ? '\0' + program.engineDigest : ''));
  const review = deepFreezeStrictJsonV1({ ...body, reviewDigest } as unknown as Json) as unknown as Review;
  // An organization denial blocks the whole removal: no handle, every prepared entry blocked (contract 11).
  if (admission?.denials.length) return { status: 'ok', entries: entries.map(entry => entry.disposition === 'prepared' ? { ...entry, status: 'blocked' as const } : entry),
    review, code: 'AUTHORITY_DENIED', reason: denialReason(admission.denials) };
  const partial = engine.status === 'partial';
  // Private inputs passed for a removal (such as a secret a restored value needs again, C64) bind its review.
  const handle = register({ engine: engine.prepared, engineDigest: engine.review.reviewDigest, enginePartial: partial, reviewDigest, partial, operations,
    claims: engineOwner, ...(links.length ? { links } : {}),
    privateInputs: bindPrivateInputs(options.privateInputs),
    ...(enterprise ? { enterprise: { ...enterprise.state, root, project: located.project } } : {}),
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
  const claims = claimsOf(facts, scope, managementId);
  const claim = claims.find(entry => entry.plan.plugins || entry.plan.localPlugin) ?? claims[0];
  const plan = claim?.plan;
  if (!plan) return { managementId, item, disposition: 'absent', members: [] };
  const whole = { managementId, item, disposition: 'unavailable' as const, reason: 'plugin-indivisible', members: [] };
  if (plan.localPlugin) {
    // Without the route's contained-item metadata Core can't say what the plugin holds; it lists its files (C68).
    if (plan.localPlugin.contains === null) {
      const row = readOwnership(root).value.items?.[claimIdentity(scope, claim!.engineId, anchor)];
      return { ...whole, files: pluginFiles((row?.members ?? []).map(member => ({ kind: member.kind, path: 'path' in member ? member.path : '' })), root),
        offers: [{ managementId }], choices: ['remove-plugin'] };
    }
    if (!plan.localPlugin.contains.includes(item)) return { managementId, item, disposition: 'absent', members: [] };
    return { ...whole, contains: [...plan.localPlugin.contains], offers: [{ managementId }], choices: ['remove-plugin'] };
  }
  if (!plan.plugins) return undefined;
  const holding = plan.plugins.filter(plugin => plugin.contains.includes(item));
  if (!holding.length) return { managementId, item, disposition: 'absent', members: [] };
  // Where the CLI can switch the one item off, that is a choice for this entry; once it is off, its own removal is offered.
  const offers: NonNullable<RemovalEntry['offers']> = [{ managementId }];
  const choices: NonNullable<RemovalEntry['choices']> = ['remove-plugin'];
  if (switchable(holding, item)) { if (switchedOff(facts, scope, managementId, item)) offers.push({ managementId: switchOffId(managementId, item) }); else choices.push('switch-off'); }
  return { ...whole, contains: [...new Set(holding.flatMap(plugin => plugin.contains))].sort(), offers, choices };
}
/** The `switch-off` resolution for `{ managementId, item }`: `absent` when the install doesn't record the item, else its reviewed switch-off. */
async function switchOff(framework: string, item: string, scope: 'project' | 'user', anchor: string, controls: PlanControls): Promise<RemovalResult> {
  const root = scope === 'project' ? anchor : projectRoot(homedir());
  const claims = claimsOf(planFacts([root]), scope, framework);
  const plan = claims.find(claim => claim.plan.plugins || claim.plan.localPlugin)?.plan ?? claims[0]?.plan;
  const absent: RemovalResult = { status: 'ok', entries: [{ managementId: framework, item, disposition: 'absent', members: [] }] };
  if (!plan) return absent;
  const holding = [...(plan.plugins ?? []).filter(plugin => plugin.contains.includes(item)), ...(plan.localPlugin?.contains?.includes(item) ? [null] : [])];
  if (!holding.length && plan.localPlugin?.contains !== null) return absent;
  return prepareSwitchOff(framework, item, switchable(plan.plugins ?? [], item), plan, controls);
}
/** The plugin step that lets this one item be switched off: a plugin of a CLI with a switch-off route (Codex) naming the item's skill (C45, C69). */
export function switchable(plugins: PluginFacts[], item: string): PluginFacts | undefined {
  return plugins.find(plugin => !!switchOffRoute(plugin.cli) && plugin.contains.includes(item) && typeof plugin.skills?.[item] === 'string');
}
/** Whether a switch-off claim for this item of this framework is recorded here. */
const switchedOff = (facts: Map<string, PlanItemFacts>, scope: string, framework: string, item: string): boolean =>
  facts.get(`${scope}\0${switchOffId(framework, item)}`)?.switchOff?.framework === framework;

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
      operations.set(operationKey(selectionId, id), { step: index, managementId, program: true });
      return { id, purpose: `Runs \`${argv.join(' ')}\``, kind: 'process.run', scope, executable: { name: argv[0]! },
        args: argv.slice(1).map(literal => ({ literal })), cwd, env: {}, acceptedExitCodes: [0],
        effects: [`The ${plugin.cli} CLI's own plugin removal; Core can't show its effects`], requires: at ? [`remove-${at - 1}`] : [], checks: [] };
    });
    // Its own engine management id: one framework's plugin on several CLIs (Claude Code and Codex) is one removal each.
    selections.push({ id: selectionId, managementId: `aih-plugin-removal-${index}`, scope, configuration: {}, requires: [], recipe: { inline: {
      schema: 'urn:aihq:core:recipe:1.0.0', id: 'plugin-removal', description: 'Removes a native plugin', inputs: {}, materials: [],
      targets: [scope], prerequisites: [], operations: ops, checks: [] } } });
  });
  // A tool-command's restore runs the acquired program it was installed with, in the folder and with the environment the
  // install ran it with (a secret given again, C64), before the AI setup folder goes.
  const home = projectRoot(homedir());
  const offset = plugins.length;
  const enginePrivate: Record<string, Record<string, string>> = {};
  const environments = new Map<number, Record<string, string>>();
  for (const [at, { managementId, program }] of commands.entries()) {
    const index = offset + at;
    if (!program.undo || !program.executable) { unremovable.push({ step: index, managementId, command: true }); continue; }
    const selectionId = `c${index}`;
    const env: Record<string, { literal: string } | { input: string }> = {}; const values: Record<string, string> = {}; const actual: Record<string, string> = {};
    for (const entry of program.env ?? []) {
      if ('value' in entry) { env[entry.name] = { literal: entry.value }; actual[entry.name] = entry.value; continue; }
      const value = privateInputValue(controls.privateInputs, entry.input.item, entry.input.input);
      if (value === undefined) return { status: 'refused', code: 'input-missing', item: entry.input.item, input: entry.input.input,
        reason: `Removing \`${managementId}\` runs its restore with the secret \`${entry.input.input}\` it was installed with; Core never kept it. ` +
          'Pass it in `controls.privateInputs` (`--private-input`).' };
      const id = `secret-${Object.keys(values).length}`;
      values[id] = value; env[entry.name] = { input: id }; actual[entry.name] = value;
    }
    if (Object.keys(values).length) enginePrivate[selectionId] = values;
    environments.set(index, actual);
    operations.set(operationKey(selectionId, 'restore'), { step: index, managementId, command: true });
    // Its own engine management id: running the restore must not rewrite the AI setup's claim before its release.
    selections.push({ id: selectionId, managementId: `aih-restore-${index}`, scope: 'user', configuration: {}, requires: [], recipe: { inline: {
      schema: 'urn:aihq:core:recipe:1.0.0', id: 'command-restore', description: 'Restores the value a tool command changed',
      inputs: Object.fromEntries(Object.keys(values).map(id => [id, { type: 'string' as const, required: false, sensitive: true }])), materials: [],
      targets: ['user'], prerequisites: [], checks: [], operations: [{ id: 'restore', purpose: `Runs \`${program.undo.argv.join(' ')}\``, kind: 'process.run',
        scope: 'user', executable: { name: join(home, ...program.executable.split('/')) }, args: program.undo.argv.map(literal => ({ literal })),
        cwd: { root: 'userHome', segments: (program.cwd ?? '').split('/').filter(Boolean).map(literal => ({ literal })) }, env, acceptedExitCodes: [0],
        effects: ['The tool\'s own command, given the value read before install; Core can\'t show its effects'],
        requires: [], checks: [] }] } } });
  }
  const steps: ReviewStep[] = [];
  let engine: Awaited<ReturnType<typeof prepareEngine>> | undefined;
  if (selections.length) {
    engine = await prepareEngine({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections },
      target: { project: anchor } }, { ...engineControls(controls), ...(Object.keys(enginePrivate).length ? { privateInputs: enginePrivate } : {}) }, undefined, undefined, undefined, undefined, undefined, undefined, { commandShims: true });
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
      const executable = resolveProgram(plugin.presenceCheck.argv[0]!);
      if (!executable) return { status: 'refused', code: 'program-unavailable',
        reason: `The presence check of \`${managementId}\` runs \`${plugin.presenceCheck.argv[0]}\`, which this host cannot run.` };
      if (!argumentsRunnable(executable, plugin.presenceCheck.argv.slice(1))) return shimRefusal(index, plugin.presenceCheck.argv);
      presence = { ...plugin.presenceCheck, executable: executable.launchPath, executableSha256: executable.sha256,
        ...(executable.launcher ? { launcher: launcherReview(executable.launcher) } : {}) };
      programs.set(index, { executable, argv: plugin.presenceCheck.argv, expect: plugin.presenceCheck.expect, cwd: anchor });
    }
    const commands = (plugin.undo ?? []).map((argv, at) => pinnedCommand(argv, pinned.get(index)![at]!));
    const unrunnable = commands.findIndex(command => command === undefined);
    if (unrunnable >= 0) return shimRefusal(index, plugin.undo![unrunnable]!);
    steps.push({ step: index, op: 'plugin', managementId, framework: managementId, cli: plugin.cli, clis: [plugin.cli], plugin: plugin.plugin,
      commit: plugin.commit, contains: [...plugin.contains], effect: plugin.undo ? 'run-program' : 'unchanged', commands: commands as ReviewCommand[], undo: plugin.undo,
      presenceCheck: presence,
      sentence: plugin.undo ? `Runs \`${plugin.undo.map(argv => argv.join(' ')).join('`, then `')}\`` :
        `Releases the receipt of \`${plugin.plugin}\`; Core has no removal command for it`,
      cantPromise: plugin.undo ? 'Core can\'t show or roll back what the CLI\'s own removal changes. ' +
        (presence === 'none' ? 'The receipt has no presence check, so the removal stays unverified.' : 'Core checks only that the plugin is no longer listed.') :
        'The plugin stays installed in the CLI; remove it there yourself.' });
  }
  for (const [at, { managementId, program }] of commands.entries()) {
    const index = offset + at;
    const pinned = pinnedRestore(engine, index, operations);
    const reversible = !!(program.undo && program.executable && pinned);
    // The folder the command ran in, as its receipt records it (the home for an earlier receipt that records none).
    const cwd = join(program.root === 'project' ? anchor : home, ...(program.cwd ?? '').split('/').filter(Boolean));
    if (reversible) programs.set(index, { executable: pinned!.resolved, argv: [pinned!.resolved.launchPath, ...program.undo!.readback.argv],
      expect: program.undo!.readback.expected, cwd, readback: true, env: environments.get(index) ?? {} });
    const command = program.argv.join(' ');
    steps.push({ step: index, op: program.op, managementId, item: managementId, effect: reversible ? 'run-program' : 'unchanged',
      sentence: reversible ? `Runs \`${program.undo!.argv.join(' ')}\`, then checks that \`${program.undo!.readback.argv.join(' ')}\` reads \`${program.undo!.readback.expected}\`` :
        program.op === 'upstream-setup' ? `Removes the clone \`${program.clone?.into ?? ''}\` with the install` : `Releases the record of \`${command}\``,
      cantPromise: reversible ? 'Core can\'t show or roll back what the restore command changes; it checks only that the readback shows the prior value again.' :
        program.op === 'tool-command' ? `Core can't undo \`${command}\`: the receipt holds no restore command with the value read before it.` :
        program.op === 'upstream-installer' ? `Core can't remove what \`${command}\` installed: it is not managed by Core. Remove it with the tool's own uninstaller.` :
        `Core removes only its clone; it can't remove what \`${command}\` wrote elsewhere.`,
      program: { kind: program.op, argv: reversible ? program.undo!.argv : program.argv,
        executable: reversible ? pinned!.resolved.launchPath : program.executable ? join(home, ...program.executable.split('/')) : program.argv[0]!,
        executableSha256: reversible ? pinned!.resolved.sha256 : null, from: program.executable ? 'acquired' : 'path', cwd,
        env: (program.env ?? []).map(entry => ({ name: entry.name, value: 'value' in entry ? entry.value : '[REDACTED]' })), managed: program.managed,
        readback: reversible ? program.undo!.readback : null, undo: program.undo, cantRemove: reversible ? 'Nothing else the command changed is rolled back.' :
          program.op === 'upstream-setup' ? 'What the setup command wrote outside its clone stays.' : 'What the command changed stays.' } });
  }
  return { steps, engine: engine?.prepared, engineDigest: engine?.review?.reviewDigest ?? '', operations, programs, unremovable };
}
/** The restore command's executable as the removal's engine pinned it. */
function pinnedRestore(engine: Awaited<ReturnType<typeof prepareEngine>> | undefined, index: number, operations: Map<string, StepRef>):
    { resolved: NonNullable<ReturnType<typeof resolveProgram>> } | undefined {
  const operation = engine?.review?.operations.find(entry => operations.get(entry.id)?.step === index && operations.get(entry.id)?.command);
  if (!operation || typeof operation.details.executable !== 'string') return undefined;
  const resolved = resolveProgram(operation.details.executable);
  return resolved && resolved.sha256 === operation.details.executableSha256 ? { resolved } : undefined;
}
interface ProgramRemoval {
  steps: ReviewStep[]; engine: PreparedHandle | undefined; engineDigest: string; operations: Map<string, StepRef>;
  programs: Map<number, ProgramCheck>; unremovable: StepRef[];
}
