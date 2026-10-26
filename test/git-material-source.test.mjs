import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { validatePolicy } from '../dist/core/contracts.js';

// Execution policy 1.4.0 admits a referenced recipe from one exact GitHub commit: Catalog's exact git identity plus the
// pinned archive of that commit. Moving or inexact references are named refusals; Core resolves nothing.
const sha = value => createHash('sha256').update(value).digest('hex');
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const REPOSITORY = 'https://github.com/example-org/skills';
const codeload = (commit = COMMIT, repo = 'example-org/skills') => `https://codeload.github.com/${repo}/tar.gz/${commit}`;

function header(path, size, type, mode = 0o644) {
  const block = Buffer.alloc(512);
  block.write(path, 0, 100, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.fill(32, 148, 156);
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write((block.reduce((total, value) => total + value, 0)).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}
const pad = bytes => Buffer.alloc((512 - bytes.length % 512) % 512);
/** A tarball shaped like `git archive` output: a pax global header naming the commit, then the tree under one prefix. */
export function gitArchive(files, { commit = COMMIT, prefix = 'example-org-skills-a1b2c3d/', globalComment = true, extra = {}, executable = [] } = {}) {
  const blocks = [];
  if (globalComment) {
    const body = ` comment=${commit}\n`;
    let length = body.length + 1;
    while (`${length}`.length + body.length !== length) length = `${length}`.length + body.length;
    const record = Buffer.from(`${length}${body}`);
    blocks.push(header('pax_global_header', record.length, 'g'), record, pad(record));
  }
  blocks.push(header(prefix, 0, '5', 0o755));
  for (const [path, bytes] of Object.entries({ ...files, ...extra }))
    blocks.push(header(prefix + path, bytes.length, '0', executable.includes(path) ? 0o755 : 0o644), bytes, pad(bytes));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
export const GIT = { COMMIT, REPOSITORY, codeload };

const recipeBytes = Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:recipe:1.0.0', id: 'skill', description: 'Pinned skill',
  inputs: {}, materials: [], targets: ['project'], prerequisites: [], operations: [], checks: [] }));
const archive = gitArchive({ 'recipe.json': recipeBytes });
const gitSource = (fields = {}) => ({ kind: 'git', repository: REPOSITORY, commit: COMMIT, reachable: true,
  archive: { url: codeload(), sha256: sha(archive), byteLength: archive.length }, ...fields });
const policyWith = (source, schema = 'urn:aihq:core:execution-policy:1.4.0') => ({ schema, mode: 'vibe', selections: [{
  id: 'skill', managementId: 'skill', scope: 'project', configuration: {}, requires: [],
  recipe: { reference: { source, path: 'example-org-skills-a1b2c3d/recipe.json', sha256: sha(recipeBytes), byteLength: recipeBytes.length, materials: [] } } }] });
const reasons = result => result.diagnostics.map(item => [item.reason, item.path]);

test('execution policy 1.4.0 accepts a referenced recipe from an exact GitHub commit in Catalog\'s exact identity form', () => {
  const result = validatePolicy(policyWith(gitSource()));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
});

test('moving, inexact or unproven git identities are named refusals; Core never resolves them', () => {
  const at = '/selections/0/recipe/reference/source';
  for (const [name, source, reason] of [
    ['branch', gitSource({ commit: 'main' }), 'git-commit-not-exact'],
    ['tag', gitSource({ commit: 'v1.2.3' }), 'git-commit-not-exact'],
    ['short commit', gitSource({ commit: COMMIT.slice(0, 7) }), 'git-commit-not-exact'],
    ['symbolic ref', gitSource({ commit: 'refs/heads/main' }), 'git-commit-not-exact'],
    ['HEAD', gitSource({ commit: 'HEAD' }), 'git-commit-not-exact'],
    ['uppercase commit', gitSource({ commit: COMMIT.toUpperCase() }), 'git-commit-not-exact'],
    ['sha-256 object id', gitSource({ commit: 'a'.repeat(64) }), 'git-commit-not-exact'],
    ['unchecked reachability', gitSource({ reachable: 'unchecked' }), 'git-commit-not-reachable'],
    ['unreachable commit', gitSource({ reachable: false }), 'git-commit-not-reachable'],
    ['ssh repository', gitSource({ repository: 'git@github.com:example-org/skills.git' }), 'git-repository-unsupported'],
    ['other host', gitSource({ repository: 'https://gitlab.com/example-org/skills' }), 'git-repository-unsupported'],
    ['.git suffix', gitSource({ repository: `${REPOSITORY}.git` }), 'git-repository-unsupported'],
    ['tree link', gitSource({ repository: `${REPOSITORY}/tree/main` }), 'git-repository-unsupported'],
    ['credentials', gitSource({ repository: 'https://token@github.com/example-org/skills' }), 'git-repository-unsupported'],
    ['branch archive', gitSource({ archive: { ...gitSource().archive, url: codeload('main') } }), 'git-archive-not-exact'],
    ['other commit archive', gitSource({ archive: { ...gitSource().archive, url: codeload('b'.repeat(40)) } }), 'git-archive-not-exact'],
    ['other repository archive', gitSource({ archive: { ...gitSource().archive, url: codeload(COMMIT, 'someone/else') } }), 'git-archive-not-exact'],
  ]) {
    const result = validatePolicy(policyWith(source));
    assert.equal(result.valid, false, name);
    assert.deepEqual(reasons(result), [[reason, at]], name);
  }
});

test('earlier execution policy versions do not admit a git material source', () => {
  for (const schema of ['urn:aihq:core:execution-policy:1.0.0', 'urn:aihq:core:execution-policy:1.3.0']) {
    const result = validatePolicy(policyWith(gitSource(), schema));
    assert.equal(result.valid, false, schema);
  }
});

// Prepare -> reviewed preview -> Apply with fixture-controlled transport: the pinned archive is the only acquisition.
const PREFIX = 'example-org-skills-a1b2c3d/';
const skillBytes = Buffer.from('---\nname: pinned\ndescription: A pinned skill\n---\nUse the pinned commit.\n');
const pinnedRecipe = Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:recipe:1.0.0', id: 'pinned-skill', description: 'Pinned skill',
  inputs: {}, materials: [{ id: 'skill', sha256: sha(skillBytes), byteLength: skillBytes.length }], targets: ['project'], prerequisites: [],
  operations: [{ id: 'write', purpose: 'Deliver the pinned skill', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: '.claude' }, { literal: 'skills' }, { literal: 'pinned' }, { literal: 'SKILL.md' }] },
    material: 'skill', requires: [], checks: [] }], checks: [] }));
const pinnedArchive = (files = { 'recipe.json': pinnedRecipe, 'skills/pinned/SKILL.md': skillBytes }, options) => gitArchive(files, options);
const pinnedReference = (bytes, fields = {}) => ({
  source: { kind: 'git', repository: REPOSITORY, commit: COMMIT, reachable: true, archive: { url: codeload(), sha256: sha(bytes), byteLength: bytes.length } },
  path: `${PREFIX}recipe.json`, sha256: sha(pinnedRecipe), byteLength: pinnedRecipe.length,
  materials: [{ id: 'skill', path: `${PREFIX}skills/pinned/SKILL.md`, sha256: sha(skillBytes), byteLength: skillBytes.length }], ...fields });
const pinnedPolicy = reference => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections: [{
  id: 'pinned', managementId: 'pinned-skill', scope: 'project', configuration: {}, requires: [], recipe: { reference } }] });
async function withTransport(bytes, body) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    assert.equal(options.redirect, 'error');
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  try { return await body(urls); } finally { globalThis.fetch = original; }
}
const PROVENANCE = { kind: 'git', repository: REPOSITORY, commit: COMMIT, identity: `example-org/skills@${COMMIT}` };

test('content from owner/repo@commit installs through review and Apply with its exact bytes and provenance', async () => {
  const { prepare, apply, listManagedSelections } = await import('../dist/core/index.js');
  const { sandbox } = await import('./hook-group-fixture.mjs');
  const s = sandbox('aih-git-source-');
  try {
    const bytes = pinnedArchive();
    await withTransport(bytes, async urls => {
      const prepared = await prepare({ useCase: 'policy', policy: pinnedPolicy(pinnedReference(bytes)), target: { project: s.project } });
      assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
      assert.deepEqual(urls, [codeload()], 'only the pinned archive is fetched');
      assert.deepEqual(prepared.review.selections.map(item => item.materialSource), [PROVENANCE]);
      const result = await apply(prepared.prepared, { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
      assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
      assert.deepEqual(readFileSync(s.file('.claude/skills/pinned/SKILL.md')), skillBytes);
      const inventory = await listManagedSelections({ target: { project: s.project }, scope: 'project', format: 'urn:aihq:core:managed-inventory-result:1.1.0' });
      assert.deepEqual(inventory.selections.map(item => [item.managementId, item.materialSource]), [['pinned-skill', PROVENANCE]]);
    });
  } finally { s.dispose(); }
});

test('archive and material mismatches, moving identities and bounds are refused before anything is written', async () => {
  const { prepare } = await import('../dist/core/index.js');
  const { sandbox } = await import('./hook-group-fixture.mjs');
  const s = sandbox('aih-git-refuse-');
  const outcome = async (served, reference) => withTransport(served, async urls => {
    const prepared = await prepare({ useCase: 'policy', policy: pinnedPolicy(reference), target: { project: s.project } });
    return { status: prepared.status, reasons: prepared.diagnostics.map(item => [item.code, item.reason]), fetched: urls.length, handle: !!prepared.prepared };
  });
  try {
    const good = pinnedArchive();
    const flipped = Buffer.from(good); flipped[flipped.length - 1] ^= 1;
    const otherCommit = pinnedArchive(undefined, { commit: 'b'.repeat(40) });
    const noHeader = pinnedArchive(undefined, { globalComment: false });
    const changedSkill = pinnedArchive({ 'recipe.json': pinnedRecipe, 'skills/pinned/SKILL.md': Buffer.from('tampered skill bytes\n') });
    const missingSkill = pinnedArchive({ 'recipe.json': pinnedRecipe });
    for (const [name, served, reference, expected] of [
      ['served bytes differ from the pinned archive', flipped, pinnedReference(good), ['INPUT_INVALID', 'archive-identity-mismatch']],
      ['served length differs from the pinned archive', Buffer.concat([good, Buffer.from([0])]), pinnedReference(good), ['INPUT_INVALID', 'archive-length-mismatch']],
      ['pinned archive of another commit', otherCommit, pinnedReference(otherCommit), ['INPUT_INVALID', 'git-archive-commit-mismatch']],
      ['archive that names no commit', noHeader, pinnedReference(noHeader), ['INPUT_INVALID', 'git-archive-commit-mismatch']],
      ['named material bytes differ from their pin', changedSkill, pinnedReference(changedSkill), ['INPUT_INVALID', 'member-identity-mismatch']],
      ['named material missing from the archive', missingSkill, pinnedReference(missingSkill), ['PREREQUISITE_UNAVAILABLE', 'archive-incomplete']],
      ['branch name', good, { ...pinnedReference(good), source: { ...pinnedReference(good).source, commit: 'main' } }, ['INPUT_INVALID', 'git-commit-not-exact']],
      ['archive URL of a branch', good, { ...pinnedReference(good), source: { ...pinnedReference(good).source,
        archive: { ...pinnedReference(good).source.archive, url: codeload('main') } } }, ['INPUT_INVALID', 'git-archive-not-exact']],
      ['archive above the compressed bound', good, { ...pinnedReference(good), source: { ...pinnedReference(good).source,
        archive: { ...pinnedReference(good).source.archive, byteLength: 64 * 1024 * 1024 + 1 } } }, ['INPUT_INVALID', 'maximum']],
    ]) {
      const result = await outcome(served, reference);
      // Unavailable material is an omission, as for any archive: the selection prepares nothing to apply.
      if (expected[0] === 'PREREQUISITE_UNAVAILABLE') assert.equal(result.status, 'partial', name);
      else { assert.equal(result.handle, false, name); assert.equal(result.status, 'invalid', name); }
      // A schema bound reports every oneOf branch; the archive bound is the one that applies.
      if (expected[1] === 'maximum') assert.ok(result.reasons.some(item => item[1] === 'maximum'), name);
      else assert.deepEqual(result.reasons, [expected], name);
      if (expected[1].startsWith('git-commit') || expected[1] === 'git-archive-not-exact' || expected[1] === 'maximum') assert.equal(result.fetched, 0, `${name}: nothing is fetched`);
    }
    assert.equal(s.read('.claude/skills/pinned/SKILL.md'), null);
  } finally { s.dispose(); }
});

test('an executable the recipe does not name in a git archive is refused; acquired bytes are never run', async () => {
  const { prepare } = await import('../dist/core/index.js');
  const { sandbox } = await import('./hook-group-fixture.mjs');
  const s = sandbox('aih-git-exec-');
  try {
    // A tree member with an executable mode that no material names.
    const files = { 'recipe.json': pinnedRecipe, 'skills/pinned/SKILL.md': skillBytes };
    const bytes = gitArchive(files, { executable: ['install.sh'], extra: { 'install.sh': Buffer.from('#!/bin/sh\necho ran > ran.txt\n') } });
    await withTransport(bytes, async () => {
      const prepared = await prepare({ useCase: 'policy', policy: pinnedPolicy(pinnedReference(bytes)), target: { project: s.project } });
      assert.deepEqual(prepared.diagnostics.map(item => item.reason), ['unreferenced-executable']);
      assert.equal(prepared.prepared, undefined);
    });
    assert.equal(s.read('ran.txt'), null);
  } finally { s.dispose(); }
});

test('recorded provenance follows the source of the latest Apply: another exact commit, then a local source', async () => {
  const { prepare, apply, listManagedSelections } = await import('../dist/core/index.js');
  const { sandbox } = await import('./hook-group-fixture.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const s = sandbox('aih-git-follow-');
  const run = async (policy, controls = {}) => {
    const prepared = await prepare({ useCase: 'policy', policy, target: { project: s.project } }, controls);
    assert.ok(prepared.prepared, JSON.stringify(prepared.diagnostics));
    const result = await apply(prepared.prepared, { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest }, controls);
    assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
    return prepared.review;
  };
  const recorded = async () => (await listManagedSelections({ target: { project: s.project }, scope: 'project',
    format: 'urn:aihq:core:managed-inventory-result:1.1.0' })).selections.map(item => item.materialSource ?? null);
  try {
    const first = pinnedArchive();
    await withTransport(first, () => run(pinnedPolicy(pinnedReference(first))));
    assert.deepEqual(await recorded(), [PROVENANCE]);
    // The same bytes from another exact commit: nothing on disk changes, the recorded commit does.
    const NEXT = 'c'.repeat(40);
    const next = pinnedArchive(undefined, { commit: NEXT });
    const nextReference = pinnedReference(next);
    nextReference.source = { ...nextReference.source, commit: NEXT, archive: { ...nextReference.source.archive, url: codeload(NEXT) } };
    const review = await withTransport(next, () => run(pinnedPolicy(nextReference)));
    assert.deepEqual(review.selections[0].materialSource, { ...PROVENANCE, commit: NEXT, identity: `example-org/skills@${NEXT}` });
    assert.deepEqual(await recorded(), [{ ...PROVENANCE, commit: NEXT, identity: `example-org/skills@${NEXT}` }]);
    // A local source carries no git provenance, so none stays recorded.
    const local = join(s.root, 'local');
    mkdirSync(join(local, PREFIX, 'skills', 'pinned'), { recursive: true });
    writeFileSync(join(local, PREFIX, 'recipe.json'), pinnedRecipe);
    writeFileSync(join(local, PREFIX, 'skills', 'pinned', 'SKILL.md'), skillBytes);
    const localReference = { ...pinnedReference(first), source: { kind: 'local', input: 'checkout' } };
    const localReview = await run(pinnedPolicy(localReference), { materialRoots: { checkout: local } });
    assert.equal(localReview.selections[0].materialSource, undefined);
    assert.deepEqual(await recorded(), [null]);
  } finally { s.dispose(); }
});

test('the read-only file check never fetches a git source and reports it not admitted', async () => {
  const { checkFileState } = await import('../dist/core/index.js');
  const { sandbox } = await import('./hook-group-fixture.mjs');
  const s = sandbox('aih-git-check-');
  try {
    const bytes = pinnedArchive();
    await withTransport(bytes, async urls => {
      const result = await checkFileState({ policy: pinnedPolicy(pinnedReference(bytes)), target: { project: s.project } });
      assert.deepEqual(result.notChecked, [{ kind: 'recipe', id: 'pinned', reason: 'remote-material-not-admitted' }]);
      assert.deepEqual(urls, []);
    });
  } finally { s.dispose(); }
});

test('a git-sourced reference derives the same recipe identity as its bytes from any other source', async () => {
  const { deriveRecipeIdentity } = await import('../dist/core/contracts.js');
  const bytes = pinnedArchive();
  const git = await deriveRecipeIdentity({ recipeBytes: pinnedRecipe, reference: pinnedReference(bytes) });
  const local = await deriveRecipeIdentity({ recipeBytes: pinnedRecipe, reference: { ...pinnedReference(bytes), source: { kind: 'local', input: 'checkout' } } });
  assert.equal(git.status, 'ok', JSON.stringify(git));
  assert.equal(git.value.recipeIdentity, local.value.recipeIdentity);
  const moving = await deriveRecipeIdentity({ recipeBytes: pinnedRecipe, reference: { ...pinnedReference(bytes), source: { ...pinnedReference(bytes).source, commit: 'main' } } });
  assert.equal(moving.status, 'refused');
  assert.deepEqual(moving.diagnostics[0].details.diagnostics.map(item => item.reason), ['git-commit-not-exact']);
});

test('releasing one inclusion keeps the recorded git provenance of the selection that stays', async () => {
  const { prepare, apply, listManagedSelections, prepareManagedRemoval } = await import('../dist/core/index.js');
  const { sandbox } = await import('./hook-group-fixture.mjs');
  const s = sandbox('aih-git-origin-');
  try {
    const bytes = pinnedArchive();
    const starter = { reasonIncluded: 'in-set', set: { framework: 'team-skills', setId: 'starter', setSha256: sha('starter') } };
    const policy = pinnedPolicy(pinnedReference(bytes));
    Object.assign(policy.selections[0], { item: { framework: 'team-skills', itemId: 'pinned', contentSha256: sha('content'), behaviourSha256: sha('behaviour') },
      tool: 'claude', name: 'Pinned skill', kind: 'skill', origins: [{ reasonIncluded: 'chosen' }, starter] });
    await withTransport(bytes, async () => {
      const prepared = await prepare({ useCase: 'policy', policy, target: { project: s.project } });
      assert.equal((await apply(prepared.prepared, { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest })).completion, 'complete');
    });
    const removal = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
      removals: [{ managementId: 'pinned-skill', origin: { reasonIncluded: 'chosen' } }] });
    assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
    assert.equal((await apply(removal.preparation.prepared, { approved: true, origin: 'automation', reviewDigest: removal.preparation.review.reviewDigest })).completion, 'complete');
    const [row] = (await listManagedSelections({ target: { project: s.project }, scope: 'project', format: 'urn:aihq:core:managed-inventory-result:1.1.0' })).selections;
    assert.deepEqual([row.origins, row.materialSource], [[starter], PROVENANCE]);
  } finally { s.dispose(); }
});
