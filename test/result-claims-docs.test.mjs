import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// A Windows checkout may convert README.md to CRLF; the section is read as LF text either way.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const schema = path => JSON.parse(readFileSync(new URL(`../src/core/schemas/${path}`, import.meta.url), 'utf8'));
const claimsSection = text => {
  const lf = text.replace(/\r\n/g, '\n');
  const start = lf.indexOf('\n## What each result status lets you claim\n');
  const end = start < 0 ? -1 : lf.indexOf('\n## ', start + 1);
  return start < 0 ? '' : lf.slice(start, end < 0 ? undefined : end);
};
const section = claimsSection(readme);
const rows = section.split('\n').filter(line => line.startsWith('| `')).map(line =>
  line.slice(1, -1).split(' | ').map(cell => cell.trim()));
const row = (field, value) => rows.find(cells => cells[0] === `\`${field}\`` && cells[1].startsWith(`\`${value}\``));

test('the result-claims table covers every published status value', () => {
  assert.ok(section, 'README has the result-claims section');
  const runs = readdirSync(new URL('../src/core/schemas/run-result/', import.meta.url)).map(name => schema(`run-result/${name}`));
  const removals = readdirSync(new URL('../src/core/schemas/managed-removal-preparation/', import.meta.url))
    .map(name => schema(`managed-removal-preparation/${name}`));
  const expected = [
    ...runs.flatMap(run => run.properties.operations.items.properties.application.enum.map(value => ['application', value])),
    ...runs.flatMap(run => run.properties.operations.items.properties.verification.properties.status.enum
      .map(value => ['verification.status', value])),
    ...removals.flatMap(removal => removal.properties.disposition.enum.map(value => ['disposition', value])),
    ...runs.flatMap(run => run.properties.completion.enum.map(value => ['completion', value])),
    ...runs.flatMap(run => ['intent', 'outcome', 'check'].flatMap(field =>
      (run.properties.members?.items.properties[field].enum ?? []).map(value => [`members[].${field}`, value]))),
  ];
  assert.ok(expected.some(([field]) => field === 'members[].check'), 'run result 1.4 member values are published');
  assert.equal(runs.length > 0 && removals.length > 0, true);
  for (const [field, value] of expected) assert.ok(row(field, value), `missing ${field} ${value}`);
  for (const value of ['`unverified`, reason `no-supplied-check`', '`passed`, reason `member-checked`', '`failed`, reason `member-changed`',
    '`unverified`, reason `member-unchecked`'])
    assert.ok(rows.some(cells => cells[0] === '`verification.status`' && cells[1] === value), `missing ${value} row`);
});

test('cleanup verification from member checks is limited to run result 1.4 and 1.5', () => {
  const exact = value => rows.find(cells => cells[0] === '`verification.status`' && cells[1] === value);
  const checked = exact('`passed`, reason `member-checked`');
  assert.match(checked[2], /run result 1\.4 or 1\.5/);
  assert.match(checked[2], /`absent`/);
  assert.match(exact('`failed`, reason `member-changed`')[2], /`present-different`/);
  assert.match(exact('`passed`')[2], /supplied/);
  const unchecked = exact('`unverified`, reason `no-supplied-check`');
  assert.match(unchecked[2], /run results 1\.0 to 1\.3/);
  assert.doesNotMatch(unchecked[2], /Convenience removals and generated lifecycle cleanup carry no supplied checks\./);
  assert.match(row('completion', 'incomplete')[2], /`member-changed`/);
});

test('the recovery paragraphs say when a removal deletes its own recovery data', () => {
  const lf = readme.replace(/\r\n/g, '\n');
  const start = lf.indexOf('\n## State and recovery\n');
  const state = lf.slice(start, lf.indexOf('\n## ', start + 1));
  assert.ok(start > 0);
  assert.doesNotMatch(state, /There is no automatic history expiry or cleanup\./);
  assert.match(state, /deletes its own recovery folder/);
  assert.match(state, /drops `recovery` from its result/);
  assert.match(state, /run results 1\.0 to 1\.3/);
  assert.match(state, /Install runs and every other removal keep their recovery data/);
});

test('the changelog opens with the package version', () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(/^Core (\S+?):/m.exec(changelog)?.[1], version);
  assert.match(changelog, /member-checked/);
});

test('each row states what it establishes and what may and may not be claimed', () => {
  assert.match(section, /\| Field \| Value \| Establishes \| May claim \| May not claim \|/);
  assert.ok(rows.length > 0);
  for (const cells of rows) {
    assert.equal(cells.length, 5, cells.join(' | '));
    for (const cell of cells.slice(2)) assert.ok(cell.length > 0, cells.join(' | '));
  }
});

test('the section explains confirming an unverified removal and the run result 1.4 member claims', () => {
  assert.match(section, /applied removal is not by itself "removed"/);
  assert.match(section, /Under run results 1\.0 to 1\.3 a removal operation stays `unverified` \(reason `no-supplied-check`\)/);
  assert.match(section, /Under run result 1\.4 or 1\.5, Apply checks each cleanup operation's members on disk/);
  assert.match(section, /listManagedSelections/);
  assert.match(section, /prepareManagedRemoval/);
  assert.match(section, /https:\/\/github\.com\/samartomar\/aih-core\/issues\/99/);
  assert.match(section, /\*\*"Confirmed on disk"\*\* requires run `completion: complete`, every `intent: write` member `outcome: written`, and each of those `check: present-matching`/);
  assert.match(section, /never qualifies, even when its written subset matches/);
  assert.match(section, /\*\*"Removed"\*\* means every `intent: remove` member is `claim-removed` and `absent`, or `restored` and `present-matching`/);
  assert.match(section, /runMemberClaims/);
  assert.doesNotMatch(section, /will gain the run result 1\.4/);
});

test('a prepared removal is ready for review only when its inner preparation is ready', () => {
  const prepared = row('disposition', 'prepared');
  assert.ok(prepared);
  assert.match(prepared[2], /`preparation\.status`/);
  assert.match(prepared[2], /`blocked`/);
  assert.match(prepared[3], /only when `preparation\.status` is `ready`/);
});

test('the section reads the same from LF and CRLF checkouts', () => {
  const lf = readme.replace(/\r\n/g, '\n');
  assert.ok(claimsSection(lf));
  assert.equal(claimsSection(lf.replace(/\n/g, '\r\n')), claimsSection(lf));
});
