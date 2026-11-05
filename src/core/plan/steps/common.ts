// Checks every placement step shares: what it belongs to, where it lands, and which CLIs it serves.
import { stateLocation } from '../../state-location.js';
import { knownCli } from '../tools.js';
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
