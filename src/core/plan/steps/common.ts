// Checks every placement step shares: what it belongs to, where it lands, and which CLIs it serves.
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectRoot, sha256 } from '../../internal/host-files.js';
import { readRegularFile } from '../../internal/fsxn.js';
import { readOwnership } from '../../internal/state.js';
import { stateLocation } from '../../state-location.js';
import { knownCli } from '../tools.js';
import { ACQUIRED_MARKER_PREFIX, ACQUIRING, AI_SETUP_ROOT, MANIFEST } from '../acquire/types.js';
import { TREE_MANIFEST } from '../acquire/effect.js';
import type { PlanStep, Problem, Refusal } from '../types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const refusal = (code: string, reason: string, step: number, extra: Partial<Refusal> = {}): { refusal: Refusal } =>
  ({ refusal: { status: 'refused', code, reason, step, ...extra } });
export const problem = (index: number, field: string, reason: string, message: string): { problem: Problem } =>
  ({ problem: { path: `/plan/plan/${index}${field ? '/' + field : ''}`, reason, message } });

/**
 * The management ids a placement step belongs to (D108, C48): its `item`, or each of its shared `items`, or the one
 * indivisible `framework` a local-plugin route belongs to (C68). A route step may carry `route: "local-plugin"` and, on
 * the route's first step, the sorted ids of the items it `contains` (Catalog D120).
 */
export function owners(step: PlanStep, index: number): { ids: string[]; review: { item?: string; items?: string[]; framework?: string;
    route?: 'local-plugin'; contains?: string[] } } | { problem: Problem } {
  if (step.framework !== undefined) {
    const { framework, route, contains } = step;
    if (typeof framework !== 'string' || !ID.test(framework) || step.item !== undefined || step.items !== undefined)
      return problem(index, 'framework', 'owner', 'A framework step names only its `framework`, never an `item` as well.');
    if (route !== undefined && route !== 'local-plugin') return problem(index, 'route', 'route', 'A lowered route is `local-plugin`.');
    if (contains !== undefined && !(Array.isArray(contains) && contains.length <= 4096 &&
        contains.every((id, at) => typeof id === 'string' && ID.test(id) && (at === 0 || (contains[at - 1] as string) < id))))
      return problem(index, 'contains', 'contains', 'A route\'s `contains` lists sorted, unique item ids.');
    return { ids: [framework], review: { framework, ...(route ? { route } : {}), ...(contains ? { contains: [...contains as string[]] } : {}) } };
  }
  if (typeof step.item === 'string' && ID.test(step.item) && step.items === undefined) return { ids: [step.item], review: { item: step.item } };
  if (step.item === undefined && Array.isArray(step.items) && step.items.length > 0 && step.items.every(id => typeof id === 'string' && ID.test(id)) &&
      new Set(step.items).size === step.items.length) return { ids: [...step.items as string[]].sort(), review: { items: [...step.items as string[]] } };
  return problem(index, 'item', 'owner', 'A placement step names exactly one `item` or a non-empty list of `items`.');
}

const foldName = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
/** No segment of `relative` under `root` is a link or junction (or anything but a folder, for all but the last). */
function realFolders(root: string, relative: string): boolean {
  let current = root;
  for (const segment of relative.split('/')) {
    current = join(current, segment);
    try { if (!lstatSync(current).isDirectory()) return false; } catch { return false; }
  }
  return true;
}
/**
 * The receipt record of the acquisition of the AI setup folder (`.aihq/ai-setup/<name>/<version>/<cell>/`) a user-root
 * path lies in: a user-scope plan receipt that holds the folder's marker file as a member (for `aiSetup`, a receipt of
 * that AI setup), with the marker there now a regular file, reached through real folders only, holding the recorded
 * bytes. A marker file alone, which any writer could make, is never proof. A later run of the same claim with no acquire
 * step keeps the record (the member stays on the receipt).
 */
function acquisitionOf(path: string, aiSetup?: string): { folder: string; tree: string | undefined } | undefined {
  const folder = /^(\.aihq\/ai-setup\/[^/]+\/[^/]+\/[^/]+)\//.exec(path)?.[1];
  if (!folder) return undefined;
  try {
    const home = projectRoot(homedir());
    if (!realFolders(home, folder)) return undefined;
    const markerPath = `${folder}/${MANIFEST}`;
    const bytes = readRegularFile(join(home, ...markerPath.split('/')), { maxBytes: 64 * 1024 });
    if (!bytes || !bytes.toString('utf8').startsWith(ACQUIRED_MARKER_PREFIX)) return undefined;
    const digest = sha256(bytes);
    const holder = Object.values(readOwnership(home).value.items ?? {}).find(item => item.scope === 'user' && !!item.plan &&
      (aiSetup === undefined || (item.plan.managementId ?? item.managementId) === aiSetup) &&
      item.members.some(member => member.kind === 'file' && foldName(member.path) === foldName(markerPath) && member.sha256 === digest));
    return holder ? { folder, tree: holder.plan?.aiSetup?.tree } : undefined;
  } catch { return undefined; }
}
/** Whether a user-root path lies inside an AI setup folder Core acquired (see `acquisitionOf`). */
export const acquiredByCore = (path: string, aiSetup?: string): boolean => acquisitionOf(path, aiSetup) !== undefined;
/**
 * A program an earlier acquisition placed, checked before a tool-command runs it: its folder's tree manifest
 * (`.aih-tree.json`) must have the sha256 the receipt recorded, and the program the bytes that manifest records.
 * `unplaced` when no acquisition of `aiSetup` holds the folder, `changed` when the manifest or the program differs.
 */
export function acquiredProgram(path: string, aiSetup: string): { status: 'ok'; sha256: string; tree: string } | { status: 'unplaced' | 'changed' } {
  const found = acquisitionOf(path, aiSetup);
  if (!found) return { status: 'unplaced' };
  if (!found.tree) return { status: 'changed' };
  try {
    const home = projectRoot(homedir());
    const manifest = readRegularFile(join(home, ...found.folder.split('/'), TREE_MANIFEST), { maxBytes: 64 * 1_048_576 });
    if (!manifest || sha256(manifest) !== found.tree) return { status: 'changed' };
    const entries = (JSON.parse(manifest.toString('utf8')) as { entries?: { path?: unknown; sha256?: unknown }[] }).entries ?? [];
    const relative = path.slice(found.folder.length + 1);
    const entry = entries.find(candidate => candidate.path === relative && typeof candidate.sha256 === 'string');
    const parent = relative.split('/').slice(0, -1).join('/');
    if (!entry || parent && !realFolders(join(home, ...found.folder.split('/')), parent)) return { status: 'changed' };
    const program = readRegularFile(join(home, ...path.split('/')), { maxBytes: 4 * 1024 * 1_048_576 });
    return program && sha256(program) === entry.sha256 ? { status: 'ok', sha256: entry.sha256 as string, tree: found.tree } : { status: 'changed' };
  } catch { return { status: 'changed' }; }
}
/**
 * Only an acquire step places anything in an AI setup's folders (`.aihq/ai-setup/<name>/…`): a write, merge or link there
 * is refused (`path-escape`), so no plan supplies a program a tool-command or MCP entry then starts as an AI setup's. The
 * one exception is a non-executable file directly in the setup's own `settings/` folder, where Catalog places settings
 * files. A file named like Core's acquisition marker is refused anywhere.
 */
export function aiSetupReserved(root: 'project' | 'user', path: string, index: number, executable = false): { refusal: Refusal } | undefined {
  // Case-folded where names are; on Windows a segment's trailing dots and spaces name the same folder.
  const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase().split('/').map(part => part.replace(/[. ]+$/, '')).join('/') :
    process.platform === 'darwin' ? value.toLowerCase() : value;
  const segments = fold(path).split('/');
  if (segments.at(-1) === fold(MANIFEST) || segments.at(-1) === fold(ACQUIRING))
    return refusal('path-escape', `Step ${index} places \`${path}\`, named like Core's acquisition marker.`, index);
  const under = `${segments[0]}/${segments[1]}` === AI_SETUP_ROOT;
  if (root !== 'user' || !under || segments.length === 5 && segments[3] === 'settings' && !executable &&
    // A file Windows or a shell runs by its name is a program, whatever its executable flag.
    !/\.(cmd|bat|ps1|exe|com|sh)$/i.test(segments[4]!)) return undefined;
  return refusal('path-escape', `Step ${index} places \`${path}\` inside an AI setup folder, which only an acquire step fills.`, index);
}

/** `clis`: sorted, unique registry CLI ids (D118); an unknown id is `tool-unknown`. */
export function clis(step: PlanStep, index: number): { clis: string[] } | { problem: Problem } | { refusal: Refusal } {
  if (step.clis === undefined) return { clis: [] };
  const list = step.clis;
  if (!Array.isArray(list) || !list.every(id => typeof id === 'string' && ID.test(id)) ||
      !list.every((id, at) => at === 0 || (list[at - 1] as string) < (id as string)))
    return problem(index, 'clis', 'clis', 'A step records its CLIs as sorted, unique ids.');
  const unknown = (list as string[]).find(id => !knownCli(id));
  if (unknown) return refusal('tool-unknown', `Step ${index} names CLI \`${unknown}\`, which has no registry tool.`, index, { tool: unknown });
  return { clis: [...list as string[]] };
}

/**
 * A step's target under its root. Absolute paths, `..`, `.`, empty segments, backslashes and drive changes leave the
 * root (`path-escape`); a user-root path inside Core's private state is `state-path`. The engine re-checks links and
 * special files at Prepare and Apply.
 */
export function target(step: PlanStep, index: number, field = 'path'): { root: 'project' | 'user'; path: string } | { problem: Problem } | { refusal: Refusal } {
  const root = step.root;
  if (root !== 'project' && root !== 'user') return problem(index, 'root', 'root', 'A step root is `project` or `user`.');
  const path = step[field];
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return problem(index, field, 'path', 'A step names a relative path.');
  const segments = path.split('/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.includes('\0') ||
      // Catalog's portable-path rule too: no Git folder at any depth or case, no 8.3 short name that can alias another.
      segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes(':') ||
        segment.toLowerCase() === '.git' || /~[0-9]/.test(segment)))
    return refusal('path-escape', `Step ${index} names a path that leaves its root.`, index);
  const state = stateLocation.root.segments;
  const fold = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
  if (root === 'user' && state.every((segment, at) => segments[at] !== undefined && fold(segments[at]!) === fold(segment)))
    return refusal('state-path', `Step ${index} targets Core's private state.`, index);
  return { root, path };
}
