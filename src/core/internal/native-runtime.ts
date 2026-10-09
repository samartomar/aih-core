import type * as Harness from '../../harness/native/runtime.mjs';
import { NativeStop } from './native-input.js';
import { nativeReadPinned, nativeReadPinnedRuntime } from './native-material.js';
import type { NativeRuntime } from './native-session.js';

/** Bind generic orchestration to the fixed installed Harness adapter. */
export function nativeRuntime(module: typeof Harness, recordCleanup?: (receipt: import('./native-session.js').NativeSessionCleanup, startedAt?: number) => void): NativeRuntime {
  return module.createNativeRuntime(module, { readPinned: nativeReadPinned, readPinnedRuntime: nativeReadPinnedRuntime, Stop: NativeStop, recordCleanup });
}
