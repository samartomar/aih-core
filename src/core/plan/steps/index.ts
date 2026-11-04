// The step-kind dispatch table. Append-only: a slice that carries out a new kind adds its handler file and one row.
// Every other `op` is refused before any effect (`step-unknown`, contract 8.1), including Catalog kinds this Core
// does not carry out yet.
import { fetch } from './fetch.js';
import { write } from './write.js';
import { merge } from './merge.js';
import type { StepHandler } from './types.js';

const handlers: Readonly<Record<string, StepHandler>> = Object.freeze({
  [write.op]: write,
  [fetch.op]: fetch,
  [merge.op]: merge,
});
/** Catalog's other step kinds (D92); named so the refusal can say they are known but not carried out here yet. */
const CATALOG_KINDS = new Set(['acquire', 'link', 'merge', 'plugin', 'upstream-setup', 'upstream-installer', 'tool-command']);

export function handlerFor(op: string): StepHandler | { known: boolean } {
  return Object.hasOwn(handlers, op) ? handlers[op]! : { known: CATALOG_KINDS.has(op) };
}
