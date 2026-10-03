// Controlled fixtures for owned hook-group tests. The groups are generic
// objects with a stable wrapper-command scalar; no client definition is implied.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const POLICY_11 = 'urn:aihq:core:execution-policy:1.1.0';
export const RECIPE_11 = 'urn:aihq:core:recipe:1.1.0';
export const PREPARED_11 = 'urn:aihq:core:prepared-work:1.1.0';
export const RESULT_11 = 'urn:aihq:core:run-result:1.1.0';
export const SETTINGS = '.tool/settings.json';
export const CONTAINER = ['hooks', 'PreToolUse'];

export const sha = value => createHash('sha256').update(value).digest('hex');
export const commandOf = name => `hooks/${name}.sh`;
export const groupOf = (name, extra = {}) => ({ matcher: 'Bash', hooks: [{ type: 'command', command: commandOf(name) }], ...extra });
export const selectorFor = name => ({ path: ['hooks', 0, 'command'], value: commandOf(name) });
export const selectorSha = name => sha(commandOf(name));
export const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
export const canonicalSha = value => sha(canonical(value));

export function hookOp(id, name, fields = {}) {
  const action = fields.action ?? 'set';
  const op = { id, purpose: `${id} hook group`, kind: 'hook.group', scope: fields.scope ?? 'project', requires: [], checks: [],
    target: fields.target ?? { root: 'project', segments: SETTINGS.split('/').map(literal => ({ literal })) },
    format: fields.format ?? 'json', container: fields.container ?? CONTAINER, groupId: fields.groupId ?? name,
    selector: fields.selector ?? selectorFor(name), action };
  if (action === 'set') op.group = { literal: fields.group ?? groupOf(name) };
  return op;
}
export function hookSelection(id, ops, extras = {}) {
  const scope = extras.scope ?? 'project';
  return { id, managementId: extras.managementId ?? id, scope, configuration: {}, requires: extras.requires ?? [],
    ...(extras.organizationSelectionId ? { organizationSelectionId: extras.organizationSelectionId } : {}),
    recipe: { inline: { schema: RECIPE_11, id: `${id}-recipe`, description: 'Owned hook group fixture', inputs: {}, materials: [],
      targets: [scope], prerequisites: [], operations: ops.map(op => ({ ...op, scope })), checks: [] } } };
}
export const policy11 = (selections, extras = {}) => ({ schema: POLICY_11, mode: 'vibe', selections, ...extras });
export const request = (project, policy, resolutions) => ({ useCase: 'policy', policy, target: { project }, ...(resolutions ? { resolutions } : {}) });
export const authorize = (prepared, extras = {}) => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest, ...extras });

/** Disposable HOME plus project; callers restore the environment through `dispose`. */
export function sandbox(prefix = 'aih-hook-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  return { root, home, project,
    file: relative => join(project, relative),
    write(relative, text) { const path = join(project, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
    read(relative) { const path = join(project, relative); return existsSync(path) ? readFileSync(path, 'utf8') : null; },
    dispose() {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    } };
}
export const settingsText = (groups, extra = {}) => JSON.stringify({ ...extra, hooks: { PreToolUse: groups } }, null, 2) + '\n';
