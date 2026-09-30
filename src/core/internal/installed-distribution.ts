import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distribution } from '../../distribution.mjs';

export const distributionManifest = fileURLToPath(new URL('../../../package.json', import.meta.url));
export function installedDistribution(): { name: string; version: string } {
  const actual = JSON.parse(readFileSync(distributionManifest, 'utf8')) as Record<string, unknown>;
  if (actual.name !== distribution.name || actual.version !== distribution.version)
    throw new Error('core-distribution-identity');
  return { name: distribution.name, version: distribution.version };
}
