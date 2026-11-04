// Contract limits (section 15, C34/C70), published by `@aihq/core/contracts` as `limits`. Append-only.
// `check` says when a limit applies: before any effect, at Prepare for mandatory custody, or after effects (history).

export interface Limit { name: string; value: number; unit: 'bytes' | 'count' | 'depth'; check: 'pre-effect' | 'receipt' | 'history' | 'ceiling' }

const entries: Limit[] = [
  { name: 'request-bytes', value: 16 * 1_048_576, unit: 'bytes', check: 'pre-effect' },
  { name: 'plan-steps', value: 65_536, unit: 'count', check: 'pre-effect' },
  { name: 'file-bytes', value: 16 * 1_048_576, unit: 'bytes', check: 'pre-effect' },
  { name: 'captured-bytes', value: 512 * 1_048_576, unit: 'bytes', check: 'pre-effect' },
  { name: 'artifact-bytes', value: 512 * 1_048_576, unit: 'bytes', check: 'pre-effect' },
  { name: 'receipt-bytes', value: 2 * 1_048_576, unit: 'bytes', check: 'receipt' },
  { name: 'history-bytes', value: 1_048_576, unit: 'bytes', check: 'history' },
  { name: 'document-bytes', value: 1_000_000, unit: 'bytes', check: 'pre-effect' },
  { name: 'document-depth', value: 32, unit: 'depth', check: 'pre-effect' },
  // Retained ceilings (section 15).
  { name: 'archive-bytes', value: 64 * 1_048_576, unit: 'bytes', check: 'ceiling' },
  { name: 'archive-members', value: 4_096, unit: 'count', check: 'ceiling' },
  { name: 'ownership-entries', value: 8_192, unit: 'count', check: 'ceiling' },
  { name: 'ownership-total-bytes', value: 32 * 1_048_576, unit: 'bytes', check: 'ceiling' },
  { name: 'check-files-targets', value: 4_096, unit: 'count', check: 'ceiling' },
];

export const limits: readonly Readonly<Limit>[] = Object.freeze(entries.map(entry => Object.freeze({ ...entry })));
export const limitValue = (name: string): number => {
  const found = limits.find(entry => entry.name === name);
  if (!found) throw new Error(`unknown limit: ${name}`);
  return found.value;
};
