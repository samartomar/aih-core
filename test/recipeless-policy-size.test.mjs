// Size proof for the first product: Claude Code with ECC's default pick (246 items) and its full TypeScript profile
// (476 items). With recipe-less selections both execution policies fit Core's 1,000,000-byte policy bound, which stays
// unchanged; the inline form does not. The 246-item policy prepares and applies into a disposable project, and writes
// exactly the paths and bytes the inline form writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { apply, prepare } from '../dist/core/index.js';
import { parsePolicy, validatePolicy } from '../dist/core/contracts.js';
import { canonical, catalogPack, composePolicy, eccDefault, eccFullTypescript, policyBytes, sha256 } from './fixtures/catalog-pack.mjs';

const POLICY_BOUND = 1_000_000;
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
const controls = () => ({ logging: 'off', materialRoots: { catalog: pack.root } });
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
const project = name => { const folder = join(scratch, name); mkdirSync(folder); return realpathSync(folder); };
/** Every file member the runs wrote, by project-relative path, with the bytes now at that path. */
const filesWritten = (runs, folder) => [...new Map(runs.flatMap(run => run.members).filter(member => member.outcome === 'written')
  .map(member => [relative(folder, member.path), sha256(readFileSync(member.path))])).entries()].sort();
/** Every receipt member, by management id: kind, project-relative path and pointer, block or group. */
const receipts = (runs, folder) => runs.flatMap(run => run.members).map(member => canonical({ managementId: member.managementId,
  kind: member.kind, path: relative(folder, member.path), pointer: member.pointer ?? null, blockId: member.blockId ?? null,
  groupId: member.groupId ?? null, outcome: member.outcome })).sort();

const picks = skip ? {} : { default246: composePolicy(pack, { sets: eccDefault(pack), recipeless: true }),
  full476: composePolicy(pack, { sets: eccFullTypescript(pack), recipeless: true }) };

test('the ECC default pick and full TypeScript profile fit the policy bound with recipe-less selections', { skip }, () => {
  const counts = { default246: 246, full476: 476 };
  const sizes = {};
  for (const [name, policy] of Object.entries(picks)) {
    assert.equal(policy.selections.length, counts[name], `${name} selections`);
    const bytes = policyBytes(policy);
    sizes[name] = bytes;
    console.log(`${name}: ${policy.selections.length} recipe-less selections, ${bytes} policy bytes (bound ${POLICY_BOUND})`);
    assert.ok(bytes < POLICY_BOUND, `${name} is ${bytes} bytes`);
    // The bound is Core's own: the serialized policy parses, and the policy object validates.
    const parsed = parsePolicy(JSON.stringify(policy) + '\n');
    assert.equal(parsed.valid, true, JSON.stringify(parsed.diagnostics));
    assert.equal(validatePolicy(policy).valid, true);
  }
  // The inline form of the same pick is what the bound refused.
  const inline = composePolicy(pack, { sets: eccDefault(pack), recipeless: false });
  console.log(`default246 inline: ${policyBytes(inline)} policy bytes`);
  assert.ok(policyBytes(inline) > POLICY_BOUND);
  assert.equal(parsePolicy(JSON.stringify(inline) + '\n').valid, false);
  assert.ok(sizes.full476 < POLICY_BOUND && sizes.default246 < sizes.full476);
});

test('the 246-item recipe-less policy applies into a disposable project and writes what the inline form writes', { skip, timeout: 600_000 }, async () => {
  const recipeless = picks.default246;
  const folder = project('recipeless');
  const prepared = await prepare({ useCase: 'policy', policy: recipeless, target: { project: folder } }, controls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared), controls());
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  // The inline form is over the policy bound, so it is applied as consecutive policies under the bound, in dependency
  // order; a requirement on an earlier policy's selection is already installed when the later one applies.
  const inline = composePolicy(pack, { sets: eccDefault(pack), recipeless: false });
  const ids = new Set(inline.selections.map(selection => selection.id));
  assert.equal(ids.size, 246);
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
    const step = await prepare({ useCase: 'policy', policy, target: { project: target } }, controls());
    assert.equal(step.status, 'ready', JSON.stringify(step.diagnostics));
    const ran = await apply(step.prepared, approve(step), controls());
    assert.equal(ran.completion, 'complete', JSON.stringify(ran.diagnostics));
    runs.push(ran);
  }
  console.log(`default246: inline form applied as ${chunks.length} policies; recipe-less as one`);
  const expected = filesWritten(runs, target), actual = filesWritten([run], folder);
  console.log(`default246: ${actual.length} files written`);
  assert.ok(actual.length > 246);
  assert.deepEqual(actual, expected, 'the same paths with the same SHA-256');
  assert.deepEqual(receipts([run], folder), receipts(runs, target), 'the same receipt members');
});
