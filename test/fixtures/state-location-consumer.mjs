// Runs inside a disposable consumer that installed the packed artifact, with HOME set to a disposable home.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { stateLocation } from '@aihq/core/contracts';
import { resolveStateLocation, prepare, apply } from '@aihq/core';

const [project] = process.argv.slice(2);
const home = process.env.HOME;
const before = resolveStateLocation();
// Reading the location is information only: it creates nothing.
const homeAfterRead = readdirSync(home);
const request = {
  schema: 'urn:aihq:core:change-request:0.1.0', mode: 'vibe', scope: 'project', target: { project },
  changes: [{ managementId: 'team-guidance', inputs: {}, requires: [], change: {
    schema: 'urn:aihq:core:change:0.1.0', id: 'team-guidance', description: 'Deliver project guidance',
    inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [],
    operations: [{ id: 'write', purpose: 'Write project guidance', kind: 'file.write', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'TEAM.md' }] }, content: { literal: 'Guidance\n' },
      requires: [], checks: [] }]
  } }]
};
const prepared = await prepare(request, { logging: 'on' });
const result = await apply(prepared.handle,
  { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest }, { logging: 'on' });
const after = resolveStateLocation();
process.stdout.write(JSON.stringify({
  stateLocation, frozen: Object.isFrozen(stateLocation) && Object.isFrozen(stateLocation.root) &&
    Object.isFrozen(stateLocation.root.segments) && Object.isFrozen(stateLocation.projectMarkers) &&
    stateLocation.projectMarkers.every(Object.isFrozen),
  home: realpathSync.native(home), before, after, homeAfterRead, completion: result.completion,
  markersPresent: after.markers.map(marker => existsSync(marker.path)),
  stateEntries: readdirSync(after.root).sort(),
  projectEntries: readdirSync(project).sort()
}));
