// Portable guidance rules. Data and pure functions only: importing or calling
// this module performs no host observation, process, network or file access.
// Core adapts public results into facts; these rules own every tool/vendor
// statement. No fact value is ever copied into guidance text.
import { repairIndex, targets } from './contracts.mjs';

/** Known guidance subjects: diagnostic targets plus guidance-only subjects that have no probe. */
export const guidanceSubjects = Object.freeze([...targets.map(target => target.id), 'mcp', 'docker', 'homebrew',
  'policy', 'unknown']);

/**
 * Derive ordered guidance items from adapted facts.
 * Skeleton: replaced by the shipped rule set.
 */
export function deriveGuidance(request) {
  void request; void repairIndex;
  return [];
}

/** Shipped display labels; unknown values return undefined. */
export function subjectLabel(id) {
  return targets.find(target => target.id === id)?.label;
}
export function reasonLabel(reason) {
  void reason;
  return undefined;
}
