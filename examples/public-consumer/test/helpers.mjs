import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstalledRelease } from '@aihq/catalog/node';

let cached;
export async function installedRelease() {
  if (!cached) {
    const root = dirname(fileURLToPath(import.meta.resolve('@aihq/catalog/package.json')));
    const result = await readInstalledRelease({ root, sourceInput: 'catalog' });
    if (!result.valid) throw new Error(`installed release invalid: ${JSON.stringify(result.diagnostics)}`);
    cached = result;
  }
  return cached;
}

export function disposableHome() {
  const home = mkdtempSync(join(tmpdir(), 'aih-consumer-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

export function disposableProject() {
  return mkdtempSync(join(tmpdir(), 'aih-consumer-project-'));
}

export function inlinePolicyText() {
  return JSON.stringify({
    schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe',
    selections: [{
      id: 'guidance', managementId: 'team-guidance', scope: 'project',
      configuration: { text: 'Read the public consumer example notes.\n' }, requires: [],
      recipe: { inline: {
        schema: 'urn:aihq:core:recipe:1.0.0', id: 'guidance-file',
        description: 'Deliver project guidance',
        inputs: { text: { type: 'string', required: true, maxLength: 65536 } },
        materials: [], targets: ['project'], prerequisites: [],
        operations: [{
          id: 'write', purpose: 'Write shared project guidance', kind: 'file.write',
          scope: 'project', target: { root: 'project', segments: [{ literal: 'TEAM.md' }] },
          content: { input: 'text' }, requires: [], checks: []
        }], checks: []
      } }
    }]
  });
}
