import type { GuidanceItem } from '../support.js';

/** Human next-action prose from the same ordered GuidanceItem content used by structured output and Markdown. */
export function formatGuidanceText(items: readonly GuidanceItem[]): string {
  if (!items.length) return '';
  return 'Next actions:\n' + items.map((item, index) => `${index + 1}. [${item.audience}] ${item.summary}\n` +
    item.steps.map(step => `   - ${step}\n`).join('') +
    item.repairs.map(repair => `   Repair: ${repair.id} (${repair.targets.join(', ')}); required inputs: ` +
      `${repair.requiredInputs.map(input => `${input.name} (${input.type})`).join(', ') || 'none'}\n`).join('')).join('');
}
