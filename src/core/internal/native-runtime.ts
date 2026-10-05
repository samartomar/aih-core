import type * as Harness from '../../harness/native/runtime.mjs';
import { NativeStop } from './native-input.js';
import { nativeReadPinned } from './native-material.js';
import type { NativeRuntime } from './native-session.js';

/** Bind generic orchestration to the fixed installed Harness adapter. */
export function nativeRuntime(module: typeof Harness): NativeRuntime {
  return module.createNativeRuntime(module, { readPinned: nativeReadPinned, Stop: NativeStop });
}
