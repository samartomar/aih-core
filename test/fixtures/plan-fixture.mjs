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

/**
 * A plan request whose steps are `merge` steps (Catalog 9: `root`, `file`, `format`, `key`, `entry`, `item`, `clis`, and
 * optional `inputs` bindings `{ item, input, at: { pointer } }`). Each merge names an own-content item with no files; its
 * declared inputs (`requirements.inputs`) come from `inputs[itemId]`. Steps are sorted by root, then file, as Catalog orders
 * them. FIXTURE documents in the accepted Catalog shapes, not Catalog output.
 */
export function mergeRequest(project, merges, { scope = 'project', inputs = {}, framework = 'local-my-setup', extra = [] } = {}) {
  const ids = [...new Set(merges.map(merge => merge.item))];
  const items = ids.map(id => ({ id, kind: 'mcp', name: id.split('.').at(-1), description: `Fixture item ${id}`, files: [],
    ...(inputs[id] ? { requirements: { inputs: inputs[id] } } : {}), contentSha256: sha256(id), behaviourSha256: sha256(id) }));
  const steps = merges.map(({ root = scope, clis = ['claude-code'], ...rest }) => ({ op: 'merge', root, ...rest, clis }));
  const plan = [...steps].sort((a, b) => a.root < b.root ? -1 : a.root > b.root ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const clis = [...new Set(steps.flatMap(step => step.clis))].sort();
  return { schema: PLAN_REQUEST, scope, target: { project },
    plan: { status: 'ok', data: null, plan: [...plan, ...extra], missing: [], unavailable: [], clashes: [], duplicates: [], references: [], warnings: [] },
    contents: [{ schema: CONTENT, framework: { id: framework, name: 'My setup' }, sources: [{ id: framework, kind: 'local', notices: [] }], items }],
    profiles: clis.map(id => profile(id)), files: [] };
}
