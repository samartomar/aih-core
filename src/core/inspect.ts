// `inspect` 0.1.0 (contract 3, 6, 10, 14.1, C73, D110): the retained machine inspection, presented as
// `urn:aihq:core:inspection:0.1.0`, plus the old-CLI warning. Optional Catalog tool profiles are read only for `id`,
// `version` and `checkedWith`; a CLI older than the version its profile was checked with is a warning, never a gate.
// A tool with no profile says "version not compared". Nothing is installed, written or refused because of a version.
import { isProxy } from 'node:util/types';
import { findTool, toolRegistry } from '../harness/tool-registry.mjs';
import { inspectRetained, type InspectControls, type InspectRequest, type InspectResult, type ToolVersion } from './inspection.js';
import type { Problem } from './plan/types.js';
import type { Json } from './types.js';

export const INSPECTION = 'urn:aihq:core:inspection:0.1.0' as const;

/** What `inspect` 0.1.0 takes. `target` names Harness inspection targets or registry tools (ids or aliases). */
export interface Inspect0Request {
  target?: string | string[];
  /** No network probes: only local version commands and file facts. */
  offline?: boolean;
  /** Catalog tool profile documents; only `id`, `version` and `checkedWith` are read. */
  profiles?: unknown[];
  /** The project whose configured MCP servers are probed when `probeConfiguredMcp` is set (retained). */
  project?: string;
}
export interface CheckedWith { app: string; version: string }
export interface VersionComparison {
  /** Registry id (surface cli). */
  tool: string;
  installed: string | null;
  comparison: 'older' | 'not-older' | 'not-compared';
  /** Why the version was not compared: `no-profile`, `not-installed`, `not-inspected`, `version-unknown`, `version-unparsed`, `checked-app-unmatched`. */
  reason?: string;
  profile?: { id: string; version: string | number };
  checkedWith?: CheckedWith;
  message: string;
}
export interface InspectionWarning { code: 'cli-older-than-profile'; tool: string; installed: string; checkedWith: CheckedWith;
  profile: { id: string; version: string | number }; message: string }
export interface InspectionTool { target: string; tool: string | null; label: string; state: string; selection: string; config?: string; version?: string | null }
export interface Inspection {
  schema: typeof INSPECTION; subject: 'machine'; status: 'ok'; observation: 'complete' | 'incomplete' | 'cancelled';
  package: { name: string; version: string };
  options: { target: string[] | 'detected'; offline: boolean; profiles: number };
  tools: InspectionTool[];
  versions: VersionComparison[];
  warnings: InspectionWarning[];
  observations: InspectResult['observations'];
  checks: InspectResult['checks'];
  repairChoices: Json[];
  diagnostics: { code: string; reason: string; message: string }[];
  followUp: string[];
  limits: InspectResult['limits'];
}
export type InspectionResult = Inspection | { status: 'invalid'; problems: Problem[] } |
  { status: 'refused'; code: string; reason: string };

// Harness inspection targets that are registry tools under another id (the Harness `targets` keep their own ids).
const TARGET_OF: Readonly<Record<string, string>> = Object.freeze({ 'claude-code': 'claude', 'cursor-ide': 'cursor' });
/** The registry tool a Harness target's version command reached; `cursor` is the IDE or the CLI by its command. */
function registryTool(target: string, binary?: string): string | null {
  if (target === 'claude') return 'claude-code';
  if (target === 'cursor') return binary === undefined ? null : binary === 'cursor' ? 'cursor-ide' : 'cursor';
  return findTool(target)?.via === 'id' ? target : null;
}

const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' &&
  !Array.isArray(value) && !isProxy(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEXT = /^[^\u0000-\u001f]{1,64}$/;

interface Profile { id: string; version: string | number; checkedWith: CheckedWith[] }
function readProfiles(value: unknown): { profiles: Profile[] } | { problems: Problem[] } {
  if (value === undefined) return { profiles: [] };
  if (!Array.isArray(value) || value.length > 256) return { problems: [{ path: '/profiles', reason: 'type', message: 'Profiles are an array of at most 256 Catalog tool profile documents.' }] };
  const problems: Problem[] = [];
  const profiles: Profile[] = [];
  const seen = new Set<string>();
  value.forEach((profile, index) => {
    const at = `/profiles/${index}`;
    const bad = (path: string, reason: string, message: string) => { problems.push({ path: `${at}${path}`, reason, message }); };
    if (!plainObject(profile)) return bad('', 'type', 'A tool profile is an object.');
    const { id, version, checkedWith } = profile;
    if (typeof id !== 'string' || !TOKEN.test(id)) return bad('/id', 'id', 'A tool profile names its tool id.');
    const tool = findTool(id);
    if (!tool || tool.via !== 'id' || tool.tool.surface !== 'cli') return bad('/id', 'tool-unknown', `\`${id}\` is not a registry CLI id.`);
    if (seen.has(id)) return bad('/id', 'duplicate-profile', `More than one profile names \`${id}\`.`);
    seen.add(id);
    if (!(typeof version === 'string' && TEXT.test(version) || Number.isSafeInteger(version) && (version as number) >= 0))
      return bad('/version', 'version', 'A tool profile has a version.');
    if (!Array.isArray(checkedWith) || checkedWith.length < 1 || checkedWith.length > 16)
      return bad('/checkedWith', 'checkedWith', 'A tool profile lists the app versions its facts were checked with.');
    const entries: CheckedWith[] = [];
    for (const [position, entry] of checkedWith.entries()) {
      if (!plainObject(entry) || typeof entry.app !== 'string' || !TEXT.test(entry.app) || typeof entry.version !== 'string' || !TEXT.test(entry.version))
        return bad(`/checkedWith/${position}`, 'checkedWith', 'Each checkedWith entry names an app and the version it was checked with.');
      entries.push({ app: entry.app, version: entry.version });
    }
    profiles.push({ id, version: version as string | number, checkedWith: entries });
  });
  return problems.length ? { problems } : { profiles };
}

type Parsed = { numbers: number[]; pre: string[] };
const parse = (text: string): Parsed | undefined => {
  const match = /^v?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.]{1,64}))?$/.exec(text.trim());
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)], pre: match[4] ? match[4].split('.') : [] } : undefined;
};
/** Semantic-version order; prerelease identifiers sort before the release. */
function older(installed: Parsed, checked: Parsed): boolean {
  for (let index = 0; index < 3; index++) if (installed.numbers[index] !== checked.numbers[index]) return installed.numbers[index]! < checked.numbers[index]!;
  if (!installed.pre.length || !checked.pre.length) return installed.pre.length > 0 && checked.pre.length === 0;
  for (let index = 0; index < Math.max(installed.pre.length, checked.pre.length); index++) {
    const a = installed.pre[index], b = checked.pre[index];
    if (a === undefined) return true;
    if (b === undefined) return false;
    if (a === b) continue;
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b);
    return numeric ? Number(a) < Number(b) : /^\d+$/.test(a) ? true : /^\d+$/.test(b) ? false : a < b;
  }
  return false;
}
const notCompared = (tool: string, installed: string | null, reason: string, detail: string, profile?: Profile): VersionComparison => ({
  tool, installed, comparison: 'not-compared', reason, ...(profile ? { profile: { id: profile.id, version: profile.version } } : {}),
  message: `Version not compared: ${detail}` });

function compare(tool: string, installed: { version: string | null; binary: string } | undefined, state: string | undefined, profile: Profile | undefined): VersionComparison {
  const version = installed?.version ?? null;
  if (!profile) return notCompared(tool, version, 'no-profile', 'no Catalog profile was supplied for this tool.');
  if (state === undefined) return notCompared(tool, null, 'not-inspected', 'this tool was not inspected.', profile);
  if (!installed) return notCompared(tool, null, state === 'absent' || state === 'config-only' ? 'not-installed' : 'version-unknown',
    state === 'absent' || state === 'config-only' ? 'no runnable command was found.' : 'its version command did not succeed.', profile);
  if (version === null) return notCompared(tool, null, 'version-unknown', 'its version command printed no version.', profile);
  const entry = registryEntry(tool);
  const names = new Set([tool, installed.binary, ...entry.binaries, ...entry.aliases, ...entry.binaries.map(binary => `${binary}-cli`)]);
  const matching = profile.checkedWith.filter(item => names.has(item.app));
  const checked = matching.length === 1 ? matching[0] : matching.length === 0 && profile.checkedWith.length === 1 ? profile.checkedWith[0] : undefined;
  if (!checked) return notCompared(tool, version, 'checked-app-unmatched', 'the profile does not say which of its apps is this command.', profile);
  const a = parse(version), b = parse(checked.version);
  if (!a || !b) return { ...notCompared(tool, version, 'version-unparsed', 'one of the versions is not a dotted version.', profile), checkedWith: checked };
  const isOlder = older(a, b);
  return { tool, installed: version, comparison: isOlder ? 'older' : 'not-older', profile: { id: profile.id, version: profile.version }, checkedWith: checked,
    message: isOlder ? `${entry.label} ${version} is older than ${checked.version}, which its profile was checked with; it may still work.` :
      `${entry.label} ${version} is not older than ${checked.version}, which its profile was checked with.` };
}
const registryEntry = (id: string) => toolRegistry.tools.find(item => item.id === id)!;

export async function inspectMachine(request: unknown, rawControls?: unknown): Promise<InspectionResult> {
  const invalid = (path: string, reason: string, message: string): InspectionResult => ({ status: 'invalid', problems: [{ path, reason, message }] });
  if (request === undefined) request = {};
  if (!plainObject(request) || Object.keys(request).some(key => !['target', 'offline', 'profiles', 'project'].includes(key)))
    return invalid('', 'request-field', 'Use { target?, offline?, profiles? }.');
  const { target, offline, profiles: suppliedProfiles, project } = request as Inspect0Request;
  if (offline !== undefined && typeof offline !== 'boolean') return invalid('/offline', 'type', '`offline` is true or false.');
  const names = target === undefined ? undefined : typeof target === 'string' ? [target] : target;
  if (names !== undefined && (!Array.isArray(names) || names.length < 1 || names.length > 64 || names.some(name => typeof name !== 'string')))
    return invalid('/target', 'type', '`target` names one or more inspection targets or registry tools.');
  const read = readProfiles(suppliedProfiles);
  if ('problems' in read) return { status: 'invalid', problems: read.problems };
  const targets = names?.map(name => {
    const found = findTool(name);
    return found ? TARGET_OF[found.tool.id] ?? found.tool.id : name;
  });
  const controls = (rawControls ?? {}) as InspectControls;
  let found: ToolVersion[] = [];
  const retained = await inspectRetained({ ...(targets ? { targets: [...new Set(targets)] } : {}), network: offline ? 'off' : 'declared',
    ...(project !== undefined ? { project } : {}) }, controls, list => { found = list; });
  if (retained.status === 'invalid') {
    const reason = retained.diagnostics[0]?.reason ?? 'request';
    const path = reason === 'target' ? '/target' : reason === 'project' ? '/project' : '';
    return { status: 'invalid', problems: retained.diagnostics.map(item => ({ path, reason: item.reason, message: item.message })) };
  }
  const byTarget = new Map(found.map(item => [item.target, item]));
  const tools: InspectionTool[] = retained.tools.map(entry => {
    const ran = byTarget.get(entry.id);
    return { target: entry.id, tool: registryTool(entry.id, ran?.binary), label: entry.label, state: entry.state, selection: entry.selection,
      ...(entry.config !== undefined ? { config: entry.config } : {}), ...(ran ? { version: ran.version } : {}) };
  });
  // One comparison per registry CLI that was inspected (selected), or that a profile names.
  const inspected = new Map<string, { state: string; installed?: { version: string | null; binary: string } }>();
  for (const entry of tools) {
    if (entry.selection === 'unselected') continue;
    const candidates = entry.tool ? [entry.tool] : entry.target === 'cursor' ? ['cursor'] : [];
    for (const id of candidates) {
      if (registryEntry(id).surface !== 'cli') continue;
      const ran = byTarget.get(entry.target);
      inspected.set(id, { state: entry.state, ...(ran ? { installed: { version: ran.version, binary: ran.binary } } : {}) });
    }
  }
  const profileOf = new Map(read.profiles.map(profile => [profile.id, profile]));
  const ids = toolRegistry.tools.filter(entry => entry.surface === 'cli' && (inspected.has(entry.id) || profileOf.has(entry.id))).map(entry => entry.id);
  const versions = ids.map(id => compare(id, inspected.get(id)?.installed, inspected.get(id)?.state, profileOf.get(id)));
  const warnings: InspectionWarning[] = versions.filter(item => item.comparison === 'older').map(item => ({
    code: 'cli-older-than-profile', tool: item.tool, installed: item.installed!, checkedWith: item.checkedWith!, profile: item.profile!, message: item.message }));
  return { schema: INSPECTION, subject: 'machine', status: 'ok',
    observation: retained.status === 'complete' ? 'complete' : retained.status === 'cancelled' ? 'cancelled' : 'incomplete',
    package: retained.package, options: { target: names ? [...names] : 'detected', offline: offline === true, profiles: read.profiles.length },
    tools, versions, warnings, observations: retained.observations, checks: retained.checks, repairChoices: retained.repairChoices as Json[],
    diagnostics: retained.diagnostics.map(({ code, reason, message }) => ({ code, reason, message })), followUp: retained.followUp, limits: retained.limits };
}

/**
 * The review's old-CLI warning (D110): for each CLI the plan serves, the version its own version command prints (local
 * only, no network) against the served profile's `checkedWith`. Returns undefined when no served profile carries a
 * `checkedWith` list, so nothing is run. An older CLI is a warning, never a stop; a CLI whose profile has no list
 * says "version not compared".
 */
export async function reviewVersions(profiles: unknown[], clis: readonly string[], signal?: AbortSignal):
    Promise<{ versions: VersionComparison[]; warnings: string[] } | undefined> {
  const read = new Map<string, Profile>();
  for (const profile of profiles) {
    if (!plainObject(profile) || typeof profile.id !== 'string' || !clis.includes(profile.id) || !Array.isArray(profile.checkedWith)) continue;
    const one = readProfiles([profile]);
    if ('profiles' in one && one.profiles[0]) read.set(profile.id, one.profiles[0]);
  }
  if (!read.size) return undefined;
  const ids = [...new Set(clis)].filter(id => findTool(id)?.via === 'id').sort();
  const targets = [...new Set(ids.map(id => TARGET_OF[id] ?? id))].filter(id => id !== 'dsh');
  let found: ToolVersion[] = [];
  const retained = targets.length ? await inspectRetained({ targets, network: 'off' }, signal ? { signal } : {}, list => { found = list; }) : { tools: [] };
  const byTarget = new Map(found.map(item => [item.target, item]));
  const states = new Map(retained.tools.map(tool => [tool.id, tool.state]));
  const versions = ids.map(id => {
    const target = TARGET_OF[id] ?? id;
    const ran = byTarget.get(target);
    const reached = ran && registryTool(target, ran.binary);
    const installed = ran && reached === id ? { version: ran.version, binary: ran.binary } : undefined;
    return compare(id, installed, states.get(target) ?? (target === 'dsh' ? undefined : 'absent'), read.get(id));
  });
  return { versions, warnings: versions.filter(item => item.comparison === 'older').map(item => item.message) };
}
