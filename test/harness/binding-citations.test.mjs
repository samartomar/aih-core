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
/** `command-template: <template>`: hooks rendered through this template ran and their output reached the model. */
const TEMPLATE = /^command-template: (.+)$/;
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
  // A hook command template changes every rendered hook command, so it too must have been observed working.
  const template = binding.layouts.hook.commandTemplate;
  if (template !== undefined && !hookCells.some(cell => cell.recognised === 'recognised' &&
      cell.evidence.some(line => TEMPLATE.exec(line)?.[1] === template))) missing.push('hook.commandTemplate');
  return missing;
}

test('every shipped hook event, entry file and entry pointer cites an observed line in a published run record', () => {
  assert.ok(records.size > 0, 'run records are published beside the bindings');
  for (const binding of bindings) assert.deepEqual(uncited(binding), [], binding.tool);
});

test('the citation guard refuses a hook event, entry file or pointer that no run record observed', () => {
  const claude = bindings.find(binding => binding.tool === 'claude');
  // No run record shows a Notification hook firing, a block in GEMINI.md being read, or an @README.md pointer.
  const guessed = structuredClone(claude);
  guessed.layouts.hook.hookEvents = { ...guessed.layouts.hook.hookEvents, Notification: 'Notification' };
  guessed.entryFiles = [...guessed.entryFiles, 'GEMINI.md'];
  guessed.entryPointer = { file: 'CLAUDE.md', template: '@README.md' };
  guessed.layouts.hook.commandTemplate = 'NODE_OPTIONS="" {command}';
  assert.deepEqual(uncited(guessed), ['hookEvents.Notification', 'entryFiles.GEMINI.md', 'entryPointer.CLAUDE.md', 'hook.commandTemplate']);
  // A fired line counts only through an observation the binding carries: without the hook observations, nothing is cited.
  const detached = structuredClone(claude);
  detached.layouts.hook.observations = [];
  assert.deepEqual(uncited(detached), [...Object.keys(claude.layouts.hook.hookEvents).map(event => `hookEvents.${event}`),
    'entryFiles.CLAUDE.md', 'entryPointer.CLAUDE.md', 'hook.commandTemplate']);
  // A pointer must name an entry file.
  const stray = structuredClone(claude);
  stray.entryFiles = [];
  assert.deepEqual(uncited(stray), ['entryPointer.CLAUDE.md']);
});
