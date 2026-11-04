// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Enterprise admission (contract 11, journey 9). Organization documents are local fixture files (no GitHub reads); the
// plan, content and profile documents are Core-side FIXTURES (plan-fixture.mjs) and `@aihq/catalog` beside Core is the
// Core-side reader FIXTURE. The Scan signer here is a fixture value: it is carried and shown, never verified.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewAdmission, refusalCodes, schemas, validateFormat, validateOrganizationPolicy } from '@aihq/core/contracts';
import { apply, list, prepare } from '@aihq/core';
import * as reader from '@aihq/catalog/reader';
import { ownRequest, renderRequest, savedDocument } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME;
const ORGANIZATION = 'urn:aihq:core:organization:0.1.0';
const CODEX = { id: 'codex', surface: 'cli' };
const SKILLS = { notes: { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nTake notes.\n' } };
const SIGNER = { identity: 'acme-scan', issuer: 'https://token.actions.githubusercontent.com', subject: 'https://github.com/acme/scan/.github/workflows/scan.yml@refs/heads/main' };
const catalog = { version: '0.0.0-core-fixture', renderStep: reader.renderStep, planRecipe: reader.planRecipe };
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const project = name => mkdtempSync(join(home, `${name}-`));
const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
const aih = args => {
  const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
};
const enterprise = request => ({ ...request, mode: 'enterprise', target: { ...request.target, client: CODEX } });
const document = (entries, extra = {}) => ({ schema: ORGANIZATION, id: 'acme', entries, ...extra });
function organizationFile(value) {
  const path = join(home, `org-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return { provider: 'local', path };
}
/** A request saved without bytes, plus its source folder for `--source`. */
function saved(request, folder) {
  for (const file of request.files) { mkdirSync(dirname(join(folder, file.sourcePath)), { recursive: true }); writeFileSync(join(folder, file.sourcePath), file.bytes); }
  const path = join(folder, '..', `${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(savedDocument(request)));
  return { file: path, folder };
}
const ORG = document([
  { id: 'need-notes', obligation: 'required', scopes: ['project'], clients: ['codex'], content: { recipe: { id: 'notes-base' } } }],
{ sources: { own: { kinds: ['skill', 'rule'] } }, scanSigners: { add: [SIGNER] } });
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('the organization format, its codes and the browser-safe preview are published', async () => {
  for (const code of ['AUTHORITY_DENIED', 'organization-required', 'organization-unavailable']) assert.ok(refusalCodes.some(entry => entry.code === code), code);
  assert.equal(validateFormat(schemas[ORGANIZATION].fixtures.valid).status, 'ok');
  assert.equal(validateFormat(schemas[ORGANIZATION].fixtures.invalid).status, 'invalid');
  assert.equal(validateOrganizationPolicy(ORG).status, 'ok');
  const preview = await previewAdmission({ organization: ORG, request: savedDocument(ownRequest(project('preview'), SKILLS, ['codex'])), target: { client: CODEX } });
  assert.deepEqual([preview.status, preview.value.admitted, preview.value.fulfilment[0].status], ['ok', true, 'not-fulfilled']);
});

await check('API: sources.own denies own-content hooks naming the rule; a proven ecc-style recipe fulfils the requirement; a hand-edited claim is chosen and not fulfilled; the organization signer shows', async () => {
  const source = organizationFile(ORG);
  const hooks = enterprise(ownRequest(project('hooks'), SKILLS, ['codex']));
  for (const item of hooks.contents[0].items) item.kind = 'hook';
  const denied = await prepare(hooks, { organization: source });
  assert.deepEqual([denied.status, denied.code, denied.review.organization.denials[0].rule], ['blocked', 'AUTHORITY_DENIED', 'sources.own']);
  assert.equal(denied.handle, undefined);

  const forgedAt = project('forged');
  const forged = enterprise(renderRequest(reader, forgedAt, SKILLS, ['codex'], { recipe: true }));
  forged.recipeProof.recipeJson = forged.recipeProof.recipeJson.replace('notes-base', 'notes-base ');
  const unproven = await prepare(forged, { organization: source, catalog });
  assert.deepEqual([unproven.status, unproven.review.origin, unproven.review.organization.fulfilment[0].status], ['ready', 'chosen', 'not-fulfilled']);
  const unprovenRun = conforms(await apply(unproven.handle, approve(unproven.review), { organization: source, catalog }));
  assert.equal(unprovenRun.organization.fulfilment[0].status, 'not-fulfilled');

  const where = project('proven');
  const proven = await prepare(enterprise(renderRequest(reader, where, SKILLS, ['codex'], { recipe: true })), { organization: source, catalog });
  conforms(proven.review);
  assert.deepEqual([proven.status, proven.review.organization.fulfilment[0].status], ['ready', 'fulfilled']);
  assert.deepEqual(proven.review.organization.scanSigners, { add: [SIGNER] });
  const run = conforms(await apply(proven.handle, approve(proven.review), { organization: source, catalog }));
  assert.deepEqual([run.completion, run.organization.fulfilment[0].status], ['complete', 'fulfilled']);
  const listed = conforms(await list({ target: { project: where }, scope: 'project' }));
  assert.equal(listed.entries[0].origin.recipe.id, 'notes-base');
});

await check('CLI: install and remove take --mode enterprise --org-file; a denial exits 1 naming the rule; validate reads organization documents', async () => {
  const org = organizationFile(document([{ id: 'no-notes-removal', obligation: 'recommended', content: { kind: 'skill' } }], { sources: { own: { kinds: ['skill'] } } }));
  const where = project('cli');
  const request = enterprise(ownRequest(where, SKILLS, ['codex']));
  const { file, folder } = saved(request, join(where, '..', `src-${Date.now()}`));
  const ok = aih(['install', file, '--source', `local-my-skills=${folder}`, '--mode', 'enterprise', '--org-file', org.path, '--apply', '--yes', '--json']);
  assert.equal(ok.code, 0, JSON.stringify(ok.result));
  assert.deepEqual([ok.result.completion, ok.result.organization.id], ['complete', 'acme']);
  const hooks = enterprise(ownRequest(where, SKILLS, ['codex']));
  for (const item of hooks.contents[0].items) item.kind = 'hook';
  const hooked = saved(hooks, join(where, '..', `src-hooks-${Date.now()}`));
  const denied = aih(['install', hooked.file, '--source', `local-my-skills=${hooked.folder}`, '--mode', 'enterprise', '--org-file', org.path, '--json']);
  assert.deepEqual([denied.code, denied.result.status, denied.result.code], [1, 'blocked', 'AUTHORITY_DENIED']);
  assert.match(denied.result.reason, /sources\.own/);
  const vibe = aih(['install', file, '--source', `local-my-skills=${folder}`, '--org-file', org.path, '--json']);
  assert.deepEqual([vibe.code, vibe.result.code], [2, 'usage']);
  const removed = aih(['remove', 'local-my-skills.skill.notes', '--scope', 'project', '--project', where, '--mode', 'enterprise', '--org-file', org.path, '--apply', '--yes', '--json']);
  assert.equal(removed.code, 0, JSON.stringify(removed.result));
  assert.equal(removed.result.completion, 'complete');
  assert.deepEqual(aih(['validate', 'organization', org.path, '--json']).code, 0);
  const broken = organizationFile(document([{ id: 'x', obligation: 'forbidden', content: { kind: 'hook' } }]));
  assert.deepEqual(aih(['validate', 'organization', broken.path, '--json']).code, 2);
});

console.log(JSON.stringify({ status: 'passed', checks }));
