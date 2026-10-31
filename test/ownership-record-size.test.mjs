// One pick installed for several tools writes a copy of each item per tool, and each copy owns a member per file, so a
// project's ownership record grows with tools × items × files. A person picking a few hundred items for every tool
// they use must still get a record Core can write. Ownership 1.7.0 stores the record without what it derives from
// itself (a file member's descriptor, claim data its selection record holds, an item's typed members, Catalog facts
// shared by tool copies), and reads every earlier record as it is.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { OWNERSHIP_RECORD_BYTES, admitOwnership, sealOwnership, validateOwnership } from '../dist/core/internal/state.js';
import { expandOwnership, storedOwnership } from '../dist/core/internal/ownership-storage.js';
import { sandbox } from './hook-group-fixture.mjs';

const OLD_LIMIT = 1_048_576;
const sha = value => createHash('sha256').update(value).digest('hex');
let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });
const open = () => { const s = sandbox('aih-record-size-'); live.push(s); return s; };
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
const receiptOf = s => join(s.home, '.aih', 'core', 'ownership', `${sha(realpathSync.native(s.project))}.json`);

const TOOLS = ['claude', 'codex', 'kiro', 'copilot', 'antigravity'];
const SET = { framework: 'example', setId: 'example.module.core', setSha256: sha('example.module.core') };
const id = (itemId, tool) => `project--aihq.catalog--${itemId}${tool === 'claude' ? '' : `--${tool}`}`;
const recipe = (name, paths) => ({ schema: 'urn:aihq:core:recipe:1.0.0', id: name, description: `Deliver ${name}`, inputs: {}, materials: [],
  targets: ['project'], prerequisites: [], checks: [], operations: paths.map((path, index) => ({ id: `write-${index}`, purpose: `Write ${path}`,
    kind: 'file.write', scope: 'project', target: { root: 'project', segments: path.split('/').map(literal => ({ literal })) },
    content: { literal: `${path}\n` }, requires: [], checks: [] })) });
const described = (itemId, tool, kind, origins) => ({ item: { framework: 'example', itemId, contentSha256: sha(`content:${itemId}`),
  behaviourSha256: sha(`behaviour:${itemId}`) }, tool, name: itemId.split('.').at(-1), kind, origins });
/**
 * The owner's shape: one copy per tool of each skill, each skill a folder of `files` files requiring the framework's
 * notices, which Claude's copy places once for every requirer.
 */
function pick(tools, items, files = 3) {
  const notices = { id: 'notices', managementId: id('example.notices', 'claude'), scope: 'project', configuration: {}, requires: [],
    recipe: { inline: recipe('claude.example.notices', ['.aih/notices/example/LICENSE']) },
    ...described('example.notices', 'claude', 'document', Array.from({ length: Math.min(items, 256) }, (_, index) =>
      ({ reasonIncluded: 'required-by', requiredBy: { framework: 'example', itemId: `example.skill.skill-${index}` } }))) };
  const copies = tools.flatMap(tool => Array.from({ length: items }, (_, index) => {
    const itemId = `example.skill.skill-${index}`;
    const folder = `.${tool}/skills/skill-${index}`;
    return { id: `${tool}-${index}`, managementId: id(itemId, tool), scope: 'project', configuration: {}, requires: ['notices'],
      recipe: { inline: recipe(`${tool}.${itemId}`, Array.from({ length: files }, (_, file) => `${folder}/${file === 0 ? 'SKILL.md' : `references/part-${file}.md`}`)) },
      ...described(itemId, tool, 'skill', [{ reasonIncluded: 'in-set', set: SET }]) };
  }));
  return { schema: 'urn:aihq:core:execution-policy:1.5.0', mode: 'vibe', selections: [notices, ...copies] };
}
async function install(s, policy) {
  const prepared = await prepare({ useCase: 'policy', policy, target: { project: s.project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  return run;
}

test('a 451-selection pick across five tools installs, keeps headroom in its record, and is removed', async () => {
  const s = open();
  const policy = pick(TOOLS, 90);
  assert.equal(policy.selections.length, 451);
  await install(s, policy);
  const bytes = readFileSync(receiptOf(s));
  const record = admitOwnership(bytes, realpathSync.native(s.project));
  assert.equal(record.schema, 'urn:aihq:core:ownership:1.7.0');
  assert.equal(Object.keys(record.members).length, 1 + 450 * 3);
  // The same record written whole, as ownership 1.6.0 wrote it, would not fit the former 1 MiB bound.
  assert.ok(Buffer.byteLength(JSON.stringify({ ...record, schema: 'urn:aihq:core:ownership:1.6.0' })) > OLD_LIMIT);
  assert.ok(bytes.length * 4 < OWNERSHIP_RECORD_BYTES, `${bytes.length} bytes stays within a quarter of the bound`);

  const ids = policy.selections.map(selection => selection.managementId);
  for (let offset = 0; offset < ids.length; offset += 256) {
    const removal = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
      removals: ids.slice(offset, offset + 256).map(managementId => ({ managementId })) }, { logging: 'off' });
    assert.equal(removal.preparation?.status, 'ready', JSON.stringify(removal));
    const run = await apply(removal.preparation.prepared, approve(removal.preparation), { logging: 'off' });
    assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
    assert.deepEqual([...new Set(run.members.filter(member => member.intent !== 'write').map(member => member.check))], ['absent']);
  }
  assert.deepEqual(readdirSync(s.project), []);
  assert.deepEqual(admitOwnership(readFileSync(receiptOf(s)), realpathSync.native(s.project)).members, {});
});

test('the stored record leaves out what it derives from itself and reads back as the same record', async () => {
  const s = open();
  await install(s, pick(TOOLS, 4, 2));
  const text = readFileSync(receiptOf(s), 'utf8');
  const stored = JSON.parse(text);
  const record = admitOwnership(Buffer.from(text), realpathSync.native(s.project));
  // A file member is its key; its claim's management ID is the owner's, and sets and requires are its selection record's.
  for (const [key, owner] of Object.entries(stored.members)) {
    assert.equal(owner.descriptor, undefined, key);
    assert.deepEqual(owner.claims, [{ scope: 'project' }], key);
    assert.deepEqual(record.members[key].descriptor, { path: key, kind: 'file' });
    const selection = Object.values(record.selections).find(claim => claim.managementId === owner.managementId);
    assert.deepEqual(record.members[key].claims, [{ managementId: owner.managementId, scope: 'project',
      sets: selection?.sets ?? [], requires: selection?.requires ?? [] }]);
  }
  assert.ok(Object.values(record.members).some(owner => owner.claims[0].requires.length === 1), 'requires come from selection records');
  // Typed members are derived from the members; Catalog facts are stored once for every tool's copy of an item.
  assert.ok(Object.values(stored.items).every(item => item.members === undefined && item.name === undefined && item.origins === undefined));
  assert.equal(stored.facts.length, 1 + 4, 'one entry per Catalog item, whatever the number of tools');
  const copies = Object.values(record.items).filter(item => item.item.itemId === 'example.skill.skill-2');
  assert.deepEqual(copies.map(item => item.tool).sort(), [...TOOLS].sort());
  assert.ok(copies.every(item => item.members.length === 2 && item.name === 'skill-2' && item.origins[0].set.setId === SET.setId));
  // Expansion gives back exactly the record a seal writes, and that record's stored text is these bytes.
  assert.equal(JSON.stringify(storedOwnership(record)), text);
  assert.deepEqual(sealOwnership(record), record);
});

/** A record as Core seals it, built directly: `tools` copies of `items` skills of `files` files, with their notices. */
function sealedRecord(tools, items, files, target = '/project') {
  const identity = managementId => `project:${sha(target)}:${managementId}`;
  const notices = id('example.notices', 'claude');
  const members = {}, selections = {}, items_ = {};
  members['.aih/notices/example/LICENSE'] = { managementId: notices, recipeIdentity: `sha256:${sha('notices')}`, sha256: sha('LICENSE'), mode: 0o600,
    descriptor: { path: '.aih/notices/example/LICENSE', kind: 'file' }, createdFile: true,
    claims: [{ managementId: notices, scope: 'project', sets: [], requires: [] }] };
  items_[identity(notices)] = { managementId: notices, scope: 'project', framework: 'example', ...described('example.notices', 'claude', 'document',
    [{ reasonIncluded: 'required-by', requiredBy: { framework: 'example', itemId: 'example.skill.skill-0' } }]), members: [] };
  for (const tool of tools) for (let index = 0; index < items; index++) {
    const itemId = `example.skill.skill-${index}`, managementId = id(itemId, tool);
    const claim = { managementId, scope: 'project', sets: [], requires: [identity(notices)] };
    selections[identity(managementId)] = claim;
    for (let file = 0; file < files; file++) {
      const path = `.${tool}/skills/skill-${index}/${file === 0 ? 'SKILL.md' : `references/part-${file}.md`}`;
      members[path] = { managementId, recipeIdentity: `sha256:${sha(`${tool}.${itemId}`)}`, sha256: sha(path), mode: 0o600,
        descriptor: { path, kind: 'file' }, createdFile: true, claims: [claim] };
    }
    items_[identity(managementId)] = { managementId, scope: 'project', framework: 'example', ...described(itemId, tool, 'skill', [{ reasonIncluded: 'in-set', set: SET }]), members: [] };
  }
  const record = sealOwnership({ schema: 'urn:aihq:core:ownership:1.6.0', target, members, selections, items: items_ });
  validateOwnership(record, target);
  return record;
}
const storedBytes = record => Buffer.byteLength(JSON.stringify(storedOwnership(record)));

test('each further tool adds only its own members and selections, so thirteen tools keep headroom', () => {
  const thirteen = Array.from({ length: 13 }, (_, index) => TOOLS[index] ?? `tool-${index}`);
  // The owner's pick: about 254 items for Claude and 64 for each other tool, a little under three files each.
  const one = sealedRecord(['claude'], 64, 3), two = sealedRecord(['claude', 'codex'], 64, 3);
  // A copy adds its three members, its selection record and its item's own fields; its Catalog facts are already stored.
  const perCopy = (storedBytes(two) - storedBytes(one)) / 64;
  assert.ok(perCopy < 1700, `${perCopy} bytes per tool copy`);
  assert.equal(JSON.parse(JSON.stringify(storedOwnership(two))).facts.length, JSON.parse(JSON.stringify(storedOwnership(one))).facts.length);
  const all = sealedRecord(thirteen, 64, 3);
  assert.equal(Object.keys(all.members).length, 1 + 13 * 64 * 3);
  assert.equal(JSON.parse(JSON.stringify(storedOwnership(all))).facts.length, 1 + 64);
  const bytes = storedBytes(all);
  assert.ok(bytes * 2 < OWNERSHIP_RECORD_BYTES, `${bytes} bytes for thirteen tools stays within half the bound`);
  assert.deepEqual(admitOwnership(Buffer.from(JSON.stringify(storedOwnership(all))), '/project'), all);
});

test('a 1.6.0 record is read as it is, and its next write is the same record stored as 1.7.0', () => {
  const record = sealedRecord(['claude', 'codex'], 3, 2);
  const old = { ...record, schema: 'urn:aihq:core:ownership:1.6.0' };
  const read = admitOwnership(Buffer.from(JSON.stringify(old)), '/project');
  assert.deepEqual(read, old, 'every field, claim, digest and typed member as recorded');
  const next = sealOwnership(read);
  assert.equal(next.schema, 'urn:aihq:core:ownership:1.7.0');
  assert.deepEqual({ ...next, schema: old.schema }, old);
  assert.deepEqual(admitOwnership(Buffer.from(JSON.stringify(storedOwnership(next))), '/project'), next);
});

test('only the one stored form of a record is admitted, and its digests stay exact', () => {
  const record = sealedRecord(['claude', 'codex'], 2, 2);
  const text = JSON.stringify(storedOwnership(record));
  const admit = value => admitOwnership(Buffer.from(JSON.stringify(value)), '/project');
  assert.deepEqual(admit(JSON.parse(text)), record);
  const variants = {
    'a derivable file descriptor': stored => { Object.values(stored.members)[1].descriptor = { path: Object.keys(stored.members)[1], kind: 'file' }; },
    "the owner's management ID in its claim": stored => { const owner = Object.values(stored.members)[1]; owner.claims[0].managementId = owner.managementId; },
    "the selection record's sets and requires": stored => {
      const owner = Object.values(stored.members)[1];
      const claim = Object.values(stored.selections).find(entry => entry.managementId === owner.managementId);
      owner.claims[0] = { scope: 'project', sets: claim.sets, requires: claim.requires };
    },
    'sets without requires': stored => { Object.values(stored.members)[1].claims[0].sets = []; },
    'typed members': stored => { const item = Object.values(stored.items)[1]; item.members = []; },
    'facts inline': stored => { const item = Object.values(stored.items)[1]; item.name = 'skill-0'; },
    'an unused facts entry': stored => { stored.facts.push(stored.facts[0]); },
    'facts out of range': stored => { Object.values(stored.items)[1].facts = stored.facts.length; },
    'no facts table': stored => { delete stored.facts; },
    'a reordered item': stored => { const [key, item] = Object.entries(stored.items)[1]; const { scope, ...rest } = item; stored.items[key] = { scope, ...rest }; },
  };
  for (const [name, change] of Object.entries(variants)) {
    const stored = JSON.parse(text); change(stored);
    assert.throws(() => admit(stored), /ownership-invalid/, name);
  }
  // A member's digest is the stored digest; the members an item lists are those it derives, never a stored copy.
  const tampered = JSON.parse(text); Object.values(tampered.members)[1].sha256 = sha('other bytes');
  const admitted = admit(tampered);
  const key = Object.keys(tampered.members)[1];
  assert.equal(admitted.members[key].sha256, sha('other bytes'));
  assert.ok(Object.values(admitted.items).some(item => item.members.some(member => member.path === key && member.sha256 === sha('other bytes'))));
  // Expansion of an earlier version is the identity.
  const v15 = { schema: 'urn:aihq:core:ownership:1.5.0', target: '/project', members: {} };
  assert.equal(expandOwnership(v15), v15);
});

test('a record over the ownership bound blocks Prepare before any effect', async () => {
  const s = open();
  await install(s, pick(['claude'], 1, 1));
  const receipt = receiptOf(s);
  const record = admitOwnership(readFileSync(receipt), realpathSync.native(s.project));
  // Long folder names fill a valid record to just under the bound with members another selection owns.
  const kept = Object.values(record.members).find(entry => entry.managementId !== id('example.notices', 'claude'));
  const owner = { ...kept, managementId: 'retained-owner', claims: [{ managementId: 'retained-owner', scope: 'project', sets: [], requires: [] }] };
  const folder = Array.from({ length: 15 }, (_, index) => `${'f'.repeat(200)}${index}`).join('/');
  const size = () => Buffer.byteLength(JSON.stringify(storedOwnership(sealOwnership(record))));
  let index = 0;
  const add = count => { for (const end = index + count; index < end; index++) {
    const path = `${folder}/retained-${String(index).padStart(5, '0')}.md`;
    record.members[path] = { ...owner, descriptor: { path, kind: 'file' } };
  } };
  add(1); const each = size(); add(1); const step = size() - each;
  add(Math.floor((OWNERSHIP_RECORD_BYTES - 16384 - size()) / step));
  while (size() < OWNERSHIP_RECORD_BYTES - 4096) add(1);
  assert.ok(Object.keys(record.members).length < 8192, 'within the member count bound');
  writeFileSync(receipt, JSON.stringify(storedOwnership(sealOwnership(record))));
  const more = pick(['claude', 'codex', 'kiro'], 2, 4);
  const blocked = await prepare({ useCase: 'policy', policy: more, target: { project: s.project } }, { logging: 'off' });
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked.diagnostics));
  assert.ok(blocked.diagnostics.some(d => d.code === 'SOURCE_LIMIT' && d.reason === 'custody-record-limit'));
  assert.equal(existsSync(join(s.project, '.codex')), false);
});
