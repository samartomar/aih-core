import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import type * as Harness from '../../harness/native/runtime.mjs';
import { NativeStop } from './native-input.js';
import type { NativeDefinition, NativeRuntime, NativeIdentityCapture, NativeSessionCleanup, NativeSessionHandle, NativeSessionObservations } from './native-session.js';
import { nativeReadPinned, type NativeMaterial } from './native-material.js';
import { canonicalJson } from './canonical.js';
import { sha256 } from './host-files.js';

/** A stalled helper cannot extend the single cleanup allowance or claim termination. */
async function terminateBounded(handle: Harness.LifecycleHandle, deadline: number, graceMs: number): Promise<NativeSessionCleanup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unresolved: NativeSessionCleanup = { confirmed: false, survivors: [{ pid: handle.pid, role: 'client' }], reason: 'termination-unresolved' };
  try {
    return await Promise.race([
      handle.terminate({ graceMs, deadlineMs: Math.max(0, deadline - performance.now()) })
        .then(receipt => ({ confirmed: receipt.processes === 'confirmed', survivors: receipt.survivors }), () => unresolved),
      new Promise<NativeSessionCleanup>(resolve => { timer = setTimeout(() => resolve(unresolved), Math.max(1, deadline - performance.now())); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Adapt the installed, fixed Harness exports; callers cannot provide this module. */
export function nativeRuntime(module: typeof Harness): NativeRuntime {
  const definitions = module.nativeVerificationDefinitions as readonly NativeDefinition[];
  const identities = new WeakMap<NativeIdentityCapture, Harness.CapturedIdentity>();
  const checkTime = (input: { deadline: number; signal?: AbortSignal }) => {
    if (input.signal?.aborted) throw new NativeStop('cancelled');
    if (performance.now() >= input.deadline) throw new NativeStop('budget-exhausted');
  };
  const fixture = (definition: NativeDefinition, check: () => void): NativeMaterial => {
    check();
    const resolved = module.resolveBundledFixture(definition.client as Harness.NativeClientId);
    if (resolved.outcome !== 'selected') throw new NativeStop(resolved.reason, 'unsupported');
    const metadata = module.bundledNativeFixtures.find(value => value.client === definition.client);
    if (!metadata || !module.verifyFixtureMaterials(resolved).ok) throw new NativeStop('fixture-bytes-mismatch', 'failed');
    const bytes = new Map<string, Buffer>();
    for (const file of [...metadata.outputTree, ...metadata.guardrails]) {
      const captured = resolved.files.find(value => value.root === file.root && value.path === file.path);
      if (!captured) throw new NativeStop('fixture-bytes-mismatch', 'failed');
      bytes.set(file.member.path, Buffer.from(captured.bytes));
    }
    check();
    return { ...metadata, scope: 'bundled-mechanism', bytes } as NativeMaterial;
  };
  const runtime: NativeRuntime = {
    nativeDefinitions: definitions,
    nativeBundledFixture(definition, input) { return fixture(definition, input.check); },
    nativeServerEvidenceAvailable(material) {
      if (material.server.evidenceAdapterId === module.recorderId) {
        try {
          const fixed = module.recorderMaterial(); const declared = material.server.recorder;
          if (material.server.observation !== 'recorder' || !declared || declared.sha256 !== fixed.sha256 || declared.byteLength !== fixed.byteLength ||
              !module.recorderPlan(material as unknown as Harness.ResolvedFixture)) return false;
          // Ordinary configuration already references this exact output; instrumentation never adds it.
          const selected = material.outputTree.find(file => file.root === fixed.root && file.path === fixed.path && file.member.path === declared.path &&
            file.member.sha256 === fixed.sha256 && file.member.byteLength === fixed.byteLength);
          const captured = material.bytes.get(declared.path);
          return !!selected && !!captured && captured.equals(fixed.bytes) && material.server.runtime.every(member =>
            material.outputTree.some(file => file.member.path === member.path && file.member.sha256 === member.sha256 && file.member.byteLength === member.byteLength));
        } catch { return false; }
      }
      if (material.server.evidenceAdapterId !== 'aihq.fixture.v1') return false;
      const expected = module.bundledNativeFixtures.find(value => value.client === material.client);
      return !!expected && canonicalJson(material.server.runtime) === canonicalJson(expected.server.runtime);
    },
    nativeManagedRestriction() { return module.observeClaudeManagedSettings().outcome === 'restricted'; },
    nativeCapabilities(definition) {
      const lifecycle = module.lifecycleAvailability(definition.lifecycleId, definition.platform.os);
      // Node exposes neither the required IPC peer-identity facility nor an observed whole-client
      // credential channel/boundary. A documentation-derived filename cannot prove that channel.
      return { lifecycle: lifecycle.status === 'available', peerIdentity: false, credentialChannel: false,
        ...(lifecycle.status !== 'available' ? { reason: lifecycle.reason } : {}) };
    },
    async resolveNativeClient(definition, input) {
      checkTime(input);
      const client = await module.pinExecutable({ names: definition.executableNames, pathEnv: process.env.PATH ?? '', platform: definition.platform.os });
      checkTime(input);
      if (client.status !== 'pinned') return { outcome: 'unavailable', reason: client.reason };
      if (client.byteLength > 256 * 1024 * 1024) return { outcome: 'unavailable', reason: 'limit-exceeded' };
      const lifecycle = module.lifecycleAvailability(definition.lifecycleId, definition.platform.os);
      if (lifecycle.status !== 'available') return { outcome: 'unsupported', reason: lifecycle.reason };
      const capabilities = runtime.nativeCapabilities(definition);
      if (!capabilities.lifecycle) return { outcome: 'unavailable', reason: 'termination-unresolved' };
      if (!input.acquireCell) return { outcome: 'unavailable', reason: 'sandbox-root-unavailable' };
      const cell = await input.acquireCell(); checkTime(input);
      const nodeSha256 = sha256(nativeReadPinned(process.execPath, 256 * 1024 * 1024, () => checkTime(input)));
      const env: Record<string, string> = { PATH: [dirname(client.path), dirname(process.execPath)].join(process.platform === 'win32' ? ';' : ':'), HOME: cell.home, USERPROFILE: cell.home,
        APPDATA: cell.home, LOCALAPPDATA: cell.home, XDG_CONFIG_HOME: cell.home, XDG_DATA_HOME: cell.home, XDG_CACHE_HOME: cell.scratch,
        XDG_STATE_HOME: cell.scratch, TEMP: cell.scratch, TMP: cell.scratch, TMPDIR: cell.scratch, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
      if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      const launched = await module.startLifecycle({ lifecycleId: definition.lifecycleId, os: definition.platform.os, file: client.path, argv: definition.versionArgv, cwd: cell.project, env });
      if (launched.status !== 'started') return { outcome: 'unavailable', reason: launched.reason };
      const processHandle = launched.handle; let output = ''; let bytes = 0; let overflow = false;
      processHandle.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes <= 4096) output += String(chunk); else overflow = true; });
      processHandle.stderr.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 4096) overflow = true; });
      let stopped: string | undefined;
      let cleanupStartedAt: number | undefined; let termination: Promise<NativeSessionCleanup> | undefined;
      let notifyStopped!: () => void;
      const stoppedPromise = new Promise<void>(resolve => { notifyStopped = resolve; });
      const terminate = () => termination ??= terminateBounded(processHandle, cleanupStartedAt === undefined ? input.deadline : cleanupStartedAt + 10000, 1000);
      const abort = () => { stopped = 'cancelled'; cleanupStartedAt ??= performance.now(); void terminate().then(notifyStopped); };
      input.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { stopped ??= 'budget-exhausted'; cleanupStartedAt ??= performance.now(); void terminate().then(notifyStopped); }, Math.max(1, input.deadline - performance.now()));
      if (input.signal?.aborted) abort();
      try {
        processHandle.stdin.end();
        const exit = await Promise.race([processHandle.exited, stoppedPromise.then(() => null)]);
        const receipt = await terminate();
        if (!receipt.confirmed) return { outcome: 'unavailable', reason: 'termination-unresolved', cleanup: receipt, cleanupStartedAt, probeBytes: bytes };
        if (stopped) return { outcome: 'unavailable', reason: stopped, cleanup: { confirmed: true, survivors: [] }, cleanupStartedAt, probeBytes: bytes };
        if (overflow) return { outcome: 'unavailable', reason: 'limit-exceeded', cleanup: { confirmed: true, survivors: [] }, probeBytes: bytes };
        const version = exit?.code === 0 ? module.parseClaudeVersionOutput(output) : null;
        if (!version) return { outcome: 'unavailable', reason: 'version-unreadable', cleanup: { confirmed: true, survivors: [] }, probeBytes: bytes };
        return { executable: client.path, sha256: client.sha256, observedVersion: version, argv: [client.path, ...definition.sessionArgv],
          runtime: [{ path: process.execPath, sha256: nodeSha256 }], probeCreated: true, probeBytes: bytes };
      } catch (error) {
        cleanupStartedAt ??= performance.now();
        return { outcome: 'unavailable', reason: error instanceof NativeStop ? error.reason : 'native-internal', cleanup: await terminate(), cleanupStartedAt, probeBytes: bytes };
      } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
    },
    revalidateNativeClient(pin, input) {
      try { return sha256(nativeReadPinned(pin.executable, 256 * 1024 * 1024, input.check)) === pin.sha256 && pin.runtime.every(value => sha256(nativeReadPinned(value.path, 256 * 1024 * 1024, input.check)) === value.sha256); }
      catch (error) { if (error instanceof NativeStop && ['cancelled', 'budget-exhausted'].includes(error.reason)) throw error; return false; }
    },
    async captureNativeIdentity(binding, definition, input) {
      checkTime(input);
      if (!runtime.nativeCapabilities(definition).credentialChannel) return { outcome: 'unsupported', reason: 'authentication-channel-unsupported' };
      const captured = await module.captureTestIdentity(binding); checkTime(input);
      if (captured.status !== 'captured') return { outcome: 'unavailable', reason: captured.reason };
      const identity: NativeIdentityCapture = { credential: captured.credential, expected: { ...binding.expected }, sourceIdentity: null };
      identities.set(identity, captured); return identity;
    },
    async revalidateNativeIdentity(identity, input) { input.check(); const captured = identities.get(identity); const same = captured ? await captured.recheck() : false; input.check(); return same; },
    async protectNativeCell(cell, input) {
      if (input.signal?.aborted || performance.now() >= input.deadline || process.platform === 'win32') return false;
      try { const stats = lstatSync(cell.path); return stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0; }
      catch { return false; }
    },
    async startNativeSession(input) {
      checkTime(input);
      if (runtime.nativeManagedRestriction?.(input.definition)) return { outcome: 'restricted', reason: 'managed-restriction' };
      const capabilities = runtime.nativeCapabilities(input.definition);
      if (!capabilities.lifecycle) return { outcome: 'unavailable', reason: 'termination-unresolved' };
      if (!capabilities.credentialChannel) return { outcome: 'unsupported', reason: 'authentication-channel-unsupported' };
      if (!capabilities.peerIdentity || !runtime.nativeServerEvidenceAvailable(input.material)) return { outcome: 'unavailable', reason: 'server-evidence-unavailable' };
      if (input.material.instructions.some(value => value.evidence !== 'marker')) return { outcome: 'unavailable', reason: 'instruction-attestation-unobservable' };
      const resolved = { server: input.material.server, instructions: input.material.instructions } as Harness.ResolvedFixture;
      const collector = module.createClaudeCollector({ expected: input.identity.expected });
      let channel: Harness.EvidenceChannel | undefined; let lifecycle: Harness.LifecycleHandle | undefined;
      let channelResult: Awaited<ReturnType<Harness.EvidenceChannel['close']>> | undefined;
      let channelClose: Promise<typeof channelResult> | undefined;
      let termination: Promise<NativeSessionCleanup> | undefined; let cleanupStartedAt: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined; let abort: (() => void) | undefined;
      let outputBytes = 0; let stopped: string | undefined;
      const detach = () => { if (timer) clearTimeout(timer); if (abort) input.signal?.removeEventListener('abort', abort); };
      const closeChannel = () => channelClose ??= (channel ? channel.close().then(result => channelResult = result) : Promise.resolve(undefined));
      const cleanup = async (deadline: number, graceMs: number): Promise<NativeSessionCleanup> => {
        detach();
        if (!lifecycle) { await collector.cancel(); await closeChannel(); return { confirmed: true, survivors: [] }; }
        termination ??= terminateBounded(lifecycle, deadline, graceMs);
        const receipt = await termination;
        await collector.cancel(); await closeChannel(); return receipt;
      };
      const incomplete = (reason: string): NativeSessionObservations => ({ sessionId: null, resumed: false, loading: 'unobservable', restrictions: 'unobservable', authentication: 'missing',
        discovery: { complete: false, clientTools: [], serverList: false }, instructions: { nativeSha256: [], attestations: [], rejected: false, alternateRead: false },
        query: { correlated: false, challengeMatched: false, resultSha256: null, answerSha256: null }, isolation: 'unobservable', serverPeerBound: false,
        failure: { reason, outcome: 'unavailable' }, counts: { observedBytes: outputBytes, telemetryEvents: 0, rpcMessages: 0 } });
      const ownedHandle = (observations: Promise<NativeSessionObservations>): NativeSessionHandle => ({ pid: lifecycle!.pid,
        argv: [input.pin.executable, ...input.definition.sessionArgv], challenge: channel!.challenge,
        get cleanupStartedAt() { return cleanupStartedAt; }, observations, cleanup: value => cleanup(value.deadline, value.graceMs) });
      try {
        const telemetry = await collector.start(); checkTime(input);
        // This callback cannot admit a self-reported PID. The current OS helper has no observed
        // owned-server birth/membership facility, so the native capability remains false above.
        const plan = input.material.server.evidenceAdapterId === module.recorderId ? module.recorderPlan(resolved) : null;
        channel = await module.startEvidenceChannel({ directory: input.cell.observations, isOwnedServer: () => false, plan });
        checkTime(input);
        const challenge = channel.challenge;
        const options = module.claudeStreamOptions(resolved, challenge);
        const parsers = input.material.instructions.map(value => module.createClaudeStreamParser({ ...options, markerSha256: value.markerSha256! }));
        const env = module.buildClaudeEnvironment({ platform: input.definition.platform.os, hostEnv: input.environment, homeDir: input.cell.home,
          scratchDir: input.cell.scratch, runtimeDirs: [dirname(input.pin.executable), ...input.pin.runtime.map(value => dirname(value.path))], telemetry,
          evidence: { endpoint: channel.endpoint, token: channel.token } });
        const launched = await module.startLifecycle({ lifecycleId: input.definition.lifecycleId, os: input.definition.platform.os,
          file: input.pin.executable, argv: input.definition.sessionArgv, cwd: input.cell.project, env });
        if (launched.status !== 'started') { await collector.cancel(); await closeChannel(); return { outcome: 'unavailable', reason: launched.reason }; }
        lifecycle = launched.handle;
        let overflow = false;
        let notifyStopped!: () => void;
        const stoppedPromise = new Promise<void>(resolve => { notifyStopped = resolve; });
        lifecycle.stdout.on('data', chunk => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > 2 * 1024 * 1024) { overflow = true; void stop('limit-exceeded'); } else for (const parser of parsers) parser.push(chunk); });
        lifecycle.stderr.on('data', chunk => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > 2 * 1024 * 1024) { overflow = true; void stop('limit-exceeded'); } });
        const stop = async (reason: string) => {
          stopped ??= reason; cleanupStartedAt ??= performance.now();
          try { await cleanup(cleanupStartedAt + 10000, 1000); }
          catch { /* Core will retain the cell if its cleanup call cannot confirm every resource. */ }
          finally { notifyStopped(); }
        };
        abort = () => { void stop('cancelled'); };
        input.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { void stop('budget-exhausted'); }, Math.max(1, input.deadline - performance.now()));
        if (input.signal?.aborted) abort();
        const launchedAtMs = Date.now();
        lifecycle.stdin.end(input.prompt.replaceAll(input.challenge, challenge));
        const observations: Promise<NativeSessionObservations> = (async () => {
          try {
            await Promise.race([lifecycle!.exited, stoppedPromise]);
            if (stopped) return incomplete(stopped);
            const streams = parsers.map(parser => parser.finish()); const stream = streams[0]!; collector.bindSession(stream.sessionId);
            const telemetryResult = await collector.drain({ launchedAtMs, closedAtMs: Date.now(), timeoutMs: Math.min(2000, Math.max(0, input.deadline - performance.now())) });
            const evidence = await closeChannel();
            const spec = { ...module.serverEvidenceSpec(resolved), queryTool: input.material.server.queryTool };
            const server = module.evaluateServerEvidence(evidence?.frames ?? [], spec);
            const managed = module.observeClaudeManagedSettings();
            const evaluation = module.evaluateClaudeSession({ sessionIndex: input.index, previousSessionId: null, stream, managed,
              telemetry: telemetryResult, server: { channel: evidence ?? null, evaluation: server }, toolNames: input.material.server.toolNames, deniedBuiltins: module.claudeDeniedBuiltins });
            const row = (id: string) => evaluation.rows.find(value => value.id === id);
            const failure = stopped ?? (overflow || stream.status === 'limit-exceeded' || evidence?.violation === 'limit-exceeded' ? 'limit-exceeded' : stream.status === 'malformed' ? 'session-identity-unobservable' : undefined);
            return { sessionId: stream.sessionIdConsistent ? stream.sessionId : null, resumed: false, loading: row('loading-mode')?.outcome === 'passed' ? 'observed' : row('loading-mode')?.reason === 'configuration-not-loaded' ? 'not-loaded' : 'unobservable',
              restrictions: managed.outcome === 'restricted' ? 'managed' : row('tool-restrictions')?.outcome === 'passed' && server.unrequestedCalls === 0 ? 'observed' : 'unobservable',
              authentication: telemetryResult.outcome === 'passed' ? 'matched' : telemetryResult.reason === 'identity-conflict' ? 'conflict' : telemetryResult.reason === 'identity-session-mismatch' ? 'wrong-session' : 'missing',
              discovery: { complete: server.initialize && server.discovery === 'complete' && stream.toolsListed, clientTools: stream.visibleSelectedTools, serverList: server.initialize && server.discovery === 'complete' },
              instructions: { nativeSha256: [], attestations: (evidence?.frames ?? []).filter(value => (value as Record<string, unknown>).method === 'tools/call' && (value as Record<string, unknown>).tool === spec.attestTool)
                .map(value => { const frame = value as Record<string, unknown>; const selected = input.material.instructions.findIndex(instruction => instruction.markerSha256 === frame.markerSha256);
                  return { markerSha256: typeof frame.markerSha256 === 'string' ? frame.markerSha256 : '0'.repeat(64), challengeMatched: frame.challengeMatched === true && frame.resultSha256 !== null,
                    clientReceipt: selected >= 0 && streams[selected]!.attestationReturned }; }), rejected: false,
                alternateRead: input.material.instructions.some(value => module.evaluateServerEvidence(evidence?.frames ?? [], { ...spec, markerSha256: value.markerSha256! }).ambiguousBeforeAttestation) ||
                  streams.some(value => value.unselectedToolUses.some(use => use.permitted && use.beforeAttestation)) },
              query: { correlated: server.query !== 'missing' && server.query !== 'refused', challengeMatched: server.query === 'answered' || server.query === 'result-mismatch', resultSha256: server.queryResultSha256,
                answerSha256: stream.answerReturned ? sha256(input.material.server.expectedAnswer) : null, rejectedCalls: server.rejectedQueryCalls > 0 }, isolation: 'unobservable', serverPeerBound: evidence?.peer === 'authenticated' && !evidence.violation,
              ...(failure ? { failure: { reason: failure, outcome: 'unavailable' as const } } : {}),
              counts: { observedBytes: outputBytes + telemetryResult.bytes + (evidence?.bytes ?? 0), telemetryEvents: telemetryResult.counts.events, rpcMessages: evidence?.frames.length ?? 0 } };
          } finally { detach(); }
        })();
        return ownedHandle(observations);
      } catch (error) {
        const reason = error instanceof NativeStop ? error.reason : 'native-internal';
        if (lifecycle) {
          cleanupStartedAt ??= performance.now();
          // Core receives ownership even when stdin/observation initialization fails after spawn.
          return { outcome: 'unavailable', reason, partial: ownedHandle(Promise.resolve(incomplete(reason))) };
        }
        await cleanup(input.deadline, 1000);
        return { outcome: 'unavailable', reason };
      }
    },
    nativeStatePaths() { return { home: [], project: [] }; },
  };
  return runtime;
}
