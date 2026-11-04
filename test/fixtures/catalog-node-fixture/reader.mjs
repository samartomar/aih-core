// Core-side test FIXTURE for `@aihq/catalog/reader` `renderStep` and `planRecipe` (and a `planInstall` that renders),
// in the signatures the accepted Catalog interface defines (samartomar/aih-catalog#197):
//   renderStep(step, contents, profiles, files)                  -> { status: 'ok', bytes, sha256 } | refused | invalid
//   planRecipe(recipe, contents, profiles, choices, { scope, source, data?, copy?, names? }) -> plan
// A render step records `render: { name, profile, version, installName }`, and a `from` that names
// `{ item, sourceId, sourcePath, sha256 }`, as that interface's implementation in progress does. Its two renders are
// deliberately simple stand-ins (a user-only frontmatter flag; a Codex `agents/openai.yaml`). It is not Catalog and
// establishes no producer or client compatibility: final validation needs the delivered Catalog artifact.
import { createHash } from 'node:crypto';

export const FIXTURE_VERSION = '0.0.0-core-fixture';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const refused = (code, reason) => ({ status: 'refused', code, reason });
const invalid = message => ({ status: 'invalid', problems: [{ path: 'step/render', message }] });
/** Canonical JSON (sorted keys, no whitespace): the bytes of a recipe document. */
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` :
    JSON.stringify(value);

/** Where each fixture CLI reads a project skill. */
const PLACES = { 'claude-code': '.claude/skills', codex: '.agents/skills', kiro: '.kiro/skills' };
const USER_ONLY = '\ndisable-model-invocation: true';
const OPENAI_YAML = 'policy:\n  allow_implicit_invocation: false\n';

export function renderStep(step, contents, profiles, files) {
  const render = step?.render;
  if (step?.op !== 'write' || !render || typeof render !== 'object') return invalid('renderStep takes a write step with a render');
  const profile = profiles.find(candidate => candidate.id === render.profile);
  if (!profile || profile.version !== render.version)
    return refused('profile-mismatch', `the step was planned with ${render.profile} version ${render.version}`);
  if (render.name === 'codex-user-only') {
    const bytes = new TextEncoder().encode(OPENAI_YAML);
    return { status: 'ok', bytes, sha256: sha256(bytes) };
  }
  if (render.name !== 'skill-user-only') return invalid('unknown render');
  const from = step.from;
  const supplied = files.find(file => file.sourcePath === from?.sourcePath && (file.sourceId === undefined || file.sourceId === from.sourceId));
  if (!supplied) return { status: 'invalid', problems: [{ path: 'files', message: 'the source file was not supplied' }] };
  if (sha256(supplied.bytes) !== from.sha256) return refused('source-mismatch', `the supplied ${from.sourcePath} differs from the plan`);
  const text = new TextDecoder().decode(supplied.bytes);
  if (!text.startsWith('---\n')) return invalid('a user-only skill has frontmatter');
  const bytes = new TextEncoder().encode('---' + USER_ONLY + text.slice(3));
  return { status: 'ok', bytes, sha256: sha256(bytes) };
}

/** A render plan for skills on Claude, Codex and Kiro: every SKILL.md user-only, and Codex's openai.yaml. */
function planOf(items, profiles, { scope, data, recipe }) {
  const steps = [];
  for (const item of items) for (const profile of profiles) {
    const folder = `${PLACES[profile.id]}/${item.name}`;
    const marks = { profile: profile.id, version: profile.version, installName: item.name };
    for (const file of item.files) {
      const rel = file.sourcePath.slice(item.name.length + 1);
      const rendered = rel === 'SKILL.md';
      steps.push({ op: 'write', root: scope, path: `${folder}/${rel}`,
        from: { item: item.id, sourceId: file.sourceId, sourcePath: file.sourcePath, sha256: file.sha256 }, executable: false,
        ...(rendered ? { render: { name: 'skill-user-only', ...marks }, scanned: false } : {}), item: item.id, clis: [profile.id] });
    }
    if (profile.id === 'codex')
      steps.push({ op: 'write', root: scope, path: `${folder}/agents/openai.yaml`, executable: false,
        render: { name: 'codex-user-only', ...marks }, scanned: false, item: item.id, clis: ['codex'] });
  }
  steps.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status: 'ok', ...(recipe ? { recipe } : {}), data,
    profiles: profiles.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id < b.id ? -1 : 1),
    plan: steps, missing: [], unavailable: [], clashes: [], duplicates: [], references: [], warnings: [] };
}

export function planInstall(selection, contents, profiles, { scope, data }) {
  const items = contents.flatMap(content => content.items).filter(item => selection.includes(item.id));
  return planOf(items, profiles, { scope, data });
}

/** The recipe's members plus each option group's picks; records the recipe origin from the recipe's canonical bytes. */
export function planRecipe(recipe, contents, profiles, choices, options) {
  const { scope, source, data, ...rest } = options ?? {};
  if (Object.keys(rest).length || !source?.repository || !source?.commit)
    return { status: 'invalid', problems: [{ path: 'options', message: 'scope and source are required; nothing else is known' }] };
  const picked = new Set((recipe.members ?? []).map(member => member.item));
  for (const [group, ids] of Object.entries(choices ?? {})) {
    if (!(recipe.options ?? []).some(option => option.id === group)) return { status: 'invalid', problems: [{ path: `choices/${group}`, message: 'unknown group' }] };
    for (const id of ids) picked.add(id);
  }
  const items = contents.flatMap(content => content.items).filter(item => picked.has(item.id));
  return planOf(items, profiles, { scope, data: data ?? recipe.data,
    recipe: { id: recipe.id, sha256: sha256(canonical(recipe)), repository: source.repository, commit: source.commit } });
}
