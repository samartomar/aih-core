// Core-side producer FIXTURES for plan requests (urn:aihq:core:plan-request:0.1.0).
//
// No compatible @aihq/catalog artifact exists yet, so these builders hand-make documents in the shapes the accepted
// Catalog interface defines (content urn:aihq:catalog:content:0.1.0, tool profile urn:aihq:catalog:tool-profile:0.1.0,
// and the plan `planInstall` returns). They establish Core behaviour only; they are not Catalog output and prove no
// real producer or native-client compatibility. Later slices extend this module instead of copying it.
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const PLAN_REQUEST = 'urn:aihq:core:plan-request:0.1.0';
export const CONTENT = 'urn:aihq:catalog:content:0.1.0';
export const TOOL_PROFILE = 'urn:aihq:catalog:tool-profile:0.1.0';

/** A tool profile fixture: only the identity fields Core reads. */
export const profile = (id, version = 1) => ({ schema: TOOL_PROFILE, id, version, checkedWith: 'fixture' });

/**
 * Own content (`data: null`): one local source with one skill per entry of `skills` ({ name: { 'SKILL.md': text, … } }).
 * Returns the content document and the source files keyed by source path.
 */
export function ownContent(skills, { framework = 'local-my-skills', sourceId = 'local-my-skills' } = {}) {
  const files = {};
  const items = Object.entries(skills).map(([name, entries]) => {
    const itemFiles = Object.entries(entries).map(([path, text]) => {
      const sourcePath = `${name}/${path}`;
      const bytes = Buffer.from(text);
      files[sourcePath] = bytes;
      return { sourceId, sourcePath, sha256: sha256(bytes), bytes: bytes.length, executable: false, role: 'content' };
    });
    return { id: `${framework}.skill.${name}`, kind: 'skill', name, description: `Fixture skill ${name}`, files: itemFiles,
      contentSha256: sha256(JSON.stringify(itemFiles.map(file => [file.sourcePath, file.sha256]))), behaviourSha256: sha256(name) };
  });
  return { content: { schema: CONTENT, framework: { id: framework, name: 'My skills' },
    sources: [{ id: sourceId, kind: 'local', notices: [] }], items }, files, sourceId };
}

/** Where each fixture CLI reads a project skill (the Catalog `places` facts, reduced to what the fixtures need). */
export const SKILL_PLACES = { 'claude-code': '.claude/skills', codex: '.agents/skills', kiro: '.kiro/skills' };

/**
 * A `planInstall`-shaped plan for own content at project scope: one `write` per item file per CLI place, with the CLIs a
 * shared place serves in `clis`, in Catalog's phase/root/path order.
 */
export function ownPlan(content, clis, { scope = 'project' } = {}) {
  const root = scope;
  const byPath = new Map();
  for (const item of content.items) for (const cli of clis) for (const file of item.files) {
    const path = `${SKILL_PLACES[cli]}/${item.name}/${file.sourcePath.slice(item.name.length + 1)}`;
    const step = byPath.get(path) ?? { op: 'write', item: item.id, root, path, from: { item: item.id, sourcePath: file.sourcePath }, clis: [] };
    step.clis = [...new Set([...step.clis, cli])].sort();
    byPath.set(path, step);
  }
  const plan = [...byPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status: 'ok', data: null, plan, missing: [], unavailable: [], clashes: [], duplicates: [], references: [], warnings: [] };
}

/** A complete Node API plan request: the saved-document shape plus `bytes` on each `files` entry (C65). */
export function ownRequest(project, skills, clis = ['claude-code', 'codex', 'kiro'], options = {}) {
  const { content, files, sourceId } = ownContent(skills, options);
  const plan = ownPlan(content, clis, options);
  return { schema: PLAN_REQUEST, scope: options.scope ?? 'project', target: { project },
    plan, contents: [content], profiles: clis.map(id => profile(id)),
    files: Object.entries(files).map(([sourcePath, bytes]) => ({ sourceId, sourcePath, sha256: sha256(bytes), bytes })) };
}

/** The saved request document: the same request without any source bytes. */
export const savedDocument = request => ({ ...request, files: request.files.map(({ bytes: _bytes, ...entry }) => entry) });

export const RECIPE = 'urn:aihq:catalog:recipe:0.1.0';
export const RECIPE_SOURCE = { repository: 'https://github.com/example/notes-recipe', commit: 'e'.repeat(40) };
/** A recipe FIXTURE over own content: every skill a member; the data commit is a fixture value. */
export const recipeOf = (content, id = 'notes-base') => ({ schema: RECIPE, id, kind: 'base', framework: content.framework.id,
  members: content.items.map(item => ({ item: item.id, preTicked: true })), options: [],
  data: { repository: 'samartomar/aih-catalog', commit: 'd'.repeat(40) } });

/**
 * A plan request whose plan was made by a Catalog reader (`reader`: the `@aihq/catalog/reader` FIXTURE, or a real one):
 * `planInstall` by default, or `planRecipe` with `{ recipe: true }`, which also supplies the matching `recipeProof`.
 */
export function renderRequest(reader, project, skills, clis = ['claude-code', 'codex', 'kiro'], options = {}) {
  const { content, files, sourceId } = ownContent(skills, options);
  const profiles = clis.map(id => profile(id));
  const scope = options.scope ?? 'project';
  const recipe = options.recipe ? recipeOf(content) : undefined;
  const plan = recipe ? reader.planRecipe(recipe, [content], profiles, {}, { scope, source: RECIPE_SOURCE }) :
    reader.planInstall(content.items.map(item => item.id), [content], profiles, { scope, data: null });
  return { schema: PLAN_REQUEST, scope, target: { project }, plan, contents: [content], profiles,
    files: Object.entries(files).map(([sourcePath, bytes]) => ({ sourceId, sourcePath, sha256: sha256(bytes), bytes })),
    ...(recipe ? { recipeProof: { pluginJson: JSON.stringify({ name: recipe.id, version: '1.0.0', description: 'Fixture recipe' }),
      recipeJson: reader.canonical(recipe), choices: {}, options: {} } } : {}) };
}
