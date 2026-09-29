export type * from './types.js';
export type * from './host-types.js';
import { prepare as preparePolicy, apply as applyPolicy } from './recipe-engine.js';
import { prepareRepair, applyRepair, isRepairHandle, type RepairRequest } from './repair.js';
import type { Authorization, HostControls, PolicyRequest, PreparedHandle } from './host-types.js';
import { isProxy } from 'node:util/types';
export type { RepairRequest } from './repair.js';
export function prepare(request: PolicyRequest | RepairRequest, controls: HostControls = {}) {
  const kind = request && typeof request === 'object' && !isProxy(request) ?
    Object.getOwnPropertyDescriptor(request, 'useCase')?.value : undefined;
  return kind === 'repair' ? prepareRepair(request as RepairRequest, controls) : preparePolicy(request as PolicyRequest, controls);
}
export function apply(prepared: PreparedHandle, authorization: Authorization, controls: HostControls = {}) {
  return isRepairHandle(prepared) ? applyRepair(prepared, authorization, controls) : applyPolicy(prepared, authorization, controls);
}
export { inspect } from './inspection.js';
export type { InspectRequest, InspectControls, InspectResult } from './inspection.js';
