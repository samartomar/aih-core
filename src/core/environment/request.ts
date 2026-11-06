// Admission and lowering for the 0.1.0 environment requests (contract 4, 10): a repair, a certificate export or a
// repair together with its macOS session. Each is lowered into the retained repair, trust or session preparation,
// which keeps its own source, host, target and custody checks; this module adds nothing those checks would miss.
import { cloneJsonValueStructureV1 } from '../internal/strict-json.js';
import { canonicalJson } from '../internal/canonical.js';
import { schemaProblems } from '../plan/formats.js';
import { sha256 } from '../internal/host-files.js';
import type { RepairRequest } from '../repair.js';
import type { TrustRepairRequest, CertificateExportRequest, TrustSources } from '../trust-contracts.js';
import type { MacosRepairRequest, MacosSessionSelection } from '../macos-session-contracts.js';
import type { Invalid, UnsupportedVersion } from '../plan/types.js';

export const REPAIR_REQUEST = 'urn:aihq:core:repair-request:0.1.0' as const;
export const EXPORT_REQUEST = 'urn:aihq:core:export-request:0.1.0' as const;
export const MACOS_SESSION_REQUEST = 'urn:aihq:core:macos-session-request:0.1.0' as const;
export type EnvironmentJob = 'repair' | 'export' | 'macos-session';
const REQUEST_BYTES = 16 * 1_048_576;

type Inputs = Record<string, string | boolean | number>;
/** A reviewed conflict choice: the review's management id and step, and the bytes the person saw (section 7). */
export interface EnvironmentResolution { managementId: string; step: number; choice: 'replace'; observedSha256: string | null }
export interface RepairRequest010 {
  schema: typeof REPAIR_REQUEST; repair: 'node-npm-ca' | 'node-os-trust' | 'user-tools-ca' | 'jvm-ca'; targets: string[];
  route?: 'file' | 'native'; sources?: TrustSources; inputs?: Inputs; network?: 'declared' | 'off'; resolutions?: EnvironmentResolution[];
}
export interface ExportRequest010 {
  schema: typeof EXPORT_REQUEST; format?: 'pem' | 'pkcs7-der'; output?: string; sources?: TrustSources;
  network?: 'declared' | 'off'; resolutions?: EnvironmentResolution[];
}
export interface MacosSessionRequest010 {
  schema: typeof MACOS_SESSION_REQUEST; repair: 'node-npm-ca' | 'user-tools-ca' | 'jvm-ca'; targets: string[];
  route?: 'file' | 'native'; sources?: TrustSources; inputs?: Inputs; network?: 'declared' | 'off'; resolutions?: EnvironmentResolution[];
  session: MacosSessionSelection;
}
export type EnvironmentRequest = RepairRequest010 | ExportRequest010 | MacosSessionRequest010;
/** The retained request each 0.1.0 request is carried out as, without its resolutions. */
export type Lowered =
  { kind: 'trust'; request: TrustRepairRequest | CertificateExportRequest } |
  { kind: 'repair'; request: RepairRequest } |
  { kind: 'session'; request: MacosRepairRequest };

const families: Record<string, { job: EnvironmentJob; id: string }> = {
  'urn:aihq:core:repair-request:': { job: 'repair', id: REPAIR_REQUEST },
  'urn:aihq:core:export-request:': { job: 'export', id: EXPORT_REQUEST },
  'urn:aihq:core:macos-session-request:': { job: 'macos-session', id: MACOS_SESSION_REQUEST },
};
const schemaOf = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value) ?
  Object.getOwnPropertyDescriptor(value, 'schema')?.value : undefined;

/**
 * Which 0.1.0 environment request this is. The export and macOS session families are new names, so any version of
 * them belongs here; the repair family's older versions keep their retained path until it is removed.
 */
export function environmentJob(value: unknown): EnvironmentJob | undefined {
  const schema = schemaOf(value);
  if (typeof schema !== 'string') return undefined;
  if (schema === REPAIR_REQUEST) return 'repair';
  if (schema.startsWith('urn:aihq:core:export-request:')) return 'export';
  if (schema.startsWith('urn:aihq:core:macos-session-request:')) return 'macos-session';
  return undefined;
}

export interface Checked { job: EnvironmentJob; request: EnvironmentRequest; digest: string }
/** Strict JSON, the request limit and the published schema, in that order. */
export function checkEnvironmentRequest(value: unknown): Checked | Invalid | UnsupportedVersion {
  let request: EnvironmentRequest;
  try { request = cloneJsonValueStructureV1(value, 'environment request', 32, REQUEST_BYTES) as EnvironmentRequest; }
  catch { return { status: 'invalid', problems: [{ path: '', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }] }; }
  const schema = String(request.schema);
  const family = Object.entries(families).find(([prefix]) => schema.startsWith(prefix))![1];
  if (schema !== family.id) return { status: 'unsupported-version', encountered: schema, supported: [family.id] };
  const problems = schemaProblems(family.id, request);
  if (problems) return { status: 'invalid', problems };
  return { job: family.job, request, digest: digestOf(request) };
}
export const digestOf = (request: unknown): string => sha256(canonicalJson(request));
/** The caller's request digest now, or `undefined` when it no longer reads as strict JSON. */
export function currentDigest(value: unknown): string | undefined {
  try { return digestOf(cloneJsonValueStructureV1(value, 'environment request', 32, REQUEST_BYTES)); } catch { return undefined; }
}

/** The retained request this 0.1.0 request is carried out as. Defaults: the file route, with the OS trust as source. */
export function lower(checked: Checked): Lowered {
  const network = checked.request.network === undefined ? {} : { network: checked.request.network };
  if (checked.job === 'export') {
    const request = checked.request as ExportRequest010;
    return { kind: 'trust', request: { schema: 'urn:aihq:core:certificate-export-request:1.0.0', useCase: 'certificate-export',
      ...(request.format === undefined ? {} : { format: request.format }), ...(request.output === undefined ? {} : { output: request.output }),
      ...(request.sources === undefined ? {} : { sources: request.sources }), ...network } };
  }
  const request = checked.request as RepairRequest010 | MacosSessionRequest010;
  if (request.repair === 'node-os-trust')
    return { kind: 'repair', request: { useCase: 'repair', repairs: [{ id: request.repair, targets: [...request.targets], inputs: { ...request.inputs ?? {} } }],
      ...network } };
  const route = request.route ?? 'file';
  const trust = { useCase: 'repair' as const, route, repairs: [{ id: request.repair, targets: [...request.targets], inputs: { ...request.inputs ?? {} } }],
    ...(route === 'file' ? { sources: request.sources ?? { os: true, supplied: [] } } : {}), ...network } as Omit<TrustRepairRequest, 'schema'>;
  if (checked.job === 'macos-session')
    return { kind: 'session', request: { ...trust, schema: 'urn:aihq:core:repair-request:1.1.0',
      macosSession: (request as MacosSessionRequest010).session } as MacosRepairRequest };
  return { kind: 'trust', request: { ...trust, schema: 'urn:aihq:core:repair-request:1.0.0' } as TrustRepairRequest };
}
