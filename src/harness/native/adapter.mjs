import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, posix, sep, win32 } from "node:path";
import { canonicalJson } from "./canonical.mjs";
import { validateNativeVerificationDefinition } from './contracts.mjs';
import { claudeConfigDirectory } from "./claude.mjs";
import { claudeGlobalStatePath, claudeStatePaths, inspectClaudeGlobalState } from "./claude-state.mjs";
import { sha256 } from "./digest.mjs";
import { CREDENTIAL_DESTINATION } from "./identity.mjs";
import { publishNativeAdmission, publishNativeDiagnostics, publishNativePersistenceDiagnostics } from './admission.mjs';
import { createPersistenceDiagnosticClassifier } from './persistence-diagnostics.mjs';
const sameWindowsPath = (a, b) => typeof a === "string" && typeof b === "string" && win32.isAbsolute(a) && win32.isAbsolute(b) && win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const linuxVendor = definition => definition.platform.os === 'linux' && definition.lifecycleId === 'linux-srt.v1' && definition.isolation?.mechanism === 'vendor-runtime';
const ENTRY_MARKER = "--aihq-native-absolute-entry";
const MAX_PINNED_BYTES = 256 * 1024 * 1024;
// `handle` is a started lifecycle handle or, when no client was started, the prepared context. The race
// only bounds the wait: the actual cleanup resource is bounded by the deadlineMs the facility enforces.
async function terminateBounded(handle, deadline, graceMs) {
  let timer;
  const unresolved = { confirmed: false, survivors: handle.pid ? [{ pid: handle.pid, role: "client" }] : [], reason: "termination-unresolved" };
  try {
    return await Promise.race([
      handle.terminate({ graceMs, deadlineMs: Math.max(0, deadline - performance.now()) }).then((receipt) => ({ confirmed: receipt.processes === "confirmed", survivors: receipt.survivors }), () => unresolved),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(unresolved), Math.max(1, deadline - performance.now()));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function createNativeRuntime(module, dependencies) {
  const persistenceClassifier = createPersistenceDiagnosticClassifier();
  const { readPinned: nativeReadPinned, Stop: NativeStop } = dependencies;
  const observeFacility = result => {
    if (result?.cleanup) dependencies.recordCleanup?.(result.cleanup, result.cleanupStartedAt);
    return result;
  };
  const definitions = module.nativeVerificationDefinitions.filter(definition =>
    definition.state !== 'admitted' || validateNativeVerificationDefinition(definition).valid);
  const adapters = new Set(["claude-stream-json.v1"]);
  const identitiesSupported = new Set(["claude-oauth-otel.v1"]);
  const identities = new WeakMap();
  const linuxClients = new WeakMap();
  const managedPolicy = definition => linuxVendor(definition) ? module.observeLinuxNativePolicy(definition.platform.execution) : module.observeClaudeManagedSettings();
  const checkTime = (input) => {
    if (input.signal?.aborted) throw new NativeStop("cancelled");
    if (performance.now() >= input.deadline) throw new NativeStop("budget-exhausted");
  };
  const fixture = (definition, check) => {
    check();
    const resolved = module.resolveBundledFixture(definition.client);
    if (resolved.outcome !== "selected") throw new NativeStop(resolved.reason, "unsupported");
    const metadata = module.bundledNativeFixtures.find((value) => value.client === definition.client);
    if (!metadata || !module.verifyFixtureMaterials(resolved).ok) throw new NativeStop("fixture-bytes-mismatch", "failed");
    const bytes = new Map();
    for (const file of [...metadata.outputTree, ...metadata.guardrails]) {
      const captured = resolved.files.find((value) => value.root === file.root && value.path === file.path);
      if (!captured) throw new NativeStop("fixture-bytes-mismatch", "failed");
      bytes.set(file.member.path, Buffer.from(captured.bytes));
    }
    check();
    return { ...metadata, scope: "bundled-mechanism", bytes };
  };
  // Real, bounded observation of the platform facilities; nothing is inferred from a boolean or a file.
  // Peer identity exists only where a lifecycle context emits OS-bound streams (Windows Job + pipe).
  // The credential channel check is a static declaration only: the exact destination and the CLAUDE_CONFIG_DIR
  // redirect that reaches it. The scoped protection is validated separately on the actual cell, and the
  // account identity is never claimed until same-session telemetry matches.
  const credentialChannelSupported = (definition) => {
    try {
      const destination = definition.credentialDestination;
      const linux = linuxVendor(definition), platform = linux ? 'linux' : 'win32';
      const home = linux ? '/aih-probe' : 'C:\\aihq-probe', paths = linux ? posix : win32;
      const redirect = claudeConfigDirectory(platform, home, posix.dirname(destination.path));
      return definition.client === "claude" && identitiesSupported.has(definition.identityAdapterId) && destination.root === CREDENTIAL_DESTINATION.root && destination.path === CREDENTIAL_DESTINATION.path && redirect === paths.join(home, posix.dirname(destination.path)) && (linux || typeof module.protectWindowsCell === "function");
    } catch {
      return false;
    }
  };
  const stageReason = (reason, fallback) => typeof reason === "string" && module.nativeStageReasons?.includes(reason) ? reason : fallback;
  // Facility reasons outside the stage vocabulary are mapped, never forwarded raw.
  const facilityReason = (reason, fallback) => reason === "deadline" ? "budget-exhausted" : stageReason(reason, fallback);
  // The exact launch selection, as {runtimePins, entries} in the facility's agreed shapes. Every pinned file
  // is read now and must match its declared digest/length. The one selected entry is derived from the pinned
  // .mcp.json declaration itself: Claude runs `node <relative module> <rest>`; the absolute-entry child the
  // facility observes therefore has argv [absolute module, marker, ...rest]. A declaration that cannot
  // determine that argv exactly (not a plain `node` stdio command, module differs, recorder without
  // `-- <upstream command>`) is refused rather than guessed.
  const launchPlan = (input) => {
    const { material, cell, pin } = input;
    const check = () => checkTime(input);
    const refused = () => new NativeStop("server-evidence-unavailable");
    try {
      const cellRoot = `${pathKey(realpathSync.native(cell.path))}${sep}`;
      const pins = new Map();
      const addPin = (path, expected, reason) => {
        const canonical = realpathSync.native(path);
        const bytes = nativeReadPinned(canonical, MAX_PINNED_BYTES, check);
        const digest = sha256(bytes);
        if (digest !== expected.sha256 || expected.byteLength !== undefined && bytes.length !== expected.byteLength) throw new NativeStop(reason, "failed");
        const value = { path: canonical, sha256: digest, byteLength: bytes.length };
        pins.set(pathKey(canonical), value);
        return value;
      };
      addPin(pin.executable, pin, "executable-changed");
      for (const value of pin.runtime) addPin(value.path, value, "executable-changed");
      if (linuxVendor(input.definition)) for (const file of [...material.outputTree, ...(input.definition.guardrails ?? [])]) {
        const canonical = realpathSync.native(join(cell[file.root], ...file.path.split('/')));
        if (!pathKey(canonical).startsWith(cellRoot)) throw new NativeStop('material-path-unsafe', 'failed');
        addPin(canonical, file.member, 'fixture-bytes-mismatch');
      }
      const nodeCanonical = pathKey(realpathSync.native(process.execPath));
      const nodePin = pins.get(nodeCanonical);
      if (!nodePin) throw new NativeStop("executable-changed", "failed");
      const locate = (member) => {
        const file = material.outputTree.find((value) => value.member.path === member.path && value.member.sha256 === member.sha256 && value.member.byteLength === member.byteLength);
        if (!file || file.root !== "home" && file.root !== "project") throw refused();
        const canonical = realpathSync.native(join(cell[file.root], ...file.path.split("/")));
        if (!pathKey(canonical).startsWith(cellRoot)) throw new NativeStop("material-path-unsafe", "failed");
        return { file, pin: addPin(canonical, member, "fixture-bytes-mismatch") };
      };
      const recorded = material.server.evidenceAdapterId === module.recorderId;
      const closure = material.server.runtime.map(locate);
      let selected = closure[0];
      if (recorded) {
        const fixed = module.recorderMaterial();
        if (!material.server.recorder) throw refused();
        selected = locate({ path: material.server.recorder.path, sha256: fixed.sha256, byteLength: fixed.byteLength });
      }
      if (!selected) throw refused();
      const configuration = material.outputTree.find((value) => value.root === "project" && value.path === ".mcp.json");
      const configurationBytes = configuration && material.bytes.get(configuration.member.path);
      if (!configurationBytes || sha256(configurationBytes) !== configuration.member.sha256) throw refused();
      let declared;
      try {
        const servers = module.parseStrictJson(Buffer.from(configurationBytes).toString("utf8")).mcpServers;
        declared = servers && Object.hasOwn(servers, material.server.name) ? servers[material.server.name] : undefined;
      } catch {
        throw refused();
      }
      if (!declared || declared.command !== "node" || !Array.isArray(declared.args) || declared.args.length === 0 || declared.args.some((value) => typeof value !== "string" || value.includes("\0"))) throw refused();
      const [relative, ...remainder] = declared.args;
      if (relative.includes("\\") || posix.isAbsolute(relative) || posix.normalize(relative) !== selected.file.path) throw refused();
      if (recorded ? remainder[0] !== "--" || remainder.length < 2 : remainder.length !== 0) throw refused();
      const entries = [{ id: recorded ? "aihq-recorder" : "aihq-fixture", executablePath: nodePin.path, executableSha256: nodePin.sha256, argv: [selected.pin.path, ENTRY_MARKER, ...remainder] }];
      return { runtimePins: [...pins.values()], entries };
    } catch (error) {
      if (error instanceof NativeStop) throw error;
      throw refused();
    }
  };
  // Authenticate an observed OS peer. The facility already checked Job membership and the held process
  // identity; here the reported id, image and exact argv must name exactly one selected entry, and every
  // runtime pin is held by the facility with write/delete sharing denied. Anything missing,
  // relative or ambiguous is refused; command-line matching is not execution attestation.
  const ownedPeer = async (identity, selection, input) => {
    try {
      if (identity?.status !== "observed" || !Number.isSafeInteger(identity.pid) || typeof identity.birth !== "string" || !/^[0-9]+$/.test(identity.birth)) return false;
      const matches = selection.entries.filter((value) => value.id === identity.selectedEntryId);
      if (matches.length !== 1) return false;
      const [entry] = matches;
      const samePath = linuxVendor(input.definition) ? (a, b) => typeof a === 'string' && posix.isAbsolute(a) && a === b : sameWindowsPath;
      if (!samePath(identity.executablePath, entry.executablePath) || identity.executableSha256 !== entry.executableSha256) return false;
      if (!Array.isArray(identity.argv) || identity.argv.length !== entry.argv.length || !identity.argv.every((value, index) => index === 0 ? samePath(value, entry.argv[0]) : value === entry.argv[index])) return false;
      checkTime(input);
      return true;
    } catch {
      return false;
    }
  };
  // Probes the platform facility within the caller's own deadline/signal; no allowance is renewed here.
  const observeCapabilities = async (definition, input) => {
    let lifecycle;
    try {
      lifecycle = observeFacility(await module.lifecycleAvailability(definition.lifecycleId, definition.platform.os, input ? { deadline: input.deadline, signal: input.signal } : {}));
    } catch {
      lifecycle = { status: "unavailable", reason: "termination-unresolved" };
    }
    const available = lifecycle?.status === "available";
    const windows = definition.platform.os === "win32" && process.platform === "win32" && definition.lifecycleId === "windows-job.v1";
    const linux = linuxVendor(definition) && process.platform === 'linux' && process.arch === 'x64';
    return {
      lifecycle,
      capabilities: {
        lifecycle: available,
        peerIdentity: available && (windows || linux) && !lifecycle.missing && typeof module.prepareLifecycleContext === "function",
        credentialChannel: available && (windows || linux) && credentialChannelSupported(definition),
        ...!available ? { reason: lifecycle?.reason ?? "termination-unresolved" } : {}
      }
    };
  };
  const runtime = {
    nativeDefinitions: definitions,
    nativeBundledFixture(definition, input) {
      return fixture(definition, input.check);
    },
    nativeServerEvidenceAvailable(material) {
      if (material.server.evidenceAdapterId === module.recorderId) {
        try {
          const fixed = module.recorderMaterial();
          const declared = material.server.recorder;
          if (material.server.observation !== "recorder" || !declared || declared.sha256 !== fixed.sha256 || declared.byteLength !== fixed.byteLength || !module.recorderPlan(material)) return false;
          const selected = material.outputTree.find((file) => file.root === fixed.root && file.path === fixed.path && file.member.path === declared.path && file.member.sha256 === fixed.sha256 && file.member.byteLength === fixed.byteLength);
          const captured = material.bytes.get(declared.path);
          return !!selected && !!captured && captured.equals(fixed.bytes) && material.server.runtime.every((member) => material.outputTree.some((file) => file.member.path === member.path && file.member.sha256 === member.sha256 && file.member.byteLength === member.byteLength));
        } catch {
          return false;
        }
      }
      if (material.server.evidenceAdapterId !== "aihq.fixture.v1") return false;
      const expected = module.bundledNativeFixtures.find((value) => value.client === material.client);
      return !!expected && canonicalJson(material.server.runtime) === canonicalJson(expected.server.runtime);
    },
    nativeManagedRestriction(definition) {
      return definition.client === "claude" && adapters.has(definition.parserId) && managedPolicy(definition).outcome === "restricted";
    },
    async nativeCapabilities(definition, input) {
      return (await observeCapabilities(definition, input)).capabilities;
    },
    async resolveNativeClient(definition, input) {
      checkTime(input);
      if (!adapters.has(definition.parserId) || !identitiesSupported.has(definition.identityAdapterId) || definition.client !== "claude") return { outcome: "unsupported", reason: "client-unsupported" };
      const client = await module.pinExecutable({ names: definition.executableNames, pathEnv: process.env.PATH ?? "", platform: definition.platform.os });
      checkTime(input);
      if (client.status !== "pinned") return { outcome: "unavailable", reason: client.reason };
      if (client.byteLength > 256 * 1024 * 1024) return { outcome: "unavailable", reason: "limit-exceeded" };
      const { lifecycle, capabilities } = await observeCapabilities(definition, input);
      checkTime(input);
      if (lifecycle?.status !== "available") return lifecycle?.reason === "platform-unsupported" || !lifecycle?.reason ? { outcome: "unsupported", reason: "platform-unsupported" } : { outcome: "unavailable", reason: facilityReason(lifecycle.reason, "termination-unresolved") };
      if (!capabilities.lifecycle) return { outcome: "unavailable", reason: "termination-unresolved" };
      if (!input.acquireCell) return { outcome: "unavailable", reason: "sandbox-root-unavailable" };
      const cell = await input.acquireCell();
      checkTime(input);
      if (linuxVendor(definition)) {
        const resolved = observeFacility(await module.resolveLinuxNativeClient({ definition, input,
          client: { path: client.path, sha256: client.sha256, byteLength: client.byteLength }, cell, check: () => checkTime(input) }));
        checkTime(input);
        if (resolved.status !== 'resolved') return resolved;
        linuxClients.set(resolved.pin, { platform: resolved.platform, vendor: resolved.vendor, runtime: resolved.runtime });
        return resolved.pin;
      }
      const nodeSha256 = sha256(nativeReadPinned(process.execPath, 256 * 1024 * 1024, () => checkTime(input)));
      const env = {
        PATH: [dirname(client.path), dirname(process.execPath)].join(process.platform === "win32" ? ";" : ":"),
        HOME: cell.home,
        USERPROFILE: cell.home,
        ...definition.platform.os === "win32" && credentialChannelSupported(definition) ? { CLAUDE_CONFIG_DIR: claudeConfigDirectory("win32", cell.home, posix.dirname(definition.credentialDestination.path)) } : {},
        APPDATA: cell.home,
        LOCALAPPDATA: cell.home,
        XDG_CONFIG_HOME: cell.home,
        XDG_DATA_HOME: cell.home,
        XDG_CACHE_HOME: cell.scratch,
        XDG_STATE_HOME: cell.scratch,
        TEMP: cell.scratch,
        TMP: cell.scratch,
        TMPDIR: cell.scratch,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8"
      };
      if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      const launched = observeFacility(await module.startLifecycle({ lifecycleId: definition.lifecycleId, os: definition.platform.os, file: client.path, argv: definition.versionArgv, cwd: cell.project, env, deadline: input.deadline, signal: input.signal }));
      if (launched.status !== "started") {
        const reason = facilityReason(launched.reason, "session-launch-failed");
        if (!launched.partial) return { outcome: "unavailable", reason, ...launched.cleanup ? { cleanup: launched.cleanup, cleanupStartedAt: launched.cleanupStartedAt } : {} };
        // A root created before the failure is still owned: stop it with the standard cleanup allowance.
        const startedAt = performance.now();
        const receipt = await terminateBounded(launched.partial, startedAt + 10_000, 1000);
        return { outcome: "unavailable", reason: receipt.confirmed ? reason : "termination-unresolved", cleanup: receipt, cleanupStartedAt: startedAt };
      }
      const processHandle = launched.handle;
      let output = "";
      let bytes = 0;
      let overflow = false;
      processHandle.stdout.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes <= 4096) output += String(chunk);
        else overflow = true;
      });
      processHandle.stderr.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4096) overflow = true;
      });
      let stopped;
      let cleanupStartedAt;
      let termination;
      let notifyStopped;
      const stoppedPromise = new Promise((resolve) => {
        notifyStopped = resolve;
      });
      const terminate = () => termination ??= terminateBounded(processHandle, cleanupStartedAt === undefined ? input.deadline : cleanupStartedAt + 10_000, 1000);
      const abort = () => {
        stopped = "cancelled";
        cleanupStartedAt ??= performance.now();
        void terminate().then(notifyStopped);
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        stopped ??= "budget-exhausted";
        cleanupStartedAt ??= performance.now();
        void terminate().then(notifyStopped);
      }, Math.max(1, input.deadline - performance.now()));
      if (input.signal?.aborted) abort();
      try {
        processHandle.stdin.end();
        const exit = await Promise.race([processHandle.exited, stoppedPromise.then(() => null)]);
        const receipt = await terminate();
        const nativeFailure = processHandle.failure ?? exit;
        if (Number.isSafeInteger(nativeFailure?.observedBytes)) bytes = Math.max(bytes, nativeFailure.observedBytes);
        const limited = overflow || nativeFailure?.reason === "limit-exceeded";
        if (!receipt.confirmed) return { outcome: "unavailable", reason: stopped ?? (limited ? "limit-exceeded" : "termination-unresolved"), cleanup: receipt, cleanupStartedAt, probeBytes: bytes };
        if (stopped) return { outcome: "unavailable", reason: stopped, cleanup: { confirmed: true, survivors: [] }, cleanupStartedAt, probeBytes: bytes };
        if (limited) return { outcome: "unavailable", reason: "limit-exceeded", cleanup: { confirmed: true, survivors: [] }, probeBytes: bytes };
        const version = exit?.code === 0 ? module.parseClaudeVersionOutput(output) : null;
        if (!version) return { outcome: "unavailable", reason: "version-unreadable", cleanup: { confirmed: true, survivors: [] }, probeBytes: bytes };
        return {
          executable: client.path,
          sha256: client.sha256,
          observedVersion: version,
          argv: [client.path, ...definition.sessionArgv],
          runtime: [{ path: process.execPath, sha256: nodeSha256 }],
          probeCreated: true,
          probeBytes: bytes
        };
      } catch (error) {
        cleanupStartedAt ??= performance.now();
        return { outcome: "unavailable", reason: error instanceof NativeStop ? error.reason : "native-internal", cleanup: await terminate(), cleanupStartedAt, probeBytes: bytes };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
      }
    },
    revalidateNativeClient(pin, input) {
      try {
        return sha256(nativeReadPinned(pin.executable, 256 * 1024 * 1024, input.check)) === pin.sha256 && pin.runtime.every((value) => sha256(nativeReadPinned(value.path, 256 * 1024 * 1024, input.check)) === value.sha256);
      } catch (error) {
        if (error instanceof NativeStop && ["cancelled", "budget-exhausted"].includes(error.reason)) throw error;
        return false;
      }
    },
    async captureNativeIdentity(binding, definition, input) {
      checkTime(input);
      if (!(await runtime.nativeCapabilities(definition, input)).credentialChannel) return { outcome: "unsupported", reason: "authentication-channel-unsupported" };
      const captured = await module.captureTestIdentity(binding);
      checkTime(input);
      if (captured.status !== "captured") return { outcome: "unavailable", reason: captured.reason };
      const identity = { credential: captured.credential, expected: { ...binding.expected }, sourceIdentity: null };
      identities.set(identity, captured);
      return identity;
    },
    async revalidateNativeIdentity(identity, input) {
      input.check();
      const captured = identities.get(identity);
      const same = captured ? await captured.recheck() : false;
      input.check();
      return same;
    },
    async protectNativeCell(cell, input) {
      if (input.signal?.aborted || performance.now() >= input.deadline) return false;
      if (process.platform === "win32") {
        // Only the already-owned exact cell directory: current user, System and Administrators DACL.
        try {
          if (typeof module.protectWindowsCell !== "function") return false;
          const protectedCell = observeFacility(await module.protectWindowsCell({ directory: cell.path, deadline: input.deadline, signal: input.signal }));
          return protectedCell?.status === "protected" && !input.signal?.aborted && performance.now() < input.deadline;
        } catch {
          return false;
        }
      }
      try {
        const stats = lstatSync(cell.path);
        return stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0;
      } catch {
        return false;
      }
    },
    async startNativeSession(input) {
      checkTime(input);
      if (!adapters.has(input.definition.parserId) || !identitiesSupported.has(input.definition.identityAdapterId) || input.definition.client !== "claude") return { outcome: "unsupported", reason: "client-unsupported" };
      if (runtime.nativeManagedRestriction?.(input.definition)) return { outcome: "restricted", reason: "managed-restriction" };
      const linux = linuxVendor(input.definition);
      const linuxClient = linux ? linuxClients.get(input.pin) : null;
      if (linux && (!linuxClient || managedPolicy(input.definition).outcome !== 'file-sources-clear')) return { outcome: 'unavailable', reason: 'restriction-unobservable' };
      const capabilities = await runtime.nativeCapabilities(input.definition, input);
      checkTime(input);
      if (!capabilities.lifecycle) return { outcome: "unavailable", reason: "termination-unresolved" };
      if (!capabilities.credentialChannel) return { outcome: "unsupported", reason: "authentication-channel-unsupported" };
      if (!capabilities.peerIdentity || !runtime.nativeServerEvidenceAvailable(input.material)) return { outcome: "unavailable", reason: "server-evidence-unavailable" };
      if (input.material.instructions.some((value) => value.evidence !== "marker")) return { outcome: "unavailable", reason: "instruction-attestation-unobservable" };
      const resolved = { server: input.material.server, instructions: input.material.instructions };
      const collector = module.createClaudeCollector({ expected: input.identity.expected });
      let channel;
      let context;
      let lifecycle;
      let channelResult;
      let channelClose;
      let termination;
      let cleanupStartedAt;
      let timer;
      let abort;
      let outputBytes = 0;
      const countedBytes = (source, baseline) => {
        const failure = lifecycle?.failure;
        return failure?.limitSource === source && Number.isSafeInteger(failure.observedBytes) && failure.observedBytes >= 0 ? Math.max(baseline, failure.observedBytes) : baseline;
      };
      let stopped;
      let watchdog;
      let tracking;
      let admissionPublished = false;
      let diagnosticsPublished = false;
      let telemetryFinal;
      let diagnosticsSnapshot = () => ({ collector: collector.snapshot({ launchedAtMs: Date.now(), closedAtMs: Date.now() }).stats });
      const publishDiagnostics = () => {
        if (diagnosticsPublished) return;
        diagnosticsPublished = true;
        // Diagnostics are evidence-free; a failure here must never affect cleanup or admission publication.
        try {
          publishNativeDiagnostics({ phase: 'session', index: input.index, definition: input.definition.id,
            runSha256: sha256(input.cell.path), ...diagnosticsSnapshot() });
        } catch { /* diagnostics are best-effort */ }
      };
      let restrictionCounts;
      let snapshot = () => ({ ...incomplete(stopped ?? "native-internal"), completed: [] });
      const detach = () => {
        if (timer) clearTimeout(timer);
        if (watchdog) clearInterval(watchdog);
        if (abort) input.signal?.removeEventListener("abort", abort);
      };
      const closeChannel = () => channelClose ??= channel ? channel.close().then((result) => channelResult = result) : Promise.resolve(undefined);
      const cleanup = async (deadline, graceMs) => {
        detach();
        const owner = lifecycle ?? context;
        if (!owner) {
          await collector.cancel();
          await closeChannel();
          publishDiagnostics();
          return { confirmed: true, survivors: [] };
        }
        // The started handle and its context share one aggregate cleanup; with no client only the context exists.
        termination ??= terminateBounded(owner, deadline, graceMs);
        const receipt = await termination;
        await collector.cancel();
        await closeChannel();
        publishDiagnostics();
        if (linux && !admissionPublished) {
          admissionPublished = true;
          publishNativeAdmission({ phase: 'session', index: input.index, definition: input.definition.id,
            runSha256: sha256(input.cell.path), vendorTreeSha256: linuxClient.vendor.treeSha256,
            innerArgv: [input.pin.executable, ...input.definition.sessionArgv], outerArgv: lifecycle?.argv,
            isolation: context.isolationRecord(), restrictions: restrictionCounts, cleanupConfirmed: receipt.confirmed,
            authenticationProofKind: telemetryFinal?.outcome === 'passed' ? telemetryFinal.stats?.authenticationProofKind : null });
        }
        return receipt;
      };
      // Pre-client failure: stop whatever was created (context, channel, collector) and always report the
      // explicit cleanup outcome when a context existed, so Core can carry unconfirmed survivors.
      const failed = async (reason) => {
        cleanupStartedAt ??= performance.now();
        let receipt;
        try {
          receipt = await cleanup(cleanupStartedAt + 10_000, 1000);
        } catch {
          receipt = { confirmed: false, survivors: [], reason: "termination-unresolved" };
        }
        return { outcome: "unavailable", reason: receipt.confirmed ? reason : "termination-unresolved", ...context ? { cleanup: receipt } : {}, cleanupStartedAt };
      };
      const incomplete = (reason) => ({
        sessionId: null,
        resumed: false,
        loading: "unobservable",
        restrictions: "unobservable",
        authentication: "missing",
        discovery: { complete: false, clientTools: [], serverList: false },
        instructions: { nativeSha256: [], attestations: [], rejected: false, alternateRead: false },
        query: { correlated: false, challengeMatched: false, resultSha256: null, answerSha256: null },
        isolation: "unobservable",
        serverPeerBound: false,
        failure: { reason, outcome: "unavailable" },
        counts: { observedBytes: countedBytes("output", outputBytes) + countedBytes("pipe", 0), telemetryEvents: 0, rpcMessages: 0 }
      });
      const ownedHandle = (observations) => ({
        pid: lifecycle.pid,
        argv: linux ? lifecycle.argv : [input.pin.executable, ...input.definition.sessionArgv],
        challenge: channel.challenge,
        get cleanupStartedAt() {
          return cleanupStartedAt;
        },
        observations,
        snapshot: () => snapshot(),
        cleanup: (value) => cleanup(value.deadline, value.graceMs)
      });
      try {
        // A fresh context exists before any evidence channel or client; every
        // failure below reaches cleanup(), which terminates it even when no client ever started.
        const selection = launchPlan(input);
        const telemetry = await collector.start();
        checkTime(input);
        const contextInput = {
          lifecycleId: input.definition.lifecycleId,
          os: input.definition.platform.os,
          directory: input.cell.observations,
          deadline: input.deadline,
          signal: input.signal,
          runtimePins: selection.runtimePins,
          selectedEntries: selection.entries
        };
        const prepared = observeFacility(await (linux ? module.prepareLinuxSandboxContext({ ...contextInput,
          cell: input.cell, runtime: linuxClient.runtime, vendor: linuxClient.vendor, collector: telemetry,
          execution: input.definition.platform.execution, expectedArgv: input.definition.sessionArgv,
          selectedPaths: [...new Set([...input.material.outputTree, ...input.definition.guardrails].map(file => join(input.cell[file.root], ...file.path.split('/'))))]
        }) : module.prepareLifecycleContext(contextInput)));
        if (prepared?.status !== "ready" || !prepared.context) return await failed(facilityReason(prepared?.reason, "termination-unresolved"));
        context = prepared.context;
        checkTime(input);
        const plan = input.material.server.evidenceAdapterId === module.recorderId ? module.recorderPlan(resolved) : null;
        let transport;
        let handedOver = false;
        try {
          const created = await context.createPipe();
          if (created?.status !== "ready" || !created.transport) throw new Error("pipe-unavailable");
          transport = created.transport;
          handedOver = true;
          channel = await module.startEvidenceChannel({ directory: input.cell.observations,
            isOwnedServer: async identity => await ownedPeer(identity, selection, input) && (!linux || context.acceptServer(identity)), plan, transport });
        } catch (error) {
          // The channel closes a transport it was given; a pipe it never handed over is closed here.
          if (transport && !handedOver) await Promise.resolve(transport.close?.()).catch(() => {
          });
          // Cancellation and budget stops keep their own reason; only a real channel failure is evidence-unavailable.
          throw error instanceof NativeStop ? error : new NativeStop("server-evidence-unavailable");
        }
        checkTime(input);
        const challenge = channel.challenge;
        const options = module.claudeStreamOptions(resolved, challenge);
        const parsers = input.material.instructions.map((value) => module.createClaudeStreamParser({ ...options, markerSha256: value.markerSha256 }));
        const launchedAtMs = Date.now();
        diagnosticsSnapshot = () => ({ collector: telemetryFinal?.stats ?? collector.snapshot({ launchedAtMs, closedAtMs: Date.now() }).stats,
          result: parsers[0].snapshot(), proxy: linux ? context.proxyDiagnostics?.() ?? null : null,
          forwarder: linux ? context.forwarderDiagnostics?.() ?? null : null });
        const capture = (streams, telemetryResult, evidence, finalized = false) => {
            const stream = streams[0];
            const spec = { ...module.serverEvidenceSpec(resolved), queryTool: input.material.server.queryTool };
            const server = module.evaluateServerEvidence(evidence?.frames ?? [], spec);
            restrictionCounts = { listedBuiltins: stream.builtinTools.length, listedUnselected: stream.unselectedTools,
              permittedUnselected: stream.unselectedToolUses.filter(use => use.permitted).length,
              unrequestedCalls: server.unrequestedCalls, rejectedQueryCalls: server.rejectedQueryCalls };
            const managed = managedPolicy(input.definition);
            const evaluation = module.evaluateClaudeSession({
              sessionIndex: input.index,
              previousSessionId: null,
              stream,
              managed,
              telemetry: telemetryResult,
              server: { channel: evidence ?? null, evaluation: server },
              toolNames: input.material.server.toolNames,
              deniedBuiltins: module.claudeDeniedBuiltins
            });
            const row = (id) => evaluation.rows.find((value) => value.id === id);
            const failure = ["cancelled", "budget-exhausted"].includes(stopped) ? stopped : lifecycle?.failure?.reason === "limit-exceeded" ? "limit-exceeded" : stopped ?? (linux ? context.failureReason : undefined) ?? (streams.some(value => value.status === "limit-exceeded") || stream.status === "limit-exceeded" || evidence?.violation === "limit-exceeded" || telemetryResult.reason === "limit-exceeded" ? "limit-exceeded" : stream.status === "malformed" ? "session-identity-unobservable" : undefined);
            const observation = {
              sessionId: stream.sessionIdConsistent ? stream.sessionId : null,
              resumed: false,
              loading: row("loading-mode")?.outcome === "passed" ? "observed" : row("loading-mode")?.reason === "configuration-not-loaded" ? "not-loaded" : "unobservable",
              restrictions: managed.outcome === "restricted" ? "managed" : row("tool-restrictions")?.outcome === "passed" && server.unrequestedCalls === 0 ? "observed" : "unobservable",
              authentication: telemetryResult.outcome === "passed" ? "matched" : telemetryResult.reason === "identity-conflict" ? "conflict" : telemetryResult.reason === "identity-session-mismatch" ? "wrong-session" : telemetryResult.reason === "limit-exceeded" ? "limited" : "missing",
              discovery: { complete: server.initialize && server.discovery === "complete" && stream.toolsListed, clientTools: stream.visibleSelectedTools, serverList: server.initialize && server.discovery === "complete" },
              instructions: {
                nativeSha256: [],
                attestations: (evidence?.frames ?? []).filter((value) => value.method === "tools/call" && value.tool === spec.attestTool).map((value) => {
                  const frame = value;
                  const selected = input.material.instructions.findIndex((instruction) => instruction.markerSha256 === frame.markerSha256);
                  return {
                    markerSha256: typeof frame.markerSha256 === "string" ? frame.markerSha256 : "0".repeat(64),
                    challengeMatched: frame.challengeMatched === true && frame.resultSha256 !== null,
                    clientReceipt: selected >= 0 && streams[selected].attestationReturned
                  };
                }),
                rejected: false,
                alternateRead: input.material.instructions.some((value) => module.evaluateServerEvidence(evidence?.frames ?? [], { ...spec, markerSha256: value.markerSha256 }).ambiguousBeforeAttestation) || streams.some((value) => value.unselectedToolUses.some((use) => use.permitted && use.beforeAttestation))
              },
              query: {
                correlated: server.query !== "missing" && server.query !== "refused",
                challengeMatched: server.query === "answered" || server.query === "result-mismatch",
                resultSha256: server.queryResultSha256,
                answerSha256: stream.answerSha256,
                rejectedCalls: server.rejectedQueryCalls > 0
              },
              isolation: linux ? context.isolation() : "unobservable",
              serverPeerBound: evidence?.peer === "authenticated" && !evidence.violation,
              ...failure ? { failure: { reason: failure, outcome: "unavailable" } } : {},
              counts: { observedBytes: countedBytes("output", outputBytes) + telemetryResult.bytes + countedBytes("pipe", evidence?.bytes ?? 0), telemetryEvents: telemetryResult.counts.events, rpcMessages: evidence?.frames.length ?? 0 }
            };
            if (!finalized) observation.completed = [
              ...(stream.sessionId !== null ? ['session-freshness'] : []),
              ...(stream.serverStatus !== null ? ['loading-mode'] : []),
              ...(stream.toolsListed || managed.outcome === 'restricted' ? ['tool-restrictions'] : []),
              ...(['identity-conflict','limit-exceeded'].includes(telemetryResult.reason) ? ['provider-authentication'] : []),
              ...(server.discovery === 'complete' && stream.toolsListed ? ['tool-discovery'] : []),
              ...(observation.instructions.attestations.length || observation.instructions.alternateRead ? ['instruction-loading'] : []),
              ...(server.query !== 'missing' && (server.query !== 'answered' || stream.answerSha256 !== null) ? ['read-only-query'] : []),
              ...(observation.isolation === 'violated' || observation.isolation === 'observed' ? ['isolation'] : [])
            ];
            return observation;
        };
        snapshot = () => {
          const streams = parsers.map(parser => parser.snapshot());
          collector.bindSession(streams[0].sessionIdConsistent ? streams[0].sessionId : null);
          return capture(streams, collector.snapshot({ launchedAtMs, closedAtMs: Date.now() }), channelResult ?? channel.snapshot());
        };
        const env = module.buildClaudeEnvironment({
          platform: input.definition.platform.os,
          hostEnv: input.environment,
          homeDir: input.cell.home,
          scratchDir: input.cell.scratch,
          runtimeDirs: linux ? [dirname(linuxClient.runtime.node), dirname(linuxClient.runtime.client)] : [dirname(input.pin.executable), ...input.pin.runtime.map((value) => dirname(value.path))],
          telemetry,
          evidence: { endpoint: channel.endpoint, token: channel.token },
          configDir: posix.dirname(input.definition.credentialDestination.path)
        });
        const protectedValues = linux ? (() => {
          const oauth = module.parseStrictJson(input.identity.credential.toString('utf8')).claudeAiOauth;
          return [oauth.accessToken, oauth.refreshToken, input.identity.expected.accountUuid, input.identity.expected.organizationId];
        })() : [];
        const launched = await context.start({
          file: input.pin.executable,
          argv: input.definition.sessionArgv,
          cwd: input.cell.project,
          env, ...(linux ? { protectedValues } : {})
        });
        if (launched?.status !== "started" || !launched.handle) {
          const reason = facilityReason(launched?.reason, "session-launch-failed");
          // A partial spawn is still owned: hand it back so Core can account for it.
          if (launched?.partial) {
            lifecycle = launched.partial;
            cleanupStartedAt ??= performance.now();
            return { outcome: "unavailable", reason, partial: ownedHandle(Promise.resolve({ ...snapshot(), failure: { reason, outcome: "unavailable" } })) };
          }
          return await failed(reason);
        }
        lifecycle = launched.handle;
        let overflow = false;
        let notifyStopped;
        const stoppedPromise = new Promise((resolve) => {
          notifyStopped = resolve;
        });
        lifecycle.stdout.on("data", (chunk) => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > 2 * 1024 * 1024) {
            overflow = true;
            void stop("limit-exceeded");
          } else for (const parser of parsers) parser.push(chunk);
        });
        lifecycle.stderr.on("data", (chunk) => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > 2 * 1024 * 1024) {
            overflow = true;
            void stop("limit-exceeded");
          }
        });
        const stop = async (reason) => {
          stopped ??= reason;
          cleanupStartedAt ??= performance.now();
          try {
            await cleanup(cleanupStartedAt + 10_000, 1000);
          } catch {
          } finally {
            notifyStopped();
          }
        };
        abort = () => {
          void stop("cancelled");
        };
        input.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          void stop("budget-exhausted");
        }, Math.max(1, input.deadline - performance.now()));
        if (input.signal?.aborted) abort();
        watchdog = setInterval(() => {
          if (!tracking && typeof lifecycle.track === 'function') {
            tracking = Promise.resolve().then(() => lifecycle.track())
              .catch(() => stop('isolation-unobserved')).finally(() => { tracking = undefined; });
          }
          const observed = snapshot();
          if (observed.restrictions === 'managed') void stop('managed-restriction');
          else if (observed.sessionId && observed.authentication === 'conflict') void stop('identity-conflict');
          else if (observed.failure) void stop(observed.failure.reason);
        }, 20);
        lifecycle.stdin.end(input.prompt.replaceAll(input.challenge, challenge));
        const observations = (async () => {
          try {
            const exit = await Promise.race([lifecycle.exited, stoppedPromise]);
            if (exit?.reason === "limit-exceeded" && !["cancelled", "budget-exhausted"].includes(stopped)) {
              await stop("limit-exceeded");
              stopped = "limit-exceeded";
            }
            if (stopped) return { ...snapshot(), failure: { reason: stopped, outcome: "unavailable" } };
            const streams = parsers.map((parser) => parser.finish());
            const stream = streams[0];
            collector.bindSession(stream.sessionId);
            const telemetryResult = await collector.drain({ launchedAtMs, closedAtMs: Date.now(), timeoutMs: Math.min(2000, Math.max(0, input.deadline - performance.now())) });
            telemetryFinal = telemetryResult;
            const evidence = await closeChannel();
            if (linux) {
              // Core consumes observations before invoking handle cleanup. Final coverage must
              // therefore reach this observation through the same memoized cleanup receipt.
              cleanupStartedAt ??= performance.now();
              await cleanup(Math.min(input.deadline, cleanupStartedAt + 10_000), 1000);
            }
            return capture(streams, telemetryResult, evidence, true);
          } finally {
            detach();
          }
        })();
        return ownedHandle(observations);
      } catch (error) {
        const reason = error instanceof NativeStop ? error.reason : "native-internal";
        if (lifecycle) {
          cleanupStartedAt ??= performance.now();
          return { outcome: "unavailable", reason, partial: ownedHandle(Promise.resolve({ ...snapshot(), failure: { reason, outcome: "unavailable" } })) };
        }
        return await failed(reason);
      }
    },
    // Only the fixed ordinary state of a supported Claude definition; never configuration or instruction surfaces.
    nativeStatePaths(definition) {
      const supported = definition?.client === "claude" && adapters.has(definition.parserId);
      const copy = (entries) => supported ? entries.map((entry) => ({ path: entry.path, exclusions: [...entry.exclusions], inspected: entry.inspected, ...(entry.kind ? { kind: entry.kind } : {}) })) : [];
      return { home: copy(claudeStatePaths.home), project: copy(claudeStatePaths.project) };
    },
    // Separate precedence check for the one inspected state file.
    inspectNativeState(definition, input) {
      return definition?.client === "claude" && adapters.has(definition.parserId) && input?.root === "home" && input.path === claudeGlobalStatePath &&
        inspectClaudeGlobalState(input.bytes, { diagnose: input.diagnose, classifyKey: persistenceClassifier.key });
    },
    classifyNativePersistence(definition, fact) {
      return definition?.client === 'claude' && adapters.has(definition.parserId)
        ? persistenceClassifier.entry(fact) : persistenceClassifier.key('unknown', null);
    },
    publishNativePersistence({ cell, stage, diagnostics }) {
      publishNativePersistenceDiagnostics({ ...diagnostics, stage, runSha256: sha256(cell.path) });
    }
  };
  return runtime;
}
export {
  createNativeRuntime
};
