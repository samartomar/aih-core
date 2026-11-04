// The step-kind dispatch table. Append-only: a slice that carries out a new kind adds its handler file and one row.
// Every other `op` is refused before any effect (`step-unknown`, contract 8.1), including Catalog kinds this Core
// does not carry out yet.
import { fetch } from './fetch.js';
import { acquire } from './acquire.js';
import { write } from './write.js';
import { plugin } from './plugin.js';
import { merge } from './merge.js';
import { link } from './link.js';
import { toolCommand } from './tool-command.js';
import { upstreamInstaller } from './upstream-installer.js';
import { upstreamSetup } from './upstream-setup.js';
import type { StepHandler } from './types.js';

const handlers: Readonly<Record<string, StepHandler>> = Object.freeze({
  [write.op]: write,
  [fetch.op]: fetch,
  [acquire.op]: acquire,
  [plugin.op]: plugin,
  [merge.op]: merge,
  [link.op]: link,
  [toolCommand.op]: toolCommand,
  [upstreamInstaller.op]: upstreamInstaller,
  [upstreamSetup.op]: upstreamSetup,
});
/** Catalog's other step kinds (D92); named so the refusal can say they are known but not carried out here yet. */
const CATALOG_KINDS = new Set(['link', 'merge', 'upstream-setup', 'upstream-installer', 'tool-command']);

export function handlerFor(op: string): StepHandler | { known: boolean } {
  return Object.hasOwn(handlers, op) ? handlers[op]! : { known: CATALOG_KINDS.has(op) };
}
