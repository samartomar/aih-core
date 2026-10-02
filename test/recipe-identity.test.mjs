// Regression tests for samartomar/aihq#89: recipe identity must order materials by
// ascending UTF-16 code-unit order of `id`, never by runtime locale collation.
// Expected identities are independent known-answer vectors: each digest is the
// node:crypto SHA-256 of a canonical descriptor JSON string written literally
// below (keys in code-unit order, materials in the stated order, no whitespace).
// Core's canonical/sort helpers are never called to derive them.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../dist/core/index.js';
import { orgSource, orgRoutes, fakeFetch } from './fixtures/github-org.mjs';

const sha256hex = value => createHash('sha256').update(value, 'utf8').digest('hex');

// --- Recipe whose material ids order differently under code-unit vs locale collation.
// Code-unit order: A1 B a-b a.b a1 a_b aa b. en-US collation: a_b a-b a.b a1 A1 aa b B.
const RECIPE_MIXED_JSON = '{"checks":[],"description":"Recipe with mixed-case and punctuation material ids","id":"mixed-materials","inputs":{},"materials":[{"byteLength":12,"id":"A1","path":"f0-A1.txt","sha256":"98200326b665fd9976a7df63663099d3d372c353db4dd3a13a81713bcbfd243b","source":{"input":"materials","kind":"local"}},{"byteLength":11,"id":"B","path":"f1-B.txt","sha256":"e3b8148db68260155ada2ae4770ce3f48355cee7c2f17fe0d1d111ddc3de50a8","source":{"input":"materials","kind":"local"}},{"byteLength":13,"id":"a-b","path":"f2-a-b.txt","sha256":"2326e9745b34cde5eae5ff28204e8bf55667b425d767fb74896565c2eb96c403","source":{"input":"materials","kind":"local"}},{"byteLength":13,"id":"a.b","path":"f3-a.b.txt","sha256":"1c1fd0d197b6c2b69a253d0ed6536e6cbdf3f4e452308ce607010d36238c70fc","source":{"input":"materials","kind":"local"}},{"byteLength":12,"id":"a1","path":"f4-a1.txt","sha256":"6bac00030cd84f547333ebbb3c0eee7bd22bc4fd0c17b1dc3b31518f29435bd6","source":{"input":"materials","kind":"local"}},{"byteLength":13,"id":"a_b","path":"f5-a_b.txt","sha256":"c5f40b8683d9520b0b8fca1e55f7774faf993fa9e406eda02c3105a71d817fbf","source":{"input":"materials","kind":"local"}},{"byteLength":12,"id":"aa","path":"f6-aa.txt","sha256":"a63b0058249eb9b446f9480462817e3a53a51dd24048d381a2fb2e7af36ff68d","source":{"input":"materials","kind":"local"}},{"byteLength":11,"id":"b","path":"f7-b.txt","sha256":"79ce1984618972c71b02e1d0824255bf64e6fe1be9811b305c5c30abe6255d65","source":{"input":"materials","kind":"local"}}],"operations":[{"checks":[],"content":{"literal":"team guidance"},"id":"write","kind":"file.write","purpose":"Write shared project guidance","requires":[],"scope":"project","target":{"root":"project","segments":[{"literal":"TEAM.md"}]}}],"prerequisites":[],"schema":"urn:aihq:core:recipe:1.0.0","targets":["project"]}';
const RECIPE_MIXED_SHA256 = 'a4c729f1da367073eef20b2e1a8fafdae84aca18bc1595c911cacdf5734948e1';
const DESCRIPTOR_MIXED_CODE_UNIT_JSON = '{"materials":[{"byteLength":12,"id":"A1","sha256":"98200326b665fd9976a7df63663099d3d372c353db4dd3a13a81713bcbfd243b"},{"byteLength":11,"id":"B","sha256":"e3b8148db68260155ada2ae4770ce3f48355cee7c2f17fe0d1d111ddc3de50a8"},{"byteLength":13,"id":"a-b","sha256":"2326e9745b34cde5eae5ff28204e8bf55667b425d767fb74896565c2eb96c403"},{"byteLength":13,"id":"a.b","sha256":"1c1fd0d197b6c2b69a253d0ed6536e6cbdf3f4e452308ce607010d36238c70fc"},{"byteLength":12,"id":"a1","sha256":"6bac00030cd84f547333ebbb3c0eee7bd22bc4fd0c17b1dc3b31518f29435bd6"},{"byteLength":13,"id":"a_b","sha256":"c5f40b8683d9520b0b8fca1e55f7774faf993fa9e406eda02c3105a71d817fbf"},{"byteLength":12,"id":"aa","sha256":"a63b0058249eb9b446f9480462817e3a53a51dd24048d381a2fb2e7af36ff68d"},{"byteLength":11,"id":"b","sha256":"79ce1984618972c71b02e1d0824255bf64e6fe1be9811b305c5c30abe6255d65"}],"recipeSha256":"a4c729f1da367073eef20b2e1a8fafdae84aca18bc1595c911cacdf5734948e1","schema":"urn:aihq:core:recipe-identity:1.0.0"}';
const DESCRIPTOR_MIXED_LEGACY_JSON = '{"materials":[{"byteLength":13,"id":"a_b","sha256":"c5f40b8683d9520b0b8fca1e55f7774faf993fa9e406eda02c3105a71d817fbf"},{"byteLength":13,"id":"a-b","sha256":"2326e9745b34cde5eae5ff28204e8bf55667b425d767fb74896565c2eb96c403"},{"byteLength":13,"id":"a.b","sha256":"1c1fd0d197b6c2b69a253d0ed6536e6cbdf3f4e452308ce607010d36238c70fc"},{"byteLength":12,"id":"a1","sha256":"6bac00030cd84f547333ebbb3c0eee7bd22bc4fd0c17b1dc3b31518f29435bd6"},{"byteLength":12,"id":"A1","sha256":"98200326b665fd9976a7df63663099d3d372c353db4dd3a13a81713bcbfd243b"},{"byteLength":12,"id":"aa","sha256":"a63b0058249eb9b446f9480462817e3a53a51dd24048d381a2fb2e7af36ff68d"},{"byteLength":11,"id":"b","sha256":"79ce1984618972c71b02e1d0824255bf64e6fe1be9811b305c5c30abe6255d65"},{"byteLength":11,"id":"B","sha256":"e3b8148db68260155ada2ae4770ce3f48355cee7c2f17fe0d1d111ddc3de50a8"}],"recipeSha256":"a4c729f1da367073eef20b2e1a8fafdae84aca18bc1595c911cacdf5734948e1","schema":"urn:aihq:core:recipe-identity:1.0.0"}';
const IDENTITY_MIXED_CODE_UNIT = 'sha256:18ef40d0e01343d35cd6308b134b35641313f963bb76dadb7ee29baa8e5ba28f';
const IDENTITY_MIXED_LEGACY = 'sha256:90a0e0a198e91fdf2825fc47fd6358ef3f8881c403f34dba5e53119021a1638c';

// --- Recipe whose material ids order identically under both rules: identity unchanged.
const RECIPE_PAIR_JSON = '{"checks":[],"description":"Recipe whose material ids agree under both orderings","id":"ordered-pair","inputs":{},"materials":[{"byteLength":17,"id":"license","path":"f0-license.txt","sha256":"2d32f42970fedcf77a2e15da602f0c5baa044264bcee18a3510cfd0d315ffb75","source":{"input":"materials","kind":"local"}},{"byteLength":15,"id":"skill","path":"f1-skill.txt","sha256":"93d239902a529aa6fc29a356dc995d47d7f2ab46658d05b7adb6785db4f69b6b","source":{"input":"materials","kind":"local"}}],"operations":[{"checks":[],"content":{"literal":"team guidance"},"id":"write","kind":"file.write","purpose":"Write shared project guidance","requires":[],"scope":"project","target":{"root":"project","segments":[{"literal":"TEAM.md"}]}}],"prerequisites":[],"schema":"urn:aihq:core:recipe:1.0.0","targets":["project"]}';
const RECIPE_PAIR_SHA256 = '2fc967c9e351200d62bf36f4d0079ed698d171aee165c814d88fe108874ed792';
const DESCRIPTOR_PAIR_JSON = '{"materials":[{"byteLength":17,"id":"license","sha256":"2d32f42970fedcf77a2e15da602f0c5baa044264bcee18a3510cfd0d315ffb75"},{"byteLength":15,"id":"skill","sha256":"93d239902a529aa6fc29a356dc995d47d7f2ab46658d05b7adb6785db4f69b6b"}],"recipeSha256":"2fc967c9e351200d62bf36f4d0079ed698d171aee165c814d88fe108874ed792","schema":"urn:aihq:core:recipe-identity:1.0.0"}';
const IDENTITY_PAIR = 'sha256:df1a317e3dd4769ceecb85cd34f7848c91a278b74bfc7eedaed0f109c99fc19c';

// Local material bytes served to Core capture; paths are unique on case-insensitive
// filesystems (A1/a1 and B/b would collide as bare names). Content is `material:<id>\n`.
const MATERIAL_FILES = [
  ['A1', 'f0-A1.txt'], ['B', 'f1-B.txt'], ['a-b', 'f2-a-b.txt'], ['a.b', 'f3-a.b.txt'],
  ['a1', 'f4-a1.txt'], ['a_b', 'f5-a_b.txt'], ['aa', 'f6-aa.txt'], ['b', 'f7-b.txt'],
  ['license', 'f0-license.txt'], ['skill', 'f1-skill.txt']
];

const scratch = mkdtempSync(join(tmpdir(), 'aih-recipe-identity-'));
const home = join(scratch, 'home');
const materialRoot = join(scratch, 'materials');
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const originalFetch = globalThis.fetch;
before(() => {
  mkdirSync(home);
  mkdirSync(materialRoot);
  for (const [id, path] of MATERIAL_FILES) writeFileSync(join(materialRoot, path), `material:${id}\n`);
  process.env.HOME = home; process.env.USERPROFILE = home;
});
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  for (const [key, value] of Object.entries(previousHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true });
});

const policy = recipeJson => ({
  schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'enterprise',
  selections: [{
    id: 'guidance', managementId: 'team-guidance', scope: 'project', configuration: {}, requires: [],
    organizationSelectionId: 'project-guidance', recipe: { inline: JSON.parse(recipeJson) }
  }]
});
const orgDocument = recipeIdentity => ({
  schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'org-policy',
  selections: [{ selectionId: 'project-guidance', recipeIdentity, scopes: ['project'], inputs: {} }]
});
function runPrepare(recipeJson, recipeIdentity) {
  const target = mkdtempSync(join(scratch, 'project-'));
  globalThis.fetch = fakeFetch(orgRoutes({ bytes: Buffer.from(JSON.stringify(orgDocument(recipeIdentity))) }));
  return prepare({ useCase: 'policy', policy: policy(recipeJson), target: { project: target }, organizationSource: orgSource() },
    { logging: 'off', materialRoots: { materials: materialRoot } });
}

test('the literal vectors are self-consistent known answers', () => {
  for (const [id, path] of MATERIAL_FILES) {
    const descriptor = `"id":"${id}","path":"${path}"`;
    const hash = sha256hex(`material:${id}\n`);
    assert.ok(RECIPE_MIXED_JSON.includes(descriptor) || RECIPE_PAIR_JSON.includes(descriptor), `material binding ${id}`);
    assert.ok(RECIPE_MIXED_JSON.includes(hash) || RECIPE_PAIR_JSON.includes(hash), `material digest ${id}`);
  }
  assert.equal(sha256hex(RECIPE_MIXED_JSON), RECIPE_MIXED_SHA256);
  assert.equal(`sha256:${sha256hex(DESCRIPTOR_MIXED_CODE_UNIT_JSON)}`, IDENTITY_MIXED_CODE_UNIT);
  assert.equal(`sha256:${sha256hex(DESCRIPTOR_MIXED_LEGACY_JSON)}`, IDENTITY_MIXED_LEGACY);
  assert.equal(sha256hex(RECIPE_PAIR_JSON), RECIPE_PAIR_SHA256);
  assert.equal(`sha256:${sha256hex(DESCRIPTOR_PAIR_JSON)}`, IDENTITY_PAIR);
});

test('an organization entry carrying the code-unit ordered identity admits the selection', async () => {
  const result = await runPrepare(RECIPE_MIXED_JSON, IDENTITY_MIXED_CODE_UNIT);
  assert.equal(result.status, 'ready', JSON.stringify(result.diagnostics));
});

test('an organization entry carrying the legacy collation ordered identity is denied', async () => {
  const result = await runPrepare(RECIPE_MIXED_JSON, IDENTITY_MIXED_LEGACY);
  assert.equal(result.status, 'blocked', JSON.stringify(result.diagnostics));
  assert.equal(result.prepared, undefined);
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every(item => item.code === 'AUTHORITY_DENIED'), JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some(item => item.reason === 'recipe-identity'), JSON.stringify(result.diagnostics));
});

test('a recipe whose ids agree under both orderings keeps its identity', async () => {
  const result = await runPrepare(RECIPE_PAIR_JSON, IDENTITY_PAIR);
  assert.equal(result.status, 'ready', JSON.stringify(result.diagnostics));
});

// Child probe: admits/denies the mixed recipe and prints the outcomes plus the
// collated order of the material ids. Node 24 on Windows accepts no --icu-locale
// option and ignores LANG/LC_ALL for the ICU default locale, so the probe pins the
// default collation itself: it replaces String.prototype.localeCompare with an
// Intl.Collator for the requested tag BEFORE Core is imported, which is exactly the
// call shape a different default locale would produce for Core's no-argument
// localeCompare calls. The parent requires byte-identical outcomes under every tag.
const CHILD_PROBE = `
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
const tag = process.env.AIH_PROBE_LOCALE;
if (tag) {
  const collator = new Intl.Collator(tag);
  String.prototype.localeCompare = function (that) { return collator.compare(String(this), String(that)); };
}
const home = process.env.AIH_PROBE_HOME;
mkdirSync(home, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home;
const { prepare } = await import(process.env.AIH_PROBE_CORE);
const { orgSource, orgRoutes, fakeFetch } = await import(process.env.AIH_PROBE_FIXTURES);
const recipe = JSON.parse(process.env.AIH_PROBE_RECIPE);
const run = async recipeIdentity => {
  const document = { schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'org-policy',
    selections: [{ selectionId: 'project-guidance', recipeIdentity, scopes: ['project'], inputs: {} }] };
  globalThis.fetch = fakeFetch(orgRoutes({ bytes: Buffer.from(JSON.stringify(document)) }));
  const policy = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'enterprise', selections: [{
    id: 'guidance', managementId: 'team-guidance', scope: 'project', configuration: {}, requires: [],
    organizationSelectionId: 'project-guidance', recipe: { inline: recipe } }] };
  const result = await prepare({ useCase: 'policy', policy,
    target: { project: mkdtempSync(join(home, 'project-')) }, organizationSource: orgSource() },
    { logging: 'off', materialRoots: { materials: process.env.AIH_PROBE_MATERIALS } });
  return { status: result.status, findings: result.diagnostics.map(item => item.code + ':' + item.reason) };
};
const codeUnit = await run(process.env.AIH_PROBE_CODE_UNIT_IDENTITY);
const legacy = await run(process.env.AIH_PROBE_LEGACY_IDENTITY);
const order = recipe.materials.map(item => item.id).sort((a, b) => a.localeCompare(b));
process.stdout.write(JSON.stringify({ order, codeUnit, legacy }));
`;

test('identity and admission outcomes are identical across runtime locales', () => {
  const enUsOrder = ['a_b', 'a-b', 'a.b', 'a1', 'A1', 'aa', 'b', 'B'];
  const daOrder = ['a_b', 'a-b', 'a.b', 'A1', 'a1', 'B', 'b', 'aa'];
  const locales = [
    ['en-US', 'en_US.UTF-8', enUsOrder], ['da', 'da_DK.UTF-8', daOrder],
    ['tr', 'tr_TR.UTF-8', enUsOrder], ['sv', 'sv_SE.UTF-8', enUsOrder],
    ['', '', enUsOrder] // unmodified runtime default locale
  ];
  const expected = {
    codeUnit: { status: 'ready', findings: [] },
    legacy: { status: 'blocked', findings: ['AUTHORITY_DENIED:recipe-identity'] }
  };
  const outcomes = [];
  for (const [icu, lang, expectedOrder] of locales) {
    const label = icu || 'default';
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD_PROBE], {
      encoding: 'utf8', timeout: 120_000,
      env: {
        ...process.env, LANG: lang, LC_ALL: lang,
        AIH_PROBE_LOCALE: icu,
        AIH_PROBE_HOME: join(scratch, `probe-${label}`),
        AIH_PROBE_CORE: new URL('../dist/core/index.js', import.meta.url).href,
        AIH_PROBE_FIXTURES: new URL('./fixtures/github-org.mjs', import.meta.url).href,
        AIH_PROBE_RECIPE: RECIPE_MIXED_JSON,
        AIH_PROBE_MATERIALS: materialRoot,
        AIH_PROBE_CODE_UNIT_IDENTITY: IDENTITY_MIXED_CODE_UNIT,
        AIH_PROBE_LEGACY_IDENTITY: IDENTITY_MIXED_LEGACY
      }
    });
    assert.equal(child.status, 0, `${label} probe failed: ${child.stderr}\n${child.stdout}`);
    const outcome = JSON.parse(child.stdout);
    assert.deepEqual(outcome.order, expectedOrder, `${label} collation did not take effect`);
    outcomes.push([label, { codeUnit: outcome.codeUnit, legacy: outcome.legacy }]);
  }
  for (const [label, outcome] of outcomes) assert.deepEqual(outcome, expected, `${label}: ${JSON.stringify(outcome)}`);
  assert.deepEqual(outcomes.map(([, outcome]) => outcome), outcomes.map(() => outcomes[0][1]),
    `locale-dependent outcomes: ${JSON.stringify(outcomes)}`);
});
