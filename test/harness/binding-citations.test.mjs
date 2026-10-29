// Bindings come from observations, never guesses. Every hook event a binding maps, every entry file it writes a shared
// block into and its entry pointer must cite a line a published run record actually observed: a hook's fired line naming
// that event, or a recognised cell that delivered that file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const directory = new URL('../../src/harness/run-records/', import.meta.url);
/** Published run records by the SHA-256 their observations cite. */
const records = new Map(readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
  const bytes = readFileSync(new URL(name, directory));
  return [createHash('sha256').update(bytes).digest('hex'), JSON.parse(bytes)];
}));
const bindings = JSON.parse(readFileSync(new URL('../../src/harness/tool-bindings.json', import.meta.url), 'utf8'));
/** `hook-fired.log: <token> <time> <event>`, as the canary hook appends it. */
const FIRED = /^hook-fired\.log: \S+ \S+ (\S+)$/;
/** `entry-pointer: <file> <template>`: the pointer's import reached the model in the same session. */
const POINTER = /^entry-pointer: (\S+) (.+)$/;

/** Run-record cells for the binding's tool, reached only through observations the binding itself carries. */
function citedCells(binding, kinds) {
  const digests = new Set(Object.entries(binding.layouts).filter(([kind]) => kinds === undefined || kinds.includes(kind))
    .flatMap(([, layout]) => layout.observations.map(observation => observation.runRecordDigest)));
  return [...digests].flatMap(digest => records.get(digest)?.cells.filter(cell => cell.tool === binding.tool) ?? []);
}
/** What the binding claims without a cited observation; empty when every claim cites one. */
export function uncited(binding) {
  const missing = [];
  const hookCells = citedCells(binding, ['hook']).filter(cell => cell.kind === 'hook');
  const fired = new Set(hookCells.flatMap(cell => cell.evidence.flatMap(line => FIRED.exec(line)?.[1] ?? [])));
  for (const event of Object.keys(binding.layouts.hook.hookEvents ?? {}))
    if (!fired.has(event)) missing.push(`hookEvents.${event}`);
  // An entry file counts when a session read a block Core delivered into it.
  const recognised = citedCells(binding).filter(cell => cell.recognised === 'recognised');
  const read = new Set(recognised.flatMap(cell => cell.delivered.filter(entry => entry.root === 'project').map(entry => entry.path)));
  for (const file of binding.entryFiles) if (!read.has(file)) missing.push(`entryFiles.${file}`);
  if (binding.entryPointer) {
    const { file, template } = binding.entryPointer;
    const pointed = recognised.some(cell => cell.evidence.some(line => {
      const match = POINTER.exec(line);
      return match?.[1] === file && match[2] === template;
    }));
    if (!pointed || !binding.entryFiles.includes(file)) missing.push(`entryPointer.${file}`);
  }
  return missing;
}

test('every shipped hook event, entry file and entry pointer cites an observed line in a published run record', () => {
  assert.ok(records.size > 0, 'run records are published beside the bindings');
  for (const binding of bindings) assert.deepEqual(uncited(binding), [], binding.tool);
});

test('the citation guard refuses a hook event, entry file or pointer that no run record observed', () => {
  const claude = bindings.find(binding => binding.tool === 'claude');
  // The 23 October run fired only SessionStart, and no session read a CLAUDE.md block.
  const guessed = structuredClone(claude);
  guessed.layouts.hook.hookEvents = { ...guessed.layouts.hook.hookEvents, PreToolUse: 'PreToolUse' };
  guessed.entryFiles = ['CLAUDE.md'];
  guessed.entryPointer = { file: 'CLAUDE.md', template: '@AGENTS.md' };
  assert.deepEqual(uncited(guessed), ['hookEvents.PreToolUse', 'entryFiles.CLAUDE.md', 'entryPointer.CLAUDE.md']);
  // A fired line counts only through an observation the binding carries: no observation, no citation.
  const detached = structuredClone(claude);
  detached.layouts.hook.observations = [];
  assert.deepEqual(uncited(detached), ['hookEvents.SessionStart']);
});
