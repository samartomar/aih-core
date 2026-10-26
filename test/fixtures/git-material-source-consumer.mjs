// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
// Install from an exact git material source: a referenced recipe from owner/repo@<40-hex commit>, acquired only as that
// commit's pinned archive through fixture-controlled transport, reviewed, applied, and recorded on the managed selection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { contractSupport, validatePolicy } from '@aihq/core/contracts';
import { apply, listManagedSelections, prepare, resolveStateLocation } from '@aihq/core';

const require = createRequire(import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const COMMIT = '4f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
const NEXT = '0123456789abcdef0123456789abcdef01234567';
const REPOSITORY = 'https://github.com/example-org/team-skills';
const PREFIX = 'example-org-team-skills-4f1e2d3/';
const archiveUrl = commit => `https://codeload.github.com/example-org/team-skills/tar.gz/${commit}`;
const INVENTORY_11 = 'urn:aihq:core:managed-inventory-result:1.1.0';
const SECRET = 'ghp_GitSourceConsumerSecret0123456789';

// --- Fixture archives shaped like `git archive` output ---------------------------------------------------------------
function tarHeader(path, size, type, mode = 0o644) {
  const block = Buffer.alloc(512);
  block.write(path, 0, 100, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii'); block.write('0000000\0', 116, 8, 'ascii');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.fill(32, 148, 156);
  block.write(type, 156, 1, 'ascii'); block.write('ustar\0', 257, 6, 'ascii'); block.write('00', 263, 2, 'ascii');
  block.write(block.reduce((total, value) => total + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}
const pad = bytes => Buffer.alloc((512 - bytes.length % 512) % 512);
function gitArchive(files, commit) {
  const body = ` comment=${commit}\n`;
  let length = body.length + 1;
  while (`${length}`.length + body.length !== length) length = `${length}`.length + body.length;
  const record = Buffer.from(`${length}${body}`);
  const blocks = [tarHeader('pax_global_header', record.length, 'g'), record, pad(record), tarHeader(PREFIX, 0, '5', 0o755)];
  for (const [path, bytes] of Object.entries(files)) blocks.push(tarHeader(PREFIX + path, bytes.length, '0'), bytes, pad(bytes));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const skill = Buffer.from('---\nname: review-checklist\ndescription: Team review checklist\n---\nCheck tests, names and errors.\n');
const license = Buffer.from('MIT License for the team skills.\n');
const recipeBytes = Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:recipe:1.0.0', id: 'review-checklist', description: 'Team review checklist',
  inputs: { token: { type: 'string', required: true, sensitive: true, maxLength: 256 } },
  materials: [{ id: 'license', sha256: sha256(license), byteLength: license.length }, { id: 'skill', sha256: sha256(skill), byteLength: skill.length }],
  targets: ['project'], prerequisites: [],
  operations: [
    { id: 'skill', purpose: 'Deliver the skill', kind: 'file.write', scope: 'project', material: 'skill', requires: [], checks: [],
      target: { root: 'project', segments: ['.claude', 'skills', 'review-checklist', 'SKILL.md'].map(literal => ({ literal })) } },
    { id: 'license', purpose: 'Deliver its license', kind: 'file.write', scope: 'project', material: 'license', requires: [], checks: [],
      target: { root: 'project', segments: ['.claude', 'skills', 'review-checklist', 'LICENSE'].map(literal => ({ literal })) } },
    { id: 'token', purpose: 'Deliver the private token', kind: 'file.write', scope: 'project', content: { input: 'token' }, requires: [], checks: [],
      target: { root: 'project', segments: ['.secrets', 'token'].map(literal => ({ literal })) } }],
  checks: [] }));
const tree = { 'recipe.json': recipeBytes, 'skills/review-checklist/SKILL.md': skill, 'skills/review-checklist/LICENSE': license };

/** A selection whose recipe is referenced from one exact commit: Catalog's exact git identity plus the pinned archive. */
function pinnedSelection(archive, { commit = COMMIT, url = archiveUrl(commit), materials, ...identity } = {}) {
  return { id: 'review-checklist', managementId: 'review-checklist', scope: 'project', configuration: {}, requires: [],
    item: { framework: 'team-skills', itemId: 'review-checklist', contentSha256: sha256('content'), behaviourSha256: sha256('behaviour') },
    tool: 'claude', name: 'Review checklist', kind: 'skill', origins: [{ reasonIncluded: 'chosen' }],
    recipe: { reference: {
      source: { kind: 'git', repository: REPOSITORY, commit, reachable: true, archive: { url, sha256: sha256(archive), byteLength: archive.length }, ...identity },
      path: `${PREFIX}recipe.json`, sha256: sha256(recipeBytes), byteLength: recipeBytes.length,
      materials: materials ?? [
        { id: 'license', path: `${PREFIX}skills/review-checklist/LICENSE`, sha256: sha256(license), byteLength: license.length },
        { id: 'skill', path: `${PREFIX}skills/review-checklist/SKILL.md`, sha256: sha256(skill), byteLength: skill.length }] } } };
}
const policy = selection => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections: [selection] });

// --- Fixture-controlled transport: serves one archive URL, refuses every other request -------------------------------
const served = new Map();
const requested = [];
globalThis.fetch = async (url, options) => {
  requested.push(String(url));
  assert.equal(options?.redirect, 'error', 'acquisition never follows a redirect');
  const bytes = served.get(String(url));
  if (!bytes) throw new TypeError('fixture transport: no network');
  return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
};

const outputs = [];
const keep = value => { outputs.push(value); return value; };
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const controls = { logging: 'on', privateInputs: { 'review-checklist': { token: SECRET } } };
const workspace = prefix => { const project = join(mkdtempSync(join(process.env.HOME, `${prefix}-`)), 'project'); mkdirSync(project); return project; };
const inventory = async project => keep(await listManagedSelections({ target: { project }, scope: 'project', format: INVENTORY_11 }));

/**
 * The public consumer example: install one selection from an exact commit through review and Apply, and hand the exact
 * identity Core recorded back to the caller. Saving or reopening that intent is the caller's own concern.
 */
async function installFromExactCommit(project, selection) {
  const prepared = keep(await prepare({ useCase: 'policy', policy: policy(selection), target: { project } }, controls));
  if (prepared.status !== 'ready') return { status: prepared.status, diagnostics: prepared.diagnostics };
  const reviewed = prepared.review.selections.find(item => item.managementId === selection.managementId).materialSource;
  const result = keep(await apply(prepared.prepared, approve(prepared.review), controls));
  const recorded = (await inventory(project)).selections.find(item => item.managementId === selection.managementId)?.materialSource;
  return { status: result.completion, reviewed, recorded };
}

const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
const archive = gitArchive(tree, COMMIT);
served.set(archiveUrl(COMMIT), archive);
const PROVENANCE = { kind: 'git', repository: REPOSITORY, commit: COMMIT, identity: `example-org/team-skills@${COMMIT}` };

await check('execution policy 1.4.0 admits the exact git source in the form Catalog publishes', async () => {
  const result = validatePolicy(policy(pinnedSelection(archive)));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  // The published fixtures for that form replay through the public reader with their declared outcome.
  const contract = contractSupport.contracts.find(item => item.id === 'urn:aihq:core:execution-policy:1.4.0');
  const gitFixtures = contract.fixtures.filter(item => item.export.includes('/git-source-'));
  assert.deepEqual(gitFixtures.map(item => item.expect), ['accept', 'refuse']);
  for (const fixture of gitFixtures) {
    const replay = validatePolicy(JSON.parse(readFileSync(require.resolve(fixture.export), 'utf8')));
    assert.equal(replay.valid, fixture.expect === 'accept', fixture.export);
    if (fixture.code) assert.deepEqual(replay.diagnostics.map(item => [item.code, item.reason]), [[fixture.code, 'git-commit-not-exact']]);
  }
});

await check('owner/repo@commit installs through review and Apply with exact bytes, and the caller gets the identity back', async () => {
  const project = workspace('install');
  requested.length = 0;
  const installed = await installFromExactCommit(project, pinnedSelection(archive));
  assert.deepEqual(installed, { status: 'complete', reviewed: PROVENANCE, recorded: PROVENANCE });
  assert.deepEqual(requested, [archiveUrl(COMMIT)], 'the pinned archive is the only acquisition');
  assert.deepEqual(readFileSync(join(project, '.claude/skills/review-checklist/SKILL.md')), skill);
  assert.deepEqual(readFileSync(join(project, '.claude/skills/review-checklist/LICENSE')), license);
  const row = (await inventory(project)).selections[0];
  assert.deepEqual([row.name, row.kind, row.tool, row.materialSource, row.installState], ['Review checklist', 'skill', 'claude', PROVENANCE, 'complete']);
  // Nothing from the archive was extracted or kept outside the reviewed targets.
  assert.equal(existsSync(join(project, 'recipe.json')), false);
  assert.equal(readdirSync(project).sort().join(','), '.claude,.secrets');
});

await check('another exact commit updates the recorded provenance through a fresh review', async () => {
  const project = workspace('next');
  await installFromExactCommit(project, pinnedSelection(archive));
  const nextArchive = gitArchive(tree, NEXT);
  served.set(archiveUrl(NEXT), nextArchive);
  const moved = await installFromExactCommit(project, pinnedSelection(nextArchive, { commit: NEXT }));
  const expected = { ...PROVENANCE, commit: NEXT, identity: `example-org/team-skills@${NEXT}` };
  assert.deepEqual(moved, { status: 'complete', reviewed: expected, recorded: expected });
});

await check('branch names and every other moving or unproven reference are refused before any request', async () => {
  const project = workspace('moving');
  requested.length = 0;
  for (const [identity, reason] of [[{ commit: 'main' }, 'git-commit-not-exact'], [{ commit: COMMIT.slice(0, 12) }, 'git-commit-not-exact'],
    [{ commit: 'refs/tags/v1.0.0' }, 'git-commit-not-exact'], [{ reachable: 'unchecked' }, 'git-commit-not-reachable'],
    [{ url: archiveUrl('main') }, 'git-archive-not-exact'], [{ repository: 'https://gitlab.com/example-org/team-skills' }, 'git-repository-unsupported']]) {
    const selection = pinnedSelection(archive, identity);
    const installed = await installFromExactCommit(project, selection);
    assert.equal(installed.status, 'invalid', JSON.stringify(identity));
    assert.deepEqual(installed.diagnostics.map(item => [item.code, item.reason]), [['INPUT_INVALID', reason]]);
    assert.deepEqual(validatePolicy(policy(selection)).diagnostics.map(item => item.reason), [reason]);
  }
  assert.deepEqual(requested, [], 'Core resolves nothing and fetches nothing for a refused identity');
  assert.equal(existsSync(join(project, '.claude')), false);
});

await check('archive and material mismatches are refused and nothing is written', async () => {
  const project = workspace('mismatch');
  const otherCommit = gitArchive(tree, NEXT);
  served.set(archiveUrl(COMMIT), otherCommit);
  const wrongCommit = await installFromExactCommit(project, pinnedSelection(otherCommit));
  assert.deepEqual(wrongCommit.diagnostics.map(item => item.reason), ['git-archive-commit-mismatch']);
  served.set(archiveUrl(COMMIT), archive);
  const wrongPin = await installFromExactCommit(project, pinnedSelection(otherCommit, { commit: COMMIT }));
  // The served bytes are not the pinned archive: their length or digest differs from the pin.
  assert.equal(wrongPin.diagnostics.length, 1, JSON.stringify(wrongPin));
  assert.ok(['archive-identity-mismatch', 'archive-length-mismatch'].includes(wrongPin.diagnostics[0].reason), JSON.stringify(wrongPin));
  const tampered = { ...tree, 'skills/review-checklist/SKILL.md': Buffer.from('Tampered.\n') };
  const tamperedArchive = gitArchive(tampered, COMMIT);
  served.set(archiveUrl(COMMIT), tamperedArchive);
  const wrongMember = await installFromExactCommit(project, pinnedSelection(tamperedArchive));
  assert.deepEqual(wrongMember.diagnostics.map(item => item.reason), ['member-identity-mismatch']);
  served.set(archiveUrl(COMMIT), archive);
  const incomplete = await installFromExactCommit(project, pinnedSelection(archive, { materials: [
    { id: 'license', path: `${PREFIX}skills/review-checklist/LICENSE`, sha256: sha256(license), byteLength: license.length }] }));
  assert.equal(incomplete.status, 'invalid', 'the named closure must match the recipe');
  assert.equal(existsSync(join(project, '.claude')), false);
});

await check('a target changed after the review is stale at Apply and nothing is written', async () => {
  const project = workspace('stale');
  const prepared = keep(await prepare({ useCase: 'policy', policy: policy(pinnedSelection(archive)), target: { project } }, controls));
  assert.equal(prepared.status, 'ready');
  mkdirSync(join(project, '.claude/skills/review-checklist'), { recursive: true });
  writeFileSync(join(project, '.claude/skills/review-checklist/SKILL.md'), 'Written after the review.\n');
  const stale = keep(await apply(prepared.prepared, approve(prepared.review), controls));
  assert.deepEqual([stale.completion, stale.diagnostics.map(item => [item.code, item.reason, item.changed])],
    ['rejected', [['REVIEW_STALE', 'binding-changed', 'target-file']]]);
  assert.equal(readFileSync(join(project, '.claude/skills/review-checklist/SKILL.md'), 'utf8'), 'Written after the review.\n');
  assert.equal((await inventory(project)).selections.length, 0);
});

await check('every output conforms to its published schema and no private value reaches outputs or history', async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const id of ['prepared-work/1.0.0', 'prepared-work/1.1.0', 'prepared-work/1.4.0', 'prepared-work/1.5.0', 'prepared-work/1.6.0',
    'run-result/1.0.0', 'run-result/1.1.0', 'run-result/1.4.0', 'managed-inventory-result/1.0.0', 'managed-inventory-result/1.1.0'])
    ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@aihq/core/schemas/${id}.json`))));
  let validated = 0;
  for (const document of outputs) {
    const schema = document?.review?.schema ?? document?.schema;
    const subject = document?.review ?? document;
    const validate = schema && ajv.getSchema(schema);
    if (!validate) continue;
    assert.equal(validate(JSON.parse(JSON.stringify(subject))), true, `${schema}: ${JSON.stringify(validate.errors)}`);
    validated++;
  }
  assert.ok(validated >= 10, `validated ${validated}`);
  assert.ok(contractSupport.contracts.some(item => item.id === 'urn:aihq:core:execution-policy:1.4.0' && item.role === 'accepts'));
  const runs = join(resolveStateLocation().root, 'runs');
  const history = existsSync(runs) ? readdirSync(runs).map(name => readFileSync(join(runs, name), 'utf8')) : [];
  assert.ok(history.length > 0);
  const text = [...outputs.map(value => JSON.stringify(value)), ...history].join('\n');
  for (const forbidden of [SECRET, sha256(SECRET)]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.ok(text.includes(`example-org/team-skills@${COMMIT}`), 'history keeps the reviewed provenance');
});

process.stdout.write(`${JSON.stringify({ status: 'passed', checks })}\n`);
