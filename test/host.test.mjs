import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepare, apply } from '../dist/core/index.js';
import { pathPins, pinsMatch } from '../dist/core/internal/host-files.js';
import { policy } from './fixture.mjs';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'aih-core-host-'));
const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => {
  const home = join(fixtureRoot, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
});
after(() => {
  for (const [key, value] of Object.entries(originalHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});
function target() { return mkdtempSync(join(fixtureRoot, 'project-')); }
const authorize = p => ({ approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest });

test('a caller previews one file, approves that live work and receives applied but unverified', async () => {
  const project = target();
  const prepared = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready');
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
  assert.equal(prepared.review.operations[0].details.content, "Read the project's contribution guide.\n");
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  assert.equal(result.operations[0].application, 'applied');
  assert.deepEqual(result.operations[0].verification, { status: 'unverified', reason: 'no-supplied-check' });
  assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), "Read the project's contribution guide.\n");
  assert.equal(result.authorization.origin, 'automation');
  assert.deepEqual(result.authorization.allowPartial, { value: false, origin: 'default' });
  assert.equal(result.record.status, 'disabled');
  assert.equal((await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' })).review.operations[0].ownership, 'managed');
});

test('missing approval, edited digest and serialized handles cannot authorize writes', async () => {
  const project = target();
  const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal((await apply(p.prepared, undefined, { logging: 'off' })).diagnostics[0].code, 'APPROVAL_REQUIRED');
  assert.equal((await apply(p.prepared, { ...authorize(p), reviewDigest: 'edited' }, { logging: 'off' })).diagnostics[0].code, 'REVIEW_STALE');
  assert.equal((await apply(JSON.parse(JSON.stringify(p.prepared)), authorize(p), { logging: 'off' })).diagnostics[0].code, 'REVIEW_STALE');
  assert.throws(() => { p.review.operations[0].details.content = 'changed'; }, TypeError);
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
});

test('target drift and changed policy invalidate the reviewed work', async () => {
  for (const change of ['target', 'policy']) {
    const project = target(); const document = policy();
    const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
    if (change === 'target') writeFileSync(join(project, 'TEAM.md'), 'human content');
    else document.selections[0].configuration.text = 'edited after approval';
    const result = await apply(p.prepared, authorize(p), { logging: 'off' });
    assert.equal(result.completion, 'rejected');
    assert.equal(result.diagnostics[0].code, 'REVIEW_STALE');
    if (change === 'target') assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), 'human content');
    else assert.equal(existsSync(join(project, 'TEAM.md')), false);
  }
});

test('matching unowned content stays unowned and a different file stays a conflict', async () => {
  const project = target();
  writeFileSync(join(project, 'TEAM.md'), "Read the project's contribution guide.\n");
  const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(p.review.operations[0].ownership, 'unowned');
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).operations[0].application, 'already-satisfied');
  const again = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(again.review.operations[0].ownership, 'unowned');
  writeFileSync(join(project, 'TEAM.md'), 'human edit');
  const conflict = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(conflict.status, 'blocked'); assert.equal(conflict.prepared, undefined);
});

test('private values never enter review digests as reusable hashes or completed history', async () => {
  const project = target(); const document = policy();
  document.selections[0].configuration = {};
  document.selections[0].recipe.inline.inputs.text.sensitive = true;
  const privateInputs = { guidance: { text: 'fixture-private-value' } };
  const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { privateInputs });
  assert.equal(p.status, 'ready'); assert.equal(p.record.status, 'written');
  assert.equal(JSON.stringify(p).includes('fixture-private-value'), false);
  const result = await apply(p.prepared, authorize(p));
  assert.equal(result.completion, 'complete'); assert.equal(result.record.status, 'written');
  assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), 'fixture-private-value');
  const record = readFileSync(join(process.env.USERPROFILE, '.aih/core', result.record.reference), 'utf8');
  assert.equal(record.includes('fixture-private-value'), false);
  assert.equal(JSON.parse(record).operations[0].application, 'applied');
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).completion, 'rejected');
});

test('private inputs are declared data, and pre-cancelled or malformed work changes no target', async () => {
  const project = target(); const request = { useCase: 'policy', policy: policy(), target: { project } };
  assert.equal((await prepare(request, { logging: 'off', privateInputs: { guidance: { undeclared: 'secret' } } })).status, 'invalid');
  const controller = new AbortController(); controller.abort();
  assert.equal((await prepare(request, { logging: 'off', signal: controller.signal })).status, 'cancelled');
  const p = await prepare(request, { logging: 'off' });
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off', signal: controller.signal })).completion, 'cancelled');
  request.policy.selections[0].requires = ['guidance'];
  assert.equal((await prepare(request, { logging: 'off' })).status, 'invalid');
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
});

test('replaced parent directories and linked target paths cannot reuse approval', async () => {
  const project = target(); const dir = join(project, 'docs'); mkdirSync(dir);
  const document = policy(); document.selections[0].recipe.inline.operations[0].target.segments.unshift({ literal: 'docs' });
  const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  renameSync(dir, join(project, 'old-docs')); mkdirSync(dir);
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).diagnostics[0].code, 'REVIEW_STALE');
  rmSync(dir, { recursive: true });
  const external = target(); symlinkSync(external, dir, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.notEqual(linked.status, 'ready'); assert.equal(linked.prepared, undefined);
  assert.equal(existsSync(join(external, 'TEAM.md')), false);
});

test('macOS fixed system temp aliases are pinned while interior symlinks stay unsafe',
  { skip: process.platform !== 'darwin' }, async () => {
    for (const [alias, physical] of [['/var', '/private/var'], ['/tmp', '/private/tmp']]) {
      assert.equal(realpathSync.native(alias), physical);
      const writable = alias === '/var' ? '/var/tmp' : alias;
      const temp = mkdtempSync(join(writable, 'aih-core-alias-'));
      try {
        const pins = pathPins(temp);
        assert.equal(pinsMatch(pins), true);
        const p = await prepare({ useCase: 'policy', policy: policy(), target: { project: temp } }, { logging: 'off' });
        assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
        const applied = await apply(p.prepared, authorize(p), { logging: 'off' });
        assert.equal(applied.completion, 'complete', JSON.stringify(applied));
        mkdirSync(join(temp, 'real'));
        symlinkSync(join(temp, 'real'), join(temp, 'linked'), 'dir');
        assert.throws(() => pathPins(join(temp, 'linked', 'TEAM.md')), /unsafe-path/);
      } finally {
        assert.ok(realpathSync.native(temp).startsWith(realpathSync.native(writable) + sep));
        rmSync(temp, { recursive: true, force: true });
      }
    }
  });

test('history failures are reported without pretending already-satisfied work failed', async () => {
  const project = target(); writeFileSync(join(project, 'TEAM.md'), "Read the project's contribution guide.\n");
  const home = join(fixtureRoot, 'blocked-history-home'); mkdirSync(home);
  writeFileSync(join(home, '.aih'), 'not a directory');
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } });
    assert.equal(p.status, 'ready'); assert.equal(p.record.status, 'failed');
    assert.ok(p.diagnostics.some(d => d.reason === 'record-write'));
    const result = await apply(p.prepared, authorize(p));
    assert.equal(result.completion, 'complete'); assert.equal(result.record.status, 'failed');
    assert.ok(result.diagnostics.some(d => d.reason === 'record-write'));
  } finally { Object.assign(process.env, previous); }
});

test('cancellation scheduled by the caller is observed before the next file effect', async () => {
  const project = target(); const controller = new AbortController();
  const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  const pending = apply(p.prepared, authorize(p), { logging: 'off', signal: controller.signal });
  setImmediate(() => controller.abort());
  const result = await pending;
  assert.equal(result.completion, 'cancelled');
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
});

test('dotted local names have distinct qualified operation and input identities', async () => {
  const project = target(); const document = policy();
  const first = document.selections[0];
  first.id = 'a.b'; first.recipe.inline.operations[0].id = 'c';
  const second = structuredClone(first); second.id = 'a'; second.managementId = 'second';
  second.recipe.inline.operations[0].id = 'b.c';
  second.recipe.inline.operations[0].target.segments = [{ literal: 'SECOND.md' }];
  document.selections.push(second);
  const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.review.operations.map(op => op.id), ['a.b/c', 'a/b.c']);
});

test('cancellation between writes preserves earlier outcomes and releases staged work', { timeout: 30_000 }, async () => {
  const project = target(); const document = policy(); const controller = new AbortController();
  const recipe = document.selections[0].recipe.inline;
  recipe.operations = ['FIRST.md', 'SECOND.md', 'THIRD.md'].map((name, index) => ({
    ...structuredClone(recipe.operations[0]), id: `write-${index}`,
    target: { root: 'project', segments: [{ literal: 'new-directory' }, { literal: name }] }
  }));
  const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(p.status, 'ready');
  let finished = false;
  const cancelAfterSecond = () => {
    if (finished) return;
    if (existsSync(join(project, 'new-directory/SECOND.md'))) controller.abort();
    else setImmediate(cancelAfterSecond);
  };
  const pending = apply(p.prepared, authorize(p), { logging: 'off', signal: controller.signal });
  setImmediate(cancelAfterSecond);
  let result;
  try { result = await pending; } finally { finished = true; }
  assert.equal(result.completion, 'cancelled', JSON.stringify(result));
  assert.deepEqual(result.operations.map(op => op.application), ['applied', 'applied', 'not-attempted']);
  assert.equal(existsSync(join(project, 'new-directory/THIRD.md')), false);
  assert.equal(existsSync(join(process.env.USERPROFILE, `.aih/core/ownership/.pending-${result.runId}.json`)), false);
  const again = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.deepEqual(again.review.operations.map(op => op.ownership), ['managed', 'managed', 'unowned']);
});

test('an existing ownership file with unrelated Windows writers is not trusted', { skip: process.platform !== 'win32' }, async () => {
  const project = target();
  const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).completion, 'complete');
  const ownership = join(process.env.USERPROFILE, '.aih/core/ownership', createHash('sha256').update(p.review.target.project).digest('hex') + '.json');
  const script = `$p=$env:AIHQ_TEST_RECORD; $a=[System.IO.File]::GetAccessControl($p); $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Write','Allow'); $a.AddAccessRule($r); [System.IO.File]::SetAccessControl($p,$a)`;
  const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-Command',script], { windowsHide:true, encoding:'utf8',env:{...process.env,AIHQ_TEST_RECORD:ownership} });
  assert.equal(result.status,0,result.stderr);
  const untrusted = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.notEqual(untrusted.status, 'ready'); assert.equal(untrusted.prepared, undefined);
});

test('known ownership record capacity failure blocks a new target write', async () => {
  const project = target(); const document = policy();
  const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).completion, 'complete');
  const ownership = join(process.env.USERPROFILE, '.aih/core/ownership', createHash('sha256').update(p.review.target.project).digest('hex') + '.json');
  const record = JSON.parse(readFileSync(ownership,'utf8'));
  const current = Object.values(record.members)[0];
  const member = { managementId: current.managementId, recipeIdentity: current.recipeIdentity, sha256: current.sha256, mode: current.mode };
  // Fill a valid, protected record to just below its admitted byte ceiling.
  const entryBytes = Buffer.byteLength(JSON.stringify('retained-00000000') + ':' + JSON.stringify(member) + ',');
  const count = Math.floor((1_048_576 - 4 - Buffer.byteLength(JSON.stringify(record))) / entryBytes);
  for (let i = 0; i < count; i++) record.members[`retained-${String(i).padStart(8, '0')}`] = member;
  const bytes = Buffer.byteLength(JSON.stringify(record));
  // Inert whitespace is permitted in a historical state file. It does not make
  // the next canonical ownership update larger, so fill remaining space in a key.
  const last = Object.keys(record.members).at(-1);
  const enlarged = last + 'x'.repeat(1_048_576 - bytes - 4);
  record.members[enlarged] = record.members[last]; delete record.members[last];
  writeFileSync(ownership, JSON.stringify(record));
  document.selections[0].recipe.inline.operations[0].target.segments = [{literal:'NEXT.md'}];
  document.selections[0].managementId = 'additional-capacity-member';
  const next = await prepare({useCase:'policy',policy:document,target:{project}},{logging:'off'});
  assert.equal(next.status,'ready');
  const result = await apply(next.prepared,authorize(next),{logging:'off'});
  assert.equal(existsSync(join(project,'NEXT.md')),false);
  assert.equal(result.completion,'rejected');
  assert.equal(result.diagnostics[0].reason,'state-unwritable');
  // An update's final receipt removes TEAM.md, but its intermediate receipt
  // still holds both old and new members. Capacity must be proved before NEXT.
  document.selections[0].managementId = current.managementId;
  const update = await prepare({useCase:'policy',policy:document,target:{project}},{logging:'off'});
  assert.equal(update.status,'ready',JSON.stringify(update));
  const updateResult = await apply(update.prepared,authorize(update),{logging:'off'});
  assert.equal(updateResult.completion,'rejected',JSON.stringify(updateResult));
  assert.equal(updateResult.diagnostics[0].reason,'state-unwritable');
  assert.equal(existsSync(join(project,'NEXT.md')),false);
  assert.equal(existsSync(join(project,'TEAM.md')),true);
});

for (const limit of ['selection', 'claim']) test(`ownership ${limit} count capacity rejects before publishing custody or target effects`, async () => {
  const project = target(); const document = policy();
  const initial = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal((await apply(initial.prepared, authorize(initial), { logging: 'off' })).completion, 'complete');
  const ownership = join(process.env.USERPROFILE, '.aih/core/ownership', createHash('sha256').update(initial.review.target.project).digest('hex') + '.json');
  const record = JSON.parse(readFileSync(ownership, 'utf8'));
  const retained = Array.from({ length: 4096 }, (_, i) => ({ managementId: `retained-${i}`, scope: 'project', sets: [], requires: [] }));
  if (limit === 'selection') {
    const anchor = process.platform === 'win32' ? initial.review.target.project.toLowerCase() : initial.review.target.project;
    const identity = createHash('sha256').update(anchor).digest('hex');
    record.selections = Object.fromEntries(retained.map(claim => [`project:${identity}:${claim.managementId}`, claim]));
    document.selections[0].recipe.inline.operations[0].target.segments = [{ literal: 'COUNT-NEXT.md' }];
  } else {
    Object.values(record.members)[0].claims = retained;
    // A longer historical primary ID makes the overflowing proposed owner
    // smaller in bytes. Byte reservation must not hide semantic count growth.
    Object.values(record.members)[0].managementId = 'z'.repeat(128);
  }
  const before = JSON.stringify(record);
  assert.ok(Buffer.byteLength(before) < 1_048_576);
  writeFileSync(ownership, before);
  document.selections[0].managementId = limit === 'claim' ? 'n' : 'new-count-owner';
  if (limit === 'selection') document.managedSelections = [{ id: 'count', scope: 'project', members: ['new-count-owner'] }];
  const selection = document.selections[0];
  const resolutions = limit === 'claim' ? [{ selectionId: selection.id, operationId: selection.recipe.inline.operations[0].id,
    choice: 'adopt', observedSha256: createHash('sha256').update(readFileSync(join(project, 'TEAM.md'))).digest('hex') }] : undefined;
  const next = await prepare({ useCase: 'policy', policy: document, target: { project }, ...(resolutions ? { resolutions } : {}) }, { logging: 'off' });
  assert.equal(next.status, 'ready', JSON.stringify(next));
  const result = await apply(next.prepared, authorize(next), { logging: 'off' });
  assert.equal(result.completion, 'rejected', JSON.stringify(result));
  assert.equal(result.diagnostics[0].reason, 'state-unwritable');
  assert.equal(existsSync(join(project, 'COUNT-NEXT.md')), false);
  assert.equal(readFileSync(ownership, 'utf8'), before);
  assert.equal((await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' })).diagnostics.some(diagnostic => diagnostic.reason === 'ownership-invalid'), false);
});

test('a protected ownership directory that denies receipt creation blocks target effects', { skip: process.platform !== 'win32' }, async () => {
  const project = target(); const home = join(fixtureRoot, 'denied-ownership-home'); mkdirSync(home);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } });
    assert.equal(p.status, 'ready'); assert.equal(p.record.status, 'written');
    const ownership = join(home, '.aih/core/ownership'); mkdirSync(ownership);
    const script = `$p=$env:AIHQ_TEST_DIRECTORY; $a=[System.IO.Directory]::GetAccessControl($p); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'CreateFiles','Deny'); $a.AddAccessRule($r); [System.IO.Directory]::SetAccessControl($p,$a)`;
    const denied = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', env: { ...process.env, AIHQ_TEST_DIRECTORY: ownership }
    });
    assert.equal(denied.status, 0, denied.stderr);
    const result = await apply(p.prepared, authorize(p), { logging: 'off' });
    assert.equal(result.completion, 'rejected', JSON.stringify(result));
    assert.equal(result.operations[0].application, 'not-attempted');
    assert.equal(result.diagnostics[0].reason, 'state-unwritable');
    assert.equal(existsSync(join(project, 'TEAM.md')), false);
  } finally { Object.assign(process.env, previous); }
});
