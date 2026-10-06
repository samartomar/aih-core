// One fresh trusted SRT instance per launch, owned by the fixed native subreaper.
// SRT is initialized with the fixed base and exact collector only; the IPC socket slots it reports are
// derived afterwards. There is no ask callback, updateConfig, TLS termination or permissive fallback.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, parseStrictJson } from './canonical.mjs';
import { createLinuxBaseProfile, deriveLinuxSessionProfile, fixedLinuxCommand,
  initializeLinuxProfile, verifyLinuxSessionProfile } from './linux-profile.mjs';
import { verifyLinuxVendorClosure } from './linux-runtime.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const present = path => { try { lstatSync(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } };
// Vendor convenience write roots are not part of the fixed profile; any object there, even a dangling link, is refused.
const vendorTmpPresent = () => present('/tmp/claude') || present('/private/tmp/claude');
const ownedSocket = path => { const stat = lstatSync(path); return stat.isSocket() && stat.uid === process.getuid(); };
let manager, child, stopping = false, code = 125;
const stop = () => {
  if (stopping) return; stopping = true;
  try { child?.kill('SIGTERM'); } catch { /* the native subreaper owns final termination */ }
};
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0 || process.argv.length !== 3) throw Error();
  const bytes = readFileSync(process.argv[2]);
  if (bytes.length > 65536 || sha(bytes) !== process.env.AIHQ_NATIVE_SANDBOX_PLAN_SHA256) throw Error();
  const plan = parseStrictJson(bytes.toString('utf8'));
  if (plan?.version !== 1 || plan.profileInput?.plan !== process.argv[2]) throw Error();
  const workloadEnv = { ...process.env };
  // Proxy helpers are trusted outer processes but receive no evidence, telemetry or identity fields.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: [...new Set([plan.runtime.bash, plan.runtime.env, plan.runtime.socat, plan.runtime.rg, plan.which].map(dirname))].join(':'),
    HOME: plan.bridge, TMPDIR: plan.bridge, CLAUDE_CODE_TMPDIR: `${plan.cell.scratch}/tmp`, LANG: 'C', LC_ALL: 'C',
    ...(plan.ldLibraryPath ? { LD_LIBRARY_PATH: plan.ldLibraryPath } : {}) });
  process.chdir(plan.cell.project);
  const closure = verifyLinuxVendorClosure();
  // Resolve only the independently verified SDK entry. Bundled vendor support files must be present
  // so resolution never falls back to a global package installation.
  if (closure.status !== 'ready' || closure.entry !== plan.vendorEntry || closure.treeSha256 !== plan.vendorTreeSha256 ||
      basename(closure.entry) !== 'index.js') throw Error();
  const distribution = dirname(closure.entry), root = dirname(distribution), library = closure.entry;
  const pinned = new Set(closure.pins.map(pin => pin.path));
  if (![library, join(root, 'vendor', 'seccomp', 'x64', 'apply-seccomp'),
    join(root, 'vendor', 'java-proxy-agent', 'srt-proxy-agent.jar')].every(path => pinned.has(path))) throw Error();
  const base = createLinuxBaseProfile(plan.profileInput);
  if (canonicalJson(base) !== readFileSync(plan.baseFile, 'utf8') || vendorTmpPresent()) throw Error();
  manager = (await import(pathToFileURL(library).href)).SandboxManager;
  const initial = initializeLinuxProfile(base, plan.collector);
  await manager.initialize(initial, undefined, false);
  if (stopping || manager.getConfig() !== initial || manager.getMitmCA() !== undefined) throw Error();
  const http = manager.getLinuxHttpSocketPath(), socks = manager.getLinuxSocksSocketPath();
  if (typeof http !== 'string' || typeof socks !== 'string' || dirname(http) !== plan.bridge || dirname(socks) !== plan.bridge ||
      !ownedSocket(http) || !ownedSocket(socks)) throw Error();
  const slots = { collector: plan.collector, evidence: plan.evidence, probe: plan.probe, http, socks };
  const profile = deriveLinuxSessionProfile(base, slots), serialized = canonicalJson(profile);
  if (!verifyLinuxSessionProfile(base, slots, serialized)) throw Error();
  const proxyCapability = manager.getProxyAuthToken();
  if (!/^[a-f0-9]{32}$/.test(proxyCapability ?? '')) throw Error();
  writeFileSync(plan.profileFile, serialized, { flag: 'wx', mode: 0o600 });
  writeFileSync(plan.receiptFile, canonicalJson({ slots, baseSha256: sha(canonicalJson(base)), profileSha256: sha(serialized), proxyCapabilitySha256: sha(proxyCapability) }),
    { flag: 'wx', mode: 0o600 });
  const command = fixedLinuxCommand(plan.runtime.env, plan.runtime.node, [plan.workload, process.argv[2]]);
  const wrapped = await manager.wrapWithSandboxArgv(command, plan.runtime.bash, profile, undefined, plan.cell.project);
  if (!Array.isArray(wrapped?.argv) || wrapped.argv.length !== 3 || wrapped.argv[0] !== plan.runtime.bash ||
      wrapped.argv[1] !== '-c' || typeof wrapped.argv[2] !== 'string') throw Error();
  // Recheck immediately before execution: same initialized object, no MITM CA, no vendor tmp root, same bytes.
  if (stopping || manager.getConfig() !== initial || manager.getMitmCA() !== undefined || vendorTmpPresent() ||
      readFileSync(plan.profileFile, 'utf8') !== serialized) throw Error();
  child = spawn(wrapped.argv[0], wrapped.argv.slice(1), { shell: false, cwd: plan.cell.project, stdio: 'inherit',
    env: { ...workloadEnv, CLAUDE_CODE_TMPDIR: `${plan.cell.scratch}/tmp` } });
  code = await new Promise(resolve => {
    child.once('error', () => resolve(125)); child.once('exit', (value, signal) => resolve(signal ? 125 : value ?? 125));
  });
} catch { code = 125; }
finally {
  if (manager) { try { manager.cleanupAfterCommand(); await manager.reset(); } catch { code = 125; } }
}
process.exit(code);
