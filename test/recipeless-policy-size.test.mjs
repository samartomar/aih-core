// Size proof for the first product: Claude Code with ECC's default pick and its full TypeScript profile, each the size
// the packed Catalog resolves it to. With recipe-less selections both execution policies fit Core's 5 MiB policy
// bound, and each is smaller than its inline form. The default pick's recipe-less policy
// prepares and applies into a disposable project, and writes exactly the paths and bytes the inline form writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { apply, prepare } from '../dist/core/index.js';
import { parsePolicy, validatePolicy } from '../dist/core/contracts.js';
import { canonical, catalogPack, composePolicy, eccDefault, eccFullTypescript, policyBytes, privateInputsFor, resolvedCount, sha256 }
  from './fixtures/catalog-pack.mjs';

const POLICY_BOUND = 5_242_880;
const pack = await catalogPack();
const skip = pack.skip;
const scratch = mkdtempSync(join(tmpdir(), 'aih-recipeless-size-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
  if (pack.folder) rmSync(pack.folder, { recursive: true, force: true });
});
const controls = privateInputs => ({ logging: 'off', materialRoots: { catalog: pack.root }, ...(privateInputs ? { privateInputs } : {}) });
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
const project = name => { const folder = join(scratch, name); mkdirSync(folder); return realpathSync(folder); };
/** Every file member the runs wrote, by project-relative path, with the bytes now at that path. */
const filesWritten = (runs, folder) => [...new Map(runs.flatMap(run => run.members).filter(member => member.outcome === 'written')
  .map(member => [relative(folder, member.path), sha256(readFileSync(member.path))])).entries()].sort();
/** Every receipt member, by management id: kind, project-relative path and pointer, block or group. */
const receipts = (runs, folder) => runs.flatMap(run => run.members).map(member => canonical({ managementId: member.managementId,
  kind: member.kind, path: relative(folder, member.path), pointer: member.pointer ?? null, blockId: member.blockId ?? null,
  groupId: member.groupId ?? null, outcome: member.outcome })).sort();

const sets = skip ? {} : { default: eccDefault(pack), full: eccFullTypescript(pack) };
const picks = skip ? {} : Object.fromEntries(Object.entries(sets).map(([name, pick]) => [name, composePolicy(pack, { sets: pick, recipeless: true })]));

test('the ECC default pick and full TypeScript profile fit the policy byte bound with recipe-less selections', { skip }, () => {
  const sizes = {};
  for (const [name, policy] of Object.entries(picks)) {
    assert.equal(policy.selections.length, resolvedCount(pack, { sets: sets[name] }), `${name} selections`);
    const bytes = policyBytes(policy);
    sizes[name] = bytes;
    console.log(`${name}: ${policy.selections.length} recipe-less selections, ${bytes} policy bytes (bound ${POLICY_BOUND})`);
    assert.ok(bytes < POLICY_BOUND, `${name} is ${bytes} bytes`);
  }
  // The bound is Core's own: the serialized default pick parses and validates.
  const parsed = parsePolicy(JSON.stringify(picks.default) + '\n');
  assert.equal(parsed.valid, true, JSON.stringify(parsed.diagnostics));
  assert.equal(validatePolicy(picks.default).valid, true);
  // The full profile fits the byte bound, but its one ECC notices selection is required by every other item, and
  // execution policy 1.5.0's limit of 256 origins per selection, unchanged in 1.6.0, refuses it there and only there.
  const notices = picks.full.selections.findIndex(selection => selection.item.itemId === 'ecc.notices');
  const origins = picks.full.selections[notices].origins.length;
  console.log(`full: ecc.notices carries ${origins} origins (schema limit 256)`);
  assert.equal(origins, picks.full.selections.length - 1);
  assert.ok(origins > 256, 'the full profile is past the origin limit');
  assert.deepEqual(validatePolicy(picks.full).diagnostics.map(item => [item.reason, item.path]),
    [['maxItems', `/selections/${notices}/origins`]]);
  // Each inline form is larger than its recipe-less one.
  for (const [name, pick] of Object.entries(sets)) {
    const inline = composePolicy(pack, { sets: pick, recipeless: false });
    console.log(`${name} inline: ${policyBytes(inline)} policy bytes`);
    assert.ok(policyBytes(inline) > sizes[name], `${name} inline is larger`);
  }
  assert.ok(sizes.full < POLICY_BOUND && sizes.default < sizes.full);
});

test('the default pick\'s recipe-less policy applies into a disposable project and writes what the inline form writes', { skip, timeout: 600_000 }, async () => {
  const recipeless = picks.default;
  const folder = project('recipeless');
  // Required server inputs the pick has, if any: the sensitive ones go only in the live request.
  const secrets = privateInputsFor(pack, recipeless);
  const prepared = await prepare({ useCase: 'policy', policy: recipeless, target: { project: folder } }, controls(secrets));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared), controls(secrets));
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  // The inline form can be over the policy bound, so it is applied as consecutive policies under the bound, in
  // dependency order; a requirement on an earlier policy's selection is already installed when the later one applies.
  const inline = composePolicy(pack, { sets: sets.default, recipeless: false });
  const ids = new Set(inline.selections.map(selection => selection.id));
  assert.equal(ids.size, recipeless.selections.length);
  const order = []; const seen = new Set();
  const visit = id => { if (seen.has(id)) return; seen.add(id); for (const dependency of inline.selections.find(item => item.id === id).requires) visit(dependency); order.push(id); };
  for (const selection of inline.selections) visit(selection.id);
  const ordered = order.map(id => inline.selections.find(selection => selection.id === id));
  const chunks = [];
  for (const selection of ordered) {
    const last = chunks.at(-1);
    if (last && policyBytes({ ...inline, selections: [...last, selection] }) < 900_000) last.push(selection); else chunks.push([selection]);
  }
  const target = project('inline');
  const runs = [];
  for (const chunk of chunks) {
    const inChunk = new Set(chunk.map(selection => selection.id));
    const policy = { ...inline, selections: chunk.map(selection => ({ ...selection, requires: selection.requires.filter(id => inChunk.has(id)) })) };
    const chunkSecrets = Object.fromEntries(Object.entries(secrets).filter(([id]) => inChunk.has(id)));
    const step = await prepare({ useCase: 'policy', policy, target: { project: target } }, controls(chunkSecrets));
    assert.equal(step.status, 'ready', JSON.stringify(step.diagnostics));
    const ran = await apply(step.prepared, approve(step), controls(chunkSecrets));
    assert.equal(ran.completion, 'complete', JSON.stringify(ran.diagnostics));
    runs.push(ran);
  }
  console.log(`default: inline form applied as ${chunks.length} policies; recipe-less as one`);
  const expected = filesWritten(runs, target), actual = filesWritten([run], folder);
  console.log(`default: ${actual.length} files written for ${recipeless.selections.length} selections`);
  assert.ok(actual.length > recipeless.selections.length);
  assert.deepEqual(actual, expected, 'the same paths with the same SHA-256');
  assert.deepEqual(receipts([run], folder), receipts(runs, target), 'the same receipt members');
});
