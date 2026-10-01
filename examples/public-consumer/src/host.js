// UI-owned Node host. The live prepared handles never leave this module: the UI
// receives a serializable review and an opaque session id, and approval is an
// explicit digest-bound decision against the retained handle. Review JSON is
// never deserialized back into executable work.
import { randomUUID } from 'node:crypto';
import { apply, prepare } from '@aihq/core';
import { parsePolicy } from '@aihq/core/contracts';

const lostResult = () => ({
  status: 'lost',
  diagnostics: [{
    code: 'SESSION_LOST', reason: 'unknown-or-consumed-session',
    message: 'This preparation is no longer held by the host; prepare and approve again.'
  }]
});

export function createHost({ projectRoot, materialRoots, controls: hostControls } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('createHost requires a host-configured projectRoot');
  }
  const sessions = new Map();

  const controlsFor = controls => ({
    ...hostControls, ...controls,
    materialRoots: controls?.materialRoots ?? materialRoots
  });

  return {
    async prepareSession({ policyText, controls } = {}) {
      const parsed = parsePolicy(policyText);
      if (!parsed.valid) return { status: 'invalid', diagnostics: parsed.diagnostics };
      const preparation = await prepare(
        { useCase: 'policy', policy: parsed.document, target: { project: projectRoot } },
        controlsFor(controls)
      );
      const result = { status: preparation.status, diagnostics: preparation.diagnostics };
      if (preparation.review) {
        result.review = JSON.parse(JSON.stringify(preparation.review));
      }
      if (preparation.prepared) {
        const sessionId = randomUUID();
        sessions.set(sessionId, {
          handle: preparation.prepared,
          reviewDigest: preparation.review.reviewDigest
        });
        result.sessionId = sessionId;
      }
      return result;
    },

    async applyApproved({ sessionId, reviewDigest, origin = 'interactive', controls } = {}) {
      const session = sessions.get(sessionId);
      if (!session) return lostResult();
      if (reviewDigest !== session.reviewDigest) {
        return {
          status: 'rejected',
          reason: 'digest-mismatch',
          diagnostics: [{
            code: 'APPROVAL_REJECTED', reason: 'digest-mismatch',
            message: 'Approval must name the exact review digest returned by preparation.'
          }]
        };
      }
      sessions.delete(sessionId);
      return apply(
        session.handle,
        { approved: true, origin, reviewDigest },
        controlsFor(controls)
      );
    }
  };
}
