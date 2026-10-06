// Public runtime boundary: deterministic test adapters stay inside the Harness.
import { isProxy } from 'node:util/types';
import { snapshotNativeData } from './native/canonical.mjs';
import * as helpers from './macos-session.mjs';
export const { macosSessionBudgets, macosSessionTrustKeys } = helpers;

function controlsSnapshot(value) {
  if (!value || typeof value !== 'object' || isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'signal' || !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], 'value'))) throw new TypeError();
  const signal = descriptors.signal?.value;
  if (signal !== undefined) {
    if (isProxy(signal)) throw new TypeError();
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal);
  }
  return signal === undefined ? {} : { signal };
}

function dataSnapshot(value) {
  let nodes = 0;
  const active = new WeakSet();
  const guard = (input, depth) => {
    if (++nodes > 1024 || depth > 8) throw new TypeError();
    if (!input || typeof input !== 'object') return;
    if (isProxy(input) || active.has(input)) throw new TypeError();
    active.add(input);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError();
      guard(descriptor.value, depth + 1);
    }
    active.delete(input);
  };
  guard(value, 0);
  return snapshotNativeData(value, 65_536, 8);
}
const unavailable = reason => ({ status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason });

export function renderMacosSessionLaunchAgent(intent) {
  try { return helpers.renderMacosSessionLaunchAgent(dataSnapshot(intent)); }
  catch { return { status: 'invalid', code: 'INPUT_INVALID', reason: 'launch-agent-intent' }; }
}
export async function observeMacosGuiSession(controls = {}) {
  try { return await helpers.observeMacosGuiSession(controlsSnapshot(controls)); }
  catch { return unavailable('gui-session-unavailable'); }
}
export async function observeMacosApplication(request, controls = {}) {
  try { return await helpers.observeMacosApplication(dataSnapshot(request), controlsSnapshot(controls)); }
  catch { return unavailable('app-request-invalid'); }
}
export async function readMacosGuiDomainKey(request, controls = {}) {
  try { return await helpers.readMacosGuiDomainKey(dataSnapshot(request), controlsSnapshot(controls)); }
  catch { return unavailable('session-unavailable'); }
}
