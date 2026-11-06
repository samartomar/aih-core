// `@aihq/core` (contract 3): the Node entry. Every request and result is a 0.1.0 format; portable document types,
// validators, schemas, refusal codes and limits belong to `@aihq/core/contracts`.
import { isProxy } from 'node:util/types';
import { preparePlan } from './plan/prepare.js';
import { applyPlan } from './plan/apply.js';
import { applyEnvironment, isEnvironmentHandle, isEnvironmentRequest, isSessionVerificationRequest, prepareEnvironment,
  verifyMacosSessionRequest, type MacosSessionVerificationResult010 } from './environment/index.js';
import { prepareChange, type ChangeControls, type ChangeRequest } from './change/prepare.js';
import { prepareUpdate as preparePlanUpdate } from './plan/update.js';
import { inspectMachine, type Inspect0Request, type InspectionResult } from './inspect.js';
import type { InspectControls } from './inspection.js';
import type { EnvironmentRequest } from './environment/request.js';
import { CHANGE_REQUEST } from './change/validate.js';
import { PLAN_REQUEST, type Approval, type PlanControls, type PlanHandle, type PlanPreparation, type PlanRequest, type Run,
  type UpdateResult, type UpdateSelector } from './plan/types.js';

const ENVIRONMENT_REQUESTS = ['urn:aihq:core:repair-request:0.1.0', 'urn:aihq:core:export-request:0.1.0', 'urn:aihq:core:macos-session-request:0.1.0'];
const schemaOf = (request: unknown): unknown => request && typeof request === 'object' && !isProxy(request) ?
  Object.getOwnPropertyDescriptor(request, 'schema')?.value : undefined;
const startsWith = (schema: unknown, prefix: string): boolean => typeof schema === 'string' && schema.startsWith(prefix);

/** Prepare a plan, change, repair, export or macOS session request (contract 7, 14.1). Any other document is not read. */
export function prepare(request: PlanRequest, controls?: PlanControls): Promise<PlanPreparation>;
export function prepare(request: ChangeRequest, controls?: ChangeControls): Promise<PlanPreparation>;
export function prepare(request: EnvironmentRequest, controls?: Pick<PlanControls, 'signal' | 'logging'>): Promise<PlanPreparation>;
export async function prepare(request: PlanRequest | ChangeRequest | EnvironmentRequest, controls: PlanControls | ChangeControls = {}): Promise<PlanPreparation> {
  const schema = schemaOf(request);
  if (schema === PLAN_REQUEST || startsWith(schema, 'urn:aihq:core:plan-request:')) return preparePlan(request, controls);
  if (schema === CHANGE_REQUEST || startsWith(schema, 'urn:aihq:core:change-request:')) return prepareChange(request, controls);
  if (isEnvironmentRequest(request)) return prepareEnvironment(request, controls);
  if (typeof schema === 'string' && schema.length <= 256)
    return { status: 'unsupported-version', encountered: schema, supported: [PLAN_REQUEST, CHANGE_REQUEST, ...ENVIRONMENT_REQUESTS] };
  return { status: 'invalid', problems: [{ path: '/schema', reason: 'request',
    message: 'A request names its format in `schema`: a plan, change, repair, export or macOS session request.' }] };
}

/** Apply a handle from `prepare`, `prepareRemoval` or `prepareUpdate` with the person's approval (contract 7). */
export async function apply(handle: PlanHandle, approval: Approval, controls: PlanControls | ChangeControls = {}): Promise<Run> {
  if (isEnvironmentHandle(handle)) return applyEnvironment(handle, approval, controls);
  // A value that is not an issued handle reaches the plan path, which answers `handle-unavailable`.
  return applyPlan(handle, approval, controls);
}

export { list, prepareRemoval } from './plan/lifecycle.js';

/** `{ target, scope, updates: [{ managementIds?, request }] }` with a complete plan or change request (contract 12). */
export function prepareUpdate(request: { target: { project?: string | null }; scope: 'project' | 'user'; updates: UpdateSelector[] },
  controls?: PlanControls | ChangeControls): Promise<UpdateResult> {
  return preparePlanUpdate(request, controls);
}

/** `{ target?, offline?, profiles? }` returns `urn:aihq:core:inspection:0.1.0` (contract 10, D110). */
export function inspect(request?: Inspect0Request, controls?: InspectControls): Promise<InspectionResult> {
  return inspectMachine(request, controls);
}

/** A `macos-session-verification-request:0.1.0` returns the 0.1.0 result (contract 10). */
export async function verifyMacosSession(request: { schema: 'urn:aihq:core:macos-session-verification-request:0.1.0'; managementId: string },
  controls: Pick<PlanControls, 'signal' | 'logging'> = {}): Promise<MacosSessionVerificationResult010> {
  if (!isSessionVerificationRequest(request)) {
    const schema = schemaOf(request);
    return { status: typeof schema === 'string' ? 'unsupported-version' : 'invalid', ...(typeof schema === 'string' ?
      { encountered: schema, supported: ['urn:aihq:core:macos-session-verification-request:0.1.0'] } :
      { problems: [{ path: '/schema', reason: 'request', message: 'Name `urn:aihq:core:macos-session-verification-request:0.1.0`.' }] }) } as never;
  }
  return verifyMacosSessionRequest(request, controls as never);
}

export { verifyClient } from './verify-client.js';
export { checkFiles } from './file-check.js';
export { writeSupportReport } from './support-report.js';
export { resolveStateLocation } from './resolve-state-location.js';

// Explicit type exports: each name appears in a request, control or result of an operation exported here.
export type { PlanRequest, PlanControls, PlanPreparation, PlanStep, Plan, PlanFile, PlanResolution, Preparation, Refusal, Invalid,
  UnsupportedVersion, Problem, Review, ReviewStep, ReviewConflict, Approval, Run, RunStep, RunMember, BuildFailureRecord, BuildPhase, StaleChange, PlanHandle,
  Inventory, InventoryEntry, InventoryMember, ListResult, RemovalSelector, RemovalMember, RemovalEntry, RemovalPreparation, RemovalResult,
  EnvironmentReview, EnvironmentRun, EnvironmentProblem, UpdateResult, UpdatePreparation, UpdateEntry, UpdateMember, UpdateSelector } from './plan/types.js';
export type { ChangeRequest, ChangeControls } from './change/prepare.js';
export type { EnvironmentRequest, RepairRequest010 as RepairRequest, ExportRequest010 as ExportRequest,
  MacosSessionRequest010 as MacosSessionRequest, EnvironmentResolution } from './environment/request.js';
export type { MacosSessionVerificationResult010 as MacosSessionVerificationResult } from './environment/index.js';
export type { InspectControls } from './inspection.js';
export type { Inspect0Request as InspectRequest, Inspection, InspectionResult, InspectionTool, InspectionWarning, VersionComparison,
  CheckedWith } from './inspect.js';
export type { NativeVerificationRequest010 as NativeVerificationRequest, NativeVerificationResult010 as NativeVerificationResult,
  NativeVerificationRefusal, NativeVerificationControls010 as NativeVerificationControls } from './verify-client.js';
export type { FileCheck, FileCheckResult, FileCheckTarget, FileCheckControls } from './file-check.js';
export type { SupportReportResult, WriteSupportReportOptions } from './support-report.js';
export type { ReportFileResult, ReportFileStatus } from './internal/report-file.js';
export type { ResolvedStateLocation, ResolvedStateLocationMarker } from './resolve-state-location.js';
