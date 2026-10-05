// Map one Claude session's observations onto the contract's canonical session rows.
// Pure: it never starts anything and every missing observation stays unavailable, never a pass.
const NONE = Object.freeze({ kind: 'none' });

export function evaluateClaudeSession({ sessionIndex, previousSessionId, stream, managed, telemetry, server, toolNames,
  deniedBuiltins }) {
  const restricted = managed?.outcome === 'restricted';
  const row = (id, outcome, reason, evidence = NONE) => ({ id, session: sessionIndex, outcome, reason, evidence });
  const unavailable = (id, reason) => row(id, 'unavailable', reason);
  const streamLimit = stream.status === 'limit-exceeded';
  const malformed = stream.status === 'malformed';
  const downstream = reason => (restricted ? 'not-run-after-restriction' : reason);

  const freshness = (() => {
    if (streamLimit) return unavailable('session-freshness', 'limit-exceeded');
    if (malformed || stream.sessionId === null || !stream.sessionIdConsistent)
      return unavailable('session-freshness', 'session-identity-unobservable');
    if (sessionIndex === 2) {
      if (previousSessionId === null) return unavailable('session-freshness', 'session-identity-unobservable');
      if (previousSessionId === stream.sessionId) return row('session-freshness', 'failed', 'session-not-fresh');
    }
    return row('session-freshness', 'passed', 'observed', { kind: 'match', matched: true });
  })();

  const loading = (() => {
    if (streamLimit) return unavailable('loading-mode', 'limit-exceeded');
    if (malformed) return unavailable('loading-mode', 'loading-mode-unobservable');
    if (stream.serverStatus === 'connected') return row('loading-mode', 'passed', 'observed', { kind: 'match', matched: true });
    if (restricted) return row('loading-mode', 'restricted', 'managed-restriction');
    if (stream.serverStatus === null) return unavailable('loading-mode', 'loading-mode-unobservable');
    if (stream.serverStatus === 'absent') return row('loading-mode', 'failed', 'configuration-not-loaded');
    return unavailable('loading-mode', 'server-evidence-unavailable');
  })();

  const restrictions = (() => {
    if (streamLimit) return unavailable('tool-restrictions', 'limit-exceeded');
    if (restricted) return row('tool-restrictions', 'restricted', 'managed-restriction');
    if (malformed || !stream.toolsListed || managed?.outcome === 'unreadable')
      return unavailable('tool-restrictions', 'restriction-unobservable');
    const offered = stream.builtinTools.length > 0 || (stream.unselectedTools ?? 0) > 0;
    const used = stream.unselectedToolUses.some(use => use.permitted);
    if (offered || used) return unavailable('tool-restrictions', 'restriction-unobservable');
    return row('tool-restrictions', 'passed', 'observed', { kind: 'counts', count: stream.builtinTools.length });
  })();

  const authentication = (() => {
    if (telemetry?.outcome === 'passed') return row('provider-authentication', 'passed', 'observed', { kind: 'counts', count: telemetry.counts.matched });
    if (restricted) return row('provider-authentication', 'restricted', 'managed-restriction');
    return unavailable('provider-authentication', telemetry?.reason ?? 'authentication-unavailable');
  })();

  // Rows that depend on the authenticated server observation stream.
  const serverGuard = id => {
    if (streamLimit || server.channel?.violation === 'limit-exceeded') return unavailable(id, 'limit-exceeded');
    if (malformed || server.channel?.peer !== 'authenticated' || server.channel?.violation) return unavailable(id, downstream('server-evidence-unavailable'));
    return null;
  };
  const ev = server.evaluation;

  const discovery = serverGuard('tool-discovery') ?? (() => {
    if (ev.discovery !== 'complete' || !stream.toolsListed) return unavailable('tool-discovery', downstream('server-evidence-unavailable'));
    if (toolNames.every(name => stream.visibleSelectedTools.includes(name)))
      return row('tool-discovery', 'passed', 'observed', { kind: 'counts', count: stream.visibleSelectedTools.length });
    return row('tool-discovery', 'failed', 'tools-not-discovered');
  })();

  const instruction = serverGuard('instruction-loading') ?? (() => {
    if (ev.ambiguousBeforeAttestation || stream.unselectedToolUses.some(use => use.permitted && use.beforeAttestation))
      return unavailable('instruction-loading', 'instruction-source-ambiguous');
    if (ev.attestation === 'mismatch') return unavailable('instruction-loading', 'instruction-attestation-mismatch');
    if (ev.attestation === 'attested' && stream.attestationReturned)
      return row('instruction-loading', 'passed', 'observed', { kind: 'match', matched: true });
    return unavailable('instruction-loading', downstream('instruction-attestation-unobservable'));
  })();

  const query = serverGuard('read-only-query') ?? (() => {
    if (ev.unrequestedCalls > 0) return unavailable('read-only-query', 'restriction-unobservable');
    if (ev.query === 'challenge-mismatch') return unavailable('read-only-query', 'query-challenge-mismatch');
    if (ev.query === 'result-mismatch') return row('read-only-query', 'failed', 'query-answer-mismatch');
    if (ev.query === 'answered' && typeof stream.answerSha256 === 'string' && !stream.answerReturned)
      return row('read-only-query', 'failed', 'query-answer-mismatch');
    if (ev.rejectedQueryCalls > 0) return unavailable('read-only-query', 'restriction-unobservable');
    if (ev.query === 'answered' && stream.answerReturned)
      return row('read-only-query', 'passed', 'observed', { kind: 'digest', sha256: ev.queryResultSha256 });
    return unavailable('read-only-query', downstream('server-evidence-unavailable'));
  })();

  // No client-native observer is implemented, so isolation is never observed here.
  const isolation = unavailable('isolation', 'isolation-unobserved');
  const rows = [freshness, loading, restrictions, authentication, discovery, instruction, query, isolation];
  return { rows, proceed: rows.every(entry => entry.id === 'isolation' || entry.outcome === 'passed'),
    notes: ['managed-registry-mdm-server-sources-unobserved'] };
}
