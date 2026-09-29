import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { contractSupport, helperMetadata, targets } from '@aihq/harness/contracts';
import { diagnose } from '@aihq/harness/runtime';
import type { Diagnostic } from './types.js';
import type { Effective } from './host-types.js';

export interface InspectRequest {
  targets?: string[];
  network?: 'declared' | 'off';
  probeConfiguredMcp?: boolean;
  project?: string;
}
export interface InspectControls { signal?: AbortSignal; budgetMs?: number }
export interface InspectResult {
  status: 'complete' | 'incomplete' | 'invalid' | 'cancelled';
  package: { name: string; version: string };
  tools: { id: string; label: string; state: string; selection: string; config?: string }[];
  observations: { id: string; target: string; detail: string }[];
  checks: { id: string; target: string; outcome: 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string; detail: string }[];
  repairChoices: unknown[];
  diagnostics: Diagnostic[];
  effectiveOptions: {
    targets: Effective<string[] | 'detected'>;
    network: Effective<'declared' | 'off'>;
    probeConfiguredMcp: Effective<boolean>;
    budgetMs: Effective<number>;
  };
  limits: { budgetMs: number; elapsedMs: number; maxActiveProbes: number };
  followUp: string[];
}

const internalFailure: Diagnostic = {
  code: 'INTERNAL_ERROR', reason: 'inspection-helper', message: 'Inspection could not safely complete. Reinspect after checking the installed Harness package.'
};

function plain(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && keys.includes(key) && descriptor?.enumerable && 'value' in descriptor;
  });
}
function validTargets(value: unknown): value is string[] {
  if (!Array.isArray(value) || isProxy(value) || value.length < 1 || value.length > targets.length) return false;
  if (Reflect.ownKeys(value).some(key => key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return false;
  const ids: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' ||
        !targets.some(target => target.id === descriptor.value)) return false;
    ids.push(descriptor.value);
  }
  return new Set(ids).size === ids.length;
}

function installedPackage(): { name: string; version: string } {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(readFileSync(require.resolve('@aihq/harness/package.json'), 'utf8')) as Record<string, unknown>;
  if (manifest.name !== '@aihq/harness' || typeof manifest.version !== 'string' ||
      contractSupport.package.name !== manifest.name || contractSupport.package.version !== manifest.version)
    throw new Error('harness-package-identity');
  return { name: manifest.name, version: manifest.version };
}

export async function inspect(request: InspectRequest = {}, controls: InspectControls = {}): Promise<InspectResult> {
  let identity: { name: string; version: string };
  try { identity = installedPackage(); }
  catch {
    return { status: 'incomplete', package: { name: '@aihq/harness', version: 'unavailable' },
      tools: [], observations: [], checks: [], repairChoices: [],
      diagnostics: [{ code: 'PREREQUISITE_UNAVAILABLE', reason: 'harness-package-identity',
        message: 'The installed Harness package identity could not be verified.' }],
      effectiveOptions: { targets: { value: 'detected', origin: 'default' }, network: { value: 'declared', origin: 'default' },
        probeConfiguredMcp: { value: false, origin: 'default' }, budgetMs: { value: 180000, origin: 'default' } },
      limits: { budgetMs: 180000, elapsedMs: 0, maxActiveProbes: 2 }, followUp: [] };
  }
  const profile = helperMetadata.diagnostics.find(entry => entry.id === 'existing-tools')?.profile;
  if (!profile || profile.phaseMs > 180000 || profile.maxActiveProbes > 2 ||
      profile.localProcessMs > 30000 || profile.networkProcessMs > 25000 ||
      profile.networkSocketMs > 20000 || profile.outputBytes > 65536 ||
      profile.checkDetailBytes > 4096 || profile.phaseDetailBytes > 65536 ||
      profile.configuredMcpOrigins > 3 || profile.configuredMcpMs > 60000)
    return { status: 'incomplete', package: identity, tools: [], observations: [], checks: [], repairChoices: [],
      diagnostics: [{ code: 'PREREQUISITE_UNAVAILABLE', reason: 'harness-diagnostic-profile',
        message: 'The installed diagnostic profile could not be accepted.' }],
      effectiveOptions: { targets: { value: 'detected', origin: 'default' }, network: { value: 'declared', origin: 'default' },
        probeConfiguredMcp: { value: false, origin: 'default' }, budgetMs: { value: 180000, origin: 'default' } },
      limits: { budgetMs: 180000, elapsedMs: 0, maxActiveProbes: 2 }, followUp: [] };
  if (!plain(request, ['targets', 'network', 'probeConfiguredMcp', 'project']) ||
      !plain(controls, ['signal', 'budgetMs'])) return {
    status: 'invalid', package: identity, tools: [], observations: [], checks: [], repairChoices: [],
    diagnostics: [{ code: 'INPUT_INVALID', reason: 'request-field', message: 'Use published inspection options.' }],
    effectiveOptions: { targets: { value: 'detected', origin: 'default' }, network: { value: 'declared', origin: 'default' },
      probeConfiguredMcp: { value: false, origin: 'default' }, budgetMs: { value: profile.phaseMs, origin: 'default' } },
    limits: { budgetMs: profile.phaseMs, elapsedMs: 0, maxActiveProbes: profile.maxActiveProbes }, followUp: []
  };
  const options: InspectResult['effectiveOptions'] = {
    targets: { value: request.targets ?? 'detected', origin: request.targets === undefined ? 'default' : 'explicit' },
    network: { value: request.network ?? 'declared', origin: request.network === undefined ? 'default' : 'explicit' },
    probeConfiguredMcp: { value: request.probeConfiguredMcp ?? false, origin: request.probeConfiguredMcp === undefined ? 'default' : 'explicit' },
    budgetMs: { value: controls.budgetMs ?? profile.phaseMs, origin: controls.budgetMs === undefined ? 'default' : 'explicit' }
  };
  const base: InspectResult = { status: 'invalid', package: identity, tools: [], observations: [], checks: [],
    repairChoices: [], diagnostics: [], effectiveOptions: options,
    limits: { budgetMs: options.budgetMs.value, elapsedMs: 0, maxActiveProbes: profile.maxActiveProbes }, followUp: [] };
  const fail = (reason: string): InspectResult => ({
    ...base, diagnostics: [{ code: 'INPUT_INVALID', reason, message: 'Use published targets and bounded inspection options.' }]
  });
  if (request.targets !== undefined && !validTargets(request.targets))
    return fail('target');
  if (request.network !== undefined && (typeof request.network !== 'string' || !['declared', 'off'].includes(request.network))) return fail('network');
  if (request.probeConfiguredMcp !== undefined && typeof request.probeConfiguredMcp !== 'boolean') return fail('probe-configured-mcp');
  if (request.project !== undefined && (typeof request.project !== 'string' || !request.project || request.project.length > 4096)) return fail('project');
  if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) return fail('signal');
  if (controls.budgetMs !== undefined && (typeof controls.budgetMs !== 'number' ||
      !Number.isInteger(controls.budgetMs) || controls.budgetMs < 1 || controls.budgetMs > profile.phaseMs))
    return fail('budget-ms');
  let result: Awaited<ReturnType<typeof diagnose>>;
  try {
    result = await diagnose({ requestId: randomUUID(), targets: request.targets, network: options.network.value,
      probeConfiguredMcp: options.probeConfiguredMcp.value, project: request.project },
      { signal: controls.signal, budgetMs: options.budgetMs.value });
    if (!result || result.helper?.name !== identity.name || result.helper?.version !== identity.version ||
        !['completed', 'cancelled', 'invalid', 'unavailable'].includes(result.status) ||
        !Array.isArray(result.tools) || !Array.isArray(result.observations) ||
        !Array.isArray(result.checks) || !Array.isArray(result.diagnostics) || !Array.isArray(result.repairChoices) ||
        result.checks.some(check => !['passed', 'failed', 'unavailable', 'skipped'].includes(check.outcome) ||
          typeof check.reason !== 'string' || typeof check.detail !== 'string' || Buffer.byteLength(check.detail) > 4096) ||
        !result.limits || result.limits.budgetMs > options.budgetMs.value ||
        result.limits.maxActiveProbes > profile.maxActiveProbes)
      throw new Error('helper-result-invalid');
  } catch { return { ...base, status: controls.signal?.aborted ? 'cancelled' : 'incomplete',
    diagnostics: [controls.signal?.aborted ? { code: 'CANCELLED', reason: 'cancelled', message: 'Inspection was cancelled.' } : internalFailure] }; }
  const incomplete = result.status !== 'completed' ||
    result.checks.some(check => check.outcome === 'failed' || check.outcome === 'unavailable');
  const followUp = result.checks.flatMap(check =>
    check.outcome === 'failed' ? [`Inspect ${check.target}: ${check.reason}. Select an applicable published repair for a separate reviewed request.`] :
    check.outcome === 'unavailable' ? [`Check ${check.target} could not complete: ${check.reason}. Reinspect after resolving the prerequisite.`] : []);
  return { ...base, status: result.status === 'cancelled' ? 'cancelled' : incomplete ? 'incomplete' : 'complete',
    tools: result.tools, observations: result.observations, checks: result.checks, repairChoices: result.repairChoices,
    diagnostics: result.status === 'invalid' || result.status === 'unavailable' ?
      [...result.diagnostics, { code: 'EXECUTION_FAILED', reason: 'helper-' + result.status,
        message: 'The installed diagnostic helper did not complete.' }] : result.diagnostics,
    limits: result.limits, followUp };
}
