// UI-owned Node host. The live prepared handles never leave this module: the UI
// receives the serializable preparation (review, operationSelections, record and
// diagnostics) plus an opaque session id, and approval is an explicit digest-bound
// decision against the retained handle. Review JSON is never deserialized back
// into executable work.
import { randomUUID } from 'node:crypto';
import { apply, checkFileState, prepare } from '@aihq/core';
import { parsePolicy } from '@aihq/core/contracts';

const PREPARATION_FIELDS = ['status', 'runId', 'review', 'diagnostics', 'record', 'evidence',
  'resolutionInputs', 'operationSelections'];

const lostResult = () => ({
  status: 'lost',
  diagnostics: [{
    code: 'SESSION_LOST', reason: 'unknown-or-consumed-session',
    message: 'This preparation is no longer held by the host; prepare and approve again.'
  }]
});

// organizationSource and organizationTarget (Enterprise only) are host
// configuration, never browser input. A declared organizationTarget makes Prepare
// evaluate the organization's client/repository obligations.
export function createHost({ projectRoot, materialRoots, organizationSource, organizationTarget, controls: hostControls } = {}) {
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
        { useCase: 'policy', policy: parsed.document, target: { project: projectRoot },
          ...(organizationSource !== undefined ? { organizationSource } : {}),
          ...(organizationTarget !== undefined ? { organizationTarget } : {}) },
        controlsFor(controls)
      );
      // Only the named serializable fields reach the UI; the handle never does.
      const handle = preparation.prepared;
      const result = JSON.parse(JSON.stringify(Object.fromEntries(PREPARATION_FIELDS
        .filter(name => preparation[name] !== undefined).map(name => [name, preparation[name]]))));
      if (handle) {
        const sessionId = randomUUID();
        sessions.set(sessionId, {
          handle,
          reviewDigest: preparation.review.reviewDigest
        });
        result.sessionId = sessionId;
      }
      return result;
    },

    // Read-only comparison of the policy's declared file intent with the target.
    // No preparation, custody, history or process execution.
    async checkFiles({ policyText, controls } = {}) {
      const parsed = parsePolicy(policyText);
      if (!parsed.valid) return { status: 'invalid', diagnostics: parsed.diagnostics };
      const roots = controls?.materialRoots ?? materialRoots;
      return checkFileState({ policy: parsed.document, target: { project: projectRoot } }, {
        ...(roots !== undefined ? { materialRoots: roots } : {}),
        ...(controls?.privateInputs !== undefined ? { privateInputs: controls.privateInputs } : {})
      });
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
